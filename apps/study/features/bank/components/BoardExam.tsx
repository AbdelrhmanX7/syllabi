import type { AttemptDone } from '../api';
import type { BoardPaper } from '../lib/boardPaper';
import type { BoardSession as Session } from '../lib/boardSession';
import type { WhiteboardDocument, WhiteboardStorage } from '@repo/whiteboard-core';
import type { MergeOverlaysResult } from '@repo/whiteboard-react';
import type { AttemptVerdict, Question } from '@/lib/api/types';

import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, NotebookPen, Send } from 'lucide-react';

import { attemptQuestion } from '../api';
import { boardAnswers } from '../lib/boardGrade';
import { BOARD_EXAM_MAX, buildBoardPaper, isBoardGradable } from '../lib/boardPaper';
import { readBoardSession, writeBoardSession as writeSession } from '../lib/boardSession';
import { resultLabel, resultTone } from '../lib/verdict';

import { Markdown } from './Markdown';
import { VerdictPanel } from './VerdictPanel';

import { NotebookBoard } from '@/components/notebook/NotebookBoard';
import { ActionButton, Badge, ErrorNote } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';
import { createPage } from '@/lib/api/endpoints';
import { rememberPages } from '@/lib/notebooks/pages-cache';
import { buildPdfNotebookDocument, restorePdfAsset } from '@/lib/notebooks/pdf-import';

