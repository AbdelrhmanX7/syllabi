import type { ExamAnswer, ExamDetail, ExamQuestion, ExamRow, ExamSummary, GradedFrame } from '../api';
import type { ExamDraft, StoredExam } from '../lib/examStore';
import type { InkCanvasHandle } from './InkCanvas';
import type { Exam, Question, StudyClass } from '@/lib/api/types';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  History,
  Play,
  Plus,
  Sparkles,
  Timer,
  Trophy,
} from 'lucide-react';
import { ConfirmSheet } from '@/components/ui/ConfirmSheet';

import { createExam, getExam, getMastery, listExams, submitExam } from '../api';
import { errorText, useLoad } from '../hooks/useLoad';
import { answeredCount, draftAnswered, examDeadline, examState, isResumable, scoreFraction } from '../lib/exam';
import { EMPTY_DRAFT, createDraftSaver, deleteExamDraft, listExamDrafts, loadExamDraft } from '../lib/examStore';
import { buildExamInk } from '../lib/inkBudget';
import { useKatex } from '../lib/katex';
import { blankCount, fillBlankPayload, isStructured, matchingLefts, matchingPayload } from '../lib/questionTypes';
import { examSections, sectionAt, sectionTallies, withBySection } from '../lib/sections';
import { formatClock, pct, resultLabel, resultTone } from '../lib/verdict';

import { AddQuestionsModal } from './AddQuestions';
import { Chip } from './BankBrowser';
import { FillBlankStem } from './FillBlankStem';
import { InkCanvas } from './InkCanvas';
import { InlineMd } from './Markdown';
import { MatchingAnswer } from './MatchingAnswer';
import { barTone } from './MasteryPanel';
import { QuestionCard } from './QuestionCard';
import { VerdictPanel } from './VerdictPanel';

import { Toggle } from '@/components/ui/Toggle';
import { getBlueprint } from '@/features/guide/api';
import { isStudyApiError } from '@/lib/api/errors';
import { useSampleRoute } from '@/lib/api/hooks';

/**
 * Mock exam on BE P5 (#569): setup (class / topics / count / minutes) + exam history → timed runner
 * (startedAt is set on create; ink per question, persisted to IndexedDB so an app kill loses
 * nothing) → submit streams per-question grades under a 10 MB body budget → results with the
 * by-topic breakdown and the revealed answers. «Real exam format» sends `blueprint: 'class'` (the class's
 * real sections / types / length); its results add a by-section breakdown when the exam is sectioned.
 */

export interface MockExamProps {
  classes: StudyClass[];
  classId: string | null;
  onExit: () => void;
  /** «Practice first» on the empty state — the host opens a review session. */
  onPractice?: () => void;
  /** Preselected topics (e.g. «Start mock exam on these topics» from the exam countdown). */
  initialTopics?: string[];
  /** The countdown link asks for «Real exam format»; it is on by default anyway when offered. */
  initialBlueprint?: boolean;
}

type Stage =
  | { kind: 'setup' }
  | { kind: 'run'; exam: ExamDetail; restored: StoredExam | null }
  | { kind: 'results'; exam: ExamDetail; graded: Map<string, GradedFrame>; summary: ExamSummary | null };

const COUNTS = [5, 10, 15, 20, 30];
const MINUTES = [15, 30, 45, 60, 90, 120];
const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Open exams come without the answer; the card and the verdict panel want the full shape. */
const asQuestion = (q: ExamQuestion): Question => ({
  ...q,
  answer: q.answer ?? '',
  solutionSteps: q.solutionSteps ?? [],
});

/** `GET /exams` rows — the live shape, or the pre-P5 mock's full exam. */
function toRow(row: ExamRow | Exam): ExamRow {
  if ('questionCount' in row) return row;

  return {
    id: row.id,
    classId: row.classId,
    topics: [],
    questionCount: row.questions.length,
    minutes: row.minutes,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    late: false,
    score: null,
  };
}

function resultsFromDetail(detail: ExamDetail): { graded: Map<string, GradedFrame>; summary: ExamSummary | null } {
  const graded = new Map<string, GradedFrame>();

  for (const frame of detail.results ?? []) graded.set(frame.questionId, frame);
  const summary =
    detail.score !== undefined
      ? { score: detail.score, byTopic: detail.byTopic ?? [], bySection: detail.bySection, late: detail.late ?? false }
      : null;

  return { graded, summary };
}

