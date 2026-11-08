import type { TermMatch } from '../lib/terms';

import { Check, Circle, Quote, X } from 'lucide-react';

/**
 * The prompt terms pinned above the canvas. Before grading each chip is a manual tick (tap when the
 * term is on the map); after grading the AI's reading decides: found = green tick, missing = red.
 * The last chip, «Each term defined», is a manual tick (the grader cannot see intent). With no term
 * list only that chip shows.
 */
export interface TermChecklistProps {
  terms: string[];
  checked: Set<string>;
  onToggle: (term: string) => void;
  /** After a grade: what the model found per term. Null = not graded yet. */
  matches?: TermMatch[] | null;
  /** The 6th item: a short definition written under every term. */
  defined: boolean;
  onToggleDefined: () => void;
  disabled?: boolean;
}

export const DEFINED_LABEL = 'Each term defined';
export const DEFINED_HINT = 'Define every term: one line under each box.';

export function TermChecklist({
  terms,
  checked,
  onToggle,
  matches,
  defined,
  onToggleDefined,
  disabled = false,
}: TermChecklistProps) {
  const byTerm = new Map((matches ?? []).map((row) => [row.term, row]));
  const graded = matches !== null && matches !== undefined;
  const found = graded ? matches.filter((row) => row.node).length : checked.size;

  return (
    <div className='flex flex-wrap items-center gap-2'>
      {terms.length > 0 && (
        <span className='text-st-muted mr-1 text-xs font-medium uppercase tracking-wide'>
          Terms {found}/{terms.length}
        </span>
      )}
      {terms.map((term) => {
        const match = byTerm.get(term);
        const on = graded ? Boolean(match?.node) : checked.has(term);
        const tone = graded
          ? on
            ? 'border-st-ok/40 bg-st-ok/10 text-st-ok'
            : 'border-st-danger/40 bg-st-danger/10 text-st-danger'
          : on
            ? 'border-st-accent-lip bg-st-accent text-st-accent-fg'
            : 'border-st-line bg-st-surface text-st-fg hover:bg-st-raised';
        const Icon = graded ? (on ? Check : X) : on ? Check : Circle;

        return (
          <button
            key={term}
            aria-pressed={on}
            className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors disabled:cursor-default ${tone}`}
            disabled={disabled || graded}
            title={
              graded
                ? match?.node
                  ? `Read as “${match.node.label}”`
                  : 'Not found on the map'
                : 'Tap when it is on your map'
            }
            type='button'
            onClick={() => onToggle(term)}
          >
            <Icon className='h-3.5 w-3.5' strokeWidth={2.5} />
            {term}
          </button>
        );
      })}
      <span aria-hidden className='bg-st-line mx-1 h-5 w-px' />
      <button
        aria-pressed={defined}
        className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors ${
          defined
            ? 'border-st-accent bg-st-accent/10 text-st-accent'
            : 'border-st-accent/40 bg-st-surface text-st-fg hover:bg-st-raised'
        }`}
        disabled={disabled}
        title={DEFINED_HINT}
        type='button'
        onClick={onToggleDefined}
      >
        {defined ? <Check className='h-3.5 w-3.5' strokeWidth={2.5} /> : <Quote className='h-3.5 w-3.5' />}
        {DEFINED_LABEL}
      </button>
    </div>
  );
}
