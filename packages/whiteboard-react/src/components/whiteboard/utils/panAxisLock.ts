/**
 * Axis lock for finger pans (`WhiteboardEditor.verticalNotebook`): a pan's first few px decide its
 * axis, and for the rest of that gesture (its fling included) movement on the other axis is dropped —
 * so scrolling down a notebook with a slightly diagonal finger never drifts sideways, even zoomed in.
 *
 * Until the travel reaches {@link PAN_AXIS_DECIDE_PX} the deltas are held back, then released along
 * the decided axis: nothing off-axis is ever applied. A gesture that is neither mostly vertical nor
 * mostly horizontal stays free. Pure; the state object is mutated in place, one per gesture.
 */

export type PanAxis = 'x' | 'y' | 'free';

export interface PanAxisLockState {
  axis: PanAxis | null;
  heldX: number;
  heldY: number;
}

/** Travel (CSS px) after which the axis is decided. */
export const PAN_AXIS_DECIDE_PX = 10;
/** Off-axis ÷ on-axis travel at or below which a pan locks (≈ 31° either side of the axis). */
export const PAN_AXIS_LOCK_RATIO = 0.6;

export function createPanAxisLock(): PanAxisLockState {
  return { axis: null, heldX: 0, heldY: 0 };
}

export function decidePanAxis(travelX: number, travelY: number): PanAxis {
  const x = Math.abs(travelX);
  const y = Math.abs(travelY);

  if (x <= y * PAN_AXIS_LOCK_RATIO) return 'y';
  if (y <= x * PAN_AXIS_LOCK_RATIO) return 'x';

  return 'free';
}

/** The part of a pan delta to apply under the lock. */
export function filterPanDelta(state: PanAxisLockState, dx: number, dy: number): { dx: number; dy: number } {
  if (state.axis === null) {
    state.heldX += dx;
    state.heldY += dy;

    if (Math.hypot(state.heldX, state.heldY) < PAN_AXIS_DECIDE_PX) return { dx: 0, dy: 0 };

    state.axis = decidePanAxis(state.heldX, state.heldY);
    dx = state.heldX;
    dy = state.heldY;
    state.heldX = 0;
    state.heldY = 0;
  }

  if (state.axis === 'y') return { dx: 0, dy };
  if (state.axis === 'x') return { dx, dy: 0 };

  return { dx, dy };
}