export function MockExam({
  classes,
  classId: initialClassId,
  onExit,
  onPractice,
  initialTopics,
  initialBlueprint,
}: MockExamProps) {
  const [classId, setClassId] = useState<string | null>(
    initialClassId ?? (classes.length === 1 ? classes[0]!.id : null),
  );
  const [stage, setStage] = useState<Stage>({ kind: 'setup' });

  if (stage.kind === 'results') {
    return (
      <ExamResults
        exam={stage.exam}
        graded={stage.graded}
        summary={stage.summary}
        onExit={onExit}
        onRetake={() => setStage({ kind: 'setup' })}
      />
    );
  }
  if (stage.kind === 'run') {
    return (
      <ExamRunner
        exam={stage.exam}
        restored={stage.restored}
        onExit={onExit}
        onResults={(exam) => setStage({ kind: 'results', exam, ...resultsFromDetail(exam) })}
        onSubmitted={(graded, summary) => setStage({ kind: 'results', exam: stage.exam, graded, summary })}
      />
    );
  }

  return (
    <ExamSetup
      classId={classId}
      classes={classes}
      initialBlueprint={initialBlueprint}
      initialTopics={initialTopics}
      onClassChange={setClassId}
      onExit={onExit}
      onOpen={(exam, restored) => setStage({ kind: 'run', exam, restored })}
      onPractice={onPractice}
      onResults={(exam) => setStage({ kind: 'results', exam, ...resultsFromDetail(exam) })}
    />
  );
}

/* ------------------------------------------------------------------ setup + history */

