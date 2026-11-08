import type { ConceptChip } from './workspace-state';

import { AlertTriangle, Check, Circle, NotebookText } from 'lucide-react';

import { chipProgress } from './workspace-state';

/**
 * The professor's concept list across the top of the workspace. He ticks a chip as he places the term
 * on his map. Once the notes digest is in, a term his notes never mention gets a «not in notes» mark
 * (take it from the slide), and a term worded unlike hers gets a dot.
 */
export interface ConceptStripProps {
  chips: ConceptChip[];
  onToggle: (term: string) => void;
}

export function ConceptStrip({ chips, onToggle }: ConceptStripProps) {
  const { placed, total } = chipProgress(chips);

  return (
    <div className='flex min-w-0 items-start gap-2'>
      <span
        className={`mt-2 shrink-0 rounded-sm px-2.5 py-1 text-xs font-semibold tabular-nums ${
          total > 0 && placed === total ? 'bg-st-ok/15 text-st-ok' : 'bg-st-raised text-st-muted'
        }`}
        title='Terms placed on your map'
      >
        {placed}/{total}
      </span>
      <div className='flex min-w-0 flex-1 flex-wrap gap-1.5'>
        {total === 0 && <span className='text-st-muted px-1 text-sm'>No concept list yet.</span>}
        {chips.map((chip) => {
          const on = chip.state === 'placed';
          const missing = chip.state === 'missing-from-notes';

          return (
            <button
              key={chip.term}
              aria-pressed={on}
              className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors ${
                on
                  ? 'border-st-ok/50 bg-st-ok/10 text-st-ok'
                  : missing
                    ? 'border-st-warn/50 bg-st-warn/10 text-st-fg hover:bg-st-warn/15'
                    : 'border-st-line bg-st-surface text-st-fg hover:bg-st-raised'
              }`}
              title={
                on
                  ? 'On your map — tap to untick'
                  : missing
                    ? 'Not in your notes — take it from the slide'
                    : chip.differs
                      ? 'Your notes word this differently from the reference'
                      : 'Tap when it is on your map'
              }
              type='button'
              onClick={() => onToggle(chip.term)}
            >
              {on ? <Check className='h-3.5 w-3.5' strokeWidth={2.5} /> : <Circle className='h-3.5 w-3.5 opacity-60' />}
              {chip.term}
              {missing && !on && (
                <span className='text-st-muted inline-flex items-center gap-1 text-xs font-medium'>
                  <AlertTriangle className='text-st-warn h-3 w-3' /> not in notes
                </span>
              )}
              {chip.differs && !on && <span aria-hidden className='bg-st-accent h-1.5 w-1.5 rounded-full' />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The professor's leading questions for the lecture (guide first, then the ones found in his notes). */
export function QuestionsList({ questions, answers }: { questions: string[]; answers: Map<string, string | null> }) {
  return (
    <ol className='flex flex-col gap-2'>
      {questions.map((question, index) => {
        const answer = answers.get(question);

        return (
          <li key={question} className='flex gap-2.5 text-sm'>
            <span className='text-st-muted w-5 shrink-0 text-right tabular-nums'>{index + 1}.</span>
            <div className='min-w-0'>
              <p className='text-st-fg font-medium'>{question}</p>
              {answer && (
                <p className='text-st-muted mt-0.5 flex gap-1 text-xs'>
                  <NotebookText className='mt-0.5 h-3.5 w-3.5 shrink-0' /> {answer}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
