// Installs the study transport (`lib/api/http.ts`). The backend ships the study module in phases, so
// the decision is PER ROUTE: a path whose prefix is in `LIVE_ROUTES` goes to the real backend
// (`${backend}/study`, Bearer JWT, SSE via readSse); every other path is answered by the in-memory
// mock (`lib/api/mock`). Settings can still force everything to mock or everything to live
// (`localStorage.study_mock` = '1' / '0'); the default is this hybrid.
//
// Extend `LIVE_ROUTES` as the backend lands each phase — one constant, nothing else to touch.
import type { SseFrame, StudyTransport } from './http';
import type { StudyClass } from './types';

import { NEEDS_INTERNET_MESSAGE, OFFLINE_CODE, StudyApiError, studyApiError } from './errors';
import { readSse, setStudyTransport } from './http';
import { createMockTransport } from './mock';
import { rememberLiveClasses } from './mock/class-map';
import { markSample } from './sample';
import { isSessionDead } from './session-401';

import { readSessionToken, STUDY_TOKEN_KEY, STUDY_USER_KEY } from '@/lib/auth';
import { getBackendSettingsSnapshot, subscribeBackendSettings } from '@/lib/backend-settings';
import { isOnline, reportNetworkFailure, reportNetworkSuccess } from '@/lib/offline/network';

/**
 * Route prefixes the backend serves today.
 * P1: Canvas connection + sync, classes, items, today. P2: pages (CRUD + content + ocr), search,
 * questions (list/create/patch/delete + extract/attempt/similar SSE), review, mastery.
 * P3: lectures, video transcripts, ai/flashcards. P4: code. P5: exams. P6: mcp keys. P-CM: class library
 * (+ search), guide, exam schedule + results (all under /classes), library docs, concept maps.
 * A-plan (#576): /classes/:id/a-plan (+ refresh) and the /today aPlan / highAnnouncements fields.
 * Tutor (#577): ai/ask (SSE) + ai/conversations. Force-mock (Settings) still answers them from the
 * tutor mock, marked `__sample`.
 * Phone inbox (#585): /inbox (items, tokens, stream). Multipart upload + the GET stream live in
 * features/inbox/api.ts and follow the same rule via `isMockRoute`.
 * Perf telemetry (lib/perf): /telemetry/perf (#635) — a 404 keeps the events queued on the device.
 * My handwriting glyph bank (#635): /handwriting/bank (GET/PUT with If-Match).
 */
export const LIVE_ROUTES = [
  '/canvas',
  '/classes',
  '/items',
  '/today',
  '/pages',
  '/search',
  '/questions',
  '/review',
  '/mastery',
  '/lectures',
  '/videos',
  '/ai/flashcards',
  '/ai/ask',
  // Dictation (mic in the Ask-AI box): raw audio in, {text} out. A 404 sends the FE to the browser engine.
  '/ai/transcribe',
  '/ai/conversations',
  '/ai/board-actions',
  // Board «map my terms»: /study/ai/concept-map/from-terms.
  '/ai/concept-map',
  // Auto-colour cloud classifier (lib/ink/cloudClassify): live even before the BE ships it — its 404 is
  // the signal that turns the cloud off for the session (rules-only), so it must reach the backend.
  '/ai/ink-classify',
  '/exams',
  '/mcp',
  '/library',
  '/concept-maps',
  '/inbox',
  '/telemetry',
  '/handwriting',
  // Office → PDF (#657): raw file in, PDF out.
  '/convert',
  // Sharing (read-only share + make a copy): the server mounts it at /study/share too.
  '/share',
] as const;

/**
 * Hosted accounts (`${backend}/auth/*`, docs/accounts.md) are ALWAYS live and never pass through this
 * transport: they sit at the backend root (not under `/study`) and a mock sign-in would mean nothing.
 * `features/auth/api.ts` calls them with the axios client; with no server (demo mode) the login page says
 * sign-in needs one instead of calling anything. Listed here so the routing rule lives in one place.
 */