function ExamSetup({
  classes,
  classId,
  initialTopics,
  initialBlueprint,
  onClassChange,
  onOpen,
  onResults,
  onPractice,
  onExit,
}: {
  classes: StudyClass[];
  classId: string | null;
  initialTopics?: string[];
  initialBlueprint?: boolean;
  onClassChange: (id: string) => void;
  onOpen: (exam: ExamDetail, restored: StoredExam | null) => void;
  onResults: (exam: ExamDetail) => void;
  onPractice?: () => void;
  onExit: () => void;
}) {
  const mastery = useLoad(() => getMastery(classId ?? undefined), [classId], Boolean(classId));
  const history = useLoad(async () => (await listExams(classId ?? undefined)).map(toRow), [classId]);
  const drafts = useLoad(listExamDrafts, []);
  const [topics, setTopics] = useState<string[]>(initialTopics ?? []);
  const [count, setCount] = useState(10);
  const [minutes, setMinutes] = useState(30);
  // Blueprint mode: null minutes = the real exam's length.
  const [realMinutes, setRealMinutes] = useState<number | null>(null);
  // «Real exam format»: offered when the class has an exam blueprint (owner-set or the course default,
  // GET /classes/:id/exam-blueprint), and only when POST /exams goes to the live backend (the mock
  // has no blueprints). On by default when offered; the toggle pins it.
  const [realPinned, setRealPinned] = useState<boolean | null>(initialBlueprint ? true : null);
  const examsOnMock = useSampleRoute('/exams', 'POST');
  const blueprint = useLoad(() => getBlueprint(classId!), [classId], Boolean(classId) && !examsOnMock);
  const realOffered = !examsOnMock && !blueprint.loading && !blueprint.error && Boolean(blueprint.data?.blueprint);
  const real = realOffered && (realPinned ?? true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [adding, setAdding] = useState(false);
  // Prefilled topics stay pickable even before the class has mastery rows for them.
  const available = Array.from(
    new Set([...(initialTopics ?? []), ...(mastery.data?.topics.map((t) => t.topic) ?? [])]),
  );
  const draftById = useMemo(() => new Map((drafts.data ?? []).map((d) => [d.examId, d])), [drafts.data]);

  const firstClass = useRef(classId);

  // A class switch clears the picked topics; the initial class keeps its prefilled ones.
  useEffect(() => {
    if (classId === firstClass.current) return;
    firstClass.current = classId;
    setTopics([]);
    setRealPinned(null);
  }, [classId]);

  const start = async () => {
    if (!classId) return;
    setBusy('create');
    setError(null);
    setEmpty(false);
    try {
      const exam = await createExam(
        real
          ? {
              classId,
              blueprint: 'class',
              topics: topics.length ? topics : undefined,
              minutes: realMinutes ?? undefined,
            }
          : { classId, topics: topics.length ? topics : undefined, count, minutes },
      );

      onOpen(exam, null);
    } catch (err) {
      if (isStudyApiError(err, 409) && err.code === 'NO_QUESTIONS') setEmpty(true);
      // A backend without blueprints rejects the count-less body as VALIDATION_ERROR («count must be…»).
      else if (real && isStudyApiError(err, 400) && (err.code === 'NO_BLUEPRINT' || err.code === 'VALIDATION_ERROR'))
        setError('Real exam format is not available for this class yet. Switch it off for a regular mock.');
      else setError(errorText(err));
      setBusy(null);
    }
  };

  const open = async (row: ExamRow) => {
    setBusy(row.id);
    setError(null);
    try {
      const exam = await getExam(row.id);

      if (exam.submittedAt || exam.results) onResults(exam);
      else onOpen(exam, await loadExamDraft(row.id));
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  const rows = history.data ?? [];

  return (
    <div className='mx-auto w-full max-w-3xl'>
      <Header title='Mock exam' onExit={onExit} />
      <div className='space-y-5'>
        {classes.length > 1 ? (
          <Field label='Class'>
            {classes.map((c) => (
              <Chip key={c.id} active={classId === c.id} dot={c.color} onPress={() => onClassChange(c.id)}>
                {c.code || c.name}
              </Chip>
            ))}
          </Field>
        ) : null}
        <Field
          hint={
            available.length
              ? 'None selected = the whole syllabus so far.'
              : 'Topics appear once you have attempted questions; leave empty for the syllabus.'
          }
          label='Topics'
        >
          {available.map((topic) => (
            <Chip
              key={topic}
              active={topics.includes(topic)}
              onPress={() => setTopics((t) => (t.includes(topic) ? t.filter((x) => x !== topic) : [...t, topic]))}
            >
              {topic}
            </Chip>
          ))}
        </Field>
        {realOffered ? (
          <div className='flex items-start gap-3 rounded-2xl border border-st-line p-3'>
            <div className='min-w-0 flex-1'>
              <p className='text-base font-medium text-st-fg'>Real exam format</p>
              <p className='text-xs text-st-muted'>
                Same sections, question types and length as the professor&apos;s exams
                {blueprint.data?.blueprint
                  ? ` (${blueprint.data.blueprint.sections.map((sec) => sec.section).join(', ')}).`
                  : '.'}
              </p>
            </div>
            <Toggle checked={real} label='Real exam format' onChange={setRealPinned} />
          </div>
        ) : null}
        {real ? (
          <Field label='Minutes'>
            <Chip active={realMinutes === null} onPress={() => setRealMinutes(null)}>
              Real length
            </Chip>
            {MINUTES.map((n) => (
              <Chip key={n} active={realMinutes === n} onPress={() => setRealMinutes(n)}>
                {n}
              </Chip>
            ))}
          </Field>
        ) : (
          <>
            <Field label='Questions'>
              {COUNTS.map((n) => (
                <Chip key={n} active={count === n} onPress={() => setCount(n)}>
                  {n}
                </Chip>
              ))}
            </Field>
            <Field label='Minutes'>
              {MINUTES.map((n) => (
                <Chip key={n} active={minutes === n} onPress={() => setMinutes(n)}>
                  {n}
                </Chip>
              ))}
            </Field>
          </>
        )}

        {empty ? (
          <div className='rounded-2xl border border-dashed border-st-line p-6 text-center'>
            <p className='text-base font-medium text-st-fg'>
              No questions in the bank for this scope yet
            </p>
            <p className='mt-1 text-sm text-st-muted'>
              Pull some from Canvas or a photo, or practise what is there first.
            </p>
            <div className='mt-4 flex flex-wrap justify-center gap-2'>
              <button
                className='flex h-12 items-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent px-5 text-sm font-semibold text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
                type='button'
                onClick={() => setAdding(true)}
              >
                <Plus className='h-4 w-4' /> Add questions
              </button>
              {onPractice ? (
                <button
                  className='flex h-12 items-center gap-2 rounded-st border-2 border-st-clay-edge bg-st-surface px-5 text-sm font-medium text-st-fg shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
                  type='button'
                  onClick={onPractice}
                >
                  <Sparkles className='h-4 w-4' /> Practice first
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {error ? (
          <p className='rounded-2xl bg-st-danger/10 p-3 text-sm text-st-danger'>
            {error}
          </p>
        ) : null}
        <button
          className='flex h-14 w-full items-center justify-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent text-base font-semibold text-st-accent-fg disabled:opacity-40 shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
          disabled={!classId || busy !== null}
          type='button'
          onClick={() => void start()}
        >
          <Play className='h-5 w-5' />{' '}
          {busy === 'create'
            ? 'Building your exam…'
            : real
              ? `Start · real format${realMinutes ? ` · ${realMinutes} min` : ''}`
              : `Start · ${count} questions · ${minutes} min`}
        </button>

        <section>
          <p className='mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-st-muted'>
            <History className='h-4 w-4' /> Exam history
          </p>
          {history.loading ? <p className='text-sm text-st-muted'>Loading…</p> : null}
          {history.error ? <p className='text-sm text-st-danger'>{history.error}</p> : null}
          {!history.loading && !rows.length ? <p className='text-sm text-st-muted'>No exams yet.</p> : null}
          <ul className='space-y-2'>
            {rows.map((row) => (
              <HistoryRow
                key={row.id}
                busy={busy === row.id}
                draft={draftById.get(row.id) ?? null}
                row={row}
                onOpen={() => void open(row)}
              />
            ))}
          </ul>
        </section>
      </div>
      {adding ? (
        <AddQuestionsModal
          classId={classId ?? undefined}
          classes={classes}
          onAdded={() => setEmpty(false)}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

function HistoryRow({
  row,
  draft,
  busy,
  onOpen,
}: {
  row: ExamRow;
  draft: StoredExam | null;
  busy: boolean;
  onOpen: () => void;
}) {
  const state = examState(row);
  const resumable = isResumable(state);
  const answered = draft ? answeredCount(draft.drafts) : 0;
  const when = row.startedAt
    ? new Date(row.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const stateLabel =
    state === 'submitted'
      ? `${pct(scoreFraction(row.score))}%`
      : state === 'open'
        ? 'In progress'
        : state === 'late'
          ? 'Late'
          : 'Expired';
  const tone =
    state === 'submitted'
      ? resultTone(scoreFraction(row.score) >= 0.8 ? 'right' : scoreFraction(row.score) >= 0.5 ? 'partial' : 'wrong')
      : resultTone(state === 'expired' ? null : 'partial');

  return (
    <li>
      <button
        className='flex w-full items-center gap-3 rounded-2xl border border-st-line bg-st-surface p-3 text-left hover:border-st-ink/50 disabled:opacity-60'
        disabled={busy || state === 'expired'}
        type='button'
        onClick={onOpen}
      >
        <div className='min-w-0 flex-1'>
          <p className='truncate text-base font-medium text-st-fg'>
            {row.topics.length ? row.topics.join(', ') : 'Whole syllabus'}
          </p>
          <p className='text-xs text-st-muted'>
            {row.questionCount} questions · {row.minutes} min · {when}
            {resumable && draft ? ` · ${answered} answered` : ''}
          </p>
        </div>
        {row.late ? <Badge>Late</Badge> : null}
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone.bg} ${tone.text}`}>
          {busy ? '…' : stateLabel}
        </span>
        {resumable ? <ChevronRight className='h-5 w-5 text-st-muted' /> : null}
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ runner */

function ExamRunner({
  exam,
  restored,
  onSubmitted,
  onResults,
  onExit,
}: {
  exam: ExamDetail;
  restored: StoredExam | null;
  onSubmitted: (graded: Map<string, GradedFrame>, summary: ExamSummary | null) => void;
  onResults: (exam: ExamDetail) => void;
  onExit: () => void;
}) {
  const katex = useKatex();
  const deadline = useMemo(() => examDeadline(exam.startedAt, exam.minutes), [exam.startedAt, exam.minutes]);
  const [index, setIndex] = useState(() => Math.min(restored?.index ?? 0, Math.max(0, exam.questions.length - 1)));
  const [drafts, setDrafts] = useState<Map<string, ExamDraft>>(() => new Map(Object.entries(restored?.drafts ?? {})));
  const [left, setLeft] = useState(deadline - Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState<number | null>(null);
  const [gradedCount, setGradedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inkRef = useRef<InkCanvasHandle>(null);
  const saver = useMemo(() => createDraftSaver(), []);
  const question = exam.questions[index];
  const groups = useMemo(() => examSections(exam), [exam]);
  const section = question ? sectionAt(groups, question.id) : null;
  const draft = (question && drafts.get(question.id)) ?? EMPTY_DRAFT;
  const isCode = question?.type === 'code_output' || question?.type === 'code_write';
  const isMcq = question?.type === 'mcq';
  const structured = question ? isStructured(question.type) : false;
  const state = examState({ startedAt: exam.startedAt, submittedAt: exam.submittedAt, minutes: exam.minutes });

  // Persist on every change (debounced) and flush when leaving the screen.
  useEffect(() => {
    saver.save({
      examId: exam.id,
      classId: exam.classId,
      drafts: Object.fromEntries(drafts),
      index,
      deadline,
      savedAt: Date.now(),
    });
  }, [deadline, drafts, exam.classId, exam.id, index, saver]);

  useEffect(() => () => saver.flush(), [saver]);

  const patchDraft = useCallback((id: string, patch: Partial<ExamDraft>) => {
    setDrafts((current) => {
      const next = new Map(current);

      next.set(id, { ...(current.get(id) ?? EMPTY_DRAFT), ...patch });

      return next;
    });
  }, []);

  /** Pull the live ink into the draft before leaving the question. */
  const snapshotInk = useCallback(() => {
    if (inkRef.current && question) patchDraft(question.id, { strokes: inkRef.current.getStrokes() });
  }, [patchDraft, question]);

  const go = (next: number) => {
    snapshotInk();
    setIndex(Math.max(0, Math.min(exam.questions.length - 1, next)));
  };

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const finalDrafts = new Map(drafts);

    if (question && inkRef.current) {
      finalDrafts.set(question.id, {
        ...(finalDrafts.get(question.id) ?? EMPTY_DRAFT),
        strokes: inkRef.current.getStrokes(),
      });
    }
    setDrafts(finalDrafts);
    const strokesById = new Map(Array.from(finalDrafts.entries()).map(([id, d]) => [id, d.strokes] as const));
    const inkById = buildExamInk(strokesById);
    const answers: ExamAnswer[] = exam.questions.map((q) => {
      const d = finalDrafts.get(q.id) ?? EMPTY_DRAFT;
      const answer: ExamAnswer = { questionId: q.id };

      if (q.type === 'matching') {
        const { matches } = matchingPayload(matchingLefts(q), d.matches ?? {});

        if (Object.keys(matches).length) answer.matches = matches;
      } else if (q.type === 'fill_blank') {
        if ((d.blanks ?? []).some((b) => b.trim()))
          answer.blanks = fillBlankPayload(d.blanks ?? [], blankCount(q.stem)).blanks;
      } else if (q.type === 'mcq') {
        if (d.choice !== null) answer.choice = d.choice;
      } else if (q.type === 'code_write') {
        if (d.typed.trim()) answer.code = d.typed;
      } else if (q.type === 'code_output') {
        if (d.typed.trim()) answer.typed = d.typed;
      }
      const ink = inkById.get(q.id);

      if (ink) answer.inkPngB64 = ink;

      return answer;
    });
    const graded = new Map<string, GradedFrame>();

    setGradedCount(0);
    try {
      const summary = await submitExam(exam.id, answers, (frame) => {
        graded.set(frame.questionId, frame);
        setGradedCount(graded.size);
      });

      saver.cancel();
      void deleteExamDraft(exam.id);
      onSubmitted(graded, summary);
    } catch (err) {
      if (isStudyApiError(err, 409) && err.code === 'ALREADY_SUBMITTED') {
        try {
          saver.cancel();
          void deleteExamDraft(exam.id);
          onResults(await getExam(exam.id));

          return;
        } catch (inner) {
          setError(errorText(inner));
        }
      } else {
        // Answers are kept (state + IndexedDB); the button comes back for a resubmit.
        setError(errorText(err));
      }
      setSubmitting(false);
    }
  }, [drafts, exam.id, exam.questions, onResults, onSubmitted, question, saver, submitting]);

  // Countdown; auto-submit when the timer ends.
  useEffect(() => {
    if (submitting) return;
    const id = window.setInterval(() => {
      const remaining = deadline - Date.now();

      setLeft(remaining);
      if (remaining <= 0) {
        window.clearInterval(id);
        void submit();
      }
    }, 1000);

    return () => window.clearInterval(id);
  }, [deadline, submit, submitting]);

  const answered = (q: ExamQuestion) => draftAnswered(drafts.get(q.id));

  if (!question) {
    return (
      <div className='mx-auto max-w-md p-10 text-center'>
        <p className='text-base text-st-fg'>This exam has no questions.</p>
        <button
          className='mt-4 h-12 rounded-st border-2 border-st-clay-edge bg-st-surface px-5 text-sm shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
          type='button'
          onClick={onExit}
        >
          Back
        </button>
      </div>
    );
  }

  const urgent = left < 5 * 60_000;

  if (submitting) {
    return (
      <div className='mx-auto flex max-w-md flex-col items-center gap-3 p-12 text-center'>
        <span className='h-3 w-3 animate-pulse rounded-full bg-st-accent' />
        <p className='text-lg font-semibold text-st-fg'>Grading…</p>
        <p className='text-sm text-st-muted'>
          {gradedCount} / {exam.questions.length} graded
        </p>
      </div>
    );
  }

  return (
    <div className='mx-auto flex w-full max-w-5xl flex-col gap-4'>
      {confirmSubmit !== null ? (
        <ConfirmSheet
          confirmLabel='Submit anyway'
          title={`${confirmSubmit} unanswered`}
          onClose={() => setConfirmSubmit(null)}
          onConfirm={() => void submit()}
        >
          Unanswered questions count as wrong.
        </ConfirmSheet>
      ) : null}
      <div className='flex items-center gap-2'>
        <button
          aria-label='Leave exam'
          className='flex h-11 w-11 items-center justify-center rounded-xl text-st-fg hover:bg-st-raised'
          type='button'
          onClick={() => {
            snapshotInk();
            saver.flush();
            onExit();
          }}
        >
          <ArrowLeft className='h-5 w-5' />
        </button>
        <span className='text-sm text-st-muted'>
          Question {index + 1} of {exam.questions.length}
          {exam.questions.length < exam.count ? ` (${exam.questions.length} available)` : ''}
        </span>
        {section ? (
          <span className='rounded-full bg-st-raised px-2.5 py-0.5 text-xs font-medium text-st-fg'>
            {section.name}
            {section.bonus ? ' · bonus' : ''}
          </span>
        ) : null}
        <span className='flex-1' />
        {state === 'late' || left <= 0 ? <Badge>Late</Badge> : null}
        <span
          className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold tabular-nums ${
            urgent
              ? 'bg-st-danger/10 text-st-danger'
              : 'bg-st-raised text-st-fg'
          }`}
        >
          <Timer className='h-4 w-4' /> {formatClock(left)}
        </span>
      </div>

      {error ? (
        <div className='flex flex-wrap items-center gap-3 rounded-2xl bg-st-danger/10 p-3 text-sm text-st-danger'>
          <span className='flex-1'>{error}</span>
          <button
            className='h-10 rounded-xl bg-st-surface px-4 font-semibold text-st-danger'
            type='button'
            onClick={() => void submit()}
          >
            Resubmit
          </button>
        </div>
      ) : null}

      {exam.scope || exam.skipped?.length ? (
        <div className='rounded-2xl bg-st-bg p-3 text-sm text-st-fg'>
          {exam.scope ? (
            <p>
              Practising for <span className='font-medium'>{exam.scope.name}</span>
              {[...exam.scope.chapters, ...exam.scope.topics].length
                ? ` · ${[...exam.scope.chapters, ...exam.scope.topics].join(', ')}`
                : ''}
            </p>
          ) : null}
          {exam.skipped?.map((s) => (
            <p key={s.section} className='text-st-warn'>
              {s.section} {s.got ? `has ${s.got} of ${s.wanted}` : 'skipped'}:{' '}
              {s.reason.replace(/^./, (c) => c.toLowerCase())}
            </p>
          ))}
        </div>
      ) : null}

      <div className='flex flex-wrap gap-1.5'>
        {exam.questions.map((q, i) => (
          <button
            key={q.id}
            aria-current={i === index}
            className={`h-10 min-w-10 rounded-xl px-2 text-sm font-medium tabular-nums ${pillClass(i === index ? 'current' : answered(q) ? 'answered' : 'open')}`}
            type='button'
            onClick={() => go(i)}
          >
            {i + 1}
          </button>
        ))}
      </div>

      <QuestionCard
        question={asQuestion(question)}
        stem={
          question.type === 'fill_blank' ? (
            <FillBlankStem
              stem={question.stem}
              values={draft.blanks ?? []}
              onChange={(blanks) => patchDraft(question.id, { blanks })}
            />
          ) : undefined
        }
        variant='full'
      />

      {question.type === 'matching' ? (
        <MatchingAnswer
          question={question}
          value={draft.matches ?? {}}
          onChange={(matches) => patchDraft(question.id, { matches })}
        />
      ) : null}

      {isMcq && question.choices?.length ? (
        <div className='grid gap-2 sm:grid-cols-2'>
          {question.choices.map((text, i) => {
            const selected = draft.choice === i;

            return (
              <button
                key={i}
                aria-pressed={selected}
                className={`flex min-h-14 items-start gap-3 rounded-2xl border p-3 text-left text-base ${
                  selected
                    ? 'border-st-accent-lip bg-st-accent text-st-accent-fg'
                    : 'border-st-line bg-st-surface text-st-fg'
                }`}
                type='button'
                onClick={() => patchDraft(question.id, { choice: selected ? null : i })}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    selected ? 'bg-st-accent-fg/20' : 'bg-st-raised'
                  }`}
                >
                  {CHOICE_LETTERS[i] ?? i + 1}
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
        <textarea
          autoCapitalize='off'
          autoCorrect='off'
          className='min-h-[200px] w-full rounded-st border-2 border-st-clay-edge bg-st-bg p-3 font-mono text-sm leading-6 text-st-fg outline-none focus:border-st-accent'
          placeholder={question.type === 'code_output' ? 'What does it print?' : '// your code'}
          spellCheck={false}
          value={draft.typed}
          onChange={(e) => patchDraft(question.id, { typed: e.target.value })}
        />
      ) : null}

      {!isCode && !structured ? (
        <InkCanvas
          key={question.id}
          ref={inkRef}
          initialStrokes={draft.strokes}
          minHeight={isMcq ? 240 : 420}
          onChange={() => {
            // Keep the draft (and IndexedDB) current after every committed stroke.
            if (inkRef.current) patchDraft(question.id, { strokes: inkRef.current.getStrokes() });
          }}
        />
      ) : null}

      <div className='sticky bottom-0 -mx-1 flex items-center gap-2 bg-st-bg/95 p-1'>
        <NavButton disabled={index === 0} onPress={() => go(index - 1)}>
          <ChevronLeft className='h-5 w-5' /> Prev
        </NavButton>
        <NavButton disabled={index >= exam.questions.length - 1} onPress={() => go(index + 1)}>
          Next <ChevronRight className='h-5 w-5' />
        </NavButton>
        <span className='flex-1' />
        <button
          className='flex h-14 items-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent px-6 text-base font-semibold text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
          type='button'
          onClick={() => {
            const unanswered = exam.questions.filter((q) => !answered(q) && q.id !== question.id).length;

            if (unanswered === 0) void submit();
            else setConfirmSubmit(unanswered);
          }}
        >
          <Flag className='h-5 w-5' /> Submit
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ results */

function ExamResults({
  exam,
  graded,
  summary,
  onExit,
  onRetake,
}: {
  exam: ExamDetail;
  graded: Map<string, GradedFrame>;
  summary: ExamSummary | null;
  onExit: () => void;
  onRetake: () => void;
}) {
  const score = scoreFraction(summary?.score ?? exam.score);
  const late = summary?.late ?? exam.late ?? false;
  const byTopic = summary?.byTopic ?? exam.byTopic ?? [];
  const tally = useMemo(() => {
    const t = { right: 0, partial: 0, wrong: 0 };

    for (const q of exam.questions) {
      const g = graded.get(q.id);

      if (g) t[g.result] += 1;
      else t.wrong += 1;
    }

    return t;
  }, [exam.questions, graded]);
  const sections = useMemo(() => {
    const groups = examSections(exam);

    return withBySection(groups ? sectionTallies(groups, graded) : null, summary?.bySection ?? exam.bySection);
  }, [exam, graded, summary?.bySection]);

  return (
    <div className='mx-auto w-full max-w-4xl'>
      <Header title='Results' onExit={onExit} />
      <div className='mb-5 flex flex-col items-center gap-2 rounded-3xl border border-st-line p-8 text-center'>
        <Trophy className={`h-10 w-10 ${score >= 0.8 ? 'text-st-warn' : 'text-st-muted'}`} />
        <p className='text-5xl font-semibold tabular-nums text-st-fg'>{pct(score)}%</p>
        <p className='flex items-center gap-2 text-sm text-st-muted'>
          {tally.right} right · {tally.partial} partial · {tally.wrong} wrong · {exam.minutes} min
          {late ? <Badge>Late</Badge> : null}
        </p>
        <div className='mt-2 flex gap-2'>
          <button
            className='flex h-12 items-center rounded-st border-2 border-st-accent-lip bg-st-accent px-5 text-sm font-semibold text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
            type='button'
            onClick={onRetake}
          >
            New exam
          </button>
          <button
            className='flex h-12 items-center rounded-st border-2 border-st-clay-edge bg-st-surface px-5 text-sm font-medium text-st-fg shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
            type='button'
            onClick={onExit}
          >
            Back to bank
          </button>
        </div>
      </div>

      {sections ? (
        <div className='mb-6 space-y-2'>
          <p className='text-xs font-semibold uppercase tracking-wide text-st-muted'>By section</p>
          {sections.map((row) => (
            <div key={row.name} className='rounded-2xl border border-st-line p-3'>
              <div className='flex items-baseline justify-between gap-3'>
                <p className='text-base font-medium text-st-fg'>
                  {row.name}
                  {row.bonus ? <span className='ms-2 text-xs font-normal text-st-muted'>bonus</span> : null}
                </p>
                <p className='text-sm tabular-nums text-st-muted'>
                  {row.total
                    ? `${row.right}/${row.total} right${row.partial ? ` · ${row.partial} partial` : ''} · `
                    : ''}
                  {pct(row.score)}%
                </p>
              </div>
              <div className='mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-st-raised'>
                <div className={`h-full rounded-full ${barTone(row.score)}`} style={{ width: `${pct(row.score)}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {byTopic.length ? (
        <div className='mb-6 space-y-2'>
          <p className='text-xs font-semibold uppercase tracking-wide text-st-muted'>By topic</p>
          {byTopic.map((row) => {
            const value = scoreFraction(row.score);

            return (
              <div key={row.topic} className='rounded-2xl border border-st-line p-3'>
                <div className='flex items-baseline justify-between'>
                  <p className='text-base font-medium text-st-fg'>{row.topic}</p>
                  <p className='text-sm tabular-nums text-st-muted'>{pct(value)}%</p>
                </div>
                <div className='mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-st-raised'>
                  <div className={`h-full rounded-full ${barTone(value)}`} style={{ width: `${pct(value)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className='space-y-4'>
        {exam.questions.map((raw, i) => {
          const q = asQuestion(raw);
          const g = graded.get(q.id);
          const tone = resultTone(g?.result ?? null);

          return (
            <div key={q.id} className='space-y-2'>
              <div className='flex items-center gap-2'>
                <span className='text-sm font-semibold text-st-muted'>Q{i + 1}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}>
                  {g ? resultLabel(g.result) : 'Not graded'}
                </span>
              </div>
              <QuestionCard question={q} />
              {g ? (
                <VerdictPanel
                  busy={false}
                  done={null}
                  error={null}
                  fallbackSolution={
                    q.solutionSteps.length || q.answer ? { answer: q.answer, steps: q.solutionSteps } : null
                  }
                  reading={null}
                  verdict={{
                    result: g.result,
                    steps: g.steps ?? [],
                    firstErrorStep: g.firstErrorStep ?? null,
                    hint: g.hint ?? '',
                    solution: g.solution ?? null,
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ bits */

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className='inline-flex items-center gap-1 rounded-full bg-st-warn/10 px-2 py-0.5 text-xs font-semibold text-st-warn'>
      <Clock className='h-3 w-3' /> {children}
    </span>
  );
}

function Header({ title, onExit }: { title: string; onExit: () => void }) {
  return (
    <div className='mb-4 flex items-center gap-2'>
      <button
        aria-label='Back'
        className='flex h-11 w-11 items-center justify-center rounded-xl text-st-fg hover:bg-st-raised'
        type='button'
        onClick={onExit}
      >
        <ArrowLeft className='h-5 w-5' />
      </button>
      <h2 className='text-base font-semibold text-st-fg'>{title}</h2>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className='mb-2 text-xs font-semibold uppercase tracking-wide text-st-muted'>{label}</p>
      <div className='flex flex-wrap gap-2'>{children}</div>
      {hint ? <p className='mt-1.5 text-xs text-st-muted'>{hint}</p> : null}
    </div>
  );
}

/** Question-number pill: the one you are on, one you answered, one still open. */
function pillClass(state: 'current' | 'answered' | 'open'): string {
  if (state === 'current') return 'bg-st-accent text-st-accent-fg';
  if (state === 'answered') return 'bg-st-ok/10 text-st-ok';

  return 'bg-st-raised text-st-fg';
}

function NavButton({
  disabled,
  onPress,
  children,
}: {
  disabled: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className='flex h-14 items-center gap-1 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-base font-medium text-st-fg disabled:opacity-40 shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
      disabled={disabled}
      type='button'
      onClick={onPress}
    >
      {children}
    </button>
  );
}
