// Always-on performance telemetry for the Study app — the DOM wiring. Framework-agnostic: started once
// from `_app` (client only, dynamic import) and read by Settings through `getPerfStatus` /
// `subscribePerfStatus`. Nothing here runs per input event except the board gesture frame counter
// (one rAF callback per frame, only while a gesture is open — O(1) work).
//
// Collected (all feature-detected; the Galaxy Tab A6/A7 WebView may be Chrome 138, LoAF needs 123):
// - Long Animation Frames with script attribution — `longtask` where LoAF is missing;
// - Event Timing entries ≥ 40 ms (interaction latency by event type + target);
// - board gestures (pen/finger/pinch/wheel on the canvas): frames, dropped %, worst frame, tagged
//   with tool/pages/objects/zoom/layout — janky ones on their own, smooth ones rolled up per minute;
// - JS errors + unhandled rejections (deduped), renderer spans from whiteboard-react's `perfSpan`,
//   the board's native pen trace (pen buttons), route changes, a heap/DOM sample per minute.
//
// Storage: in memory → IndexedDB ring (2000 events / 2 MB, oldest dropped) every 5 s or 50 events.
// Upload: every 60 s while visible + a keepalive flush when the page goes hidden (see ./uploader).

import type { BoardGestureEdge } from '@repo/whiteboard-react/telemetry';
import type { PerfStore, PerfStoreStats } from './store';
import type { PerfApp, PerfDevice, PerfEvent, PerfEventKind } from './types';

import {
  getBoardTelemetryContext,
  isFeatureLabel,
  PEN_NATIVE_TRACE_EVENT,
  readPenNativeTrace,
  setPerfSpanRecorder,
  subscribeBoardGestures,
} from '@repo/whiteboard-react/telemetry';

import { sendPerfBatch } from './api';
import { randomId, readPerfApp, readPerfDevice } from './device';
import { FrameMeter, isJanky, RateLimiter } from './frames';
import { IdbPerfStore } from './idb-store';
import { filterEventEntries, parseError, parseEventTiming, parseLoaf, parseLongTask } from './parse';
import { PerfRollup } from './rollup';
import { MemoryPerfStore } from './store';
import { PERF_SCHEMA } from './types';
import { PerfUploader } from './uploader';

export const PERF_ENABLED_KEY = 'study.perf.enabled';
const PEN_CURSOR_KEY = 'study.perf.penAt';

export const PERF_UPLOAD_INTERVAL_MS = 60_000;
const FIRST_UPLOAD_DELAY_MS = 15_000;
const FLUSH_DELAY_MS = 5_000;
const FLUSH_AT_EVENTS = 50;

/** Event Timing threshold (ms) — the spec minimum is 16, 40 keeps only interactions a student feels. */
export const EVENT_DURATION_THRESHOLD_MS = 40;
/** Spans below this are not uploaded (whiteboard-react reports ≥ 4 ms). */
const SPAN_MIN_MS = 16;

/** Per-minute caps per kind; the rest is counted in the rollup's `sk`. */
const RATE_LIMITS: Partial<Record<PerfEventKind, number>> = {
  loaf: 60,
  longtask: 60,
  event: 60,
  gesture: 60,
  pen: 120,
  error: 30,
};
const SPAN_RATE_PER_LABEL = 20;
const INK_RATE_PER_LABEL = 600;
const INK_DETAIL_MAX = 200;
/** A gesture longer than this stops being metered (lost end edge backstop). */
const MAX_GESTURE_MS = 30_000;

export interface PerfStatus {
  enabled: boolean;
  started: boolean;
  /** Events waiting on the device (ring + not yet flushed). */
  queued: number;
  bytes: number;
  /** Evicted by the caps and not yet reported. */
  dropped: number;
  sent: number;
  lastUploadAt: number | null;
  lastStatus: number | null;
  nextAttemptAt: number;
  supports: { loaf: boolean; longtask: boolean; event: boolean; gzip: boolean };
}

type Listener = () => void;

const listeners = new Set<Listener>();

