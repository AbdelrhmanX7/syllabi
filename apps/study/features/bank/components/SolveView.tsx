import type { AttemptDone } from '../api';
import type { InkCanvasHandle } from './InkCanvas';
import type { AttemptInput, AttemptResult, AttemptVerdict, Question, StudyClass } from '@/lib/api/types';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Keyboard, PenLine, RefreshCw, Shuffle, Timer } from 'lucide-react';

import { attemptQuestion, similarQuestion } from '../api';
import { errorText } from '../hooks/useLoad';
import { useKatex } from '../lib/katex';
import {
  blankCount,
  blanksStarted,
  fillBlankPayload,
  isStructured,
  matchesStarted,
  matchingLefts,
  matchingPayload,
  pairsRevealed,
  stepMarks,
} from '../lib/questionTypes';
import { attemptErrorMessage, formatClock } from '../lib/verdict';

import { FillBlankStem } from './FillBlankStem';
import { InkCanvas } from './InkCanvas';
import { InlineMd } from './Markdown';
import { MatchingAnswer } from './MatchingAnswer';
import { QuestionCard } from './QuestionCard';
import { VerdictPanel } from './VerdictPanel';
import { useAiEnabled } from '@/hooks/useAiEnabled';

/**
 * The core screen: the question on top, the pen area below, «Check» sends the ink (or the typed /
 * chosen answer) to `/questions/:id/attempt` and the verdict renders step by step beside the ink.
 */

export interface AttemptOutcome {
  question: Question;
  result: AttemptResult;
  timeMs: number;
  done: AttemptDone;
}

export interface SolveViewProps {
  question: Question;
  studyClass?: StudyClass | null;
  onBack?: () => void;
  /** Fires once the attempt stream finishes (review sessions advance on this). */
  onAttempted?: (outcome: AttemptOutcome) => void;
  /** «Similar question» — on by default; exams and review turn it off. */
  allowSimilar?: boolean;
  /** Rendered under the verdict (e.g. the review session's «Next»). */
  footer?: React.ReactNode;
  /** Shows elapsed time since the question appeared. */
  showTimer?: boolean;
  className?: string;
}

type Mode = 'pen' | 'typed';

interface RunState {
  busy: boolean;
  reading: string | null;
  verdict: AttemptVerdict | null;
  done: AttemptDone | null;
  error: string | null;
  /** The error is a transient read failure (READ_TIMEOUT) — a plain retry is offered. */
  retryable: boolean;
}

const IDLE: RunState = { busy: false, reading: null, verdict: null, done: null, error: null, retryable: false };

