// Pure exam helpers: score normalisation, the clock, and what an exam row IS right now.

/** The BE accepts a submit up to this long after the timer ends (graded `late:true`). */
export const LATE_GRACE_MS = 2 * 60_000;

/** BE P5 scores are 0–100 (one decimal); the older mock sent 0..1. Both → 0..1. */
export function scoreFraction(score: number | null | undefined): number {
  if (score === null || score === undefined || !Number.isFinite(score)) return 0;
  const fraction = score > 1 ? score / 100 : score;

  return Math.min(1, Math.max(0, fraction));
}

export function examDeadline(startedAt: string | null, minutes: number, fallbackStart = Date.now()): number {
  const started = startedAt ? Date.parse(startedAt) : NaN;

  return (Number.isFinite(started) ? started : fallbackStart) + minutes * 60_000;
}

export type ExamState = 'open' | 'late' | 'expired' | 'submitted';

/**
 * open      — timer still running, can resume.
 * late      — timer ended but inside the BE's grace window; a submit is still graded (late:true).
 * expired   — too late to submit; only history.
 * submitted — results exist.
 */
export function examState(
  row: { startedAt: string | null; submittedAt: string | null; minutes: number },
  now = Date.now(),
): ExamState {
  if (row.submittedAt) return 'submitted';
  const deadline = examDeadline(row.startedAt, row.minutes, now);

  if (now <= deadline) return 'open';
  if (now <= deadline + LATE_GRACE_MS) return 'late';

  return 'expired';
}

export const isResumable = (state: ExamState) => state === 'open' || state === 'late';

/** "3 of 10 answered" style counts for the history list / submit confirm. */
export interface DraftLike {
  strokes: unknown[];
  typed: string;
  choice: number | null;
  matches?: Record<string, string>;
  blanks?: string[];
}

/** Anything entered at all: ink, text, a choice, a match or a filled blank. */
export function draftAnswered(d: DraftLike | undefined | null): boolean {
  if (!d) return false;

  return (
    d.strokes.length > 0 ||
    d.typed.trim().length > 0 ||
    d.choice !== null ||
    Object.keys(d.matches ?? {}).length > 0 ||
    (d.blanks ?? []).some((b) => b.trim().length > 0)
  );
}

export function answeredCount<T extends DraftLike>(drafts: Map<string, T> | Record<string, T>): number {
  const values = drafts instanceof Map ? Array.from(drafts.values()) : Object.values(drafts);

  return values.filter(draftAnswered).length;
}
