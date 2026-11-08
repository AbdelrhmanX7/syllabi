import type { ChecklistItem } from '../lib/checklist';
import type { ReactNode } from 'react';

import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, ListChecks, NotebookPen, Target } from 'lucide-react';

import { CHECKLIST_CAP } from '../lib/checklist';
import { formatScore } from '../lib/score';

import { ActionButton, Surface } from '@/components/ui/primitives';

/**
 * «Get to 10/10»: the few fixes that actually cost points, highest cost first (`buildChecklist`).
 * Sits above the maps so the minimum is obvious; the full AI reference is optional extras.
 */
export function GetToTen({
  items,
  grade = null,
  className,
}: {
  items: ChecklistItem[];
  /** Her grade (or the predicted one): the header says how far off full marks it is. */
  grade?: { score: number | null; max: number } | null;
  className?: string;
}) {
  const shown = items.slice(0, CHECKLIST_CAP);
  const more = items.length - shown.length;
  const gap = grade && grade.score !== null && grade.score < grade.max ? grade.max - grade.score : null;

  return (
    <Surface className={`border-st-accent/40 flex flex-col gap-2 p-4 ${className ?? ''}`}>
      <h3 className='text-st-fg flex items-center gap-1.5 text-sm font-semibold'>
        <Target className='text-st-accent h-4 w-4' /> Get to 10/10
        {gap !== null && grade && (
          <span className='text-st-muted text-xs font-normal'>
            · {formatScore(grade.score, grade.max)}, {gap} to go
          </span>
        )}
      </h3>
      {shown.length === 0 ? (
        <p className='text-st-ok flex items-center gap-1.5 text-sm'>
          <CheckCircle2 className='h-4 w-4' /> This map has everything the grader checks.
        </p>
      ) : (
        <>
          <ol className='flex flex-col gap-1.5'>
            {shown.map((item, index) => (
              <li key={`${item.kind}-${index}`} className='flex items-start gap-2 text-sm'>
                <span className='bg-st-accent/15 text-st-accent mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold'>
                  {index + 1}
                </span>
                <ChecklistRow item={item} />
              </li>
            ))}
          </ol>
          <p className='text-st-muted text-xs'>
            {more > 0 ? `${more} smaller fix${more > 1 ? 'es' : ''} after these. ` : ''}
            That is all that costs points — anything beyond it is optional.
          </p>
        </>
      )}
    </Surface>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const [why, setWhy] = useState(false);

  return (
    <span className='min-w-0'>
      <span className='text-st-fg font-medium'>{item.title}</span>
      {item.detail && <span className='text-st-muted'>: {item.detail}</span>}
      {item.why && (
        <button
          aria-expanded={why}
          className='text-st-accent hover:bg-st-raised ml-1.5 rounded px-1 text-xs'
          type='button'
          onClick={() => setWhy((open) => !open)}
        >
          why?
        </button>
      )}
      {why && item.why && <span className='text-st-muted mt-0.5 block text-xs'>{item.why}</span>}
    </span>
  );
}

/** Shown only when a server still refuses a map without terms (400 NO_PROMPT_TERMS); terms are optional otherwise. */
export function NeedsTerms({ onEnter, className }: { onEnter?: () => void; className?: string }) {
  return (
    <Surface className={`border-st-warn/50 flex flex-col gap-2 p-4 ${className ?? ''}`}>
      <h3 className='text-st-fg flex items-center gap-1.5 text-sm font-semibold'>
        <ListChecks className='text-st-warn h-4 w-4' /> This map needs a term list first
      </h3>
      <p className='text-st-muted text-sm'>Snap the slide or type the terms, then grade or draw again.</p>
      {onEnter && (
        <ActionButton className='min-h-10 self-start px-3' variant='primary' onClick={onEnter}>
          <NotebookPen className='h-4 w-4' /> Add terms
        </ActionButton>
      )}
    </Surface>
  );
}

/** «See the full AI map (optional extras)» — folded by default when she would not deduct for any of it. */
export function OptionalExtras({ folded, children }: { folded: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!folded);

  return (
    <div className='flex flex-col gap-3'>
      <button
        aria-expanded={open}
        className='text-st-fg hover:bg-st-raised rounded-st flex min-h-10 items-center gap-1.5 self-start px-2 text-sm font-medium'
        type='button'
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown className='text-st-muted h-4 w-4' />
        ) : (
          <ChevronRight className='text-st-muted h-4 w-4' />
        )}
        See the full AI map <span className='text-st-muted font-normal'>(optional extras)</span>
      </button>
      {open && children}
    </div>
  );
}
