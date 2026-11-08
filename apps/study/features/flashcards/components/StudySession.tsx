import type { Grade, SessionTally } from '../lib/deck';
import type { Question } from '@/lib/api/types';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw, X } from 'lucide-react';

import { gradeFlashcard } from '../api';
import { EMPTY_TALLY, GRADES, gradeForKey, recallPercent, tallyAdd } from '../lib/deck';

import { ActionButton, Badge, ErrorNote } from '@/components/ui/primitives';
import { Markdown } from '@/features/bank/components/Markdown';
import { describeError } from '@/lib/api/errors';

const GRADE_VARIANT: Record<Grade, 'secondary' | 'primary' | 'soft'> = {
  again: 'secondary',
  hard: 'secondary',
  good: 'primary',
  easy: 'soft',
};

/** Typing in a field, or a modal open, keeps the shortcuts out of the way. */
function shortcutsBlocked(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;

  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return true;

  return Boolean(document.querySelector('[role="dialog"][aria-modal]'));
}

/**
 * One card at a time: tap / Space flips it, then Again · Hard · Good · Easy (keys 1–4) records the
 * self-grade through the bank's attempt API in the background and moves on. The queue is a snapshot
 * taken when the session starts; the decks refresh when it ends.
 */
export function StudySession({
  cards,
  title,
  onExit,
}: {
  cards: Question[];
  title: string;
  onExit: () => void;
}) {
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState(cards);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [tally, setTally] = useState<SessionTally>(EMPTY_TALLY);
  const [error, setError] = useState<string | null>(null);
  const shownAt = useRef(Date.now());
  /** Ids graded «Again» this round — «Review again» replays them. */
  const missed = useRef(new Set<string>());
  const done = index >= queue.length;
  const card = done ? null : queue[index];

  /** Grades save one after another; the decks refresh once the last one lands. */
  const chain = useRef<Promise<void>>(Promise.resolve());

  // Refresh the decks once the session is over (or left early) and every grade has saved.
  useEffect(
    () => () => {
      void chain.current.finally(() => {
        void queryClient.invalidateQueries({ queryKey: ['study', 'questions'] });
        void queryClient.invalidateQueries({ queryKey: ['study', 'mastery'] });
      });
    },
    [queryClient],
  );

  const flip = useCallback(() => setFlipped((value) => !value), []);

  const grade = useCallback(
    (value: Grade) => {
      if (!card || !flipped) return;
      const timeMs = Date.now() - shownAt.current;

      if (value === 'again') missed.current.add(card.id);

      chain.current = chain.current
        .then(async () => {
          // Offline the grade is kept on the device and sent when the server is back.
          await gradeFlashcard(card, value, timeMs);
        })
        .catch((err: unknown) => setError(describeError(err, 'A grade didn’t save — that card stays due')));
      setTally((current) => tallyAdd(current, value));
      setFlipped(false);
      setIndex((current) => current + 1);
      shownAt.current = Date.now();
    },
    [card, flipped],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || shortcutsBlocked(event)) return;
      if (done) return;
      const onButton = (event.target as HTMLElement | null)?.tagName === 'BUTTON';

      if (event.key === ' ' || (event.key === 'Enter' && !onButton)) {
        // A focused button would also click on Space / Enter and flip twice.
        event.preventDefault();
        flip();

        return;
      }
      const picked = gradeForKey(event.key);

      if (picked && flipped) {
        event.preventDefault();
        grade(picked);
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [done, flip, flipped, grade]);

  const restart = () => {
    const ids = missed.current;

    setQueue((current) => current.filter((item) => ids.has(item.id)));
    missed.current = new Set();
    setIndex(0);
    setFlipped(false);
    setTally(EMPTY_TALLY);
    setError(null);
    shownAt.current = Date.now();
  };

  if (done) {
    const total = queue.length;
    const again = tally.again;

    return (
      <section className='flex flex-col gap-4 pb-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <h2 className='text-st-fg font-display text-lg font-bold'>Session done</h2>
          <span className='text-st-muted text-sm'>
            {title} · {total} card{total === 1 ? '' : 's'} · {recallPercent(tally)}% recalled
          </span>
        </div>
        <div className='flex flex-wrap gap-2'>
          {GRADES.map(({ grade: g, label }) => (
            <Badge key={g} tone={g === 'again' ? 'warn' : g === 'hard' ? 'neutral' : g === 'good' ? 'ok' : 'accent'}>
              {label} {tally[g]}
            </Badge>
          ))}
        </div>
        {error && <ErrorNote message={error} />}
        <div className='flex flex-wrap gap-3'>
          {again > 0 && (
            <ActionButton variant='primary' onClick={restart}>
              <RotateCcw className='h-4 w-4' /> Review {again} again
            </ActionButton>
          )}
          <ActionButton variant={again > 0 ? 'secondary' : 'primary'} onClick={onExit}>
            Back to decks
          </ActionButton>
        </div>
      </section>
    );
  }

  return (
    <section className='flex flex-col gap-4 pb-2'>
      <div className='flex items-center gap-3'>
        <span className='text-st-fg text-sm font-semibold tabular-nums'>
          {index + 1} / {queue.length}
        </span>
        <span className='text-st-muted min-w-0 flex-1 truncate text-sm' title={title}>
          {title}
          {card && !title.endsWith(card.topic) ? ` · ${card.topic}` : ''}
        </span>
        <ActionButton aria-label='End session' className='min-h-10 px-3' variant='ghost' onClick={onExit}>
          <X className='h-4 w-4' /> End
        </ActionButton>
      </div>

      {card && <FlipCard key={card.id} card={card} flipped={flipped} onFlip={flip} />}

      {error && <ErrorNote message={error} />}

      {flipped ? (
        <div className='grid grid-cols-4 gap-3'>
          {GRADES.map(({ grade: g, label, key }) => (
            <ActionButton key={g} className='px-2' variant={GRADE_VARIANT[g]} onClick={() => grade(g)}>
              <span className='truncate'>{label}</span>
              <span className='hidden text-xs opacity-60 sm:inline'>{key}</span>
            </ActionButton>
          ))}
        </div>
      ) : (
        <ActionButton variant='primary' onClick={flip}>
          Show answer <span className='hidden text-xs opacity-70 sm:inline'>Space</span>
        </ActionButton>
      )}
    </section>
  );
}

