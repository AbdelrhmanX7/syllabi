import type { GradeState } from '../lib/frames';

import { AlertTriangle, ArrowRight, CheckCircle2, Lightbulb, Loader2 } from 'lucide-react';

import { isNoteNode } from '../lib/frames';
import { aggregateCriteria, CRITERIA, formatScore, scoreTone } from '../lib/score';

import { BuiltFrom } from './BuiltFrom';

import { Badge, ErrorNote } from '@/components/ui/primitives';

/**
 * The live grade: what the model read, the five rubric rows filling in as their frames arrive,
 * then the verdict — missing terms, unlabeled arrows, wrong links with why, suggestions.
 */
export interface GradePanelProps {
  state: GradeState;
  onRetry?: () => void;
}

const TONE_BAR: Record<ReturnType<typeof scoreTone>, string> = {
  ok: 'bg-st-ok',
  warn: 'bg-st-warn',
  danger: 'bg-st-danger',
  neutral: 'bg-st-muted',
};

const TONE_TEXT: Record<ReturnType<typeof scoreTone>, string> = {
  ok: 'text-st-ok',
  warn: 'text-st-warn',
  danger: 'text-st-danger',
  neutral: 'text-st-muted',
};

export function GradePanel({ state, onRetry }: GradePanelProps) {
  if (state.phase === 'idle') return null;
  const { reading, criteria, verdict } = state;
  const running = state.phase === 'sending' || state.phase === 'grading';
  const partial = aggregateCriteria(criteria);
  const labelOf = (id: string) => reading?.nodes.find((node) => node.id === id)?.label ?? id;
  const finalScore = verdict?.score ?? (criteria.length === CRITERIA.length ? partial.score : null);
  const finalMax = verdict?.max ?? 10;
  const concepts = reading?.nodes.filter((node) => node.kind !== 'note') ?? [];
  const notes = reading?.nodes.filter((node) => node.kind === 'note') ?? [];

  return (
    <div className='flex flex-col gap-4'>
      {state.phase === 'error' && <ErrorNote message={state.error ?? 'Grading failed'} onRetry={onRetry} />}

      {running && (
        <p className='text-st-muted flex items-center gap-2 text-sm'>
          <Loader2 className='h-4 w-4 animate-spin' />
          {state.phase === 'sending'
            ? 'Sending the picture…'
            : !reading
              ? 'Reading the map…'
              : !verdict
                ? 'Scoring against the rubric…'
                : 'Finishing…'}
        </p>
      )}

      {(finalScore !== null || verdict) && (
        <div className='rounded-st-lg border-st-line bg-st-raised flex items-baseline justify-between gap-3 border px-4 py-3'>
          <span className='flex flex-col'>
            {/* verdict.score is calibrated to how she grades; the plain rubric sum is the detail. */}
            <span className='text-st-muted text-sm font-medium'>{verdict ? 'Predicted grade' : 'Rubric so far'}</span>
            {verdict?.rawScore !== null && verdict?.rawScore !== undefined && verdict.rawScore !== verdict.score && (
              <span className='text-st-muted text-xs tabular-nums'>
                rubric sum {formatScore(verdict.rawScore, finalMax)}
              </span>
            )}
          </span>
          <span className={`text-3xl font-semibold tabular-nums ${TONE_TEXT[scoreTone(finalScore, finalMax)]}`}>
            {formatScore(finalScore, finalMax)}
          </span>
        </div>
      )}

      {state.phase === 'done' && state.attemptId && (
        <p className='text-st-ok flex items-center gap-1.5 text-xs'>
          <CheckCircle2 className='h-3.5 w-3.5' /> Saved to this map&apos;s attempts
        </p>
      )}

      {state.phase === 'done' && <BuiltFrom provenance={state.provenance} />}

      <section>
        <h3 className='text-st-muted mb-2 text-xs font-medium uppercase tracking-wide'>Rubric</h3>
        <ul className='flex flex-col gap-2'>
          {CRITERIA.map((name, index) => {
            const row = criteria.find((item) => item.name === name) ?? criteria[index];
            const pending = !row;
            const tone = row ? scoreTone(row.score, row.max) : 'neutral';

            return (
              <li key={name} className={`rounded-st border-st-line border px-3 py-2 ${pending ? 'opacity-60' : ''}`}>
                <div className='flex items-center justify-between gap-3 text-sm'>
                  <span className='text-st-fg font-medium'>{row?.name ?? name}</span>
                  <span className={`tabular-nums ${TONE_TEXT[tone]}`}>
                    {row ? `${row.score} / ${row.max}` : running ? '…' : '—'}
                  </span>
                </div>
                <div className='bg-st-line mt-1.5 h-1.5 overflow-hidden rounded-full'>
                  <div
                    className={`h-full rounded-full transition-[width] duration-500 ${TONE_BAR[tone]}`}
                    style={{ width: row && row.max > 0 ? `${Math.round((row.score / row.max) * 100)}%` : '0%' }}
                  />
                </div>
                {row?.note && <p className='text-st-muted mt-1.5 text-xs'>{row.note}</p>}
              </li>
            );
          })}
        </ul>
      </section>

      {verdict && (
        <section className='flex flex-col gap-3'>
          {verdict.missingTerms.length > 0 && (
            <div className='flex flex-wrap items-center gap-1.5 text-sm'>
              <span className='text-st-muted mr-1'>Missing:</span>
              {verdict.missingTerms.map((term) => (
                <Badge key={term} tone='danger'>
                  {term}
                </Badge>
              ))}
            </div>
          )}
          {verdict.unlabeledArrows > 0 && (
            <p className='text-st-warn flex items-center gap-2 text-sm'>
              <AlertTriangle className='h-4 w-4' />
              {verdict.unlabeledArrows} arrow{verdict.unlabeledArrows > 1 ? 's' : ''} without a label
            </p>
          )}
          {verdict.wrongLinks.length > 0 && (
            <div>
              <h3 className='text-st-muted mb-1.5 text-xs font-medium uppercase tracking-wide'>Links to fix</h3>
              <ul className='flex flex-col gap-2'>
                {verdict.wrongLinks.map((link, index) => (
                  <li key={index} className='rounded-st border-st-danger/30 bg-st-danger/5 border px-3 py-2 text-sm'>
                    <p className='text-st-fg flex flex-wrap items-center gap-1 font-medium'>
                      {link.from}
                      <ArrowRight className='text-st-muted h-3.5 w-3.5' />
                      {link.label && <span className='text-st-muted italic'>{link.label}</span>}
                      {link.label && <ArrowRight className='text-st-muted h-3.5 w-3.5' />}
                      {link.to}
                    </p>
                    <p className='text-st-muted mt-0.5'>{link.why}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {verdict.suggestions.length > 0 && (
            <div>
              <h3 className='text-st-muted mb-1.5 text-xs font-medium uppercase tracking-wide'>Next time</h3>
              <ul className='flex flex-col gap-1.5'>
                {verdict.suggestions.map((tip, index) => (
                  <li key={index} className='text-st-fg flex items-start gap-2 text-sm'>
                    <Lightbulb className='text-st-accent mt-0.5 h-4 w-4 shrink-0' />
                    <span>{tip}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {reading && (
        <section>
          <h3 className='text-st-muted mb-2 text-xs font-medium uppercase tracking-wide'>What the AI read</h3>
          <div className='mb-2 flex flex-wrap gap-1.5'>
            {concepts.map((node) => (
              <Badge key={node.id}>{node.label}</Badge>
            ))}
          </div>
          {notes.length > 0 && (
            <ul className='mb-2 flex flex-col gap-1'>
              {notes.map((node) => (
                <li key={node.id} className='text-st-muted border-st-line border-l-2 pl-2 text-xs italic'>
                  {node.label}
                </li>
              ))}
            </ul>
          )}
          {reading.edges.length > 0 ? (
            <ul className='flex flex-col gap-1 text-sm'>
              {reading.edges.map((edge, index) => (
                <li key={index} className='text-st-fg flex flex-wrap items-center gap-1'>
                  <span>{labelOf(edge.from)}</span>
                  <ArrowRight className='text-st-muted h-3.5 w-3.5' />
                  {edge.label ? (
                    <span className='text-st-muted italic'>{edge.label}</span>
                  ) : isNoteNode(reading, edge.from) || isNoteNode(reading, edge.to) ? (
                    <span className='text-st-muted text-xs'>definition</span>
                  ) : (
                    <Badge tone='warn'>no label</Badge>
                  )}
                  <ArrowRight className='text-st-muted h-3.5 w-3.5' />
                  <span className={isNoteNode(reading, edge.to) ? 'text-st-muted truncate italic' : undefined}>
                    {labelOf(edge.to)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className='text-st-muted text-sm'>No arrows were read.</p>
          )}
        </section>
      )}
    </div>
  );
}
