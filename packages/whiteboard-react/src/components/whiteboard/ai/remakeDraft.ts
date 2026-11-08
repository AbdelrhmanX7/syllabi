import type { RemakeImageResult, RemakePageRequest } from './types';

/**
 * «Similar copy» (image mode) as a DRAFT PAGE: the copy is made on a placeholder page inserted right
 * after the original, under the «AI Dissolve» overlay, and only becomes a real page when the
 * teacher keeps it. Everything here is pure — the layer does the side effects.
 */

// ---------------------------------------------------------------------------
// Stage → progress
// ---------------------------------------------------------------------------

/** The four stages /remake-page reports, in order, as the status card shows them. Index = stage. */
export const REMAKE_STAGE_LINES = ['Reading the page…', 'Writing the new questions…', 'Drawing the new page…', 'Checking the writing…'] as const;

/** The server's status lines → stage. */
const STAGE_PATTERNS: RegExp[] = [/\bread/i, /\bwrit|question/i, /\bdraw|render/i, /\bcheck|verif|review/i];

/** A status line → its stage (0..3), or -1 when it names none of them. */
export function remakeStageOf(line: string | null | undefined): number {
  if (!line) return -1;

  // Latest stage first: «Checking the writing» contains «writing», never confuse it with stage 1.
  for (let stage = STAGE_PATTERNS.length - 1; stage >= 0; stage -= 1) {
    if (STAGE_PATTERNS[stage]!.test(line)) return stage;
  }

  return -1;
}

/**
 * Progress band per stage, and how fast the bar creeps inside it (seconds to cover ~63 %). Drawing is
 * the long one (30–150 s), so it owns the widest band and the slowest creep. Bands never touch 1:
 * only the result finishes the reveal.
 */
export const REMAKE_BANDS: ReadonlyArray<{ from: number; to: number; tau: number }> = [
  // The shader eases progress with a cubic, so raw values under ~0.25 show no front at all: the
  // first band starts where the first islands of the page break through the paper.
  { from: 0.26, to: 0.36, tau: 6 },
  { from: 0.36, to: 0.46, tau: 10 },
  { from: 0.46, to: 0.8, tau: 45 },
  { from: 0.8, to: 0.9, tau: 12 },
];

/** The ceiling while waiting — the reveal never completes before the picture exists. */
export const REMAKE_PROGRESS_CAP = 0.9;

export interface StageClock {
  stage: number;
  /** ms timestamp the stage began. */
  since: number;
}

/** A new status line → the clock. Monotonic: a retry's «Drawing» after «Checking» never moves the bar back. */
export function advanceStage(clock: StageClock, line: string | null | undefined, now: number): StageClock {
  const next = remakeStageOf(line);

  return next > clock.stage ? { stage: next, since: now } : clock;
}

/**
 * Progress for a stage `secondsInStage` into it: eased toward the band's end by an exponential that
 * never arrives. Before any status (`stage` -1) it creeps through the first band.
 */
export function generatingProgress(stage: number, secondsInStage: number): number {
  const band = REMAKE_BANDS[Math.min(Math.max(stage, 0), REMAKE_BANDS.length - 1)]!;
  const t = Math.max(0, secondsInStage);
  const creep = 1 - Math.exp(-t / band.tau);
  // 92 % of the band at most — the next stage always has somewhere to start from.
  const value = band.from + (band.to - band.from) * 0.92 * creep;

  return Math.min(REMAKE_PROGRESS_CAP, value);
}

