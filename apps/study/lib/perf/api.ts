/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * BACKEND CONTRACT — Study perf telemetry (`study-perf/v1`)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * POST /study/telemetry/perf                         (auth: Bearer session JWT, any signed-in role)
 *   Headers: Content-Type: application/json
 *            Content-Encoding: gzip   ← when the WebView has CompressionStream (Chrome 80+); else absent
 *   Body:    PerfBatch (lib/perf/types.ts):
 *     { schema: 'study-perf/v1', batchId: string, session: string, sentAt: epochMs,
 *       device: { id, ua, cores?, mem?, screen: [w, h], dpr, platform: 'android'|'web', chrome? },
 *       app:    { version, sha, versionCode|null },
 *       dropped: number,            // events evicted on the device since the last accepted batch
 *       events: PerfEvent[] }       // ≤ ~2000; kinds: loaf | longtask | event | gesture | gsum |
 *                                   //   error | pen | span | nav | mem  (shapes in types.ts)
 *   Size:    ≤ 256 KB on the wire (the client caps the RAW JSON at 256 KB, so gzip only shrinks it);
 *            keepalive flushes (page hidden) are ≤ 56 KB raw. Set the body-parser `limit` to ~2 MB:
 *            express inflates gzip by default and the limit applies to the INFLATED size.
 *   Answer:  204 (SHIPPED, BE #635). Idempotent by `batchId`: a duplicate is a 204 and costs no quota.
 *            A retry of the same events (lost answer, 5xx, 429) re-sends the SAME batchId.
 *            Events with an unknown `k` or a non-numeric `t` are dropped server-side and counted;
 *            the rest of the batch is stored.
 *   Errors:  401 → client keeps the events, backs off 5 min → 1 h (never signs the user out).
 *            404 → client keeps them, backs off 30 min → 6 h.
 *            400 (envelope only: schema / batchId / device.id / events not an array) and 413
 *            (> 5000 events or > 2 MB inflated — the client caps a batch at 256 KB raw and ≤ 4096
 *            events, so neither should happen) → client DROPS that batch (poison).
 *            429 (120 req/h, 5 MB/day per user) → waits max(backoff, Retry-After). 5xx → 1 → 30 min.
 *   CORS:    the APK origin (tauri://localhost / http://tauri.localhost) is cross-origin: allow
 *            `Authorization`, `Content-Type` AND `Content-Encoding` in Access-Control-Allow-Headers.
 *   Storage: one document per event (or per batch with events[]) keyed by user, device.id, session,
 *            t; TTL index → retention 30 days. Quota: ≤ 5 MB inflated per user per day and
 *            ≤ 120 requests per user per hour → 429 beyond.
 *
 * GET /study/telemetry/perf?device=&user=&from=&to=&kind=&limit=   (OWNER/admin only, 403 otherwise)
 *   → { events: (PerfEvent & { device: string, session: string, user: string, app: PerfApp })[],
 *       devices: { id, ua, lastSeen, app }[], next?: cursor }      newest first, limit ≤ 5000.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The sender. NOT `studyPost`: the shared transport signs the user out on any 401, always
 * JSON-stringifies (no gzip Blob) and cannot set `keepalive` — none of which a background beacon may
 * do or lack. Force-mock routes it to the in-memory mock (lib/perf/mock.ts) instead.
 */

import type { PerfSender } from './uploader';
import type { PerfBatch } from './types';

import { parseRetryAfter } from './uploader';

import { isMockRoute } from '@/lib/api/client';
import { StudyApiError } from '@/lib/api/errors';
import { studyPost } from '@/lib/api/http';
import { readSessionToken } from '@/lib/auth';
import { getBackendSettingsSnapshot } from '@/lib/backend-settings';

export const PERF_TELEMETRY_PATH = '/telemetry/perf';

/** gzip a string, or null where CompressionStream is missing/fails (pre-Chrome 80 WebViews). */
export async function gzipText(text: string): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined' || typeof Blob === 'undefined' || typeof Response === 'undefined') {
    return null;
  }

  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));

    return await new Response(stream).blob();
  } catch {
    return null;
  }
}

/**
 * Network failures in a row on gzip bodies while online. A backend whose CORS forgot
 * `Content-Encoding` fails the preflight as a plain network error — after two, send uncompressed.
 */
let gzipNetworkFailures = 0;
let gzipDisabled = false;

export const sendPerfBatch: PerfSender = async (batch: PerfBatch, { keepalive }) => {
  if (isMockRoute(PERF_TELEMETRY_PATH, 'POST')) {
    try {
      await studyPost(PERF_TELEMETRY_PATH, batch);

      return { ok: true, status: 204 };
    } catch (error) {
      return { ok: false, status: error instanceof StudyApiError ? error.status : 0 };
    }
  }

  const token = readSessionToken();

  // Signed out: nothing leaves the device, the queue waits for a session (backoff as for 401).
  if (!token) return { ok: false, status: -1 };

  const json = JSON.stringify(batch);
  const gz = gzipDisabled ? null : await gzipText(json);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  if (gz) headers['Content-Encoding'] = 'gzip';

  try {
    const res = await fetch(`${getBackendSettingsSnapshot().backendUrl}/study${PERF_TELEMETRY_PATH}`, {
      method: 'POST',
      headers,
      body: gz ?? json,
      keepalive,
      credentials: 'omit',
    });

    if (gz) gzipNetworkFailures = 0;

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'), Date.now());

      return { ok: false, status: 429, ...(retryAfterMs !== null ? { retryAfterMs } : {}) };
    }

    return { ok: res.ok, status: res.status };
  } catch {
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;

    if (gz && online) {
      gzipNetworkFailures += 1;
      if (gzipNetworkFailures >= 2) gzipDisabled = true;
    }

    return { ok: false, status: 0 };
  }
};
