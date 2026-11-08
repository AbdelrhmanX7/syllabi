import type { Question, StudyClass } from '@/lib/api/types';

import React from 'react';
import { Clock } from 'lucide-react';

import { SOURCE_LABEL, TYPE_LABEL } from '../lib/filters';
import { stemWithGaps } from '../lib/questionTypes';
import { isDue, nextDueLabel, resultLabel, resultTone } from '../lib/verdict';

import { Markdown } from './Markdown';

export interface QuestionCardProps {
  question: Question;
  studyClass?: StudyClass | null;
  onOpen?: (question: Question) => void;
  /** Compact list card (default) or the full stem for the solve view header. */
  variant?: 'list' | 'full';
  className?: string;
  /** A top-level card on the page: ink edge + lip. Leave off inside modals / scroll boxes (flat). */
  elevated?: boolean;
  /** Extra controls (e.g. a delete button) rendered in the footer row. */
  actions?: React.ReactNode;
  /** Replaces the rendered stem (e.g. the `fill_blank` stem with inline inputs). */
  stem?: React.ReactNode;
}

const DIFFICULTY_DOTS = [1, 2, 3, 4, 5] as const;

export function QuestionCard({
  question,
  studyClass,
  onOpen,
  variant = 'list',
  className = '',
  elevated = false,
  actions,
  stem,
}: QuestionCardProps) {
  const due = isDue(question.srs.dueAt);
  const tone = resultTone(question.stats.lastResult);
  const interactive = variant === 'list' && Boolean(onOpen);
  // `___` would read as markdown emphasis; draw blanks as a visible gap instead.
  const stemText = question.type === 'fill_blank' ? stemWithGaps(question.stem) : question.stem;
  const pairCount = question.type === 'matching' ? (question.pairs?.length ?? 0) : 0;

  // A div with role=button, not a <button>: the footer `actions` slot holds real buttons (delete),
  // and a button inside a button is invalid HTML (React hydration warning).
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen?.(question);
    }
  };

  return (
    <div
      aria-label={interactive ? 'Open question' : undefined}
      className={`${variant === 'list' ? 'flex h-full flex-col' : 'block'} w-full rounded-2xl bg-st-surface p-4 text-left ${
        elevated ? 'border-2 border-st-clay-edge shadow-clay' : 'border border-st-line'
      } ${
        interactive
          ? 'cursor-pointer transition hover:bg-st-raised/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-st-ink active:scale-[0.995]'
          : ''
      } ${className}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => onOpen?.(question) : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
    >
      <div className='mb-2 flex flex-wrap items-center gap-2 text-xs'>
        {studyClass ? (
          <span className='inline-flex items-center gap-1.5 font-medium text-st-fg'>
            <span className='h-2.5 w-2.5 rounded-full' style={{ background: studyClass.color }} />
            {studyClass.code || studyClass.name}
          </span>
        ) : null}
        <span className='rounded-full bg-st-raised px-2 py-0.5 text-st-fg'>
          {question.topic}
        </span>
        {question.subtopic ? <span className='text-st-muted'>{question.subtopic}</span> : null}
        <span className='text-st-muted'>·</span>
        <span className='text-st-muted'>
          {TYPE_LABEL[question.type] ?? question.type}
          {pairCount ? ` · ${pairCount} pairs` : ''}
        </span>
        <span className='text-st-muted'>·</span>
        <span className='text-st-muted'>{SOURCE_LABEL[question.source.kind]}</span>
        <span className='ms-auto inline-flex items-center gap-0.5' title={`Difficulty ${question.difficulty}/5`}>
          {DIFFICULTY_DOTS.map((d) => (
            <span
              key={d}
              className={`h-1.5 w-1.5 rounded-full ${d <= question.difficulty ? 'bg-st-accent' : 'bg-st-raised'}`}
            />
          ))}
        </span>
      </div>

      {stem ??
        (variant === 'list' ? (
          // Every list card is the same shape: the stem always takes exactly two lines (clamped,
          // short ones keep the room) and the footer sits on the bottom edge.
          <div className='line-clamp-2 min-h-[3.5rem] overflow-hidden'>
            <Markdown text={stemText} />
          </div>
        ) : (
          <Markdown size='lg' text={stemText} />
        ))}

      {variant === 'full' && question.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt='' className='mt-3 max-h-[480px] w-auto max-w-full rounded-xl' src={question.imageUrl} />
      ) : null}

      <div className={`flex flex-wrap items-center gap-2 text-xs ${variant === 'list' ? 'mt-auto pt-3' : 'mt-3'}`}>
        {question.stats.attempts > 0 ? (
          <span className={`rounded-full px-2 py-0.5 font-medium ${tone.bg} ${tone.text}`}>
            {resultLabel(question.stats.lastResult)} · {question.stats.correct}/{question.stats.attempts}
          </span>
        ) : (
          <span className='rounded-full bg-st-raised px-2 py-0.5 text-st-muted'>
            New
          </span>
        )}
        <span
          className={`inline-flex items-center gap-1 ${due ? 'font-medium text-st-warn' : 'text-st-muted'}`}
        >
          <Clock className='h-3.5 w-3.5' />
          {due ? 'Due now' : `Review ${nextDueLabel(question.srs.dueAt)}`}
        </span>
        <span className='text-st-muted'>Mastery {Math.round(question.stats.mastery * 100)}%</span>
        {actions ? <span className='ms-auto flex items-center gap-1'>{actions}</span> : null}
      </div>
    </div>
  );
}
