import type { AttemptDone } from '../api';
import type { AttemptVerdict } from '@/lib/api/types';

import React, { useMemo, useState } from 'react';
import { Check, CircleAlert, Eye, Lightbulb, X } from 'lucide-react';

import { useKatex } from '../lib/katex';
import { annotateSteps, nextDueLabel, resultLabel, resultTone } from '../lib/verdict';

import { InlineMd, Markdown, MathBlock } from './Markdown';

/**
 * What the AI made of the attempt: the transcript it read (LaTeX), one row per step with ✓ / the
 * first error + note, the hint up front, and the full solution only on request.
 */

export interface VerdictPanelProps {
  reading: string | null;
  verdict: AttemptVerdict | null;
  done: AttemptDone | null;
  /** Streaming state: `reading` arrives before `verdict`. */
  busy: boolean;
  error: string | null;
  /** Called when the user asks for the full solution and the verdict has none yet (re-request with reveal). */
  onReveal?: () => void;
  revealing?: boolean;
  /** Fallback: the question's own stored answer / steps, shown when the verdict carries no solution. */
  fallbackSolution?: { answer: string; steps: string[] } | null;
  /** Shown as a Retry button in the error block (e.g. after a READ_TIMEOUT). */
  onRetry?: () => void;
}

export function VerdictPanel({
  reading,
  verdict,
  done,
  busy,
  error,
  onReveal,
  revealing = false,
  fallbackSolution,
  onRetry,
}: VerdictPanelProps) {
  const katex = useKatex();
  const [showSolution, setShowSolution] = useState(false);
  const steps = useMemo(() => (verdict ? annotateSteps(verdict) : []), [verdict]);
  const tone = resultTone(verdict?.result ?? null);
  const solution = verdict?.solution ?? null;

  if (!busy && !reading && !verdict && !error) return null;

  return (
    <section aria-live='polite' className='space-y-3'>
      {error ? (
        <div className='flex items-start gap-2 rounded-2xl bg-st-danger/10 p-4 text-sm text-st-danger'>
          <CircleAlert className='mt-0.5 h-4 w-4 shrink-0' />
          <span className='flex-1'>{error}</span>
          {onRetry ? (
            <button
              className='h-9 shrink-0 rounded-xl bg-st-surface px-3 text-sm font-semibold text-st-danger'
              type='button'
              onClick={onRetry}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {/* An empty reading (typed, matching, blanks) is only «reading…» while the check runs. */}
      {reading !== null && (reading || busy) ? (
        <div className='rounded-2xl border border-st-line bg-st-bg p-4'>
          <p className='mb-1 text-xs font-semibold uppercase tracking-wide text-st-muted'>
            What I read
          </p>
          {reading ? (
            <ReadingText katex={katex} text={reading} />
          ) : (
            <p className='text-sm text-st-muted'>Reading your handwriting…</p>
          )}
        </div>
      ) : busy ? (
        <div className='flex items-center gap-3 rounded-2xl border border-st-line p-4 text-sm text-st-muted'>
          <span className='h-2.5 w-2.5 animate-pulse rounded-full bg-st-accent' />
          Checking your work…
        </div>
      ) : null}

      {verdict ? (
        <div className={`rounded-2xl p-4 ring-1 ${tone.bg} ${tone.ring}`}>
          <div className='flex items-center justify-between gap-3'>
            <p className={`text-lg font-semibold ${tone.text}`}>{resultLabel(verdict.result)}</p>
            {done ? (
              <p className='text-xs text-st-muted'>
                Next review {nextDueLabel(done.srs.dueAt)} · mastery {Math.round(done.stats.mastery * 100)}%
              </p>
            ) : null}
          </div>

          {steps.length ? (
            <ol className='mt-3 space-y-1.5'>
              {steps.map((step, position) => (
                <li
                  key={`${position}-${step.line}`}
                  className={`flex items-start gap-3 rounded-xl px-3 py-2 ${
                    step.status === 'error'
                      ? 'bg-st-surface ring-1 ring-st-danger'
                      : step.status === 'after'
                        ? 'opacity-50'
                        : ''
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-st-accent-fg ${
                      step.status === 'ok' ? 'bg-st-ok' : step.status === 'error' ? 'bg-st-danger' : 'bg-st-muted'
                    }`}
                  >
                    {step.status === 'ok' ? (
                      <Check className='h-4 w-4' />
                    ) : step.status === 'error' ? (
                      <X className='h-4 w-4' />
                    ) : (
                      <span className='text-xs'>{position + 1}</span>
                    )}
                  </span>
                  <div className='min-w-0 flex-1'>
                    {step.text ? (
                      <div className='text-base text-st-fg'>
                        <InlineMd katex={katex} text={step.text} />
                      </div>
                    ) : null}
                    {step.latex ? <MathBlock katex={katex} tex={step.latex} /> : null}
                    {step.note && step.status !== 'ok' ? (
                      <p className='mt-1 text-sm text-st-danger'>{step.note}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}

          {verdict.hint ? (
            <div className='mt-3 flex items-start gap-2 rounded-xl bg-st-surface/70 p-3 text-sm text-st-fg'>
              <Lightbulb className='mt-0.5 h-4 w-4 shrink-0 text-st-warn' />
              <div className='min-w-0 flex-1'>
                <InlineMd katex={katex} text={verdict.hint} />
              </div>
            </div>
          ) : null}

          <div className='mt-3'>
            {solution || showSolution ? (
              <div className='rounded-xl bg-st-surface p-3'>
                <p className='mb-1 text-xs font-semibold uppercase tracking-wide text-st-muted'>Solution</p>
                {solution ? (
                  <Markdown text={solution} />
                ) : fallbackSolution ? (
                  <div className='space-y-1'>
                    {fallbackSolution.steps.map((step, index) => (
                      <div key={index} className='flex gap-2 text-base'>
                        <span className='text-st-muted'>{index + 1}.</span>
                        <div className='flex-1'>
                          <InlineMd katex={katex} text={step} />
                        </div>
                      </div>
                    ))}
                    <p className='mt-2 text-base font-medium'>
                      Answer: <InlineMd katex={katex} text={fallbackSolution.answer} />
                    </p>
                  </div>
                ) : revealing ? (
                  <p className='text-sm text-st-muted'>Fetching the solution…</p>
                ) : (
                  <p className='text-sm text-st-muted'>No solution available.</p>
                )}
              </div>
            ) : (
              <button
                className='flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-st-fg hover:bg-st-surface/70'
                type='button'
                onClick={() => {
                  setShowSolution(true);
                  if (!fallbackSolution) onReveal?.();
                }}
              >
                <Eye className='h-4 w-4' /> Show solution
              </button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The transcript is LaTeX-heavy; lines without `$` are wrapped as math, a line with `$` is left as markdown. */
function ReadingText({ text, katex }: { text: string; katex: ReturnType<typeof useKatex> }) {
  const lines = text.split('\n').filter((line) => line.trim());

  return (
    <div className='space-y-1'>
      {lines.map((line, index) =>
        line.includes('$') ? (
          <p key={index} className='text-base text-st-fg'>
            <InlineMd katex={katex} text={line} />
          </p>
        ) : /[\\^_{}=]/.test(line) ? (
          <MathBlock key={index} katex={katex} tex={line} />
        ) : (
          <p key={index} className='text-base text-st-fg'>
            {line}
          </p>
        ),
      )}
    </div>
  );
}