export const AUTH_ROUTE_PREFIX = '/auth';

/**
 * Sub-routes of LIVE prefixes the backend has NOT shipped yet — checked BEFORE `LIVE_ROUTES`, so
 * they stay on the mock. `*` matches exactly one path segment. Delete entries as the backend lands them.
 */
export const MOCK_OVERRIDES: readonly string[] = [];

/**
 * Same idea for calls the backend serves only PARTIALLY: a `PATCH /classes/:id` whose body carries one
 * of these keys belongs to a feature the backend does not know yet, so it goes to the mock; any other
 * body (hidden, color) is live.
 */
export const MOCK_BODY_OVERRIDES: readonly { method: string; pattern: string; keys: readonly string[] }[] = [];

function matchesGlob(pathname: string, pattern: string): boolean {
  const actual = pathname.split('/').filter(Boolean);
  const expected = pattern.split('/').filter(Boolean);

  return actual.length === expected.length && expected.every((part, index) => part === '*' || part === actual[index]);
}

/** Whether this call is pinned to the mock although its prefix is live. */
export function isMockOverride(path: string, method = 'GET', body?: unknown): boolean {
  const pathname = path.split('?')[0];

  if (MOCK_OVERRIDES.some((pattern) => matchesGlob(pathname, pattern))) return true;
  if (!body || typeof body !== 'object') return false;
  const keys = Object.keys(body as Record<string, unknown>);

  return MOCK_BODY_OVERRIDES.some(
    (rule) =>
      rule.method === method.toUpperCase() &&
      matchesGlob(pathname, rule.pattern) &&
      rule.keys.some((key) => keys.includes(key)),
  );
}

export type ResolvedMode = 'mock' | 'live' | 'hybrid';

type ModeListener = (mode: ResolvedMode | null) => void;

let resolvedMode: ResolvedMode | null = null;
const modeListeners = new Set<ModeListener>();

function emitMode(): void {
  Array.from(modeListeners).forEach((listener) => {
    try {
      listener(resolvedMode);
    } catch {
      // never let one subscriber break the transport
    }
  });
}

/** Which transport policy is in force (`null` until the first call). Reactive via `subscribeResolvedMode`. */
export function getResolvedMode(): ResolvedMode | null {
  return resolvedMode;
}

export function subscribeResolvedMode(listener: ModeListener): () => void {
  modeListeners.add(listener);

  return () => {
    modeListeners.delete(listener);
  };
}