function emit(): void {
  status = computeStatus();
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // a broken subscriber never breaks the collector
    }
  });
}

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(PERF_ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

function supportedEntryTypes(): readonly string[] {
  try {
    return typeof PerformanceObserver !== 'undefined' ? (PerformanceObserver.supportedEntryTypes ?? []) : [];
  } catch {
    return [];
  }
}

function epochOrigin(): number {
  return typeof performance !== 'undefined' && performance.timeOrigin
    ? performance.timeOrigin
    : Date.now() - performance.now();
}

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function idle(callback: () => void): void {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;

  if (typeof ric === 'function') ric(callback, { timeout: 10_000 });
  else window.setTimeout(callback, 200);
}

/* ------------------------------------------------------------------ state */

let store: PerfStore | null = null;
let ready: Promise<void> | null = null;
let uploader: PerfUploader | null = null;
let header: { session: string; device: PerfDevice; app: PerfApp } | null = null;
let pending: PerfEvent[] = [];
let flushTimer: number | null = null;
let running = false;
let teardown: (() => void)[] = [];
const rollup = new PerfRollup();
const kindLimiters = new Map<string, RateLimiter>();
let lastRoute = '';
let gestureOpen = false;
let status: PerfStatus = computeStatus();

function computeStatus(): PerfStatus {
  const stats: PerfStoreStats = store?.stats() ?? { count: 0, bytes: 0, dropped: 0 };
  const types = typeof window === 'undefined' ? [] : supportedEntryTypes();

  return {
    enabled: typeof window === 'undefined' ? true : readEnabled(),
    started: running,
    queued: stats.count + pending.length,
    bytes: stats.bytes,
    dropped: stats.dropped,
    sent: uploader?.sentEvents ?? 0,
    lastUploadAt: uploader?.lastUploadAt ?? null,
    lastStatus: uploader?.lastStatus ?? null,
    nextAttemptAt: uploader?.nextAttemptAt ?? 0,
    supports: {
      loaf: types.includes('long-animation-frame'),
      longtask: types.includes('longtask'),
      event: types.includes('event'),
      gzip: typeof CompressionStream !== 'undefined',
    },
  };
}

function allow(key: string, perMinute: number): boolean {
  let rate = kindLimiters.get(key);

  if (!rate) {
    rate = new RateLimiter(perMinute);
    kindLimiters.set(key, rate);
  }

  if (rate.allow(key, Date.now())) return true;
  rollup.skip(key);

  return false;
}

function currentRoute(): string {
  return typeof location === 'undefined' ? '' : location.pathname;
}

function noteRoute(now: number): string {
  const route = currentRoute();

  if (route !== lastRoute) {
    lastRoute = route;
    pending.push({ k: 'nav', t: now, r: route });
  }

  return route;
}

/** Queue one event (route stamped). Rate-limited per kind; never throws. */
function record(event: PerfEvent): void {
  if (!running) return;

  try {
    const limit = RATE_LIMITS[event.k];

    if (limit !== undefined && !allow(event.k, limit)) return;
    event.r = noteRoute(event.t);
    pending.push(event);
    scheduleFlush(pending.length >= FLUSH_AT_EVENTS ? 0 : FLUSH_DELAY_MS);
  } catch {
    // telemetry never becomes the incident
  }
}

function scheduleFlush(delay: number): void {
  if (flushTimer !== null) {
    if (delay > 0) return;
    window.clearTimeout(flushTimer);
  }
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delay);
}

async function flush(): Promise<void> {
  if (!store || !ready) return;
  await ready;
  if (pending.length === 0) return;
  const batch = pending;

  pending = [];

  try {
    await store.append(batch);
  } catch {
    // memory/disk refusal — these events are lost, the next ones still try
  }
  emit();
}

function rollupNow(): void {
  const events = rollup.drain(Date.now());

  if (events.length) pending.push(...events);
}

/* ------------------------------------------------------------------ observers */

function observe(
  type: string,
  options: Record<string, unknown>,
  onEntries: (entries: PerformanceEntry[]) => void,
): boolean {
  try {
    const observer = new PerformanceObserver((list) => {
      try {
        onEntries(list.getEntries());
      } catch {
        // a malformed entry never breaks the observer
      }
    });

    observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit);
    teardown.push(() => observer.disconnect());

    return true;
  } catch {
    return false;
  }
}

function boardTool(): string | undefined {
  try {
    return getBoardTelemetryContext(false)?.tool;
  } catch {
    return undefined;
  }
}

