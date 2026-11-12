/**
 * Context-aware pen-button gestures — a pure state machine per learned button.
 *
 * The same physical button means three different things depending on where the pen is:
 *   - pressed and released while HOVERING                    → `short-hover`  (default: quick pen menu)
 *   - held while HOVERING past {@link PEN_BUTTON_LONG_PRESS_MS} → `long-hover`, fired AT the threshold;
 *     its release (or touching down) sends `long-hover-end` (the buddy's hold-to-talk stops there). ONLY when the button has a long-press action: with none (the default)
 *     there is no timer and a hover press opens the menu on release however long it was held.
 *   - held while the pen TOUCHES — pressed on the glass, or pressed in the air and then put down —
 *                                                           → `contact-start` … `contact-end`
 *     (default: eraser while held, previous nib on release). Touching down cancels a pending hover
 *     gesture: nothing hover-related fires for that press.
 *
 * The caller feeds edges (already de-duplicated by the dispatcher), pen contact starts, and a timer
 * tick at the long-press threshold; it acts on the returned effects. No timers or DOM here.
 */

export const PEN_BUTTON_LONG_PRESS_MS = 450;

export type PenButtonGestureState =
  | { phase: 'idle' }
  | { phase: 'hover-pressed'; at: number }
  | { phase: 'hover-long-fired' }
  | { phase: 'contact-held' };

export type PenButtonGestureEffect = 'short-hover' | 'long-hover' | 'long-hover-end' | 'contact-start' | 'contact-end';

export type PenButtonGestureInput =
  | { type: 'press'; contact: boolean; now: number }
  | { type: 'release'; now: number }
  | { type: 'contact-start'; now: number }
  | { type: 'tick'; now: number };

export const PEN_BUTTON_GESTURE_IDLE: PenButtonGestureState = { phase: 'idle' };

export interface PenButtonGestureStep {
  state: PenButtonGestureState;
  effects: PenButtonGestureEffect[];
  /** ms from `now` at which the caller should send a `tick`, or null for none. */
  tickIn: number | null;
}

export interface PenButtonGestureOptions {
  /** False when the long hover action is «Nothing»: no timer, every hover release is a short press. */
  longPress?: boolean;
  longPressMs?: number;
}

export function stepPenButtonGesture(
  state: PenButtonGestureState,
  input: PenButtonGestureInput,
  options: PenButtonGestureOptions = {},
): PenButtonGestureStep {
  const longPress = options.longPress !== false;
  const longPressMs = options.longPressMs ?? PEN_BUTTON_LONG_PRESS_MS;
  const stay = (): PenButtonGestureStep => ({ state, effects: [], tickIn: null });

  switch (input.type) {
    case 'press':
      // A press while one is already in progress is a twin / duplicate — the dispatcher should have
      // absorbed it; never restart a gesture from it.
      if (state.phase !== 'idle') return stay();

      if (input.contact) return { state: { phase: 'contact-held' }, effects: ['contact-start'], tickIn: null };

      return { state: { phase: 'hover-pressed', at: input.now }, effects: [], tickIn: longPress ? longPressMs : null };

    case 'tick':
      if (state.phase !== 'hover-pressed' || !longPress) return stay();

      if (input.now - state.at < longPressMs) {
        return { state, effects: [], tickIn: longPressMs - (input.now - state.at) };
      }

      return { state: { phase: 'hover-long-fired' }, effects: ['long-hover'], tickIn: null };

    case 'contact-start':
      if (state.phase === 'hover-pressed') return { state: { phase: 'contact-held' }, effects: ['contact-start'], tickIn: null };

      if (state.phase === 'hover-long-fired') {
        return { state: { phase: 'contact-held' }, effects: ['long-hover-end', 'contact-start'], tickIn: null };
      }

      return stay();

    case 'release':
      if (state.phase === 'hover-pressed') {
        // A late timer must not turn a long hold into a short press.
        const effects: PenButtonGestureEffect[] =
          longPress && input.now - state.at >= longPressMs ? ['long-hover', 'long-hover-end'] : ['short-hover'];

        return { state: PEN_BUTTON_GESTURE_IDLE, effects, tickIn: null };
      }

      if (state.phase === 'hover-long-fired') return { state: PEN_BUTTON_GESTURE_IDLE, effects: ['long-hover-end'], tickIn: null };

      if (state.phase === 'contact-held') {
        return { state: PEN_BUTTON_GESTURE_IDLE, effects: ['contact-end'], tickIn: null };
      }

      return stay();

    default:
      return stay();
  }
}
