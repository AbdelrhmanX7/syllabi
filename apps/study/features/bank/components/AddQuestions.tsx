import type { ExtractFrom } from '../api';
import type { Question, QuestionType, StudyClass } from '@/lib/api/types';

import React, { useEffect, useRef, useState } from 'react';
import { Camera, FilePlus, ImagePlus, Sparkles, X } from 'lucide-react';

import { createQuestions, extractQuestions, listClasses } from '../api';
import { encodeBlankAnswer, encodeMatching } from '../lib/questionTypes';
import { errorText, useLoad } from '../hooks/useLoad';
import { b64ToDataUrl, fileToPngB64 } from '../lib/image';

import { BOARD_CHIP } from '@/components/ui/primitives';

import { Chip } from './BankBrowser';
import { QuestionCard } from './QuestionCard';

/**
 * Three ways in: a photo (camera or file → PNG → `/questions/extract`), a Canvas item / notebook
 * page / lecture (`ExtractButton`, mountable from any other screen), or a manual form.
 * Extracted cards stream in as the backend saves them.
 */

export interface ExtractSource {
  itemId?: string;
  pageId?: string;
  lectureId?: string;
}

export interface ExtractButtonProps extends ExtractSource {
  classId?: string;
  /** Called with every saved question (hosts can merge them into their own lists). */
  onExtracted?: (questions: Question[]) => void;
  label?: string;
  className?: string;
}

