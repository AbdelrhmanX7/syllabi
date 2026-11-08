/**
 * Global "is the teacher interacting right now?" tracker for background work gating.
 *
 * Background jobs (PDF page pre-warming above all) contend with live pen input: a PDFium render
 * pegs a CPU core and every warm response used to decode a huge image on the WebView main thread —
 * on the weak board CPUs that read as the pen stuttering mid-stroke. Any background work that can
 * wait MUST wait while input is active; this module is the shared, dependency-free signal for that.
 *
 * Listeners are passive + capture-phase on `window`, installed once per page lifetime.
 */

let lastInputAt = 0;
let installed = false;

/**
 * Contacts currently on the glass, by pointerId. `lastInputAt` alone misses one real case: a pen
 * (or a resting palm) held perfectly still. No samples arrive, the clock says "idle", and a
 * full-resolution PDFium render starts underneath a contact that is about to move again. A contact
 * is "interacting" until it lifts, whatever the clock says.
 */
const downPointers = new Set<number>();

/** JSDOM and some synthetic events carry no pointerId; one shared bucket keeps them countable. */
const ANONYMOUS_POINTER_ID = -1;

/**
 * A contact silent for longer than this is treated as lifted even though no pointerup arrived.
 *
 * WebView2 can drop a pointer stream with neither pointerup, pointercancel nor a window blur. Without
 * a ceiling that one contact would pin {@link isPointerDown} forever: no warm render ever again, and
 * every other idle wait (autosave included) wedged with it. 8 s mirrors the stroke-in-progress
 * ceiling the background redraw policy uses: no real stroke goes that long without a single sample.
 */
export const CONTACT_SILENCE_CEILING_MS = 8_000;

function pointerIdOf(event: Event): number {
  const id = (event as Partial<PointerEvent>).pointerId;

  return typeof id === 'number' ? id : ANONYMOUS_POINTER_ID;
}

function markPointerDown(event: Event): void {
  downPointers.add(pointerIdOf(event));
  markActivity();
}

function markPointerUp(event: Event): void {
  downPointers.delete(pointerIdOf(event));
}

/** The up event is not coming once the window loses the pointer: drop every contact. */
function releaseAllPointers(): void {
  downPointers.clear();
}

/**
 * Everyone who wants to be told the INSTANT input resumes, rather than discovering it on the next
 * 500 ms poll. Waiting for a poll is fine before starting work; it is NOT fine once a background
 * job is already running — see {@link createInputActivityAbortSignal}.
 */
const activityListeners = new Set<() => void>();

function markActivity(): void {
  lastInputAt = Date.now();

  // Copy before iterating: a listener that unsubscribes itself (the abort path does exactly that)
  // would otherwise mutate the Set mid-iteration. `forEach` on the copy keeps this ES5-target-safe
  // (the package compiles without downlevelIteration).
  const listeners: Array<() => void> = [];

  activityListeners.forEach((listener) => listeners.push(listener));

  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken listener must never break input tracking for everyone else.
    }
  }
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') {
    return;
  }

  installed = true;

  // pointerdown/pointermove cover pen, touch and mouse (the whiteboard is pointer-events based);
  // wheel covers zoom scrolling. Passive + capture so nothing downstream is affected.
  for (const type of ['pointermove', 'touchstart', 'wheel']) {
    window.addEventListener(type, markActivity, { capture: true, passive: true });
  }

  // Contact tracking: down adds (and counts as activity), up/cancel removes, losing the window
  // removes everything — a pointerup delivered to another window never reaches us.
  window.addEventListener('pointerdown', markPointerDown, { capture: true, passive: true });
  window.addEventListener('pointerup', markPointerUp, { capture: true, passive: true });
  window.addEventListener('pointercancel', markPointerUp, { capture: true, passive: true });
  window.addEventListener('blur', releaseAllPointers);
}

/**
 * Whether any pen/touch/mouse contact is currently down, moving or not — bounded by
 * {@link CONTACT_SILENCE_CEILING_MS}: a contact with no sample for that long is forgotten.
 */
