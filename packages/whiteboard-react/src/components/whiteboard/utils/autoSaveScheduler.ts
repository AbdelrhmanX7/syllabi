/**
 * When the editor's autosave is allowed to touch IndexedDB.
 *
 * MEASURED, not reviewed (production build, Chromium, CDP-dispatched pen input, rAF + longtask +
 * event-timing observers, `Profiler` at 150 µs, full `devtools.timeline` trace): in a PRODUCTION
 * build the React cost of drawing largely evaporates — the `jsxDEV`/`createElement` storm three
 * code reviews chased is a dev-build artifact — and the longest busy runs in EVERY prod profile are
 * this autosave's IndexedDB traffic: `put @ :0` + `onsuccess` + `get result`, on a ~2-4 s cadence
 * that ONLY appears while drawing. The burst scales with page content: 50-65 ms at 7 ink objects,
 * 77-93 ms at 707 (6× CPU throttle; ≈8-15 ms at 1× on a fast desktop — and the teacher's panel is
 * far slower than the box that measured this). Landing that on a live stroke is the dominant
 * production stall.
 *
 * The fix is NOT a longer interval and NOT dropping writes — the teacher must never lose work. It is
 * to spend the write in a gap the teacher is already taking. Handwriting is full of them: every
 * pen-up between letters and words is 100+ ms with no pointer samples at all. So:
 *
 *   - a save still becomes DUE on the same `intervalMs` cadence as before;
 *   - when it comes due mid-stroke we re-probe every `strokeGapMs` instead of writing, so the write
 *     lands within one probe of the nib lifting — in normal handwriting SOONER than the old fixed
 *     interval would have come round again;
 *   - a stroke that never breaks (a long underline, a big circle) hits `maxDeferralMs` and takes the
 *     hitch anyway, which is exactly the old behaviour.
 *
 * DATA SAFETY. The worst-case unsaved-work bound moves from `intervalMs` to
 * `intervalMs + maxDeferralMs` (plus the duration of the write itself), and only for the one case
 * that reaches the ceiling: an unbroken stroke. This app has a documented history of data loss, so
 * that widening is deliberate, bounded and stated rather than open-ended — a "defer until idle" with
 * no ceiling would let a teacher who writes continuously for a minute lose the minute. Nothing here
 * touches the IMMEDIATE flush paths (`visibilitychange`, `beforeunload`, the back button, the
 * desktop shell's close hook, the error-boundary flush): those still write the instant they fire,
 * and `lastDurableSaveAt` lets their writes reset this scheduler's ceiling too.
 *
 * Extracted from WhiteboardEditor because the component has no other seam: "does a save land
 * mid-stroke?" is a timing question, not a rendering one, and this way it is answerable without a
 * canvas, a fabric instance or a jsdom mount.
 */

/** Opaque timer handle — `setTimeout`'s return type differs between DOM and node typings. */
import { perfSpan } from './perfSpan';

export type AutoSaveTimerHandle = unknown;

/** The re-arming cadence on which an edit becomes due for a durable write. Unchanged from before. */
export const AUTO_SAVE_INTERVAL_MS = 2000;

/**
 * How long with no pointer/touch/wheel sample counts as "the nib is off the glass".
 *
 * A pen reports at 120-240 Hz while in contact (≈4-8 ms between samples) and coalesced moves are
 * flushed at least once per frame (≈16 ms), so 140 ms cannot be mistaken for a sampling hiccup —
 * while still being short enough that the write slots into the gap between two letters.
 */
export const AUTO_SAVE_STROKE_GAP_MS = 140;

/** Ceiling on how long deferral may postpone a due write. See the data-safety note above. */
export const AUTO_SAVE_MAX_DEFERRAL_MS = 2000;

/**
 * The contract this module exists to keep: an abrupt quit (crash, kill, power loss) can cost at most
 * this much drawing, plus the duration of the one write that was in flight. Exported so the bound is
 * asserted by a test rather than only claimed in a comment.
 */