function installObservers(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  const types = supportedEntryTypes();
  const origin = epochOrigin();

  const loaf = types.includes('long-animation-frame')
    ? observe('long-animation-frame', {}, (entries) => {
        const tool = boardTool();

        for (const entry of entries) {
          const event = parseLoaf(entry as unknown as Parameters<typeof parseLoaf>[0], origin);

          if (tool) event.tool = tool;
          record(event);
        }
      })
    : false;

  if (!loaf && types.includes('longtask')) {
    observe('longtask', {}, (entries) => {
      const tool = boardTool();

      for (const entry of entries) {
        const event = parseLongTask(entry as unknown as Parameters<typeof parseLongTask>[0], origin);

        if (tool) event.tool = tool;
        record(event);
      }
    });
  }

  if (types.includes('event')) {
    observe('event', { durationThreshold: EVENT_DURATION_THRESHOLD_MS }, (entries) => {
      const tool = boardTool();

      const kept = filterEventEntries(
        (entries as unknown as Parameters<typeof parseEventTiming>[0][]).filter(
          (entry) => entry.duration >= EVENT_DURATION_THRESHOLD_MS,
        ),
      );

      for (const entry of kept) {
        const event = parseEventTiming(entry, origin);

        if (tool) event.tool = tool;
        record(event);
      }
    });
  }
}

/* ------------------------------------------------------------------ errors */

function installErrorHandlers(): void {
  const onError = (event: ErrorEvent) => {
    // Resource load failures (img/script 404) arrive without `error` and with a non-window target.
    if (!event.message && !event.error) return;
    const parsed = parseError('error', event.error ?? event.message, Date.now(), event);
    const first = rollup.error(parsed);

    if (first) record(first);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const parsed = parseError('rejection', event.reason, Date.now());
    const first = rollup.error(parsed);

    if (first) record(first);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  teardown.push(() => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  });
}

/* ------------------------------------------------------------------ board: gestures, spans, pen trace */

function installBoardHooks(): void {
  let meter: FrameMeter | null = null;
  let startedAt = 0;
  let frame = 0;
  let last = 0;

  const tick = (now: number) => {
    if (!meter) return;
    // Backstop: an end edge that never comes must not mean an endless 60 Hz loop.
    if (now - startedAt > MAX_GESTURE_MS) {
      meter = null;
      gestureOpen = false;

      return;
    }
    if (last > 0) meter.add(now - last);
    last = now;
    frame = window.requestAnimationFrame(tick);
  };

  const onGesture = (edge: BoardGestureEdge) => {
    if (edge.phase === 'start') {
      if (meter) return;
      meter = new FrameMeter();
      startedAt = edge.at;
      last = 0;
      gestureOpen = true;
      frame = window.requestAnimationFrame(tick);

      return;
    }
    if (!meter) return;
    window.cancelAnimationFrame(frame);
    const stats = meter.stats();

    meter = null;
    gestureOpen = false;
    if (stats.frames < 2) return;

    if (!isJanky(stats)) {
      rollup.smoothGesture(edge.kind, stats);

      return;
    }
    const board = getBoardTelemetryContext(true) ?? undefined;

    record({
      k: 'gesture',
      t: Date.now(),
      kind: edge.kind,
      dur: Math.round(edge.at - startedAt),
      ...stats,
      ...(board ? { board } : {}),
    });
  };

  teardown.push(subscribeBoardGestures(onGesture));
  teardown.push(() => {
    window.cancelAnimationFrame(frame);
    meter = null;
    gestureOpen = false;
  });

  setPerfSpanRecorder((label, ms, detail) => {
    if (!running) return;
    // `ink-*` are feature events (auto-colour), not timings: no duration floor, a roomier rate cap and a
    // longer detail. They stay `k:'span'` because the backend drops unknown kinds.
    const feature = isFeatureLabel(label);

    if (!feature && ms < SPAN_MIN_MS) return;
    if (!allow(`span:${label}`, feature ? INK_RATE_PER_LABEL : SPAN_RATE_PER_LABEL)) return;
    record({
      k: 'span',
      t: Date.now(),
      label,
      dur: ms,
      ...(detail ? { d: detail.slice(0, feature ? INK_DETAIL_MAX : 120) } : {}),
    });
  });
  teardown.push(() => setPerfSpanRecorder(null));

  // The native pen trace: whatever the board wrote since the last upload, then live.
  let penCursor = 0;

  try {
    penCursor = Number(window.localStorage.getItem(PEN_CURSOR_KEY)) || 0;
  } catch {
    penCursor = 0;
  }
  const notePen = (entry: { at: number; type: string; text: string }) => {
    if (entry.at <= penCursor) return;
    penCursor = entry.at;
    try {
      window.localStorage.setItem(PEN_CURSOR_KEY, String(penCursor));
    } catch {
      // the cursor only avoids duplicates across launches
    }
    record({ k: 'pen', t: entry.at, type: entry.type.slice(0, 40), text: entry.text.slice(0, 200) });
  };

  try {
    readPenNativeTrace().forEach(notePen);
  } catch {
    // no trace yet
  }
  const onPen = (event: Event) => {
    const detail = (event as CustomEvent<{ at: number; type: string; text: string }>).detail;

    if (detail && typeof detail.at === 'number') notePen(detail);
  };

  window.addEventListener(PEN_NATIVE_TRACE_EVENT, onPen);
  teardown.push(() => window.removeEventListener(PEN_NATIVE_TRACE_EVENT, onPen));
}