const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export function SolveView({
  question,
  studyClass,
  onBack,
  onAttempted,
  allowSimilar = true,
  footer,
  showTimer = true,
  className = '',
}: SolveViewProps) {
  const aiOn = useAiEnabled();
  const katex = useKatex();
  const inkRef = useRef<InkCanvasHandle>(null);
  const startedAt = useRef(performance.now());
  const controller = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<Mode>(
    question.type === 'code_output' || question.type === 'code_write' ? 'typed' : 'pen',
  );
  const [typed, setTyped] = useState('');
  const [choice, setChoice] = useState<number | null>(null);
  const [matches, setMatches] = useState<Record<string, string>>({});
  const [blanks, setBlanks] = useState<string[]>([]);
  const [inkEmpty, setInkEmpty] = useState(true);
  const [run, setRun] = useState<RunState>(IDLE);
  const [revealing, setRevealing] = useState(false);
  const [similar, setSimilar] = useState<Question | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const isCode = question.type === 'code_output' || question.type === 'code_write';
  const isMcq = question.type === 'mcq';
  const isMatching = question.type === 'matching';
  const isFill = question.type === 'fill_blank';
  const structured = isStructured(question.type);
  const usesInk = !isCode && !structured && (mode === 'pen' || isMcq);
  const blanksTotal = useMemo(() => (isFill ? blankCount(question.stem) : 0), [isFill, question.stem]);

  // Fresh question → fresh state (the same component instance is reused across a review session).
  useEffect(() => {
    startedAt.current = performance.now();
    controller.current?.abort();
    setRun(IDLE);
    setTyped('');
    setChoice(null);
    setMatches({});
    setBlanks([]);
    setSimilar(null);
    setMode(question.type === 'code_output' || question.type === 'code_write' ? 'typed' : 'pen');
    inkRef.current?.setStrokes([]);
    setElapsed(0);
  }, [question.id, question.type]);

  useEffect(() => {
    if (!showTimer || run.verdict) return;
    const id = window.setInterval(() => setElapsed(performance.now() - startedAt.current), 1000);

    return () => window.clearInterval(id);
  }, [showTimer, run.verdict, question.id]);

  useEffect(() => () => controller.current?.abort(), []);

  const buildInput = useCallback(
    (reveal: boolean): AttemptInput | null => {
      const timeMs = Math.round(performance.now() - startedAt.current);
      const input: AttemptInput = { timeMs, reveal: reveal || undefined };
      const ink = inkRef.current && !inkRef.current.isEmpty() ? inkRef.current.rasterize() : null;

      if (isMatching) {
        if (!matchesStarted(matches)) return null;
        input.matches = matchingPayload(matchingLefts(question), matches).matches;
      } else if (isFill) {
        if (!blanksStarted(blanks)) return null;
        input.blanks = fillBlankPayload(blanks, blanksTotal).blanks;
      } else if (isMcq) {
        if (choice === null) return null;
        input.choice = choice;
        if (ink) input.inkPngB64 = ink;
      } else if (question.type === 'code_write') {
        if (!typed.trim()) return null;
        input.code = typed;
      } else if (question.type === 'code_output') {
        if (!typed.trim()) return null;
        input.typed = typed;
      } else if (mode === 'typed') {
        if (!typed.trim()) return null;
        input.typed = typed;
      } else {
        if (!ink) return null;
        input.inkPngB64 = ink;
      }

      return input;
    },
    [blanks, blanksTotal, choice, isFill, isMatching, isMcq, matches, mode, question, typed],
  );

  const canCheck =
    !run.busy &&
    (isMatching
      ? matchesStarted(matches)
      : isFill
        ? blanksStarted(blanks)
        : isMcq
          ? choice !== null
          : isCode || mode === 'typed'
            ? typed.trim().length > 0
            : !inkEmpty);

  const check = useCallback(
    async (reveal = false) => {
      const input = buildInput(reveal);

      if (!input) return;
      controller.current?.abort();
      const abort = new AbortController();

      controller.current = abort;
      if (reveal) setRevealing(true);
      setRun((current) => ({
        ...(reveal ? current : IDLE),
        busy: true,
        error: null,
        reading: reveal ? current.reading : null,
      }));
      let doneFrame: AttemptDone | null = null;
      let verdictFrame: AttemptVerdict | null = null;

      try {
        await attemptQuestion(
          question.id,
          input,
          {
            onReading: (text) => setRun((current) => ({ ...current, reading: text })),
            onVerdict: (verdict) => {
              verdictFrame = verdict;
              setRun((current) => ({ ...current, verdict }));
            },
            onDone: (done) => {
              doneFrame = done;
              setRun((current) => ({ ...current, done }));
            },
          },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setRun((current) => ({ ...current, busy: false }));
        if (!reveal && verdictFrame && doneFrame) {
          onAttempted?.({
            question,
            result: (verdictFrame as AttemptVerdict).result,
            timeMs: input.timeMs,
            done: doneFrame,
          });
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        const { message, retry } = attemptErrorMessage(error);

        setRun((current) => ({ ...current, busy: false, error: message, retryable: retry }));
      } finally {
        if (reveal) setRevealing(false);
      }
    },
    [buildInput, onAttempted, question],
  );

  const retry = () => {
    controller.current?.abort();
    setRun(IDLE);
    startedAt.current = performance.now();
    setElapsed(0);
  };

  const askSimilar = async () => {
    setSimilarBusy(true);
    try {
      let next: Question | null = null;

      await similarQuestion(question.id, (q) => {
        next = q;
      });
      if (next) setSimilar(next);
      else setRun((current) => ({ ...current, error: 'No similar question came back.' }));
    } catch (error) {
      setRun((current) => ({ ...current, error: errorText(error) }));
    } finally {
      setSimilarBusy(false);
    }
  };

  if (similar) {
    return (
      <SolveView
        allowSimilar={allowSimilar}
        className={className}
        footer={footer}
        question={similar}
        showTimer={showTimer}
        studyClass={studyClass}
        onAttempted={onAttempted}
        onBack={() => setSimilar(null)}
      />
    );
  }

  const fallbackSolution =
    question.solutionSteps.length || question.answer
      ? { answer: question.answer, steps: question.solutionSteps }
      : null;

  return (
    <div className={`mx-auto flex w-full max-w-5xl flex-col gap-4 ${className}`}>
      <div className='flex items-center gap-2'>
        {onBack ? (
          <button
            aria-label='Back'
            className='flex h-11 w-11 items-center justify-center rounded-xl text-st-fg hover:bg-st-raised'
            type='button'
            onClick={onBack}
          >
            <ArrowLeft className='h-5 w-5' />
          </button>
        ) : null}
        <span className='text-sm text-st-muted'>
          {question.source.kind === 'ai_similar' ? 'Similar question' : 'Solve'}
        </span>
        <span className='flex-1' />
        {showTimer ? (
          <span className='inline-flex items-center gap-1 rounded-sm bg-st-raised px-3 py-1 text-xs font-medium tabular-nums text-st-fg'>
            <Timer className='h-3.5 w-3.5' /> {formatClock(elapsed)}
          </span>
        ) : null}
      </div>

      <QuestionCard
        question={question}
        stem={
          isFill ? (
            <FillBlankStem
              disabled={Boolean(run.verdict)}
              marks={run.verdict ? stepMarks(run.verdict.steps, blanksTotal) : undefined}
              stem={question.stem}
              values={blanks}
              onChange={setBlanks}
            />
          ) : undefined
        }
        studyClass={studyClass}
        variant='full'
      />

      {isMatching ? (
        <MatchingAnswer
          disabled={Boolean(run.verdict)}
          marks={run.verdict ? stepMarks(run.verdict.steps, question.pairs?.length ?? 0) : undefined}
          question={question}
          showCorrect={Boolean(run.verdict?.solution) && pairsRevealed(question)}
          value={matches}
          onChange={setMatches}
        />
      ) : null}

      {isMcq && question.choices?.length ? (
        <div className='grid gap-2 sm:grid-cols-2'>
          {question.choices.map((text, index) => {
            const selected = choice === index;

            return (
              <button
                key={index}
                aria-pressed={selected}
                className={`flex min-h-14 items-start gap-3 rounded-2xl border p-3 text-left text-base transition ${
                  selected
                    ? 'border-st-accent-lip bg-st-accent text-st-accent-fg'
                    : 'border-st-line bg-st-surface text-st-fg hover:border-st-ink/50'
                } disabled:opacity-60`}
                disabled={Boolean(run.verdict)}
                type='button'
                onClick={() => setChoice(index)}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    selected ? 'bg-st-accent-fg/20' : 'bg-st-raised'
                  }`}
                >
                  {CHOICE_LETTERS[index] ?? index + 1}
                </span>
                <span className='min-w-0 flex-1 pt-0.5'>
                  <InlineMd katex={katex} text={text} />
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {isCode ? (
        <label className='block'>
          <span className='mb-1 block text-xs font-semibold uppercase tracking-wide text-st-muted'>
            {question.type === 'code_output' ? 'Exact output' : 'Your code'}
          </span>
          <textarea
            autoCapitalize='off'
            autoCorrect='off'
            className='min-h-[220px] w-full rounded-st border-2 border-st-control-edge bg-st-bg p-3 font-mono text-sm leading-6 text-st-fg outline-none focus:border-st-accent'
            disabled={Boolean(run.verdict)}
            placeholder={question.type === 'code_output' ? 'What does the program print?' : '// write your answer'}
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      ) : null}

      {!isCode && !isMcq && !structured ? (
        <div className='flex items-center gap-2'>
          <ModeButton active={mode === 'pen'} onPress={() => setMode('pen')}>
            <PenLine className='h-4 w-4' /> Pen
          </ModeButton>
          <ModeButton active={mode === 'typed'} onPress={() => setMode('typed')}>
            <Keyboard className='h-4 w-4' /> Type
          </ModeButton>
        </div>
      ) : null}

      {!isCode && mode === 'typed' && !isMcq && !structured ? (
        <textarea
          className='min-h-[160px] w-full rounded-st border-2 border-st-control-edge bg-st-surface p-3 text-base leading-7 text-st-fg outline-none focus:border-st-accent'
          disabled={Boolean(run.verdict)}
          placeholder='Type your working, one step per line. $LaTeX$ is fine.'
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      ) : null}

      {usesInk ? (
        <div className={`grid gap-4 ${run.verdict || run.busy ? 'lg:grid-cols-[3fr_2fr]' : ''}`}>
          <InkCanvas
            ref={inkRef}
            disabled={Boolean(run.verdict)}
            minHeight={isMcq ? 260 : 440}
            onChange={setInkEmpty}
          />
          {run.verdict || run.busy || run.error ? (
            <VerdictPanel
              busy={run.busy}
              done={run.done}
              error={run.error}
              fallbackSolution={fallbackSolution}
              reading={run.reading}
              revealing={revealing}
              verdict={run.verdict}
              onRetry={run.retryable ? () => void check(false) : undefined}
              onReveal={() => void check(true)}
            />
          ) : null}
        </div>
      ) : (
        <VerdictPanel
          busy={run.busy}
          done={run.done}
          error={run.error}
          fallbackSolution={fallbackSolution}
          reading={run.reading}
          revealing={revealing}
          verdict={run.verdict}
          onRetry={run.retryable ? () => void check(false) : undefined}
          onReveal={() => void check(true)}
        />
      )}

      <div className='sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 bg-st-bg/95 p-1'>
        {!run.verdict ? (
          <button
            className='flex h-14 flex-1 items-center justify-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent px-6 text-base font-semibold text-st-accent-fg hover:bg-st-accent/90 disabled:opacity-40 sm:flex-none shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
            disabled={!canCheck}
            type='button'
            onClick={() => void check(false)}
          >
            {run.busy ? (
              <span className='h-2.5 w-2.5 animate-pulse rounded-full bg-current' />
            ) : (
              <Check className='h-5 w-5' />
            )}
            {run.busy ? 'Checking…' : 'Check'}
          </button>
        ) : (
          <button
            className='flex h-14 items-center justify-center gap-2 rounded-st border-2 border-st-clay-edge bg-st-surface px-5 text-base font-medium text-st-fg hover:bg-st-accent-soft shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
            type='button'
            onClick={retry}
          >
            <RefreshCw className='h-5 w-5' /> Try again
          </button>
        )}
        {allowSimilar && aiOn ? (
          <button
            className='flex h-14 items-center justify-center gap-2 rounded-st border-2 border-st-clay-edge bg-st-surface px-5 text-base font-medium text-st-fg hover:bg-st-accent-soft disabled:opacity-40 shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
            disabled={similarBusy}
            type='button'
            onClick={() => void askSimilar()}
          >
            <Shuffle className='h-5 w-5' /> {similarBusy ? 'Making one…' : 'Similar question'}
          </button>
        ) : null}
        {footer}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onPress,
  children,
}: {
  active: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-pressed={active}
      className={`flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium transition ${
        active
          ? 'bg-st-accent text-st-accent-fg'
          : 'bg-st-raised text-st-fg hover:bg-st-raised'
      }`}
      type='button'
      onClick={onPress}
    >
      {children}
    </button>
  );
}
