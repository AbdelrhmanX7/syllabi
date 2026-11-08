import type { GradeState } from '../lib/frames';
import type { PredictState } from '../lib/frames';
import type { ConceptMapRecord, MapAttempt } from '../types';
import type { InkCanvasHandle } from '@/features/bank';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Columns2,
  ImagePlus,
  Loader2,
  NotebookPen,
  Quote,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';

import { gradeConceptMap, predictPrompts } from '../api';
import { useAttempts, useCreatePractice, useInvalidateConceptMaps } from '../hooks';
import { buildChecklist, isNoPromptTerms } from '../lib/checklist';
import { INITIAL_GRADE, INITIAL_PREDICT, reduceGradeFrame, reducePredictState } from '../lib/frames';
import { readingGraph } from '../lib/mapDiff';
import { NO_PROVENANCE } from '../lib/provenance';
import { fileToMapPngB64 } from '../lib/raster';
import { withStreamRetry } from '../lib/streamRetry';
import { byNumber, formatScore, mapTitle, scoreTone } from '../lib/score';
import { matchTerms, parseTermList } from '../lib/terms';
import { InClassCard } from '../notes/InClassCard';
import { NotesWorkspace, type InClassDraft } from '../notes/NotesWorkspace';

import { GetToTen, NeedsTerms } from './GetToTen';
import { BuiltFrom } from './BuiltFrom';
import { GradePanel } from './GradePanel';
import { PredictionCard } from './PredictionCard';
import { DEFINED_HINT, TermChecklist } from './TermChecklist';

import { formatRelative } from '@/lib/format';
import { describeError, isRetryableStreamError } from '@/lib/api/errors';
import { InkCanvas } from '@/features/bank';
import { ActionButton, Badge, EmptyState, ErrorNote, Field, INPUT_CLASS, Surface } from '@/components/ui/primitives';

/**
 * Practice: pick a prompt (an assigned map, a predicted one, or your own topic), draw the map with
 * the pen, grade it live, keep the attempt. A drill walks a queue of maps (the exam picks) in order.
 */
export interface PracticeProps {
  classId: string;
  maps: ConceptMapRecord[];
  /** Open straight into a session for this map. */
  initial?: ConceptMapRecord | null;
  /** The exam drill queue; the session offers «Next map» until it runs out. */
  drill?: ConceptMapRecord[] | null;
  onToast: (text: string, tone?: 'ok' | 'danger' | 'neutral') => void;
  onCompare: (map: ConceptMapRecord) => void;
}

export function Practice({ classId, maps, initial = null, drill = null, onToast, onCompare }: PracticeProps) {
  const [session, setSession] = useState<ConceptMapRecord | null>(initial);

  useEffect(() => {
    if (initial) setSession(initial);
  }, [initial?.id]);

  if (session) {
    const drillIndex = drill ? drill.findIndex((map) => map.id === session.id) : -1;
    const next = drill && drillIndex >= 0 ? drill[drillIndex + 1] : undefined;

    return (
      <PracticeSession
        key={session.id}
        classId={classId}
        drill={drill && drillIndex >= 0 ? { index: drillIndex, total: drill.length } : null}
        map={session}
        onBack={() => setSession(null)}
        onCompare={() => onCompare(session)}
        onNext={next ? () => setSession(next) : undefined}
        onToast={onToast}
      />
    );
  }

  return <Picker classId={classId} maps={maps} onPick={setSession} onToast={onToast} />;
}

/* ------------------------------------------------------------------ picker */

