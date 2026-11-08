//! Lightweight in-app performance HUD bus.
//!
//! A tiny dependency-free store that the editor feeds with timing samples (page-switch phases, ink
//! reload, PDF image resolution, …) and that {@link ../PerfOverlay} renders on-screen. The point is
//! diagnosis on the *user's* device: we can't profile their machine remotely, so this surfaces the
//! real per-action breakdown live and lets them read it off.
//!
//! Enabled by default inside the native desktop shell (a debug aid), off on the plain web build.
//! Toggle at runtime with Ctrl/Cmd+Shift+D, the `?perf=1` / `?perf=0` query param, or
//! {@link setPerfHudEnabled}. The choice is persisted in localStorage. Recording is a no-op while
//! disabled, so it costs nothing in normal use.

export interface PerfEntry {
  /** Monotonic id (newest first in the list). */
  id: number;
  /** Short label, e.g. `switch → 4`. */
  label: string;
  /** Duration in milliseconds (rounded). */
  ms: number;
  /** Optional breakdown / context, e.g. `flush=2 load=2100 ink=480kb`. */
  detail?: string;
  /** Wall-clock capture time (ms epoch). */
  at: number;
}

const MAX_ENTRIES = 18;

let entries: PerfEntry[] = [];
let seq = 0;
let enabled = false;
let initialized = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A broken subscriber must not break recording.
    }
  });
}

function readInitialEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const queryValue = new URLSearchParams(window.location.search).get('perf');

    if (queryValue === '1') {
      return true;
    }

    if (queryValue === '0') {
      return false;
    }

    const stored = window.localStorage.getItem('whiteboard-perf-hud');

    if (stored === '1') {
      return true;
    }

    if (stored === '0') {
      return false;
    }

    // Default OFF now that the native pipeline is validated. Re-enable any time with Ctrl+Shift+D,
    // ?perf=1, or by setting localStorage 'whiteboard-perf-hud' = '1'.
    return false;
  } catch {
    return false;
  }
}

function ensureInitialized(): void {
  if (initialized || typeof window === 'undefined') {
    return;
  }

  initialized = true;
  enabled = readInitialEnabled();
}

/** Whether the HUD is currently enabled. */
export function isPerfHudEnabled(): boolean {
  ensureInitialized();

  return enabled;
}

/** Enable/disable the HUD and persist the choice. */
export function setPerfHudEnabled(value: boolean): void {
  ensureInitialized();
  enabled = value;

  try {
    window.localStorage.setItem('whiteboard-perf-hud', value ? '1' : '0');
  } catch {
    // Persistence is best-effort.
  }

  notify();
}

/** Flip the HUD on/off. */
export function togglePerfHud(): void {
  setPerfHudEnabled(!isPerfHudEnabled());
}

/** Record a timing sample. No-op while the HUD is disabled (so it's free in normal use). */
export function recordPerf(label: string, ms: number, detail?: string): void {
  ensureInitialized();

  if (!enabled) {
    return;
  }

  entries = [{ id: ++seq, label, ms: Math.round(ms), detail, at: Date.now() }, ...entries].slice(0, MAX_ENTRIES);
  notify();
}

/** Current entries, newest first. */
export function getPerfEntries(): PerfEntry[] {
  return entries;
}

/**
 * Build a structured, paste-friendly report of all recorded entries plus the device/render context
 * that matters for diagnosis (devicePixelRatio + deviceMemory drive the PDF render resolution;
 * tauri tells whether the native render path is even available). Returns pretty JSON.
 */
export function getPerfReport(): string {
  const win = typeof window === 'undefined' ? undefined : window;
  const nav = typeof navigator === 'undefined' ? undefined : navigator;

  const env = {
    devicePixelRatio: win?.devicePixelRatio ?? null,
    deviceMemoryGb: (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory ?? null,
    hardwareConcurrency: nav?.hardwareConcurrency ?? null,
    viewport: win ? `${win.innerWidth}x${win.innerHeight}` : null,
    tauri: win ? '__TAURI__' in win || '__TAURI_INTERNALS__' in win : false,
    userAgent: nav?.userAgent ?? null,
  };

  return JSON.stringify(
    {
      kind: 'whiteboard-perf-report',
      capturedAt: new Date().toISOString(),
      env,
      // Newest first (same order as the HUD). ms = duration; detail = phase breakdown.
      entries: entries.map((entry) => ({ label: entry.label, ms: entry.ms, detail: entry.detail ?? null })),
    },
    null,
    2,
  );
}

/** Subscribe to changes (entries added or enabled toggled). Returns an unsubscribe fn. */
export function subscribePerf(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
