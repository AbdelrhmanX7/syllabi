import type { Provenance } from '../lib/provenance';
import type { Prediction } from '../types';

import { useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronRight, Info, Quote, Wand2 } from 'lucide-react';
import Link from 'next/link';

import { BuiltFrom } from './BuiltFrom';

import { formatDate } from '@/lib/format';
import { ActionButton, Badge } from '@/components/ui/primitives';

/** A bare `YYYY-MM-DD` is a calendar day: read it at noon UTC so Pacific time keeps the same day. */
const dayOf = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);

export function predictionHeading(prediction: Prediction): string {
  const { number, title, date } = prediction.lecture;

  return [number !== null ? `Lecture ${number}` : 'Next lecture', title, formatDate(dayOf(date))]
    .filter(Boolean)
    .join(' · ');
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/**
 * The next prompt, guessed (or already posted): the most likely term set as chips, the ranked terms
 * with their odds, why, the predicted model answer (folded), and the runner-up prompts.
 */
export function PredictionCard({
  prediction,
  provenance,
  practicing,
  onPractice,
}: {
  prediction: Prediction;
  provenance: Provenance;
  practicing: boolean;
  onPractice: (terms: string[]) => void;
}) {
  const [answerOpen, setAnswerOpen] = useState(false);
  const posted = prediction.source === 'posted';
  const postedTitle = prediction.postedIn[0];

  return (
    <div className='rounded-st border-st-line flex flex-col gap-3 border px-3 py-3'>
      <div className='flex flex-col gap-1'>
        <p className='text-st-fg text-sm font-semibold'>{predictionHeading(prediction)}</p>
        {posted && (
          <p className='rounded-st border-st-ok/40 bg-st-ok/10 text-st-fg flex items-center gap-1.5 border px-2 py-1 text-xs'>
            <BadgeCheck className='text-st-ok h-3.5 w-3.5 shrink-0' />
            <span>
              Terms already posted
              {postedTitle && (
                <>
                  {' in '}
                  {postedTitle.itemId ? (
                    <Link
                      className='text-st-accent font-medium hover:underline'
                      href={`/item/?id=${encodeURIComponent(postedTitle.itemId)}`}
                    >
                      {postedTitle.title}
                    </Link>
                  ) : (
                    <span className='font-medium'>{postedTitle.title}</span>
                  )}
                </>
              )}
            </span>
          </p>
        )}
      </div>

      {prediction.prompt.length > 0 && (
        <div className='flex flex-col gap-2'>
          <p className='text-st-muted text-xs font-medium uppercase tracking-wide'>
            {posted ? 'The prompt' : 'Most likely prompt'}
          </p>
          <div className='flex flex-wrap gap-1.5'>
            {prediction.prompt.map((term) => (
              <Badge key={term} tone='accent'>
                {term}
              </Badge>
            ))}
          </div>
          <ActionButton
            className='min-h-10 self-start px-3'
            loading={practicing}
            onClick={() => onPractice(prediction.prompt)}
          >
            <Wand2 className='h-4 w-4' /> Practice this
          </ActionButton>
        </div>
      )}

      {prediction.why && <p className='text-st-muted text-xs'>{prediction.why}</p>}

      {prediction.terms.length > 0 && (
        <div className='flex flex-col gap-1.5'>
          <p className='text-st-muted text-xs font-medium uppercase tracking-wide'>Likely terms</p>
          <ul className='flex flex-col gap-1'>
            {prediction.terms.map((row) => (
              <li key={row.term} className='grid grid-cols-[minmax(0,1fr)_5rem_2.5rem] items-center gap-2 text-sm'>
                <span className='text-st-fg truncate'>{row.term}</span>
                <span className='bg-st-line h-1.5 overflow-hidden rounded-full'>
                  <span className='bg-st-accent block h-full rounded-full' style={{ width: pct(row.p) }} />
                </span>
                <span className='text-st-muted text-right text-xs tabular-nums'>{pct(row.p)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!posted && (
        <p className='text-st-muted flex items-start gap-1.5 text-xs'>
          <Info className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          Predictions get about 1/3 of terms exactly — study the alternatives too.
        </p>
      )}

      {prediction.modelAnswer && (
        <div>
          <button
            aria-expanded={answerOpen}
            className='text-st-fg flex w-full items-center gap-1.5 text-left text-sm font-medium'
            type='button'
            onClick={() => setAnswerOpen((open) => !open)}
          >
            {answerOpen ? (
              <ChevronDown className='text-st-muted h-4 w-4' />
            ) : (
              <ChevronRight className='text-st-muted h-4 w-4' />
            )}
            <Quote className='text-st-accent h-4 w-4' /> Predicted model answer
            <span className='text-st-muted ml-auto text-xs font-normal'>{answerOpen ? 'hide' : 'show'}</span>
          </button>
          {answerOpen && (
            <p className='rounded-st border-st-accent/30 bg-st-accent/5 text-st-fg mt-2 whitespace-pre-wrap border px-3 py-2 text-sm leading-relaxed'>
              {prediction.modelAnswer}
            </p>
          )}
        </div>
      )}

      {prediction.alternatives.length > 0 && (
        <div className='flex flex-col gap-2'>
          <p className='text-st-muted text-xs font-medium uppercase tracking-wide'>Alternatives</p>
          {prediction.alternatives.map((alt, index) => (
            <div key={index} className='border-st-line flex flex-col gap-1.5 border-l-2 pl-2.5'>
              <div className='flex flex-wrap items-center gap-1.5'>
                {alt.prompt.map((term) => (
                  <Badge key={term}>{term}</Badge>
                ))}
                <button
                  className='text-st-muted hover:text-st-fg inline-flex min-h-8 items-center gap-1 px-1 text-xs font-medium disabled:opacity-50'
                  disabled={practicing}
                  type='button'
                  onClick={() => onPractice(alt.prompt)}
                >
                  <Wand2 className='h-3.5 w-3.5' /> Practice
                </button>
              </div>
              {alt.why && <p className='text-st-muted text-xs'>{alt.why}</p>}
            </div>
          ))}
        </div>
      )}

      <BuiltFrom provenance={provenance} />
    </div>
  );
}
