import type { AttemptDone } from '../api';
import type { BoardSession as Session } from '../lib/boardSession';
import type { MergeOverlaysResult } from '@repo/whiteboard-react';
import type { AttemptVerdict, Question } from '@/lib/api/types';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { ArrowLeft, Check, ChevronDown, NotebookPen, Send } from 'lucide-react';

import { attemptQuestion } from '../api';
import { boardAnswers } from '../lib/boardGrade';
import { BOARD_EXAM_MAX, buildBoardPaper, isBoardGradable } from '../lib/boardPaper';
import { readBoardSession, writeBoardSession as writeSession } from '../lib/boardSession';
import { resultLabel, resultTone } from '../lib/verdict';

import { Markdown } from './Markdown';
import { VerdictPanel } from './VerdictPanel';

import { ActionButton, Badge, ErrorNote } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { importNotebook } from '@/lib/notebooks/import-notebook';

/**
 * Board exam: the questions become a normal notebook — a page per question, typeset at the top —
 * opened on the everyday notebook board. Submit sweeps every page and the AI grades each question
 * from the ink on its page (`POST /questions/:id/attempt`, one at a time). The open exam is kept on
 * the device, so «Submit for review» survives a restart.
 */

/** Which of `questions` go on the board, and why the rest do not. */
export function boardSelection(questions: Question[]) {
  const gradable = questions.filter(isBoardGradable);

  return {
    picked: gradable.slice(0, BOARD_EXAM_MAX),
    notGradable: questions.length - gradable.length,
    overCap: Math.max(0, gradable.length - BOARD_EXAM_MAX),
  };
}

interface Graded {
  question: Question;
  state: 'pending' | 'grading' | 'done' | 'blank' | 'error';
  reading: string | null;
  verdict: AttemptVerdict | null;
  done: AttemptDone | null;
  error: string | null;
}

export interface BoardExamProps {
  /** A new exam from these questions; omit to resume the saved one. */
  questions?: Question[];
  classId: string | null;
  onExit: () => void;
}

const notebookHref = (pageId: string, classId: string | null) =>
  `/notebook/?id=${encodeURIComponent(pageId)}${classId ? `&classId=${encodeURIComponent(classId)}` : ''}`;

/**
 * The start screen. «Open the board» typesets the questions into a PDF, makes it a normal notebook
 * (one question per page) and opens it on the everyday notebook board, where «Submit for review»
 * ({@link BoardExamSubmit}) grades it.
 */
