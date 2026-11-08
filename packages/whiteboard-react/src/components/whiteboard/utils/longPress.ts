/**
 * «Hold still in one spot» detection for the board's Paste menu, kept free of the DOM so it can be tested.
 *
 * One pointer goes down and stays within `slopPx` of where it landed for `delayMs` → `onFire`. Moving
 * further first, lifting first, or a second pointer landing (a pinch) cancels it. After it fired, moving
 * past the slop means the person is drawing after all → `onMovedAfterFire` (the menu goes away and the
 * stroke stays).
 */

export interface LongPressScheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LongPressOptions<T> {
  delayMs: number;
  slopPx: number;
  onFire: (press: { x: number; y: number; data: T }) => void;
  onMovedAfterFire?: () => void;
  scheduler?: LongPressScheduler;
}

export interface LongPressEnd {
  /** The hold fired for this pointer… */
  fired: boolean;
  /** …and the pointer then moved past the slop (a real stroke). */
  movedAfterFire: boolean;
}

const defaultScheduler: LongPressScheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createLongPress<T>({ delayMs, slopPx, onFire, onMovedAfterFire, scheduler = defaultScheduler }: LongPressOptions<T>) {
  const down = new Set<number>();
  let press: { id: number; x: number; y: number; data: T; fired: boolean; moved: boolean } | null = null;
  let timer: unknown = null;

  const stopTimer = () => {
    if (timer !== null) scheduler.clear(timer);
    timer = null;
  };

  return {
    /** A pointer went down. `track: false` counts it (for the second-finger rule) without starting a hold. */
    down(id: number, x: number, y: number, data: T, track = true) {
      down.add(id);
      stopTimer();

      if (down.size !== 1 || !track) {
        if (press && !press.fired) press = null;

        return;
      }

      press = { id, x, y, data, fired: false, moved: false };
      timer = scheduler.set(() => {
        timer = null;

        if (!press || press.id !== id) return;

        press.fired = true;
        onFire({ x: press.x, y: press.y, data: press.data });
      }, delayMs);
    },

    move(id: number, x: number, y: number) {
      if (!press || press.id !== id || press.moved) return;
      if (Math.hypot(x - press.x, y - press.y) <= slopPx) return;

      if (press.fired) {
        press.moved = true;
        onMovedAfterFire?.();
      } else {
        stopTimer();
        press = null;
      }
    },

    up(id: number): LongPressEnd {
      down.delete(id);

      if (!press || press.id !== id) return { fired: false, movedAfterFire: false };

      const end = { fired: press.fired, movedAfterFire: press.moved };

      stopTimer();
      press = null;

      return end;
    },

    cancel() {
      stopTimer();
      press = null;
      down.clear();
    },
  };
}
