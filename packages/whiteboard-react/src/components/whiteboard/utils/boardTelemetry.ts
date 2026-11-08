/**
 * Board telemetry seam — what a host's performance collector needs to know about the board, without
 * the package knowing where it goes (the Study app uploads it; the desktop shell ignores it).
 *
 * Two things cross this seam:
 * - the board CONTEXT (tool, page count, page, zoom, layout) — pushed by the editor when those change,
 *   which already re-renders the editor; the object count is read lazily through a getter only when a
 *   host asks (at a gesture's end), never per render or per frame;
 * - GESTURE edges (a pen/finger/mouse contact or a wheel burst on the board surface starting and
 *   ending) — the host counts frames between the two edges with its own rAF loop.
 *
 * Costs nothing while no host subscribes: every emit is one Set size check. Dependency-free on
 * purpose — hosts import it through the `@repo/whiteboard-react/telemetry` entry, which must not pull
 * fabric into the app shell.
 */

export type BoardLayout = 'paged' | 'continuous' | 'notebook';

export interface BoardTelemetryContext {
  /** Active tool id (`pen`, `select`, `eraser`, …). */
  tool: string;
  /** Number of pages in the document. */
  pages: number;
  /** Zero-based current page. */
  page: number;
  /** Canvas zoom (1 = 100%). */
  zoom: number;
  layout: BoardLayout;
  /** Objects on the canvas right now (read lazily). */
  objects?: number;
}

export type BoardGestureKind = 'pen' | 'touch' | 'pinch' | 'mouse' | 'wheel';

export interface BoardGestureEdge {
  phase: 'start' | 'end';
  /** The contact type — on `end` the final one (a one-finger drag that became a pinch ends `pinch`). */
  kind: BoardGestureKind;
  /** `performance.now()` of the edge. */
  at: number;
}

export type BoardGestureListener = (edge: BoardGestureEdge) => void;

type ObjectCounter = () => number;

let context: Omit<BoardTelemetryContext, 'objects'> | null = null;
let objectCounter: ObjectCounter | null = null;
const gestureListeners = new Set<BoardGestureListener>();

/** Whether any host listens — lets the editor skip attaching its DOM listeners' work. */
export function hasBoardTelemetryListeners(): boolean {
  return gestureListeners.size > 0;
}

/** Host side: be told every gesture edge. Returns the unsubscribe. */
export function subscribeBoardGestures(listener: BoardGestureListener): () => void {
  gestureListeners.add(listener);

  return () => {
    gestureListeners.delete(listener);
  };
}

/** Editor side: the board's current context (`null` when the board unmounts). */
export function publishBoardTelemetryContext(next: Omit<BoardTelemetryContext, 'objects'> | null): void {
  context = next;
}

/** Editor side: how to count the canvas objects on demand (`null` on unmount). */
export function setBoardObjectCounter(counter: ObjectCounter | null): void {
  objectCounter = counter;
}

/**
 * Host side: the board context right now; `null` when no board is open. `withObjects` (default) adds a
 * fresh object count — pass false on frequent paths (it copies the canvas object list).
 */
export function getBoardTelemetryContext(withObjects = true): BoardTelemetryContext | null {
  if (!context) return null;
  let objects: number | undefined;

  if (withObjects && objectCounter) {
    try {
      objects = objectCounter();
    } catch {
      objects = undefined;
    }
  }

  return objects === undefined ? { ...context } : { ...context, objects };
}

/** Editor side: one gesture edge. Never throws into input handling. */
export function emitBoardGesture(edge: BoardGestureEdge): void {
  if (gestureListeners.size === 0) return;
  const listeners: BoardGestureListener[] = [];

  gestureListeners.forEach((listener) => listeners.push(listener));

  for (let index = 0; index < listeners.length; index += 1) {
    try {
      listeners[index](edge);
    } catch {
      // Telemetry is never allowed to become the incident.
    }
  }
}

/** How long after the last contact lifts a gesture stays open, so a fling's frames are counted too. */
export const BOARD_GESTURE_TAIL_MS = 300;
/** A wheel burst ends this long after its last wheel event. */
export const BOARD_WHEEL_IDLE_MS = 200;
/**
 * A gesture whose contacts have been silent this long is closed although no up arrived — the
 * WebViews here can drop a pointer stream with neither pointerup nor pointercancel (same ceiling as
 * inputActivity's CONTACT_SILENCE_CEILING_MS). Without it one lost lift keeps a gesture open forever.
 */
