/**
 * Quiet-idle scheduler for heavy off-input work (canvas serialisation, undo snapshots).
 *
 * `requestIdleCallback` alone is the wrong tool for a whiteboard: the browser reports "idle" in the
 * first frame that has a few spare milliseconds — which, for a teacher writing quickly, is the frame
 * BETWEEN two pen samples of the NEXT stroke. A 100–300 ms `toJSON()` of a page with hundreds of
 * strokes then lands right under the pen, and on an integrated GPU the stroke comes out as a jagged
 * polyline because every sample that arrived during the block is gone (2026-09-13, ViewSonic).
 *
 * This helper keeps rIC for the "yield to paint" property but adds what rIC cannot know: whether a
 * contact is on the glass and how long input has been quiet. Rules, in order:
 *
 *  1. A contact is down → never run. Re-check after `quietMs`.
 *  2. Input arrived less than `quietMs` ago → wait for the quiet window to open.
 *  3. Deferred for longer than `maxDeferMs` (a writer who never pauses) → run at the next lift,
 *     without waiting for the quiet window, so autosave/undo are never starved indefinitely.
 *
 * `reschedule()` replaces the pending callback in place (latest wins) and keeps the ORIGINAL
 * schedule time, so a stroke every 500 ms cannot push the ceiling out forever.
 */

export interface QuietIdleTimers {
  now: () => number;
  /** `requestIdleCallback`-like. Absent → the first arm uses `setTimeout(fallbackDelayMs)`. */
  requestIdle?: (fn: () => void) => number;
  cancelIdle?: (id: number) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

export interface QuietIdleOptions {
  /** `true` while a pen/touch/mouse contact is down. The work never runs while this is true. */
  isBusy: () => boolean;
  /** Milliseconds since the last input event (Infinity when there has been none). */
  msSinceInput: () => number;
  /** Input must have been quiet for this long before the work runs. Default 700 ms. */
  quietMs?: number;
  /** After this much continuous deferral the work runs at the next lift regardless. Default 6 s. */
  maxDeferMs?: number;
  /** Delay for the first arm when `requestIdle` is unavailable. Default = `quietMs`. */
  fallbackDelayMs?: number;
  /** `timeout` handed to `requestIdleCallback` so a saturated main thread still yields a slot. */
  idleTimeoutMs?: number;
  /** Injectable clock/timers (tests). Defaults to the window's. */
  timers?: QuietIdleTimers;
}

export interface QuietIdleHandle {
  /** Stop a pending run for good. */
  cancel: () => void;
  /** Replace the pending callback (latest wins). Re-arms if the previous run already happened. */
  reschedule: (run: () => void) => void;
  /** Whether a run is still owed. */
  isPending: () => boolean;
}

const DEFAULT_QUIET_MS = 700;
const DEFAULT_MAX_DEFER_MS = 6_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2_000;
/** Shortest re-arm so a `msSinceInput` of 699 does not spin. */
const MIN_REARM_MS = 50;

function windowTimers(idleTimeoutMs: number): QuietIdleTimers {
  const hasIdle = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function';

  return {
    cancelIdle: hasIdle ? (id) => window.cancelIdleCallback(id) : undefined,
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now(),
    requestIdle: hasIdle ? (fn) => window.requestIdleCallback(() => fn(), { timeout: idleTimeoutMs }) : undefined,
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  };
}

/**
 * Schedule `run` for the next quiet idle moment. See the module header for the rules.
 */
export function scheduleQuietIdleWork(run: () => void, options: QuietIdleOptions): QuietIdleHandle {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const maxDeferMs = options.maxDeferMs ?? DEFAULT_MAX_DEFER_MS;
  const fallbackDelayMs = options.fallbackDelayMs ?? quietMs;
  const timers = options.timers ?? windowTimers(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);

  let callback = run;
  let pending: { kind: 'idle' | 'timeout'; id: number } | null = null;
  let firstScheduledAt = timers.now();
  let cancelled = false;

  const clearPending = (): void => {
    if (!pending) {
      return;
    }

    if (pending.kind === 'idle') {
      timers.cancelIdle?.(pending.id);
    } else {
      timers.clearTimeout(pending.id);
    }

    pending = null;
  };

  const armTimeout = (ms: number): void => {
    pending = { id: timers.setTimeout(fire, ms), kind: 'timeout' };
  };

  const armFirst = (): void => {
    if (timers.requestIdle) {
      pending = { id: timers.requestIdle(fire), kind: 'idle' };

      return;
    }

    armTimeout(fallbackDelayMs);
  };

  function fire(): void {
    pending = null;

    if (cancelled) {
      return;
    }

    // Rule 1 — never under the pen, ceiling or not.
    if (options.isBusy()) {
      armTimeout(quietMs);

      return;
    }

    const sinceInput = options.msSinceInput();
    const deferredFor = timers.now() - firstScheduledAt;

    // Rule 2 — wait for the quiet window, unless Rule 3's ceiling has passed.
    if (sinceInput < quietMs && deferredFor < maxDeferMs) {
      armTimeout(Math.max(MIN_REARM_MS, quietMs - sinceInput));

      return;
    }

    const toRun = callback;

    firstScheduledAt = timers.now();
    toRun();
  }

  armFirst();

  return {
    cancel: () => {
      cancelled = true;
      clearPending();
    },
    isPending: () => pending !== null,
    reschedule: (next) => {
      callback = next;
      cancelled = false;

      if (pending === null) {
        firstScheduledAt = timers.now();
        armFirst();
      }
    },
  };
}