export function isLiveRoute(path: string): boolean {
  const pathname = path.split('?')[0];

  return LIVE_ROUTES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function studyBase(): string {
  return `${getBackendSettingsSnapshot().backendUrl}/study`;
}

/**
 * The Bearer header — or, with no session at all, a local 401 BEFORE any request leaves the device.
 * Right after sign-out (and on a device that never signed in) a few queries still fire; answering
 * them here keeps the network quiet and does NOT trigger the sign-out redirect (nothing to clear).
 */
function authHeaders(): Record<string, string> {
  const token = readSessionToken();

  if (!token) throw new StudyApiError(401, 'Not signed in', 'NO_SESSION');

  return { Authorization: `Bearer ${token}` };
}

/**
 * A 401 is the backend saying this JWT is gone (plain-text body, e.g. "jwt must be provided"): drop
 * the dead session and go to /login. 403 (a confined role) is a normal error for the caller.
 */
function handleUnauthorized(message: string): void {
  if (typeof window === 'undefined') return;
  // Both backends turn ANY error in their auth check (a slow database too) into a 401: keep a
  // still-valid session unless the server says the token or account itself is gone.
  if (!isSessionDead(readSessionToken(), message)) return;

  try {
    window.localStorage.removeItem(STUDY_TOKEN_KEY);
    window.localStorage.removeItem(STUDY_USER_KEY);
  } catch {
    // storage refusal — the cookie wipe below still ends the session
  }
  document.cookie = `${STUDY_TOKEN_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;

  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login/';
  }
}

async function throwForResponse(res: Response): Promise<never> {
  // Error bodies are `{ message, code }` — except auth's 401, which is plain text.
  const text = await res.text().catch(() => '');
  let message = text.trim() || `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;

  let extra: Record<string, unknown> = {};

  try {
    const body = JSON.parse(text) as ({ message?: string; code?: string } & Record<string, unknown>) | null;

    if (body?.message) message = body.message;
    if (body?.code) code = body.code;
    if (body && typeof body === 'object') extra = body;
  } catch {
    // plain-text body stays the message
  }

  if (res.status === 401) handleUnauthorized(message);

  // Extra fields (409 `currentVersion`, extract `failedPages`) ride along on the error object.
  throw studyApiError(res.status, message, code, extra);
}

/** Every live class listing refreshes the fixture→live class-id map the mock answers with. */
function noteLiveClasses(method: string, path: string, result: unknown): void {
  if (method !== 'GET') return;
  const pathname = path.split('?')[0];

  if (pathname === '/classes' && Array.isArray(result)) rememberLiveClasses(result as StudyClass[]);
  else if (
    pathname === '/today' &&
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { classes?: unknown }).classes)
  ) {
    rememberLiveClasses((result as { classes: StudyClass[] }).classes);
  }
}

/**
 * `fetch` that tells the offline layer what happened: a request that never reached the server flips the
 * app offline (Android WebViews keep `navigator.onLine` true on a dead network), any answer flips it back.
 */
/** Waits before re-sending a request that never reached the server (flaky connection). */
const NETWORK_RETRY_MS = [800, 2_000];

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function liveFetch(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  // Only requests that are safe to send twice are re-sent on their own (reads and whole-file PUTs).
  const retries = method === 'GET' || method === 'HEAD' || method === 'PUT' ? NETWORK_RETRY_MS : [];

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);

      reportNetworkSuccess();

      return res;
    } catch (error) {
      const aborted = init.signal?.aborted ?? false;

      if (!aborted) reportNetworkFailure();
      if (aborted || attempt >= retries.length) throw error;
      await wait(retries[attempt], init.signal);
      if (init.signal?.aborted) throw error;
    }
  }
}