export function isPointerDown(): boolean {
  ensureInstalled();

  if (downPointers.size > 0 && millisecondsSinceLastInput() > CONTACT_SILENCE_CEILING_MS) {
    releaseAllPointers();
  }

  return downPointers.size > 0;
}

/**
 * A contact the page learns about from OUTSIDE the DOM event stream.
 *
 * Samsung's WebView swallows a stylus put down with its side button already held: no pointerdown, no
 * pointermove — the Android shell forwards that contact itself (`wb-native-pen`) and the page drives the
 * eraser from it. To the window listeners above that whole erase stroke was silence, so every quiet-idle
 * job (the page snapshot + undo checkpoint, ink bake, overscan backdrop, PDF warm renders) ran UNDER the
 * pen, re-armed by each erased stroke: the button eraser lagged on a full page and was smooth on an empty
 * one. The caller reports the contact's phases here so it counts exactly like a DOM pointer.
 */
export const EXTERNAL_CONTACT_POINTER_ID = -2;

export function noteExternalContact(phase: 'down' | 'move' | 'up', pointerId = EXTERNAL_CONTACT_POINTER_ID): void {
  ensureInstalled();

  if (phase === 'up') {
    downPointers.delete(pointerId);

    return;
  }

  // A move re-asserts the contact too: its down may have been missed (the page loaded mid-stroke).
  downPointers.add(pointerId);
  markActivity();
}

/** Milliseconds since the last pointer/touch/wheel event (Infinity before any input). */
export function millisecondsSinceLastInput(): number {
  ensureInstalled();

  return lastInputAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastInputAt;
}

/**
 * Resolve once there has been no input for `idleMs` AND no contact is on the glass (polls every
 * `checkEveryMs`), or immediately when `isCancelled()` reports true — callers pass their
 * effect-cleanup flag so a page change never leaves a dangling wait.
 */
export function waitForInputIdle(idleMs: number, isCancelled: () => boolean, checkEveryMs = 500): Promise<void> {
  ensureInstalled();

  return new Promise((resolve) => {
    const check = () => {
      if (isCancelled() || (millisecondsSinceLastInput() >= idleMs && !isPointerDown())) {
        resolve();

        return;
      }

      window.setTimeout(check, checkEveryMs);
    };

    check();
  });
}

/**
 * Call `listener` on the NEXT pointer/touch/wheel event (and every one after). Returns an
 * unsubscribe function. Event-driven, unlike {@link waitForInputIdle}'s poll — a background job
 * that is already running has to yield on the first sample of a stroke, not up to 500 ms into it.
 */
export function onInputActivity(listener: () => void): () => void {
  ensureInstalled();
  activityListeners.add(listener);

  return () => {
    activityListeners.delete(listener);
  };
}

/**
 * An `AbortSignal` that fires the moment the teacher touches the board again.
 *
 * This is the PREEMPTION half of the "background work yields to live input" rule: waiting for idle
 * before starting is only half of it — a warm render issued during a pause must also be dropped the
 * instant a stroke begins, or the teacher writes through a full-resolution PDFium render + a
 * multi-MB protocol response. Pass the signal to `fetch`; always call `dispose()` in a `finally` so
 * the listener cannot outlive the job.
 *
 * NOTE (honest limit): aborting the fetch drops the RESPONSE — the native render that is already
 * running on the PDFium worker thread cannot be cancelled from here and still finishes (its bytes
 * land in the disk cache, so the work is not wasted). What this buys is that at most ONE warm
 * render can overlap a stroke instead of the whole remaining chain.
 */
export function createInputActivityAbortSignal(): InputActivityAbort {
  const controller = new AbortController();
  const unsubscribe = onInputActivity(() => {
    controller.abort();
  });

  return {
    abort: () => controller.abort(),
    dispose: unsubscribe,
    signal: controller.signal,
  };
}

export interface InputActivityAbort {
  /** Abort now, for a reason other than input (the owning effect was cleaned up). */
  abort: () => void;
  /** Remove the input listener. MUST be called once the job ends, or the listener leaks. */
  dispose: () => void;
  signal: AbortSignal;
}
