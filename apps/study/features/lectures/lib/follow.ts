// Transcript follow-along. The list keeps the playing cue in view by scrolling ITSELF only, and stops
// while the student is busy: a touch / wheel / drag on the list pauses it until they tap «Follow» (or a
// cue, which seeks there and follows again); a pen down anywhere holds it until the pen has been up a
// moment, so nothing on screen moves under a stroke.

export interface FollowState {
  mode: 'follow' | 'paused';
  penDown: boolean;
  /** No auto-scroll before this (ms, the caller's clock): the pen just lifted. */
  holdUntil: number;
}

export type FollowEvent =
  | { type: 'user-scroll' }
  | { type: 'resume' }
  | { type: 'seek' }
  | { type: 'pen-down' }
  | { type: 'pen-up'; now: number };

/** After the pen lifts, wait this long before scrolling: the next stroke usually follows at once. */
export const PEN_SETTLE_MS = 1500;

export const initialFollow: FollowState = { mode: 'follow', penDown: false, holdUntil: 0 };

export function followReducer(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case 'user-scroll':
      return state.mode === 'paused' ? state : { ...state, mode: 'paused' };
    case 'resume':
    case 'seek':
      return state.mode === 'follow' ? state : { ...state, mode: 'follow' };
    case 'pen-down':
      return state.penDown ? state : { ...state, penDown: true };
    case 'pen-up':
      return { ...state, penDown: false, holdUntil: event.now + PEN_SETTLE_MS };
  }
}

/** Whether the list may scroll to the active cue now. */
export function mayAutoScroll(state: FollowState, now: number): boolean {
  return state.mode === 'follow' && !state.penDown && now >= state.holdUntil;
}

/**
 * The list's scrollTop that centres a row (`rowTop` from the list's content top), clamped to the
 * scrollable range. Null when the row is already comfortably inside the middle band — no motion.
 */
export function centeredScrollTop(
  rowTop: number,
  rowHeight: number,
  viewHeight: number,
  scrollHeight: number,
  currentTop: number,
): number | null {
  const rowCenter = rowTop + rowHeight / 2 - currentTop;

  // Already in the middle band: leave it, so each new cue does not nudge the list.
  if (rowCenter >= viewHeight * 0.3 && rowCenter <= viewHeight * 0.6) return null;
  const max = Math.max(0, scrollHeight - viewHeight);
  const target = Math.min(max, Math.max(0, Math.round(rowTop + rowHeight / 2 - viewHeight / 2)));

  return target === Math.round(currentTop) ? null : target;
}
