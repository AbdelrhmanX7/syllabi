/**
 * Leaving a notebook: go right away, send the page after.
 *
 * The board saves the page on the tablet before it asks to leave (that save is what keeps the ink). Sending it
 * to the server can take seconds on a slow link, so it runs after the screen has changed, not before.
 *
 * One gate per open board. It lets one leave through at a time, and once the board has closed (or moved
 * to another page) nothing that was still waiting can navigate: a late «back» from the old notebook must
 * never close the next one.
 */

export interface LeaveGate {
  /** Starts a leave. False while one is already under way, or once the board has closed. */
  begin(): boolean;
  /** Whether this board is still the one on screen (a late callback must not act after it closed). */
  isCurrent(): boolean;
  /** Lets a new leave start (the screen did not change after all). */
  release(): void;
  /** The board closed or moved to another page: every later leave or callback is ignored. */
  dispose(): void;
}

export function createLeaveGate(): LeaveGate {
  let leaving = false;
  let disposed = false;

  return {
    begin() {
      if (leaving || disposed) return false;
      leaving = true;

      return true;
    },
    isCurrent: () => !disposed,
    release() {
      leaving = false;
    },
    dispose() {
      disposed = true;
    },
  };
}

export interface LeaveBoardSteps {
  gate: LeaveGate;
  /** Must finish before leaving, but never waits longer than `waitCapMs` (a live page's last changes). */
  mustFinish?: () => Promise<unknown>;
  waitCapMs?: number;
  /** Changes the screen. */
  navigate: () => void;
  /** Runs after the screen changed (the server upload). Errors are swallowed: the page is saved locally. */
  afterLeave?: () => Promise<unknown> | void;
  /** If the board is somehow still on screen this long after navigating, taps work again. */
  releaseAfterMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export type LeaveResult = 'left' | 'busy' | 'stale';

/** Leave once: repeat taps return 'busy', a board that already closed returns 'stale' and does nothing. */
export async function leaveBoard({
  gate,
  mustFinish,
  waitCapMs = 1500,
  navigate,
  afterLeave,
  releaseAfterMs = 2500,
  setTimer = (fn, ms) => setTimeout(fn, ms),
}: LeaveBoardSteps): Promise<LeaveResult> {
  if (!gate.begin()) return 'busy';

  if (mustFinish) {
    await Promise.race([
      mustFinish().catch(() => undefined),
      new Promise<void>((resolve) => setTimer(resolve, waitCapMs)),
    ]);
  }

  if (!gate.isCurrent()) return 'stale';
  navigate();
  setTimer(() => {
    if (gate.isCurrent()) gate.release();
  }, releaseAfterMs);

  if (afterLeave) {
    try {
      void Promise.resolve(afterLeave()).catch(() => undefined);
    } catch {
      // the page is saved on the tablet; it goes up on the next open
    }
  }

  return 'left';
}