export function BoardExam({ questions, classId, onExit }: BoardExamProps) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const selection = useMemo(() => boardSelection(questions ?? []), [questions]);
  const saved = useMemo(() => (questions ? null : readBoardSession()), [questions]);

  // Resume: the saved exam is just a notebook — open it.
  useEffect(() => {
    if (saved) void router.replace(notebookHref(saved.pageId, saved.classId));
  }, [router, saved]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const title = `Board exam · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
      const paper = await buildBoardPaper(selection.picked, title, (done, total) =>
        setProgress(`Typesetting questions ${done}/${total}`),
      );
      const page = await importNotebook({
        classId,
        title,
        input: { kind: 'pdf', source: { name: paper.file.name, mime: 'application/pdf', load: () => paper.file } },
        onProgress: setProgress,
      });

      writeSession({ pageId: page.id, title, classId, startedAt: Date.now(), questions: selection.picked });
      await router.push(notebookHref(page.id, classId));
    } catch (failure) {
      setError(describeError(failure, 'Could not start the board exam'));
      setStarting(false);
    }
  };

  if (saved) return null;

  return (
    <div className='mx-auto flex max-w-xl flex-col gap-4'>
      <ActionButton className='self-start' onClick={onExit}>
        <ArrowLeft className='h-4 w-4' /> Back
      </ActionButton>
      <h1 className='text-st-fg text-2xl font-semibold'>Board exam</h1>
      <p className='text-st-muted text-sm'>
        {selection.picked.length} question{selection.picked.length === 1 ? '' : 's'} in a new notebook, one per page.
        Answer with the pen, then tap «Submit» at the top.
        {selection.notGradable ? ` ${selection.notGradable} matching / fill-in questions stay out for now.` : ''}
        {selection.overCap ? ` Only the first ${BOARD_EXAM_MAX} fit in one notebook.` : ''}
      </p>
      {error ? <ErrorNote message={error} /> : null}
      <ActionButton
        className='self-start'
        disabled={!selection.picked.length}
        loading={starting}
        variant='primary'
        onClick={() => void start()}
      >
        <NotebookPen className='h-4 w-4' /> {starting && progress ? progress : 'Open the board'}
      </ActionButton>
    </div>
  );
}

/**
 * «Submit for review» in the notebook's top bar, shown only on the notebook of the open board exam.
 * Sweeps every page, grades each question from the ink on its page(s), shows the review over the
 * notebook. The notebook itself stays like any other.
 */
export function BoardExamSubmit({
  pageId,
  overlaysRef,
}: {
  pageId: string;
  overlaysRef: React.MutableRefObject<(() => Promise<MergeOverlaysResult | null>) | null>;
}) {
  const [session, setSession] = useState<Session | null>(() => {
    const saved = readBoardSession();

    return saved?.pageId === pageId ? saved : null;
  });
  const [graded, setGraded] = useState<Graded[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = readBoardSession();

    setSession(saved?.pageId === pageId ? saved : null);
  }, [pageId]);

  const submit = async () => {
    if (!session) return;
    setSubmitting(true);
    setError(null);
    try {
      let overlays = await overlaysRef.current?.();

      // A page switch can supersede the sweep — one retry.
      if (!overlays) overlays = await overlaysRef.current?.();
      if (!overlays) throw new Error('The board is not ready yet — try again in a moment');

      const paper = await buildBoardPaper(session.questions, session.title);
      const answers = await boardAnswers(overlays, paper.pages);
      const byId = new Map(session.questions.map((question) => [question.id, question]));
      const rows: Graded[] = answers.flatMap(({ questionId, inkPngB64 }) => {
        const question = byId.get(questionId);

        return question
          ? [{ question, state: inkPngB64 ? 'pending' : 'blank', reading: null, verdict: null, done: null, error: null }]
          : [];
      });
      const timeMs = Math.round((Date.now() - session.startedAt) / Math.max(1, rows.length));
      const patch = (index: number, change: Partial<Graded>) =>
        setGraded((current) => current?.map((row, at) => (at === index ? { ...row, ...change } : row)) ?? null);

      setGraded(rows);
      for (const [index, answer] of answers.entries()) {
        if (!rows[index] || !answer.inkPngB64) continue;
        patch(index, { state: 'grading' });
        try {
          await attemptQuestion(
            answer.questionId,
            { inkPngB64: answer.inkPngB64, timeMs },
            {
              onReading: (reading) => patch(index, { reading }),
              onVerdict: (verdict) => patch(index, { verdict }),
              onDone: (done) => patch(index, { done }),
            },
          );
          patch(index, { state: 'done' });
        } catch (failure) {
          patch(index, { state: 'error', error: describeError(failure, 'Could not grade this answer') });
        }
      }
      writeSession(null);
    } catch (failure) {
      setError(describeError(failure, 'Could not submit the board'));
    } finally {
      setSubmitting(false);
    }
  };

  if (graded) {
    return (
      <div className='bg-st-bg fixed inset-0 z-[60] overflow-y-auto px-4 py-4'>
        <BoardResults
          rows={graded}
          submitting={submitting}
          onExit={() => {
            setGraded(null);
            setSession(null);
          }}
        />
      </div>
    );
  }
  if (!session) return null;

  return (
    <>
      <ActionButton
        aria-label='Submit for review'
        className='shrink-0'
        loading={submitting}
        variant='primary'
        onClick={() => void submit()}
      >
        <Send className='h-4 w-4' /> {submitting ? 'Reading…' : 'Submit'}
      </ActionButton>
      {error ? (
        <div className='fixed inset-x-4 top-16 z-[60] mx-auto max-w-lg'>
          <ErrorNote message={error} onRetry={() => void submit()} />
        </div>
      ) : null}
    </>
  );
}

function BoardResults({ rows, submitting, onExit }: { rows: Graded[]; submitting: boolean; onExit: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const finished = rows.filter((row) => row.verdict);
  const answered = rows.filter((row) => row.state !== 'blank').length;
  const blank = rows.length - answered;
  const points = finished.reduce(
    (sum, row) => sum + (row.verdict?.result === 'right' ? 1 : row.verdict?.result === 'partial' ? 0.5 : 0),
    0,
  );

  return (
    <div className='mx-auto flex max-w-3xl flex-col gap-3'>
      <div className='flex items-center gap-3'>
        <ActionButton disabled={submitting} onClick={onExit}>
          <ArrowLeft className='h-4 w-4' /> Back
        </ActionButton>
        <h1 className='text-st-fg flex-1 text-xl font-semibold'>Board exam review</h1>
        <span className='text-st-fg text-lg font-semibold'>
          {submitting
            ? `Grading ${finished.length}/${answered}…`
            : `${points} / ${answered}${blank ? ` · ${blank} not answered` : ''}`}
        </span>
      </div>
      <ul className='flex flex-col gap-2'>
        {rows.map((row, index) => {
          const expanded = open === row.question.id;
          const tone = resultTone(row.verdict?.result ?? null);

          return (
            <li key={row.question.id} className='rounded-st border-st-line bg-st-surface border'>
              <button
                className='flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left'
                type='button'
                onClick={() => setOpen(expanded ? null : row.question.id)}
              >
                <span className='text-st-muted w-6 shrink-0 text-sm font-semibold'>{index + 1}</span>
                <span className='text-st-fg min-w-0 flex-1 truncate text-sm'>{row.question.topic}</span>
                {row.state === 'blank' ? (
                  <Badge tone='warn'>Not answered</Badge>
                ) : row.state === 'error' ? (
                  <Badge tone='danger'>Not graded</Badge>
                ) : row.verdict ? (
                  <span className={`text-sm font-semibold ${tone.text}`}>
                    {row.verdict.result === 'right' ? <Check className='inline h-4 w-4' /> : null}{' '}
                    {resultLabel(row.verdict.result)}
                  </span>
                ) : (
                  <span className='text-st-muted text-sm'>{row.state === 'grading' ? 'Reviewing…' : 'Waiting'}</span>
                )}
                <ChevronDown className={`text-st-muted h-4 w-4 shrink-0 transition ${expanded ? 'rotate-180' : ''}`} />
              </button>
              {expanded ? (
                <div className='border-st-line space-y-3 border-t px-4 py-3'>
                  <Markdown text={row.question.stem} />
                  {row.state === 'blank' ? (
                    <p className='text-st-muted text-sm'>Nothing was written on this page.</p>
                  ) : (
                    <VerdictPanel
                      busy={row.state === 'grading'}
                      done={row.done}
                      error={row.error}
                      fallbackSolution={{ answer: row.question.answer, steps: row.question.solutionSteps }}
                      reading={row.reading}
                      verdict={row.verdict}
                    />
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