function Picker({
  classId,
  maps,
  onPick,
  onToast,
}: {
  classId: string;
  maps: ConceptMapRecord[];
  onPick: (map: ConceptMapRecord) => void;
  onToast: PracticeProps['onToast'];
}) {
  const assigned = useMemo(
    () => maps.filter((map) => map.source !== 'practice').sort((a, b) => byNumber(b, a)),
    [maps],
  );
  const recentPractice = useMemo(
    () =>
      maps
        .filter((map) => map.source === 'practice')
        .slice(-4)
        .reverse(),
    [maps],
  );
  const [custom, setCustom] = useState('');
  const [topic, setTopic] = useState('');
  const [predicted, setPredicted] = useState<PredictState>(INITIAL_PREDICT);
  const [predicting, setPredicting] = useState(false);
  // Empty = the next lecture (the backend works it out); else 1..200.
  const [lectureInput, setLectureInput] = useState('');
  const [predictError, setPredictError] = useState<string | null>(null);
  const create = useCreatePractice(classId);
  const abortRef = useRef<AbortController | null>(null);
  // In class: notes + a blank board before the concept list exists; the map appears once he types it.
  const [inClass, setInClass] = useState<{ draft: InClassDraft; map: ConceptMapRecord | null } | null>(null);
  const latestWeek = useMemo(
    () =>
      assigned.reduce<number | null>(
        (max, map) => (map.week !== null && (max === null || map.week > max) ? map.week : max),
        null,
      ),
    [assigned],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  const predict = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();

    abortRef.current = controller;
    setPredicting(true);
    setPredictError(null);
    setPredicted(INITIAL_PREDICT);
    const lecture = Number(lectureInput);
    // ~25 s of model work. No client timeout on the stream; a network cut before the prediction
    // lands is rerun once. Once it has landed, a cut before `done` loses nothing.
    let complete = false;
    const run = () =>
      predictPrompts(
        { classId, ...(Number.isInteger(lecture) && lecture >= 1 && lecture <= 200 ? { lecture } : {}) },
        (frame) => {
          if (frame.event === 'prediction' || frame.event === 'done') complete = true;
          setPredicted((state) => reducePredictState(state, frame));
        },
        controller.signal,
      );

    try {
      await withStreamRetry(run, {
        signal: controller.signal,
        finished: () => complete,
        onRetry: () => setPredicted({ ...INITIAL_PREDICT, status: 'Connection dropped — retrying…' }),
      });
    } catch (error) {
      if (!controller.signal.aborted && !(complete && isRetryableStreamError(error)))
        setPredictError(describeError(error, 'Could not guess the next prompt'));
    } finally {
      if (!controller.signal.aborted) setPredicting(false);
    }
  }, [classId, lectureInput]);

  const start = useCallback(
    async (body: { promptTerms?: string[]; lecture?: string; week?: number }) => {
      try {
        const record = await create.mutateAsync({ classId, ...body });

        onPick(record);
      } catch (error) {
        onToast(describeError(error, 'Could not start a practice map'), 'danger');
      }
    },
    [classId, create, onPick, onToast],
  );

  const customTerms = parseTermList(custom);
  const customTopic = topic.trim();
  // A topic alone is enough (the AI builds / checks freely); terms are optional.
  const canStartCustom = customTopic.length > 0 || customTerms.length >= 2;
  const startCustom = () =>
    void start({
      ...(customTerms.length > 0 ? { promptTerms: customTerms } : {}),
      ...(customTopic ? { lecture: customTopic } : {}),
    });

  return (
    <div className='grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'>
      <Surface className='flex flex-col gap-3 p-4'>
        <h2 className='text-st-fg text-sm font-semibold'>Redo an assigned map</h2>
        <p className='text-st-muted text-sm'>Same topic, blank page. «Exam» = marked for review.</p>
        {assigned.length === 0 ? (
          <p className='text-st-muted text-sm'>No assigned maps in this class yet.</p>
        ) : (
          <ul className='flex flex-col gap-1.5'>
            {assigned.map((map) => (
              <li key={map.id}>
                <button
                  className='rounded-st hover:bg-st-raised flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left'
                  type='button'
                  onClick={() => onPick(map)}
                >
                  <span className='text-st-muted w-8 shrink-0 text-xs font-medium tabular-nums'>
                    {map.number !== null ? `#${map.number}` : ''}
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='text-st-fg block truncate text-sm font-medium'>{mapTitle(map)}</span>
                    {map.promptTerms.length > 0 && (
                      <span className='text-st-muted block truncate text-xs'>{map.promptTerms.join(' · ')}</span>
                    )}
                  </span>
                  {map.examReview && <Badge tone='accent'>Exam</Badge>}
                  <Badge tone={scoreTone(map.score, map.maxScore)}>{formatScore(map.score, map.maxScore)}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
        {recentPractice.length > 0 && (
          <>
            <h3 className='text-st-muted mt-2 text-xs font-medium uppercase tracking-wide'>Recent practice</h3>
            <ul className='flex flex-col gap-1.5'>
              {recentPractice.map((map) => (
                <li key={map.id}>
                  <button
                    className='rounded-st hover:bg-st-raised flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left'
                    type='button'
                    onClick={() => onPick(map)}
                  >
                    <span className='min-w-0 flex-1'>
                      <span className='text-st-fg block truncate text-sm font-medium'>{mapTitle(map)}</span>
                      {map.promptTerms.length > 0 && (
                        <span className='text-st-muted block truncate text-xs'>{map.promptTerms.join(' · ')}</span>
                      )}
                    </span>
                    <Badge tone={scoreTone(map.score, map.maxScore)}>{formatScore(map.score, map.maxScore)}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Surface>

      <div className='flex flex-col gap-4'>
        <InClassCard
          classId={classId}
          defaultWeek={latestWeek !== null ? latestWeek + 1 : null}
          maps={assigned}
          onStart={(draft, map) => setInClass({ draft, map })}
        />
        {inClass && (
          <NotesWorkspace
            classId={classId}
            draft={inClass.draft}
            map={inClass.map}
            onClose={() => {
              const made = inClass.map;

              setInClass(null);
              if (made) onPick(made);
            }}
            onMapCreated={(map) => setInClass((current) => (current ? { ...current, map } : current))}
            onToast={onToast}
          />
        )}

        <Surface className='flex flex-col gap-3 p-4'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <h2 className='text-st-fg text-sm font-semibold'>Guess the next prompt</h2>
            <div className='flex items-center gap-2'>
              <input
                aria-label='Lecture number'
                className='rounded-st border-st-control-edge bg-st-surface text-st-fg min-h-10 w-28 border-2 px-2 text-sm'
                disabled={predicting}
                inputMode='numeric'
                max={200}
                min={1}
                placeholder='Next lecture'
                type='number'
                value={lectureInput}
                onChange={(event) => setLectureInput(event.target.value)}
              />
              <ActionButton
                className='min-h-10 px-3'
                loading={predicting}
                variant='primary'
                onClick={() => void predict()}
              >
                <Sparkles className='h-4 w-4' /> Predict
              </ActionButton>
            </div>
          </div>
          <p className='text-st-muted text-sm'>
            Terms likely to come up in a lecture, from the syllabus, readings, slides and past maps. Leave the lecture
            empty for the next one.
          </p>
          {predictError && <ErrorNote message={predictError} onRetry={() => void predict()} />}
          {predicting && !predicted.prediction && predicted.prompts.length === 0 && (
            <p className='text-st-muted flex items-center gap-2 text-sm'>
              <Loader2 className='h-4 w-4 animate-spin' /> {predicted.status ?? 'Reading the syllabus…'}
            </p>
          )}
          {predicted.prediction && (
            <PredictionCard
              practicing={create.isPending}
              prediction={predicted.prediction}
              provenance={predicted.provenance}
              onPractice={(terms) =>
                void start({
                  promptTerms: terms,
                  ...(predicted.prediction?.lecture.title ? { lecture: predicted.prediction.lecture.title } : {}),
                  ...(predicted.prediction?.lecture.week ? { week: predicted.prediction.lecture.week } : {}),
                })
              }
            />
          )}
          {/* An older backend sends only the legacy `prompt` frames. */}
          {!predicted.prediction && predicted.prompts.length > 0 && <BuiltFrom provenance={predicted.provenance} />}
          {(predicted.prediction ? [] : predicted.prompts).map((prompt, index) => (
            <div key={index} className='rounded-st border-st-line flex flex-col gap-2 border px-3 py-3'>
              <p className='text-st-fg text-sm font-medium'>
                {prompt.lecture || 'Predicted prompt'}
                {prompt.week > 0 && <span className='text-st-muted ml-2 text-xs font-normal'>Week {prompt.week}</span>}
              </p>
              <div className='flex flex-wrap gap-1.5'>
                {prompt.terms.map((term) => (
                  <Badge key={term}>{term}</Badge>
                ))}
              </div>
              {prompt.why && <p className='text-st-muted text-xs'>{prompt.why}</p>}
              <ActionButton
                className='min-h-10 self-start px-3'
                loading={create.isPending}
                onClick={() => void start({ promptTerms: prompt.terms, lecture: prompt.lecture, week: prompt.week })}
              >
                <Wand2 className='h-4 w-4' /> Practice this
              </ActionButton>
            </div>
          ))}
        </Surface>

        <Surface className='flex flex-col gap-3 p-4'>
          <h2 className='text-st-fg text-sm font-semibold'>Your own topic</h2>
          <Field label='Topic'>
            <input
              className={INPUT_CLASS}
              placeholder='e.g. Photosynthesis, Recursion, The French Revolution'
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canStartCustom) startCustom();
              }}
            />
          </Field>
          <Field hint='Optional. Comma-separated; the grader checks each one.' label='Terms'>
            <input
              className={INPUT_CLASS}
              placeholder='Leave empty to let the AI choose'
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canStartCustom) startCustom();
              }}
            />
          </Field>
          <ActionButton
            className='self-start'
            disabled={!canStartCustom}
            loading={create.isPending}
            variant='primary'
            onClick={startCustom}
          >
            {customTerms.length > 0
              ? `Start with ${customTerms.length} term${customTerms.length === 1 ? '' : 's'}`
              : 'Start'}
          </ActionButton>
        </Surface>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ session */

const CANVAS_CHROME_PX = 300;

function PracticeSession({
  classId,
  map,
  drill,
  onBack,
  onCompare,
  onNext,
  onToast,
}: {
  classId: string;
  map: ConceptMapRecord;
  drill: { index: number; total: number } | null;
  onBack: () => void;
  onCompare: () => void;
  onNext?: () => void;
  onToast: PracticeProps['onToast'];
}) {
  const inkRef = useRef<InkCanvasHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [defined, setDefined] = useState(false);
  const [grade, setGrade] = useState<GradeState>(INITIAL_GRADE);
  const [photo, setPhoto] = useState<{ b64: string; name: string } | null>(null);
  const [inkEmpty, setInkEmpty] = useState(true);
  const [canvasHeight, setCanvasHeight] = useState(560);
  const [wordingOpen, setWordingOpen] = useState(false);
  const [workspace, setWorkspace] = useState(false);
  const attempts = useAttempts(map.id);
  const invalidate = useInvalidateConceptMaps();
  const wording = map.instructor?.modelAnswer ?? null;
  // Terms are optional; only a server that still answers 400 NO_PROMPT_TERMS asks for a list first.
  const [termsRefused, setTermsRefused] = useState(false);
  const needsTerms = termsRefused;
  const hasTerms = map.promptTerms.length > 0;

  useEffect(() => {
    const fit = () => setCanvasHeight(Math.max(420, window.innerHeight - CANVAS_CHROME_PX));

    fit();
    window.addEventListener('resize', fit);

    return () => {
      window.removeEventListener('resize', fit);
      abortRef.current?.abort();
    };
  }, []);

  // Her wording stays folded while he draws (no peeking); it opens once the grade is in.
  useEffect(() => {
    if (grade.phase === 'done' && wording) setWordingOpen(true);
  }, [grade.phase, wording]);

  const matches = useMemo(
    () => (grade.reading ? matchTerms(map.promptTerms, grade.reading.nodes) : null),
    [grade.reading, map.promptTerms],
  );
  const running = grade.phase === 'sending' || grade.phase === 'grading';
  // «Get to 10/10» from the grader's own reading and verdict (no AI reference here).
  const checklist = useMemo(
    () =>
      grade.phase === 'done' && (grade.reading || grade.verdict)
        ? buildChecklist({
            his: grade.reading ? readingGraph(grade.reading) : null,
            promptTerms: map.promptTerms,
            verdict: grade.verdict,
            criteria: grade.criteria,
            modelAnswer: wording,
          })
        : null,
    [grade.criteria, grade.phase, grade.reading, grade.verdict, map.promptTerms, wording],
  );

  useEffect(() => setTermsRefused(false), [map.id, map.promptTerms.length]);

  const toggle = useCallback((term: string) => {
    setChecked((current) => {
      const next = new Set(current);

      if (next.has(term)) next.delete(term);
      else next.add(term);

      return next;
    });
  }, []);

  const runGrade = useCallback(async () => {
    const imagePngB64 = photo?.b64 ?? inkRef.current?.rasterize() ?? null;

    if (!imagePngB64) {
      onToast('Draw the map first, or add a photo of it.', 'danger');

      return;
    }
    if (!defined) onToast('Tip: write a short definition under every term.', 'neutral');
    abortRef.current?.abort();
    const controller = new AbortController();

    abortRef.current = controller;
    setGrade({ ...INITIAL_GRADE, phase: 'sending' });
    try {
      await gradeConceptMap(
        // The backend saves the attempt under `mapId` (and falls back to the map's own terms).
        {
          classId,
          imagePngB64,
          mapId: map.id,
          ...(map.promptTerms.length > 0 ? { promptTerms: map.promptTerms } : {}),
        },
        (frame) => setGrade((state) => reduceGradeFrame(state, frame)),
        controller.signal,
      );
      setGrade((state) => (state.phase === 'done' ? state : { ...state, phase: 'done' }));
      void invalidate.attempts(map.id);
      void invalidate.maps(classId);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isNoPromptTerms(error)) {
        setTermsRefused(true);
        setGrade(INITIAL_GRADE);

        return;
      }
      setGrade((state) => ({ ...state, phase: 'error', error: describeError(error, 'Grading failed') }));
    }
  }, [classId, defined, invalidate, map.id, map.promptTerms, onToast, photo]);

  const pickPhoto = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        const b64 = await fileToMapPngB64(file);

        setPhoto({ b64, name: file.name });
        setGrade(INITIAL_GRADE);
      } catch (error) {
        onToast(describeError(error, 'Could not read that picture'), 'danger');
      }
    },
    [onToast],
  );

  const showAttempt = useCallback((attempt: MapAttempt) => {
    abortRef.current?.abort();
    setGrade({
      phase: 'done',
      reading: attempt.reading ?? null,
      criteria: attempt.criteria ?? [],
      verdict: attempt.verdict,
      attemptId: attempt.id,
      error: null,
      provenance: attempt.provenance ?? NO_PROVENANCE,
    });
  }, []);

  const startOver = useCallback(() => {
    abortRef.current?.abort();
    inkRef.current?.clear();
    setPhoto(null);
    setChecked(new Set());
    setDefined(false);
    setGrade(INITIAL_GRADE);
    setWordingOpen(false);
  }, []);

  return (
    <div className='flex flex-col gap-3'>
      <header className='flex flex-wrap items-center gap-2'>
        <ActionButton className='min-h-10 px-3' variant='ghost' onClick={onBack}>
          <ArrowLeft className='h-4 w-4' /> All prompts
        </ActionButton>
        <div className='min-w-0 flex-1'>
          <h2 className='text-st-fg truncate text-base font-semibold'>{mapTitle(map)}</h2>
          <p className='text-st-muted text-xs'>
            {drill
              ? `Exam drill · map ${drill.index + 1} of ${drill.total}`
              : map.source === 'practice'
                ? 'Practice'
                : map.number !== null
                  ? `Map ${map.number}`
                  : 'Concept map'}
            {hasTerms ? ` · ${map.promptTerms.length} terms` : ''} · out of {map.maxScore}
          </p>
        </div>
        <ActionButton className='min-h-10 px-3' onClick={() => setWorkspace(true)}>
          <NotebookPen className='h-4 w-4' /> Notes + map
        </ActionButton>
        <ActionButton className='min-h-10 px-3' onClick={onCompare}>
          <Columns2 className='h-4 w-4' /> Compare
        </ActionButton>
        {onNext && grade.phase === 'done' && (
          <ActionButton className='min-h-10 px-3' variant='primary' onClick={onNext}>
            Next map <ArrowRight className='h-4 w-4' />
          </ActionButton>
        )}
      </header>

      <div className='grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]'>
        <div className='flex min-w-0 flex-col gap-3'>
          <div className='bg-st-bg/95 sticky top-0 z-10 py-1 backdrop-blur'>
            <TermChecklist
              checked={checked}
              defined={defined}
              disabled={running}
              matches={matches}
              terms={map.promptTerms}
              onToggle={toggle}
              onToggleDefined={() => setDefined((value) => !value)}
            />
          </div>

          {photo ? (
            <div className='rounded-st-lg border-st-line relative overflow-hidden border bg-st-shadow'>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt='Your map'
                className='max-h-[70vh] w-full object-contain'
                src={`data:image/png;base64,${photo.b64}`}
              />
              <button
                aria-label='Remove photo'
                className='bg-st-surface text-st-fg border-st-clay-edge shadow-clay border-2 absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full'
                type='button'
                onClick={() => setPhoto(null)}
              >
                <X className='h-4 w-4' />
              </button>
              <p className='text-st-muted bg-st-surface/90 absolute bottom-0 left-0 right-0 truncate px-3 py-1 text-xs'>
                {photo.name}
              </p>
            </div>
          ) : (
            <InkCanvas ref={inkRef} disabled={running} minHeight={canvasHeight} onChange={setInkEmpty} />
          )}

          <div className='flex flex-wrap items-center gap-2'>
            <ActionButton
              className='min-h-12 flex-1 px-4 text-base sm:flex-none'
              disabled={needsTerms || (!photo && inkEmpty)}
              loading={running}
              variant='primary'
              onClick={() => void runGrade()}
            >
              <Sparkles className='h-4 w-4' /> Grade
            </ActionButton>
            <input
              ref={fileRef}
              accept='image/*'
              className='hidden'
              type='file'
              onChange={(event) => {
                void pickPhoto(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <ActionButton className='min-h-12 px-3' disabled={running} onClick={() => fileRef.current?.click()}>
              <ImagePlus className='h-4 w-4' /> {photo ? 'Another photo' : 'Photo of a map'}
            </ActionButton>
            {grade.phase !== 'idle' && (
              <ActionButton className='min-h-12 px-3' disabled={running} variant='ghost' onClick={startOver}>
                Start over
              </ActionButton>
            )}
          </div>
        </div>

        <aside className='flex min-w-0 flex-col gap-4'>
          {needsTerms && <NeedsTerms onEnter={() => setWorkspace(true)} />}
          {checklist && <GetToTen grade={grade.verdict} items={checklist} />}

          {wording && (
            <Surface className='p-4'>
              <button
                aria-expanded={wordingOpen}
                className='text-st-fg flex w-full items-center gap-1.5 text-left text-sm font-semibold'
                type='button'
                onClick={() => setWordingOpen((open) => !open)}
              >
                {wordingOpen ? (
                  <ChevronDown className='text-st-muted h-4 w-4' />
                ) : (
                  <ChevronRight className='text-st-muted h-4 w-4' />
                )}
                <Quote className='text-st-accent h-4 w-4' />
                Model answer
                <span className='text-st-muted ml-auto text-xs font-normal'>{wordingOpen ? 'hide' : 'show'}</span>
              </button>
              {wordingOpen ? (
                <p className='rounded-st border-st-accent/30 bg-st-accent/5 text-st-fg mt-2 whitespace-pre-wrap border px-3 py-2 text-sm leading-relaxed'>
                  {wording}
                </p>
              ) : (
                <p className='text-st-muted mt-1 text-xs'>
                  Opens after you grade, so you draw from memory first.
                </p>
              )}
            </Surface>
          )}

          <Surface className='p-4'>
            {grade.phase === 'idle' ? (
              <EmptyState
                hint={`Draw a box for each ${hasTerms ? 'term' : 'key idea'}. Join boxes with arrows. Write on every arrow what the link is. ${DEFINED_HINT}`}
                title='Grade when the map is done'
              />
            ) : (
              <GradePanel state={grade} onRetry={() => void runGrade()} />
            )}
          </Surface>

          <Surface className='p-4'>
            <h3 className='text-st-muted mb-2 text-xs font-medium uppercase tracking-wide'>Attempts</h3>
            {attempts.isLoading ? (
              <p className='text-st-muted text-sm'>Loading…</p>
            ) : !attempts.data || attempts.data.length === 0 ? (
              <p className='text-st-muted text-sm'>No graded attempts yet.</p>
            ) : (
              <ul className='flex flex-col gap-1'>
                {attempts.data.map((attempt) => (
                  <li key={attempt.id}>
                    <button
                      className='rounded-st hover:bg-st-raised flex min-h-11 w-full items-center gap-3 px-2 text-left text-sm'
                      type='button'
                      onClick={() => showAttempt(attempt)}
                    >
                      {attempt.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt=''
                          className='h-9 w-12 shrink-0 rounded border border-st-clay-edge bg-st-shadow object-contain'
                          src={attempt.imageUrl}
                        />
                      ) : (
                        <span className='bg-st-raised h-9 w-12 shrink-0 rounded' />
                      )}
                      <span className='text-st-muted flex-1 truncate text-xs'>{formatRelative(attempt.createdAt)}</span>
                      <Badge tone={scoreTone(attempt.verdict.score, attempt.verdict.max)}>
                        {formatScore(attempt.verdict.score, attempt.verdict.max)}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Surface>
        </aside>
      </div>

      {workspace && (
        <NotesWorkspace classId={classId} map={map} onClose={() => setWorkspace(false)} onToast={onToast} />
      )}
    </div>
  );
}