/* ------------------------------------------------------------------ memory + upload loop */

function sampleMemory(): void {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const mb = (bytes: number) => Math.round(bytes / 1048576);

  pending.push({
    k: 'mem',
    t: Date.now(),
    r: currentRoute(),
    nodes: document.getElementsByTagName('*').length,
    ...(memory ? { heap: mb(memory.usedJSHeapSize), limit: mb(memory.jsHeapSizeLimit) } : {}),
  });
}

async function uploadPass(options: { keepalive?: boolean; force?: boolean } = {}): Promise<void> {
  if (!uploader) return;
  rollupNow();
  await flush();
  await uploader.upload(options);
  emit();
}

function installUploadLoop(): void {
  const minute = () => {
    if (!visible()) return;
    const run = () => {
      sampleMemory();
      void uploadPass();
    };

    // Never upload under a finger: wait for the gesture to end (idle callback), at most ~10 s.
    if (gestureOpen) idle(run);
    else run();
  };
  const first = window.setTimeout(minute, FIRST_UPLOAD_DELAY_MS);
  const interval = window.setInterval(minute, PERF_UPLOAD_INTERVAL_MS);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void uploadPass({ keepalive: true });
  };

  document.addEventListener('visibilitychange', onVisibility);
  teardown.push(() => {
    window.clearTimeout(first);
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}

/* ------------------------------------------------------------------ public */

function ensureStore(): void {
  if (store) return;

  if (typeof indexedDB !== 'undefined') {
    const idb = new IdbPerfStore();

    store = idb;
    ready = idb.init().then(() => emit());
  } else {
    store = new MemoryPerfStore();
    ready = Promise.resolve();
  }
  header = { session: randomId(), device: readPerfDevice(), app: readPerfApp() };
  uploader = new PerfUploader({
    store,
    send: sendPerfBatch,
    now: Date.now,
    random: Math.random,
    newId: randomId,
    header: () => header as NonNullable<typeof header>,
  });
}

/** Start collecting (idempotent; no-op on the server or when the owner switched it off). */
export function startPerfTelemetry(): void {
  if (typeof window === 'undefined' || running) return;
  ensureStore();
  if (!readEnabled()) {
    emit();

    return;
  }
  running = true;
  lastRoute = '';
  installObservers();
  installErrorHandlers();
  installBoardHooks();
  installUploadLoop();
  emit();
}

/** Stop collecting; the queue stays on the device. */
export function stopPerfTelemetry(): void {
  if (!running) return;
  running = false;
  teardown.forEach((stop) => {
    try {
      stop();
    } catch {
      // ignore
    }
  });
  teardown = [];
  void flush();
  emit();
}

export function setPerfEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(PERF_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // the toggle still applies to this session
  }
  if (enabled) startPerfTelemetry();
  else stopPerfTelemetry();
  emit();
}

export function getPerfStatus(): PerfStatus {
  return status;
}

export function subscribePerfStatus(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Settings «upload now»: ignores the backoff window. */
export async function uploadPerfNow(): Promise<void> {
  ensureStore();
  await uploadPass({ force: true });
}

/** Everything queued on the device as one JSON document (the Copy/Share fallback). */
export async function exportPerfLog(): Promise<string> {
  ensureStore();
  rollupNow();
  await flush();
  const entries = store ? await store.all() : [];
  const events: unknown[] = [];

  for (const entry of entries) {
    try {
      events.push(JSON.parse(entry.json));
    } catch {
      // skip a corrupt row
    }
  }

  return JSON.stringify(
    {
      schema: PERF_SCHEMA,
      exportedAt: Date.now(),
      ...(header ?? {}),
      status: computeStatus(),
      events,
    },
    null,
    1,
  );
}

/** Settings «clear»: drop the device queue. */
export async function clearPerfLog(): Promise<void> {
  ensureStore();
  pending = [];
  await ready;
  await store?.clear();
  store?.takeDropped();
  emit();
}
