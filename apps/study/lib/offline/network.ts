// Whether the server can be reached right now. `navigator.onLine` alone lies on Android WebViews (it
// stays true on a dead Wi-Fi), so a failed request also flips us offline, and a small probe (every
// PROBE_MS while offline) flips us back. React Query's `onlineManager` follows this store, so queries
// pause instead of erroring and resume on their own.
//
// Chrome 103: no AbortSignal.timeout — `fetchWithTimeout` uses AbortController + setTimeout.

import { onlineManager } from '@tanstack/react-query';

type Listener = (online: boolean) => void;

const PROBE_MS = 15_000;
/** The first re-check after a failure comes quickly: one dropped request should not park us offline. */
const FIRST_PROBE_MS = 2_500;
const PROBE_TIMEOUT_MS = 6_000;

let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probesSinceOnline = 0;
let probeUrl: () => string | null = () => null;
const listeners = new Set<Listener>();

function emit(): void {
  onlineManager.setOnline(online);
  Array.from(listeners).forEach((listener) => {
    try {
      listener(online);
    } catch {
      // one bad subscriber never breaks the rest
    }
  });
}

function setOnline(next: boolean): void {
  if (next) {
    stopProbe();
    resetProbeBackoff();
  } else {
    startProbe();
  }
  if (online === next) return;
  online = next;
  emit();
}

export function isOnline(): boolean {
  return online;
}

export function subscribeOnline(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** A request never reached the server (network error): we are offline whatever the browser says. */
export function reportNetworkFailure(): void {
  setOnline(false);
}

/** The server answered (any status): we are online. */
export function reportNetworkSuccess(): void {
  setOnline(true);
}

/** `fetch` with a deadline, Chrome-103 safe. */
export function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = PROBE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function probe(): Promise<void> {
  probeTimer = null;
  if (online) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    startProbe();

    return;
  }
  const url = probeUrl();

  // No server to ask (demo mode): the browser's word is all there is.
  if (!url) {
    setOnline(true);

    return;
  }
  try {
    // Any answer proves the server is reachable; `no-cors` so a route without CORS headers still counts.
    await fetchWithTimeout(url, { method: 'GET', cache: 'no-store', mode: 'no-cors' });
    setOnline(true);
  } catch {
    startProbe();
  }
}

function startProbe(): void {
  if (probeTimer !== null || typeof window === 'undefined') return;
  probeTimer = setTimeout(() => void probe(), probesSinceOnline++ === 0 ? FIRST_PROBE_MS : PROBE_MS);
}

function stopProbe(): void {
  if (probeTimer !== null) clearTimeout(probeTimer);
  probeTimer = null;
}

function resetProbeBackoff(): void {
  probesSinceOnline = 0;
}

/** Ask right away (app came to the front, user tapped retry). */
export function recheckNow(): void {
  if (online) return;
  stopProbe();
  void probe();
}

let installed = false;

/**
 * Wire the browser events and React Query. `url` names a cheap server URL to probe (null = no server).
 * Idempotent.
 */
export function installNetworkWatch(url: () => string | null): void {
  probeUrl = url;
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // React Query listens to the same events by default; we own the signal now.
  onlineManager.setEventListener(() => () => undefined);
  window.addEventListener('online', () => {
    // The browser says yes — confirm with the server before trusting it.
    online = false;
    recheckNow();
  });
  window.addEventListener('offline', () => setOnline(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheckNow();
  });
  if (!online) startProbe();
  emit();
}

/** Test hook: reset the module state. */
export function __resetNetworkForTests(value = true): void {
  stopProbe();
  online = value;
  listeners.clear();
}