/**
 * The card: a 3D flip on transform only (≤250ms), faces stacked in one grid cell so the card is as
 * tall as its longer side. Reduced motion → the faces swap instantly.
 */
function FlipCard({ card, flipped, onFlip }: { card: Question; flipped: boolean; onFlip: () => void }) {
  const face =
    'rounded-st-lg border-st-clay-edge bg-st-surface shadow-clay flex min-h-[220px] flex-col gap-2 border-2 px-5 py-4 [-webkit-backface-visibility:hidden] [backface-visibility:hidden] [grid-area:1/1]';

  return (
    <div className='[perspective:1400px]'>
      {/* Space / Enter flip through the session's window key handler. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
      <div
        aria-label={flipped ? 'Answer — tap to see the question' : 'Question — tap to see the answer'}
        className='grid cursor-pointer select-none transition-transform duration-[240ms] ease-out [transform-style:preserve-3d] motion-reduce:transition-none'
        role='button'
        style={{ transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}
        tabIndex={0}
        onClick={onFlip}
      >
        <div aria-hidden={flipped} className={face}>
          <span className='text-st-muted text-xs font-semibold uppercase tracking-wide'>Question</span>
          <div className='flex flex-1 items-center justify-center text-center'>
            <Markdown size='lg' text={card.stem} />
          </div>
        </div>
        <div aria-hidden={!flipped} className={`${face} [transform:rotateY(180deg)]`}>
          <span className='text-st-accent text-xs font-semibold uppercase tracking-wide'>Answer</span>
          <div className='flex flex-1 items-center justify-center text-center'>
            <Markdown size='lg' text={card.answer || 'No answer written yet.'} />
          </div>
        </div>
      </div>
    </div>
  );
}