export const AUTO_SAVE_WORST_CASE_UNSAVED_MS = AUTO_SAVE_INTERVAL_MS + AUTO_SAVE_MAX_DEFERRAL_MS;

export interface AutoSaveSchedulerOptions {
  /** True while edits exist that have not reached IndexedDB yet (the editor's `needsPersistRef`). */
  needsPersist: () => boolean;
  /** Milliseconds since the last pointer/touch/wheel sample; `Infinity` before any input. */
  millisecondsSinceLastInput: () => number;
  /**
   * Wall-clock of the last durable write from ANY path, not just this scheduler's — so a back-button
   * or visibility flush resets the deferral ceiling instead of leaving it counting from a save that
   * already happened. `0` means "none yet this session", and the scheduler substitutes its own start
   * time so a board's very first stroke is deferrable like every other.
   */
  lastDurableSaveAt: () => number;
  /** Runs one durable write. Expected to resolve even on failure (the editor swallows its errors). */
  persist: () => Promise<void>;
  intervalMs?: number;
  strokeGapMs?: number;
  maxDeferralMs?: number;
  /** Injected clock/timers — the test drives these; production takes the defaults. */
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => AutoSaveTimerHandle;
  clearTimer?: (handle: AutoSaveTimerHandle) => void;
}

export interface AutoSaveScheduler {
  /** Cancel the pending probe. A write already in flight is left to finish — never abandoned. */
  stop: () => void;
}

export function startAutoSaveScheduler(options: AutoSaveSchedulerOptions): AutoSaveScheduler {
  const {
    needsPersist,
    millisecondsSinceLastInput,
    lastDurableSaveAt,
    persist,
    intervalMs = AUTO_SAVE_INTERVAL_MS,
    strokeGapMs = AUTO_SAVE_STROKE_GAP_MS,
    maxDeferralMs = AUTO_SAVE_MAX_DEFERRAL_MS,
    now = () => Date.now(),
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  const startedAt = now();

  let handle: AutoSaveTimerHandle | null = null;
  let stopped = false;
  // True from the moment `persist()` is called until it settles. The old `setInterval` could stack a
  // second write on top of a slow one (on a weak panel a 707-object write outlasts its own 2 s tick);
  // arming the next probe off the settle instead of off a fixed interval makes that impossible.
  let saving = false;

  // Function declarations, not consts: `arm` and `tick` are mutually recursive and hoisting keeps
  // them readable in call order without a forward `let`.
  function arm(delayMs: number): void {
    if (stopped || handle !== null) {
      return;
    }

    handle = setTimer(tick, Math.max(delayMs, 0));
  }

  function settle(): void {
    saving = false;
    arm(intervalMs);
  }

  function tick(): void {
    handle = null;

    if (stopped) {
      return;
    }

    // Should be unreachable: a write is only started from here, and only with no probe pending. But
    // a scheduler that returns into nothing stops saving forever, which is a data-loss bug — so
    // re-probe rather than fall off the end.
    if (saving) {
      arm(strokeGapMs);

      return;
    }

    if (!needsPersist()) {
      arm(intervalMs);

      return;
    }

    const sinceInput = millisecondsSinceLastInput();
    // `|| startedAt` covers the "nothing saved yet this session" sentinel — see the option's docs.
    const sinceDurableSave = now() - (lastDurableSaveAt() || startedAt);

    // A stroke is still in flight AND the oldest unsaved edit is still inside the ceiling: come back
    // the moment the nib could have lifted instead of writing through the stroke.
    if (sinceInput < strokeGapMs && sinceDurableSave < intervalMs + maxDeferralMs) {
      arm(strokeGapMs - sinceInput);

      return;
    }

    saving = true;
    // `then(settle, settle)`: a rejected persist must re-arm exactly like a resolved one, or one
    // failed write silently ends autosave for the rest of the session.
    // `autosave:write` in the renderer perf trace: the durable write's wall time, gap-slotted or ceiling-forced.
    void perfSpan('autosave:write', persist).then(settle, settle);
  }

  arm(intervalMs);

  return {
    stop(): void {
      stopped = true;

      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
    },
  };
}