export const BOARD_GESTURE_SILENCE_MS = 8_000;

function readNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Track gestures on a board root element: a contact landing on one of its `<canvas>` elements opens a
 * gesture, the last contact lifting (+ {@link BOARD_GESTURE_TAIL_MS}) closes it; a wheel burst is a
 * gesture of its own. Listeners are passive + capture, so they never delay input. Returns the cleanup.
 */
export function trackBoardGestures(root: HTMLElement): () => void {
  const down = new Map<number, string>();
  let open = false;
  let kind: BoardGestureKind = 'touch';
  let lastSeen = 0;
  let tailTimer: ReturnType<typeof setTimeout> | null = null;
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const clearTail = () => {
    if (tailTimer !== null) clearTimeout(tailTimer);
    tailTimer = null;
  };
  const close = () => {
    clearTail();
    if (watchdog !== null) clearInterval(watchdog);
    watchdog = null;
    if (!open) return;
    open = false;
    emitBoardGesture({ phase: 'end', kind, at: readNow() });
  };
  /** Lost lift / window blur / page hidden: forget every contact and end the gesture now. */
  const forceClose = () => {
    down.clear();
    if (wheelTimer !== null) clearTimeout(wheelTimer);
    wheelTimer = null;
    close();
  };
  const openGesture = (next: BoardGestureKind) => {
    open = true;
    kind = next;
    lastSeen = readNow();
    emitBoardGesture({ phase: 'start', kind, at: lastSeen });
    if (watchdog === null) {
      watchdog = setInterval(() => {
        if (open && readNow() - lastSeen > BOARD_GESTURE_SILENCE_MS) forceClose();
      }, 1_000);
    }
  };
  const kindOf = (pointerType: string): BoardGestureKind => {
    if (pointerType === 'pen') return 'pen';
    if (pointerType === 'mouse') return 'mouse';

    return 'touch';
  };

  const onDown = (event: PointerEvent) => {
    if (gestureListeners.size === 0) return;
    if (typeof HTMLCanvasElement === 'undefined' || !(event.target instanceof HTMLCanvasElement)) return;
    down.set(event.pointerId, event.pointerType);
    clearTail();

    if (!open) {
      openGesture(kindOf(event.pointerType));
    } else {
      lastSeen = readNow();
      if (event.pointerType === 'touch' && kind === 'touch') {
        let touches = 0;

        down.forEach((type) => {
          if (type === 'touch') touches += 1;
        });
        if (touches >= 2) kind = 'pinch';
      }
    }
  };
  const onMove = (event: PointerEvent) => {
    if (open && down.has(event.pointerId)) lastSeen = readNow();
  };
  const onUp = (event: PointerEvent) => {
    if (!down.delete(event.pointerId) || down.size > 0 || !open) return;
    clearTail();
    tailTimer = setTimeout(close, BOARD_GESTURE_TAIL_MS);
  };
  const onWheel = (event: WheelEvent) => {
    if (gestureListeners.size === 0) return;
    if (typeof HTMLCanvasElement === 'undefined' || !(event.target instanceof HTMLCanvasElement)) return;

    if (!open) openGesture('wheel');
    if (kind !== 'wheel') return;
    lastSeen = readNow();
    if (wheelTimer !== null) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      if (kind === 'wheel') close();
    }, BOARD_WHEEL_IDLE_MS);
  };
  const onHidden = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') forceClose();
  };

  const options: AddEventListenerOptions = { capture: true, passive: true };
  // Lifts are heard on the window too: a contact released outside the board root still ends.
  const lifts: EventTarget = typeof window !== 'undefined' ? window : root;

  root.addEventListener('pointerdown', onDown, options);
  root.addEventListener('pointermove', onMove, options);
  lifts.addEventListener('pointerup', onUp as EventListener, options);
  lifts.addEventListener('pointercancel', onUp as EventListener, options);
  root.addEventListener('wheel', onWheel, options);
  if (typeof window !== 'undefined') window.addEventListener('blur', forceClose);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden);

  return () => {
    root.removeEventListener('pointerdown', onDown, true);
    root.removeEventListener('pointermove', onMove, true);
    lifts.removeEventListener('pointerup', onUp as EventListener, true);
    lifts.removeEventListener('pointercancel', onUp as EventListener, true);
    root.removeEventListener('wheel', onWheel, true);
    if (typeof window !== 'undefined') window.removeEventListener('blur', forceClose);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHidden);
    forceClose();
  };
}