export const easeInOutCubic = (p: number): number => {
  const x = Math.min(1, Math.max(0, p));

  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** The finishing reveal: `from` → 1 over `durationMs`, eased. */
export function finishingProgress(from: number, elapsedMs: number, durationMs = REMAKE_REVEAL_MS): number {
  const k = easeInOutCubic(elapsedMs / Math.max(1, durationMs));

  return from + (1 - from) * k;
}

export const REMAKE_REVEAL_MS = 1200;
export const REMAKE_PULSE_MS = 520;
export const REMAKE_FADE_MS = 280;

// ---------------------------------------------------------------------------
// Placeholder page lifecycle
// ---------------------------------------------------------------------------

/** What the server is asked — kept so «Try again» re-runs the exact request on the same page. */
export type RemakeDraftRequest = Pick<RemakePageRequest, 'mode' | 'quality' | 'target' | 'instruction' | 'grade' | 'subject' | 'lang' | 'textMode'> & {
  /** «Write the questions in my handwriting»: an overlay page's text is written with the handwriting engine. Board-only. */
  handwrittenText?: boolean;
};

/** Does this result carry text the board must write over its (text-free) picture? */
export const hasOverlayText = (result: Pick<RemakeImageResult, 'layout'> | null | undefined): boolean =>
  Boolean(result?.layout?.blocks?.some((block) => block.text?.trim() || block.kind === 'answer_line' || block.choices?.length));

export type RemakeDraftPhase = 'generating' | 'revealing' | 'review';

export interface RemakeDraft {
  /** The transient placeholder page. */
  pageId: string;
  /** The page it copies — where cancel / delete return to. */
  originalPageId: string | null;
  phase: RemakeDraftPhase;
  request: RemakeDraftRequest;
  /** Bumped by every (re)run, so a stale stream's frames are ignored. */
  run: number;
  startedAt: number;
  clock: StageClock;
  result: RemakeImageResult | null;
  /** Generation finished while the teacher was on another page — the «Ready» toast is owed. */
  readyElsewhere: boolean;
  /**
   * The streamed `questions` frame arrived before the picture: the new text is already shown over
   * the blurred original while the page is cleaned. False when the server sends no partial frames.
   */
  questionsReady: boolean;
}

export type RemakeDraftAction =
  | { type: 'start'; pageId: string; originalPageId: string | null; request: RemakeDraftRequest; now: number }
  | { type: 'status'; run: number; line: string | null; now: number }
  /** The partial `questions` frame (new text before the picture). */
  | { type: 'questions'; run: number; now: number }
  /** The final `result` frame after an early `image` frame already landed: verification etc. */
  | { type: 'final'; run: number; result: RemakeImageResult }
  | { type: 'result'; run: number; result: RemakeImageResult; onPage: boolean }
  | { type: 'revealed' }
  | { type: 'opened' }
  | { type: 'retry'; now: number }
  /** keep / discard / cancel / failure — the draft is over either way. */
  | { type: 'end' };

/**
 * Where a draft goes next. `null` = no draft (never started, kept, discarded, cancelled or failed);
 * whether the placeholder page is removed is the caller's side effect, decided by `endEffect`.
 */
export function remakeDraftReducer(draft: RemakeDraft | null, action: RemakeDraftAction): RemakeDraft | null {
  switch (action.type) {
    case 'start':
      return {
        pageId: action.pageId,
        originalPageId: action.originalPageId,
        phase: 'generating',
        request: action.request,
        run: (draft?.run ?? 0) + 1,
        startedAt: action.now,
        clock: { stage: -1, since: action.now },
        result: null,
        readyElsewhere: false,
        questionsReady: false,
      };
    case 'status':
      if (!draft || draft.phase !== 'generating' || action.run !== draft.run) return draft;

      {
        const clock = advanceStage(draft.clock, action.line, action.now);

        return clock === draft.clock ? draft : { ...draft, clock };
      }
    case 'questions':
      if (!draft || draft.phase !== 'generating' || action.run !== draft.run || draft.questionsReady) return draft;

      // The text exists: the drawing stage has begun whatever the status lines said.
      return { ...draft, questionsReady: true, clock: draft.clock.stage >= 2 ? draft.clock : { stage: 2, since: action.now } };
    case 'final':
      if (!draft || draft.phase === 'generating' || action.run !== draft.run) return draft;

      return { ...draft, result: action.result };
    case 'result':
      if (!draft || draft.phase !== 'generating' || action.run !== draft.run) return draft;

      // Off the page: nothing to animate — straight to review, with the toast owed.
      return action.onPage
        ? { ...draft, phase: 'revealing', result: action.result }
        : { ...draft, phase: 'review', result: action.result, readyElsewhere: true };
    case 'revealed':
      return draft && draft.phase === 'revealing' ? { ...draft, phase: 'review' } : draft;
    case 'opened':
      return draft && draft.readyElsewhere ? { ...draft, readyElsewhere: false } : draft;
    case 'retry':
      if (!draft || draft.phase !== 'review') return draft;

      return {
        ...draft,
        phase: 'generating',
        run: draft.run + 1,
        startedAt: action.now,
        clock: { stage: -1, since: action.now },
        result: null,
        readyElsewhere: false,
        questionsReady: false,
      };
    case 'end':
      return null;
    default:
      return draft;
  }
}

/** How a draft ends → what happens to the placeholder page and where the teacher lands. */
export function endEffect(outcome: 'keep' | 'discard' | 'cancel' | 'error' | 'no-changes'): { removePage: boolean; returnToOriginal: boolean } {
  return outcome === 'keep' ? { removePage: false, returnToOriginal: false } : { removePage: true, returnToOriginal: true };
}

/** The pure progress for a draft at `now` (ms) — the overlay's input while generating. */
export function draftProgress(draft: Pick<RemakeDraft, 'clock'>, now: number): number {
  return generatingProgress(draft.clock.stage, (now - draft.clock.since) / 1000);
}

// ---------------------------------------------------------------------------
// Persistence: transient pages never reach storage, sync or export
// ---------------------------------------------------------------------------

/**
 * The persisted view of a page list: transient pages dropped, the current index re-pointed at the
 * nearest kept page before it (the original, for a placeholder). Same array when nothing is transient.
 */
export function excludeTransientPages<T extends { id: string }>(
  pages: T[],
  currentIndex: number,
  transient: ReadonlySet<string>,
): { pages: T[]; currentIndex: number } {
  if (transient.size === 0 || !pages.some((page) => transient.has(page.id))) return { pages, currentIndex };

  const kept: T[] = [];
  let mapped = -1;

  pages.forEach((page, index) => {
    if (transient.has(page.id)) return;

    kept.push(page);

    if (index <= currentIndex) mapped = kept.length - 1;
  });

  return { pages: kept, currentIndex: Math.max(0, Math.min(mapped < 0 ? 0 : mapped, kept.length - 1)) };
}
