import type { AttemptOutcome } from './SolveView';
import type { Question, StudyClass } from '@/lib/api/types';

import React, { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, RefreshCw, Trophy } from 'lucide-react';

import { listQuestions, reviewNext } from '../api';
import { useLoad } from '../hooks/useLoad';
import { addToTally, emptyTally, formatClock } from '../lib/verdict';

import { SolveView } from './SolveView';

/**
 * «Review now»: `GET /review/next` one question at a time; after each verdict the panel already
 * shows the next-due info, «Next» advances, and the end screen tallies the session.
 * With `topic` set it drills that topic instead (questions filtered by topic, due first).
 */

export interface ReviewSessionProps {
  classId?: string | null;
  topic?: string | null;
  classes: StudyClass[];
  onExit: () => void;
  limit?: number;
  /** Practise exactly these (picked or filtered in the bank), in this order. */
  picked?: Question[] | null;
}

export function ReviewSession({ classId, topic, classes, onExit, limit = 20, picked }: ReviewSessionProps) {
  const queue = useLoad<Question[]>(async () => {
    if (picked?.length) return picked;
    if (topic) {
      const page = await listQuestions({ classId: classId ?? undefined, topic, limit });
      const now = Date.now();

      return [...page.items].sort((a, b) => {
        const dueA = Date.parse(a.srs.dueAt) <= now ? 0 : 1;
        const dueB = Date.parse(b.srs.dueAt) <= now ? 0 : 1;

        return dueA - dueB || a.stats.mastery - b.stats.mastery;
      });
    }

    return reviewNext(classId ?? undefined, limit);
  }, [classId, topic, limit, picked]);
  const [index, setIndex] = useState(0);
  const [tally, setTally] = useState(emptyTally());
  const [answered, setAnswered] = useState(false);
  const [finished, setFinished] = useState(false);
  const questions = queue.data ?? [];
  const sessionTitle = picked?.length ? 'Practice' : topic ? `Drill · ${topic}` : 'Review';
  const current = questions[index] ?? null;
  const classById = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);

  const onAttempted = useCallback((outcome: AttemptOutcome) => {
    setTally((t) => addToTally(t, outcome.result, outcome.timeMs));
    setAnswered(true);
  }, []);

  const advance = () => {
    setAnswered(false);
    if (index + 1 >= questions.length) setFinished(true);
    else setIndex(index + 1);
  };

  const restart = () => {
    setIndex(0);
    setTally(emptyTally());
    setAnswered(false);
    setFinished(false);
    queue.reload();
  };

  if (queue.loading) {
    return (
      <Shell title={sessionTitle} onExit={onExit}>
        <p className='p-6 text-center text-sm text-st-muted'>Loading your queue…</p>
      </Shell>
    );
  }
  if (queue.error) {
    return (
      <Shell title='Review' onExit={onExit}>
        <p className='p-6 text-center text-sm text-st-danger'>{queue.error}</p>
      </Shell>
    );
  }
  if (!questions.length) {
    return (
      <Shell title={sessionTitle} onExit={onExit}>
        <div className='flex flex-col items-center gap-3 p-10 text-center'>
          <Trophy className='h-10 w-10 text-st-ok' />
          <p className='text-lg font-semibold text-st-fg'>Nothing due</p>
          <p className='text-sm text-st-muted'>Add questions or come back when the next review lands.</p>
        </div>
      </Shell>
    );
  }
  if (finished || !current) {
    const accuracy = tally.total ? Math.round(((tally.right + tally.partial * 0.5) / tally.total) * 100) : 0;

    return (
      <Shell title='Session done' onExit={onExit}>
        <div className='mx-auto flex max-w-md flex-col items-center gap-4 p-8 text-center'>
          <Trophy className='h-12 w-12 text-st-warn' />
          <p className='text-3xl font-semibold tabular-nums text-st-fg'>{accuracy}%</p>
          <p className='text-sm text-st-muted'>
            {tally.total} question{tally.total === 1 ? '' : 's'} in {formatClock(tally.timeMs)}
          </p>
          <div className='grid w-full grid-cols-3 gap-2 text-center'>
            <Stat label='Right' tone='text-st-ok' value={tally.right} />
            <Stat label='Partial' tone='text-st-warn' value={tally.partial} />
            <Stat label='Wrong' tone='text-st-danger' value={tally.wrong} />
          </div>
          <div className='mt-2 flex gap-2'>
            <button
              className='flex h-12 items-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent px-5 text-sm font-semibold text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
              type='button'
              onClick={restart}
            >
              <RefreshCw className='h-4 w-4' /> Review more
            </button>
            <button
              className='flex h-12 items-center gap-2 rounded-st border-2 border-st-clay-edge bg-st-surface px-5 text-sm font-medium text-st-fg shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
              type='button'
              onClick={onExit}
            >
              Done
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      right={
        <span className='text-xs tabular-nums text-st-muted'>
          {index + 1} / {questions.length}
        </span>
      }
      title={sessionTitle}
      onExit={onExit}
    >
      <div className='mb-3 h-1.5 w-full overflow-hidden rounded-full bg-st-raised'>
        <div
          className='h-full rounded-full bg-st-accent transition-all'
          style={{ width: `${((index + (answered ? 1 : 0)) / questions.length) * 100}%` }}
        />
      </div>
      <SolveView
        allowSimilar={false}
        footer={
          <button
            className='ms-auto flex h-14 items-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent px-6 text-base font-semibold text-st-accent-fg disabled:opacity-40 shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
            type='button'
            onClick={advance}
          >
            {answered ? (index + 1 >= questions.length ? 'Finish' : 'Next') : 'Skip'}{' '}
            <ChevronRight className='h-5 w-5' />
          </button>
        }
        question={current}
        studyClass={classById.get(current.classId) ?? null}
        onAttempted={onAttempted}
      />
    </Shell>
  );
}

function Shell({
  title,
  right,
  onExit,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  onExit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className='mx-auto w-full max-w-5xl'>
      <div className='mb-3 flex items-center gap-2'>
        <button
          aria-label='Exit review'
          className='flex h-11 w-11 items-center justify-center rounded-xl text-st-fg hover:bg-st-raised'
          type='button'
          onClick={onExit}
        >
          <ArrowLeft className='h-5 w-5' />
        </button>
        <h2 className='text-base font-semibold text-st-fg'>{title}</h2>
        <span className='flex-1' />
        {right}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className='rounded-2xl border border-st-line p-3'>
      <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className='text-xs text-st-muted'>{label}</p>
    </div>
  );
}