/** «Pull questions» — mount it next to a Canvas item, a page or a lecture. */
export function ExtractButton({
  classId,
  itemId,
  pageId,
  lectureId,
  onExtracted,
  label = 'Pull questions',
  className = '',
  chip = false,
}: ExtractButtonProps & { chip?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className={chip
          ? `${BOARD_CHIP} !border-st-accent-lip !bg-st-accent !text-st-accent-fg !shadow-clay-accent hover:!bg-st-accent/90 ${className}`
          : `inline-flex h-11 items-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent px-4 text-sm font-semibold text-st-accent-fg hover:bg-st-accent/90 shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none ${className}`}
        aria-label={label}
        title={label}
        type='button'
        onClick={() => setOpen(true)}
      >
        <Sparkles className='h-4 w-4 shrink-0' /> <span data-chip-label>{label}</span>
      </button>
      {open ? (
        <AddQuestionsModal
          classId={classId}
          initialMode='extract'
          source={{ itemId, pageId, lectureId }}
          onAdded={onExtracted}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

type AddMode = 'photo' | 'manual' | 'extract';

export interface AddQuestionsModalProps {
  classId?: string;
  classes?: StudyClass[];
  initialMode?: AddMode;
  source?: ExtractSource;
  onAdded?: (questions: Question[]) => void;
  onClose: () => void;
}

export function AddQuestionsModal({
  classId: initialClassId,
  classes: givenClasses,
  initialMode = 'photo',
  source,
  onAdded,
  onClose,
}: AddQuestionsModalProps) {
  const loaded = useLoad(listClasses, [], !givenClasses);
  const classes = givenClasses ?? loaded.data ?? [];
  const [classId, setClassId] = useState<string | null>(initialClassId ?? null);
  const [mode, setMode] = useState<AddMode>(initialMode);
  const [results, setResults] = useState<Question[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasSource = Boolean(source?.itemId || source?.pageId || source?.lectureId);

  useEffect(() => {
    if (!classId && classes.length === 1) setClassId(classes[0]!.id);
  }, [classId, classes]);

  useEffect(() => () => controller.current?.abort(), []);

  // Esc closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runExtract = async (from: ExtractFrom) => {
    if (!classId) {
      setError('Pick a class first.');

      return;
    }
    controller.current?.abort();
    const abort = new AbortController();

    controller.current = abort;
    setBusy(true);
    setError(null);
    const got: Question[] = [];

    try {
      await extractQuestions(
        classId,
        from,
        (question) => {
          got.push(question);
          setResults((current) => [...current, question]);
        },
        abort.signal,
      );
      if (got.length) onAdded?.(got);
      else setError('No questions found in that.');
    } catch (err) {
      if (!abort.signal.aborted) setError(errorText(err));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const b64 = await fileToPngB64(file);

      setPreview(b64ToDataUrl(b64));
      await runExtract({ imagePngB64: b64 });
    } catch (err) {
      setError(errorText(err));
    }
  };

  // Extract from a Canvas item / page / lecture straight away when opened with one.
  const autoRan = useRef(false);

  useEffect(() => {
    if (autoRan.current || !hasSource || !classId || mode !== 'extract') return;
    autoRan.current = true;
    void runExtract({ itemId: source?.itemId, pageId: source?.pageId, lectureId: source?.lectureId });
  }, [classId, hasSource, mode]);

  return (
    <div aria-modal className='fixed inset-0 z-50 flex items-end justify-center sm:items-center' role='dialog'>
      <button aria-label='Close' className='absolute inset-0 bg-st-shadow/40' type='button' onClick={onClose} />
      <div className='relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border-2 border-st-clay-edge bg-st-surface sm:rounded-3xl'>
        <div className='flex items-center gap-2 border-b border-st-line px-5 py-3'>
          <h2 className='text-base font-semibold text-st-fg'>Add questions</h2>
          <span className='flex-1' />
          <button
            aria-label='Close'
            className='flex h-10 w-10 items-center justify-center rounded-full text-st-muted hover:bg-st-raised'
            type='button'
            onClick={onClose}
          >
            <X className='h-5 w-5' />
          </button>
        </div>

        <div className='flex-1 space-y-4 overflow-y-auto px-5 py-4'>
          {classes.length > 1 ? (
            <div className='flex flex-wrap gap-2'>
              {classes.map((c) => (
                <Chip key={c.id} active={classId === c.id} dot={c.color} onPress={() => setClassId(c.id)}>
                  {c.code || c.name}
                </Chip>
              ))}
            </div>
          ) : null}

          {!hasSource ? (
            <div className='flex gap-2'>
              <Chip active={mode === 'photo'} onPress={() => setMode('photo')}>
                <Camera className='h-4 w-4' /> From a photo
              </Chip>
              <Chip active={mode === 'manual'} onPress={() => setMode('manual')}>
                <FilePlus className='h-4 w-4' /> Write one
              </Chip>
            </div>
          ) : (
            <p className='text-sm text-st-muted'>
              Reading {source?.itemId ? 'the Canvas item' : source?.pageId ? 'your notebook page' : 'the lecture'} for
              questions…
            </p>
          )}

          {mode === 'photo' && !hasSource ? (
            <div className='space-y-3'>
              <div className='grid grid-cols-2 gap-2'>
                <button
                  className='flex h-24 flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-st-line text-sm font-medium text-st-fg hover:border-st-ink/50 disabled:opacity-50'
                  disabled={busy}
                  type='button'
                  onClick={() => cameraRef.current?.click()}
                >
                  <Camera className='h-6 w-6' /> Camera
                </button>
                <button
                  className='flex h-24 flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-st-line text-sm font-medium text-st-fg hover:border-st-ink/50 disabled:opacity-50'
                  disabled={busy}
                  type='button'
                  onClick={() => fileRef.current?.click()}
                >
                  <ImagePlus className='h-6 w-6' /> Photo / screenshot
                </button>
              </div>
              <input
                ref={cameraRef}
                accept='image/*'
                capture='environment'
                className='hidden'
                type='file'
                onChange={(e) => void onPhoto(e.target.files?.[0])}
              />
              <input
                ref={fileRef}
                accept='image/*'
                className='hidden'
                type='file'
                onChange={(e) => void onPhoto(e.target.files?.[0])}
              />
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt='Captured problem'
                  className='max-h-64 w-auto rounded-2xl border border-st-line'
                  src={preview}
                />
              ) : null}
            </div>
          ) : null}

          {mode === 'manual' ? (
            <ManualForm
              classId={classId}
              disabled={busy}
              onSubmit={async (draft) => {
                setBusy(true);
                setError(null);
                try {
                  const saved = await createQuestions([draft]);

                  setResults((current) => [...current, ...saved]);
                  onAdded?.(saved);
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : null}

          {busy ? (
            <div className='flex items-center gap-3 rounded-2xl bg-st-bg p-3 text-sm text-st-muted'>
              <span className='h-2.5 w-2.5 animate-pulse rounded-full bg-st-accent' />
              {mode === 'manual' ? 'Saving…' : `Extracting… ${results.length ? `${results.length} so far` : ''}`}
            </div>
          ) : null}
          {error ? (
            <p className='rounded-2xl bg-st-danger/10 p-3 text-sm text-st-danger'>
              {error}
            </p>
          ) : null}

          {results.length ? (
            <div className='space-y-2'>
              <p className='text-xs font-semibold uppercase tracking-wide text-st-muted'>Added ({results.length})</p>
              {results.map((question) => (
                <QuestionCard key={question.id} question={question} />
              ))}
            </div>
          ) : null}
        </div>

        <div className='flex justify-end gap-2 border-t border-st-line px-5 py-3'>
          <button
            className='flex h-12 items-center rounded-st border-2 border-st-accent-lip bg-st-accent px-5 text-sm font-semibold text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
            type='button'
            onClick={onClose}
          >
            {results.length ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

const TYPES: { value: QuestionType; label: string }[] = [
  { value: 'free', label: 'Work it out' },
  { value: 'mcq', label: 'Multiple choice' },
  { value: 'code_output', label: 'Predict output' },
  { value: 'code_write', label: 'Write code' },
  { value: 'matching', label: 'Match the pairs' },
  { value: 'fill_blank', label: 'Fill the blanks' },
];

function ManualForm({
  classId,
  disabled,
  onSubmit,
}: {
  classId: string | null;
  disabled: boolean;
  onSubmit: (draft: Partial<Question>) => Promise<void>;
}) {
  const [type, setType] = useState<QuestionType>('free');
  const [topic, setTopic] = useState('');
  const [stem, setStem] = useState('');
  const [choices, setChoices] = useState('');
  const [answer, setAnswer] = useState('');
  const [steps, setSteps] = useState('');
  const [difficulty, setDifficulty] = useState<1 | 2 | 3 | 4 | 5>(3);
  // matching: «left => right» lines in `answer`, distractors in `choices`; fill_blank: one answer
  // line per ___ in `answer`. Both encode to the BE's JSON key (questionTypes).
  const structured =
    type === 'matching'
      ? encodeMatching(answer, choices)
      : type === 'fill_blank'
        ? encodeBlankAnswer(answer, stem)
        : null;
  const structuredError = structured && 'error' in structured && answer.trim() ? structured.error : null;
  const valid = Boolean(
    classId && topic.trim() && stem.trim() && answer.trim() && !(structured && 'error' in structured),
  );

  const submit = async () => {
    if (!valid || !classId) return;
    const choiceList = choices
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
    const encoded: { answer: string; pairs?: { left: string; right: string }[]; choices?: string[] } | null =
      structured && !('error' in structured) ? structured : null;

    await onSubmit({
      classId,
      topic: topic.trim(),
      type,
      stem: stem.trim(),
      choices: type === 'mcq' ? choiceList : encoded?.choices,
      pairs: encoded?.pairs,
      answer: encoded ? encoded.answer : answer.trim(),
      solutionSteps: steps
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      difficulty,
      source: { kind: 'manual', itemId: null, pageId: null, lectureId: null, ref: null },
      tags: [],
    });
    setStem('');
    setChoices('');
    setAnswer('');
    setSteps('');
  };

  const field =
    'w-full rounded-st border-2 border-st-clay-edge bg-st-surface px-3 py-2.5 text-base text-st-fg outline-none focus:border-st-accent';

  return (
    <form
      className='space-y-3'
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className='flex flex-wrap gap-2'>
        {TYPES.map((t) => (
          <Chip
            key={t.value}
            active={type === t.value}
            onPress={() => {
              // Answer and choices mean different things per type (pairs, blank lines, distractors).
              if (t.value !== type) {
                setAnswer('');
                setChoices('');
              }
              setType(t.value);
            }}
          >
            {t.label}
          </Chip>
        ))}
      </div>
      <input
        className={field}
        placeholder='Topic (e.g. Chain rule)'
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
      />
      <textarea
        className={`${field} min-h-[110px]`}
        placeholder={
          type === 'fill_blank'
            ? 'Sentence with ___ (three underscores) for each blank'
            : type === 'matching'
              ? 'Instruction, e.g. Match each rock to how it formed'
              : 'Question — markdown + $LaTeX$, ```cpp fences for code'
        }
        value={stem}
        onChange={(e) => setStem(e.target.value)}
      />
      {type === 'mcq' ? (
        <textarea
          className={`${field} min-h-[90px]`}
          placeholder='Choices, one per line'
          value={choices}
          onChange={(e) => setChoices(e.target.value)}
        />
      ) : null}
      {type === 'matching' || type === 'fill_blank' ? (
        <textarea
          className={`${field} min-h-[110px] font-mono text-sm`}
          placeholder={
            type === 'matching'
              ? 'Pairs, one per line:\nBasalt => Extrusive\nGranite => Intrusive'
              : 'One answer per blank, in order. Accept alternatives with |\nmagma\nlava | lava flow'
          }
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      ) : (
        <input
          className={field}
          placeholder={type === 'mcq' ? 'Correct choice (text or letter)' : 'Answer'}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
        />
      )}
      {type === 'matching' ? (
        <textarea
          className={`${field} min-h-[70px]`}
          placeholder='Extra wrong options, one per line (optional)'
          value={choices}
          onChange={(e) => setChoices(e.target.value)}
        />
      ) : null}
      {structuredError ? <p className='text-sm text-st-danger'>{structuredError}</p> : null}
      <textarea
        className={`${field} min-h-[80px]`}
        placeholder='Solution steps, one per line (optional)'
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
      />
      <div className='flex items-center gap-2'>
        <span className='text-xs font-semibold uppercase tracking-wide text-st-muted'>Difficulty</span>
        {([1, 2, 3, 4, 5] as const).map((d) => (
          <button
            key={d}
            aria-pressed={difficulty === d}
            className={`h-10 w-10 rounded-full text-sm font-semibold ${
              difficulty === d
                ? 'bg-st-accent text-st-accent-fg'
                : 'bg-st-raised text-st-fg'
            }`}
            type='button'
            onClick={() => setDifficulty(d)}
          >
            {d}
          </button>
        ))}
      </div>
      <button
        className='flex h-12 w-full items-center justify-center gap-2 rounded-st border-2 border-st-accent-lip bg-st-accent text-sm font-semibold text-st-accent-fg disabled:opacity-40 shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
        disabled={!valid || disabled}
        type='submit'
      >
        <FilePlus className='h-4 w-4' /> Add to bank
      </button>
    </form>
  );
}
