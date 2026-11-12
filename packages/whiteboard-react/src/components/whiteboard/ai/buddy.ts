/**
 * The study buddy's door into the board: a floating helper the host app draws over the editor sends
 * a spoken (or typed) question here; the board's AI layer looks at the page, marks it up on a
 * temporary overlay (nothing is saved), and reports back. «Keep» turns the marks into real ink (one
 * undo step); «Clear» — or a new question, or the fade timer — takes them away.
 *
 * Everything goes through `window` CustomEvents, like ./commands — no editor instance needed, and
 * nothing happens when no board with a pen-plan service is mounted.
 */

/** Host → board. `origin` = where the pointer flies in from, in viewport (client) px. */
export type BoardBuddyRequest =
  /** `questionImage`: the question written by hand on the buddy's pad (then `question` may be empty). */
  /** `avoid`: a box (viewport px) the marks must stay out of — the buddy's own panel. */
  | { type: 'ask'; question: string; origin?: { x: number; y: number }; questionImage?: Blob; avoid?: { x: number; y: number; w: number; h: number } }
  | { type: 'keep' }
  | { type: 'clear' };

/** Board → host. */
export type BoardBuddyState =
  | { phase: 'reading' | 'planning' | 'drawing' }
  /** The turn finished: `marks` temporary marks are on screen (0 = it only answered). */
  /** `notes`: short notes the page had no room for. */
  | { phase: 'done'; say?: string; marks: number; verdict?: 'correct' | 'wrong' | 'partly'; heard?: string; notes?: string[] }
  | { phase: 'error'; message: string; code?: string }
  /** The temporary marks are gone (faded, cleared, page changed). */
  | { phase: 'cleared' }
  /** «Keep»: the marks are real ink now. */
  | { phase: 'kept'; added: number };

/** How long the buddy's temporary marks (and its pointers) stay before they fade away. */
export const BOARD_BUDDY_MARKS_MS = 40_000;

export const BOARD_BUDDY_REQUEST_EVENT = 'wb-board-buddy-request';
export const BOARD_BUDDY_STATE_EVENT = 'wb-board-buddy-state';
/** Pen button «Talk to the buddy»: `detail.active` true when the hold starts, false when it ends. */
export const BOARD_BUDDY_TALK_EVENT = 'wb-board-buddy-talk';

export function requestBoardBuddy(request: BoardBuddyRequest): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent<BoardBuddyRequest>(BOARD_BUDDY_REQUEST_EVENT, { detail: request }));
}

export function emitBoardBuddyState(state: BoardBuddyState): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent<BoardBuddyState>(BOARD_BUDDY_STATE_EVENT, { detail: state }));
}

export function emitBoardBuddyTalk(active: boolean): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent<{ active: boolean }>(BOARD_BUDDY_TALK_EVENT, { detail: { active } }));
}

export function isBoardBuddyRequest(value: unknown): value is BoardBuddyRequest {
  if (!value || typeof value !== 'object') return false;

  const request = value as { type?: unknown; question?: unknown };

  if (request.type === 'keep' || request.type === 'clear') return true;

  return request.type === 'ask' && typeof request.question === 'string';
}

let buddiesMounted = 0;

/**
 * The host's buddy says it is on screen (returns the disposer for its unmount). The pen button's
 * «Talk to the buddy» hold only applies while one is mounted; elsewhere (focus mode, exams, AI off)
 * a long hold acts like «Nothing», so the press still opens the menu on release.
 */
export function registerBoardBuddy(): () => void {
  buddiesMounted += 1;
  let done = false;

  return () => {
    if (done) return;
    done = true;
    buddiesMounted = Math.max(0, buddiesMounted - 1);
  };
}

export const isBoardBuddyMounted = (): boolean => buddiesMounted > 0;