const liveTransport: StudyTransport = {
  async json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await liveFetch(`${studyBase()}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
        ...authHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) await throwForResponse(res);
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const result = (text ? JSON.parse(text) : undefined) as T;

    noteLiveClasses(method, path, result);

    return result;
  },
  async raw<T>(method: string, path: string, body: Blob | string, contentType: string): Promise<T> {
    const res = await liveFetch(`${studyBase()}${path}`, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': contentType, ...authHeaders() },
      body,
    });

    if (!res.ok) await throwForResponse(res);
    if (res.status === 204) return undefined as T;

    const text = await res.text();

    return (text ? JSON.parse(text) : undefined) as T;
  },
  async rawBlob(method: string, path: string, body: Blob, headers: Record<string, string>): Promise<Response> {
    const res = await liveFetch(`${studyBase()}${path}`, { method, headers: { ...headers, ...authHeaders() }, body });

    if (!res.ok) await throwForResponse(res);

    return res;
  },
  async sse(path: string, body: unknown, onFrame: (frame: SseFrame) => void, signal?: AbortSignal): Promise<void> {
    // Streams are AI / grading: they need the server. Offline, say so at once instead of failing slowly.
    if (!isOnline()) throw new StudyApiError(0, NEEDS_INTERNET_MESSAGE, OFFLINE_CODE);
    const res = await liveFetch(`${studyBase()}${path}`, {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body ?? {}),
      signal,
    });

    if (!res.ok) await throwForResponse(res);
    await readSse(res, onFrame);
  },
};

const mockTransport = createMockTransport();

function publishMode(mode: ResolvedMode): void {
  if (resolvedMode !== mode) {
    resolvedMode = mode;
    emitMode();
  }
}

/** Whether a call would be answered by the mock right now (forced mode, override, or unshipped prefix). */
export function isMockRoute(path: string, method = 'GET', body?: unknown): boolean {
  const { mockMode } = getBackendSettingsSnapshot();

  if (mockMode === 'mock') return true;
  if (mockMode === 'live') return false;

  return isMockOverride(path, method, body) || !isLiveRoute(path);
}

/** The transport for one call: forced mode wins, then the mock overrides, then the live allowlist. */
export function resolveTransport(path: string, method = 'GET', body?: unknown): StudyTransport {
  const { mockMode } = getBackendSettingsSnapshot();

  if (mockMode === 'mock') {
    publishMode('mock');

    return mockTransport;
  }

  if (mockMode === 'live') {
    publishMode('live');

    return liveTransport;
  }

  publishMode('hybrid');

  if (isMockOverride(path, method, body)) return mockTransport;

  return isLiveRoute(path) ? liveTransport : mockTransport;
}

/**
 * `/questions/extract` from a notebook page: the live backend reads OCR text the client sent
 * (`PUT /pages/:id/ocr`), and this app has no OCR — so the page's pixels go instead (`imagePngB64`),
 * which the backend reads directly. Only the live transport needs this; the mock accepts `pageId`.
 */
async function withExtractSource(path: string, body: unknown, transport: StudyTransport): Promise<unknown> {
  if (path.split('?')[0] !== '/questions/extract' || transport !== liveTransport) return body;
  const from = (body as { from?: { pageId?: string; imagePngB64?: string } } | null)?.from;

  if (!from?.pageId || from.imagePngB64) return body;
  const { rasterizeNotebookPage } = await import('@/lib/notebooks/rasterize');
  const png = await rasterizeNotebookPage(from.pageId, null);

  if (!png) return body;
  const rest: Record<string, unknown> = { ...from };

  delete rest.pageId;

  return { ...(body as object), from: { ...rest, imagePngB64: png } };
}

const switchingTransport: StudyTransport = {
  json: async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const transport = resolveTransport(path, method, body);
    const result = await transport.json<T>(method, path, body, headers);

    // Whatever the mock answered is sample data — whole screens in Force-mock, single unshipped
    // routes beside real Canvas data in Auto. Live answers are never marked.
    return transport === mockTransport ? markSample(result) : result;
  },
  raw: <T>(method: string, path: string, body: Blob | string, contentType: string) => {
    const transport = resolveTransport(path, method);

    if (!transport.raw) throw new StudyApiError(501, 'Raw uploads are not supported by this transport');

    return transport
      .raw<T>(method, path, body, contentType)
      .then((result) => (transport === mockTransport ? markSample(result) : result));
  },
  rawBlob: (method, path, body, headers) => {
    const transport = resolveTransport(path, method);

    if (!transport.rawBlob) throw new StudyApiError(501, 'This needs the live backend (turn off sample mode)');

    return transport.rawBlob(method, path, body, headers);
  },
  sse: async (path, body, onFrame, signal) => {
    const transport = resolveTransport(path, 'POST', body);

    const forward =
      transport === mockTransport
        ? (frame: SseFrame) => onFrame({ event: frame.event, data: markSample(frame.data) })
        : onFrame;

    return transport.sse(path, await withExtractSource(path, body, transport), forward, signal);
  },
};

let installed = false;

/** Idempotent; called from `_app.tsx` at module scope so every feature can call the API at once. */
export function installStudyTransport(): void {
  if (installed) return;

  installed = true;
  setStudyTransport(switchingTransport);

  // A new backend URL or mode re-announces the policy to the UI badges.
  subscribeBackendSettings(() => {
    resolvedMode = null;
    emitMode();
  });
}

export { StudyApiError } from './errors';
