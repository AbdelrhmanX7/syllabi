// Pure helpers that turn an attempt verdict / SRS record into what the UI shows.

import type { AttemptResult, AttemptStep } from '@/lib/api/types';

export type StepStatus = 'ok' | 'error' | 'after' | 'unchecked';

/** The BE's current step: prose in `text`, the formula (if any) in `latex`. */
export interface AttemptStepV2 {
  index: number;
  text: string;
  latex: string | null;
  ok: boolean;
  note?: string | null;
}

/** Either shape the wire may carry: v2 `{index, text, latex|null, ok, note}` or v1 `{line, latex, ok, note}`. */
export type RawStep = AttemptStep | AttemptStepV2;

export interface AnnotatedStep {
  /** Ordering key: v2 `index`, v1 `line`, else the position in the array. */
  line: number;
  /** Markdown prose (may carry `$…$`). Empty when the step is a bare formula. */
  text: string;
  /** Display formula, rendered under the prose. */
  latex: string | null;
  ok: boolean;
  note: string;
  status: StepStatus;
}

const isV2 = (raw: RawStep): raw is AttemptStepV2 => 'text' in raw || 'index' in raw;

/**
 * One step from either wire shape. v1 put prose OR TeX in `latex`; `stepMarkdown` decides which
 * and the result goes through the inline renderer, so old verdicts look exactly as before.
 */
export function normalizeStep(raw: RawStep, position: number): Omit<AnnotatedStep, 'status'> {
  if (isV2(raw)) {
    const latex = typeof raw.latex === 'string' && raw.latex.trim() ? raw.latex.trim() : null;

    return {
      line: Number.isFinite(raw.index) ? raw.index : position,
      text: typeof raw.text === 'string' ? raw.text : '',
      latex,
      ok: Boolean(raw.ok),
      note: raw.note ?? '',
    };
  }

  return {
    line: Number.isFinite(raw.line) ? raw.line : position,
    text: stepMarkdown(raw.latex ?? ''),
    latex: null,
    ok: Boolean(raw.ok),
    note: raw.note ?? '',
  };
}

/**
 * Marks every step: ✓ up to the first error, the first error itself, and everything after it as
 * `after` (shown dimmed — once a step is wrong the rest is built on sand). When the model flags an
 * early step but `firstErrorStep` points elsewhere, the earliest `ok:false` wins.
 */
export function annotateSteps(verdict: { steps: RawStep[]; firstErrorStep: number | null }): AnnotatedStep[] {
  const sorted = (verdict.steps ?? [])
    .map((raw, position) => normalizeStep(raw, position))
    .sort((a, b) => a.line - b.line);
  const firstBad = sorted.find((s) => !s.ok)?.line ?? verdict.firstErrorStep ?? null;

  return sorted.map((step) => {
    if (firstBad === null) return { ...step, status: step.ok ? 'ok' : 'error' };
    if (step.line < firstBad) return { ...step, status: step.ok ? 'ok' : 'error' };
    if (step.line === firstBad) return { ...step, status: 'error' };

    return { ...step, status: step.ok ? 'ok' : 'after' };
  });
}

export const READ_TIMEOUT_MESSAGE = "Couldn't read your handwriting in time — try writing larger or type it";

/**
 * What an attempt failure says, and whether a plain retry makes sense. `READ_TIMEOUT` is the vision
 * read hitting its ~30 s cap — the ink is still there, so the user can try again or type instead.
 */
export function attemptErrorMessage(error: unknown): { message: string; retry: boolean } {
  const code = (error as { code?: unknown } | null)?.code;

  if (code === 'READ_TIMEOUT') return { message: READ_TIMEOUT_MESSAGE, retry: true };
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'string' && error
        ? error
        : 'Something went wrong';

  return { message, retry: false };
}

export const resultLabel = (result: AttemptResult | null): string =>
  result === 'right' ? 'Correct' : result === 'partial' ? 'Partially right' : result === 'wrong' ? 'Not yet' : '—';

/** Tailwind tone classes per result — kept in one place so every surface agrees. */
export const resultTone = (result: AttemptResult | null) =>
  result === 'right'
    ? {
        text: 'text-emerald-700 dark:text-emerald-300',
        bg: 'bg-emerald-50 dark:bg-emerald-950/50',
        ring: 'ring-emerald-300 dark:ring-emerald-700',
      }
    : result === 'partial'
      ? {
          text: 'text-amber-700 dark:text-amber-300',
          bg: 'bg-amber-50 dark:bg-amber-950/50',
          ring: 'ring-amber-300 dark:ring-amber-700',
        }
      : result === 'wrong'
        ? {
            text: 'text-rose-700 dark:text-rose-300',
            bg: 'bg-rose-50 dark:bg-rose-950/50',
            ring: 'ring-rose-300 dark:ring-rose-700',
          }
        : {
            text: 'text-zinc-600 dark:text-zinc-300',
            bg: 'bg-zinc-100 dark:bg-zinc-800',
            ring: 'ring-zinc-300 dark:ring-zinc-700',
          };

const DAY = 86_400_000;

/** `dueAt` → "due now" / "in 3 h" / "tomorrow" / "in 12 days". */
export function nextDueLabel(dueAt: string, now = Date.now()): string {
  const due = Date.parse(dueAt);

  if (!Number.isFinite(due)) return 'scheduled';
  const diff = due - now;

  if (diff <= 60_000) return 'due now';
  if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))} min`;
  if (diff < DAY) return `in ${Math.round(diff / 3_600_000)} h`;
  const days = Math.round(diff / DAY);

  if (days === 1) return 'tomorrow';
  if (days < 30) return `in ${days} days`;
  const months = Math.round(days / 30);

  return months === 1 ? 'in a month' : `in ${months} months`;
}

export const isDue = (dueAt: string, now = Date.now()): boolean => {
  const due = Date.parse(dueAt);

  return Number.isFinite(due) && due <= now;
};

export interface SessionTally {
  right: number;
  partial: number;
  wrong: number;
  total: number;
  timeMs: number;
}

export const emptyTally = (): SessionTally => ({ right: 0, partial: 0, wrong: 0, total: 0, timeMs: 0 });

export function addToTally(tally: SessionTally, result: AttemptResult, timeMs: number): SessionTally {
  return { ...tally, [result]: tally[result] + 1, total: tally.total + 1, timeMs: tally.timeMs + timeMs };
}

/** mm:ss for timers. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;

  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Percent 0..100 from a 0..1 mastery, clamped. */
export const pct = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 100);

/**
 * A verdict step's `latex` is LaTeX per the contract, but graders (and the mock) put plain prose
 * there when the answer was typed text. Wrapping prose in `$…$` renders it as one run of italic math
 * with every space eaten, so a line that reads like a sentence (three words in a row, no TeX
 * markers) is shown as text; anything else is math.
 */
export function stepMarkdown(latex: string): string {
  if (latex.includes('$')) return latex;
  const prose = !/[\\^_{}]/.test(latex) && /[A-Za-z]+\s+[A-Za-z]+\s+[A-Za-z]+/.test(latex);

  return prose ? latex : `$${latex}$`;
}
