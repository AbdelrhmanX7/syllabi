/**
 * The `full-scroll` toolbar row (Toolbar `layout`) scrolls sideways when its tools do not fit. Which
 * ends still hide tools decides which edge shows a fade hint.
 *
 * `scrollLeft` is direction-agnostic here: an RTL row reports it as zero-or-negative in Chromium, so
 * the distance scrolled from the START edge is its absolute value either way.
 */
export interface ScrollEdges {
  /** Tools are hidden past the inline-start edge. */
  start: boolean;
  /** Tools are hidden past the inline-end edge. */
  end: boolean;
}

/** Sub-pixel slack: a fractional scroll width must not leave a fade on a row that fits. */
const EDGE_SLACK_PX = 1;

export function scrollEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): ScrollEdges {
  const hidden = Math.max(0, scrollWidth - clientWidth);
  if (hidden <= EDGE_SLACK_PX) return { start: false, end: false };
  const fromStart = Math.abs(scrollLeft);

  return { start: fromStart > EDGE_SLACK_PX, end: fromStart < hidden - EDGE_SLACK_PX };
}

/**
 * How far a pen / mouse press must travel sideways before it becomes a drag-scroll of the row instead
 * of a tap on the button under it.
 */
export const DRAG_SCROLL_THRESHOLD_PX = 6;

export interface DragScrollMove {
  /** The row's new `scrollLeft`. */
  scrollLeft: number;
  /** True on the move that crossed the threshold: the press under the pointer must be cancelled. */
  started: boolean;
}

export interface DragScroll {
  /** A press began on the row (pen / mouse only — touch pans the row natively). */
  down(pointerId: number, clientX: number, scrollLeft: number): void;
  /** The pointer moved: the row's next `scrollLeft`, or null while still a tap (or another pointer). */
  move(pointerId: number, clientX: number): DragScrollMove | null;
  /** The press ended. True when it was a drag, so the click that follows must be swallowed. */
  up(pointerId: number): boolean;
  /** Dropped (pointercancel, unmount). */
  cancel(): void;
  readonly isDragging: boolean;
}

/**
 * Drag-to-scroll for the `full-scroll` toolbar row. Android WebView does not pan a scroller on an
 * S Pen drag (and a mouse never does), so the row scrolls itself for those pointers: below the
 * threshold the press stays a tap; past it the content follows the pointer (`scrollLeft` is the
 * physical x offset in LTR and RTL alike, so one formula serves both).
 */
export function createDragScroll(threshold: number = DRAG_SCROLL_THRESHOLD_PX): DragScroll {
  let press: { pointerId: number; startX: number; startScroll: number; dragging: boolean } | null = null;

  return {
    down(pointerId, clientX, scrollLeft) {
      press = { dragging: false, pointerId, startScroll: scrollLeft, startX: clientX };
    },
    move(pointerId, clientX) {
      if (!press || press.pointerId !== pointerId) return null;
      const dx = clientX - press.startX;
      let started = false;

      if (!press.dragging) {
        if (Math.abs(dx) < threshold) return null;
        press.dragging = true;
        started = true;
      }

      return { scrollLeft: press.startScroll - dx, started };
    },
    up(pointerId) {
      if (!press || press.pointerId !== pointerId) return false;
      const dragged = press.dragging;

      press = null;

      return dragged;
    },
    cancel() {
      press = null;
    },
    get isDragging() {
      return press?.dragging ?? false;
    },
  };
}