/**
 * Board exam: the questions on screen become one notebook board — a page per question, typeset at
 * the top — so he answers with the real pen tools. Submit sweeps every page and the AI grades each
 * question from his ink drawn over the question (`POST /questions/:id/attempt`, one at a time).
 * The board is a `solve` page, so it syncs like any notebook and the session survives a restart.
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
  onAttempted?: (question: Question, done: AttemptDone) => void;
  onExit: () => void;
}

export function BoardExam({ questions, classId, onAttempted, onExit }: BoardExamProps) {
  const [session, setSession] = useState<Session | null>(() => (questions ? null : readBoardSession()));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [graded, setGraded] = useState<Graded[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const paperRef = useRef<BoardPaper | null>(null);
  const overlaysRef = useRef<(() => Promise<MergeOverlaysResult | null>) | null>(null);
  const selection = useMemo(() => boardSelection(questions ?? []), [questions]);

  const paperFor = useCallback(async (current: Session) => {
    if (!paperRef.current) {
      paperRef.current = await buildBoardPaper(current.questions, current.title, (done, total) =>
        setProgress(`Typesetting questions ${done}/${total}`),
      );
    }

    return paperRef.current;
  }, []);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const title = `Board exam · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
      const page = await createPage({ classId, title, kind: 'solve' });
      const next: Session = { pageId: page.id, title, classId, startedAt: Date.now(), questions: selection.picked };

      rememberPages([page]);
      paperRef.current = null;
      writeSession(next);
      setSession(next);
    } catch (failure) {
      setError(describeError(failure, 'Could not start the board exam'));
    } finally {
      setStarting(false);
    }
  };

  const seed = useCallback(
    async (storage: WhiteboardStorage): Promise<WhiteboardDocument | null> => {
      if (!session) return null;
      const paper = await paperFor(session);
      const url = URL.createObjectURL(paper.file);

      try {
        return await buildPdfNotebookDocument({
          pageId: session.pageId,
          title: session.title,
          fileUrl: url,
          fileName: paper.file.name,
          storage,
          onProgress: (value) => setProgress(`Preparing the board ${Math.round(value * 100)}%`),
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [paperFor, session],
  );

  const restore = useCallback(
    async (storage: WhiteboardStorage, assetId: string) => {
      if (!session) return;
      const paper = await paperFor(session);
      const url = URL.createObjectURL(paper.file);

      try {
        await restorePdfAsset({ assetId, fileUrl: url, fileName: paper.file.name, storage });
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [paperFor, session],
  );

  const submit = async () => {
    if (!session) return;
    setSubmitting(true);
    setError(null);
    try {
      let overlays = await overlaysRef.current?.();

      // A page switch can supersede the sweep — one retry.
      if (!overlays) overlays = await overlaysRef.current?.();
      if (!overlays) throw new Error('The board is not ready yet — try again in a moment');

      const answers = await boardAnswers(overlays, (await paperFor(session)).pages);
      const byId = new Map(session.questions.map((question) => [question.id, question]));
      const rows: Graded[] = answers.flatMap(({ questionId, inkPngB64 }) => {
        const question = byId.get(questionId);

        return question
          ? [
              {
                question,
                state: inkPngB64 ? 'pending' : 'blank',
                reading: null,
                verdict: null,
                done: null,
                error: null,
              },
            ]
          : [];
      });
      const timeMs = Math.round((Date.now() - session.startedAt) / Math.max(1, rows.length));
      const patch = (index: number, change: Partial<Graded>) =>
        setGraded((current) => current?.map((row, at) => (at === index ? { ...row, ...change } : row)) ?? null);

      setGraded(rows);
      for (const [index, answer] of answers.entries()) {
        const row = rows[index];

        if (!row || !answer.inkPngB64) continue;
        patch(index, { state: 'grading' });
        try {
          await attemptQuestion(
            answer.questionId,
            { inkPngB64: answer.inkPngB64, timeMs },
            {
              onReading: (reading) => patch(index, { reading }),
              onVerdict: (verdict) => patch(index, { verdict }),
              onDone: (done) => {
                patch(index, { done });
                onAttempted?.(row.question, done);
              },
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

  if (graded) return <BoardResults rows={graded} submitting={submitting} onExit={onExit} />;

  if (session) {
    return (
      <div className='bg-st-bg fixed inset-0 z-50'>
        <NotebookBoard
          buildMergeOverlaysRef={overlaysRef}
          pageId={session.pageId}
          pdfLayout='paged'
          restorePdfAsset={restore}
          seed={seed}
          seedProgress={progress}
          title={session.title}
          topRight={
            <>
              <ActionButton
                disabled={submitting}
                title='Close this board exam without grading (the board stays in your notebook)'
                onClick={() => {
                  writeSession(null);
                  onExit();
                }}
              >
                Discard
              </ActionButton>
              <ActionButton loading={submitting} variant='primary' onClick={() => void submit()}>
                <Send className='h-4 w-4' /> {submitting ? 'Reading your board…' : 'Submit for AI review'}
              </ActionButton>
            </>
          }
          onBack={onExit}
        />
        {error ? (
          <div className='absolute inset-x-4 top-16 z-10 mx-auto max-w-lg'>
            <ErrorNote message={error} onRetry={() => void submit()} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className='mx-auto flex max-w-xl flex-col gap-4'>
      <ActionButton className='self-start' onClick={onExit}>
        <ArrowLeft className='h-4 w-4' /> Back
      </ActionButton>
      <h1 className='text-st-fg text-2xl font-semibold'>Board exam</h1>
      <p className='text-st-muted text-sm'>
        {selection.picked.length} question{selection.picked.length === 1 ? '' : 's'} on a notebook board, one per page.
        Answer with the pen, then submit — the AI reviews every answer.
        {selection.notGradable ? ` ${selection.notGradable} matching / fill-in questions stay out for now.` : ''}
        {selection.overCap ? ` Only the first ${BOARD_EXAM_MAX} fit on one board.` : ''}
      </p>
      {error ? <ErrorNote message={error} /> : null}
      <ActionButton
        className='self-start'
        disabled={!selection.picked.length}
        loading={starting}
        variant='primary'
        onClick={() => void start()}
      >
        <NotebookPen className='h-4 w-4' /> Open the board
      </ActionButton>
    </div>
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
          <ArrowLeft className='h-4 w-4' /> Bank
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
