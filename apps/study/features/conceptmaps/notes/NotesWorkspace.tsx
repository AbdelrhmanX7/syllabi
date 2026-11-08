import type { GradeState } from '../lib/frames';
import type { MapWithNotes } from './api';
import type { NoteLink } from './links';
import type { InkCanvasHandle } from '@/features/bank';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Camera,
  GraduationCap,
  HelpCircle,
  Map as MapIcon,
  NotebookPen,
  NotebookText,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';

import { gradeConceptMap } from '../api';
import { GradePanel } from '../components/GradePanel';
import { conceptMapKeys, useCreatePractice, useInvalidateConceptMaps } from '../hooks';
import { fileToMapPngB64 } from '../lib/raster';
import { INITIAL_GRADE, reduceGradeFrame } from '../lib/frames';
import { mapTitle } from '../lib/score';
import { parseTermList } from '../lib/terms';

import { readSlideTerms, savePromptTerms } from './api';
import { ConceptStrip, QuestionsList } from './ConceptStrip';
import { DigestPanel } from './DigestPanel';
import { adoptDraftLinks, useNoteLinks, useNotesDigest } from './hooks';
import { LinkNotesDialog } from './LinkNotesDialog';
import { browserStore, linkKey, pageIdsOf } from './links';
import { MapPane, moveInk } from './MapPane';
import { NotesPane } from './NotesPane';
import { readLocalTerms, termsFromReply, writeLocalTerms } from './terms-store';
import {
  clampSplit,
  conceptChips,
  leadingQuestions,
  mergeQuestions,
  readSplit,
  readTicks,
  toggleTick,
  writeSplit,
  writeTicks,
} from './workspace-state';

import { ActionButton, Badge, INPUT_CLASS } from '@/components/ui/primitives';
import { useGuide } from '@/features/guide/api';
import { describeError } from '@/lib/api/errors';

/**
 * Notes + map, side by side — how he actually works: the lecture's notes (his leading questions
 * answered underneath, slide photos) on the left, the concept map on the right, the professor's
 * concept list across the top to tick off as each term lands on the map. Full screen, sized for the
 * Tab S9 Ultra in landscape; under 900 px wide the two sides become a Notes / Map toggle.
 *
 * `map` null = in-class mode: a fresh notes page and a blank board for a lecture whose concept list
 * has not been shown yet. Typing the list creates the practice map and carries the notes and ink over.
 */
export interface InClassDraft {
  key: string;
  lecture: string;
  week: number | null;
}

export interface NotesWorkspaceProps {
  classId: string;
  map: MapWithNotes | null;
  draft?: InClassDraft | null;
  onClose: () => void;
  /** In-class: the map now exists (the workspace keeps running on it). */
  onMapCreated?: (map: MapWithNotes) => void;
  onToast: (text: string, tone?: 'ok' | 'danger' | 'neutral') => void;
}

type Side = 'questions' | 'digest' | 'grade';
type NarrowView = 'notes' | 'map';

const NARROW_PX = 900;

export function NotesWorkspace({ classId, map, draft = null, onClose, onMapCreated, onToast }: NotesWorkspaceProps) {
  const mapKey = map?.id ?? draft?.key ?? 'draft';
  const lecture = map?.lecture ?? draft?.lecture ?? null;
  const week = map?.week ?? draft?.week ?? null;
  // A list saved here this session wins until the map record catches up (PATCH or device fallback).
  const [savedTerms, setSavedTerms] = useState<string[] | null>(null);
  const terms = map?.promptTerms.length ? map.promptTerms : (savedTerms ?? []);

  /* ---------------------------------------------------------------- notes */
  const linkError = useCallback((message: string) => onToast(message, 'danger'), [onToast]);
  const notes = useNoteLinks(mapKey, map, classId, linkError);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [pasted, setPasted] = useState<File | null>(null);
  const pageIds = useMemo(() => pageIdsOf(notes.links), [notes.links]);

  const link = useCallback(
    (row: NoteLink) => {
      notes.add(row);
      setActiveKey(linkKey(row));
    },
    [notes],
  );

  /* ---------------------------------------------------------------- chips + questions */
  const [ticked, setTicked] = useState<string[]>(() => readTicks(browserStore(), mapKey));
  const digest = useNotesDigest(map, pageIds);
  const guide = useGuide(classId);
  const chips = useMemo(
    () => conceptChips(terms, ticked, digest.available ? digest.digest : null),
    [digest.available, digest.digest, terms, ticked],
  );
  const questions = useMemo(
    () =>
      mergeQuestions(
        leadingQuestions(guide.data?.markdown, { lecture, week }),
        digest.available ? (digest.digest?.questions ?? []).map((row) => row.q) : [],
      ),
    [digest.available, digest.digest, guide.data?.markdown, lecture, week],
  );
  const answers = useMemo(
    () => new Map((digest.digest?.questions ?? []).map((row) => [row.q, row.answerFromNotes ?? null])),
    [digest.digest],
  );

  const tick = useCallback(
    (term: string) => {
      setTicked((current) => {
        const next = toggleTick(current, term);

        writeTicks(browserStore(), mapKey, next);

        return next;
      });
    },
    [mapKey],
  );

  /* ---------------------------------------------------------------- side panel */
  const [side, setSide] = useState<Side | null>(null);
  const digestShown = !!map && digest.available && pageIds.length > 0;

  useEffect(() => {
    if (side === 'digest' && !digestShown) setSide(null);
  }, [digestShown, side]);

  /* ---------------------------------------------------------------- grading */
  const inkRef = useRef<InkCanvasHandle>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [inkEmpty, setInkEmpty] = useState(true);
  const [grade, setGrade] = useState<GradeState>(INITIAL_GRADE);
  const invalidate = useInvalidateConceptMaps();
  const running = grade.phase === 'sending' || grade.phase === 'grading';

  useEffect(() => () => abortRef.current?.abort(), []);

  const runGrade = useCallback(async (target: MapWithNotes | null = map) => {
    const imagePngB64 = inkRef.current?.rasterize() ?? null;

    if (!target || !imagePngB64) return;
    abortRef.current?.abort();
    const controller = new AbortController();

    abortRef.current = controller;
    setSide('grade');
    setGrade({ ...INITIAL_GRADE, phase: 'sending' });
    try {
      await gradeConceptMap(
        { classId, imagePngB64, mapId: target.id, ...(terms.length > 0 ? { promptTerms: terms } : {}) },
        (frame) => setGrade((state) => reduceGradeFrame(state, frame)),
        controller.signal,
      );
      setGrade((state) => (state.phase === 'done' ? state : { ...state, phase: 'done' }));
      void invalidate.attempts(target.id);
      void invalidate.maps(classId);
    } catch (error) {
      if (controller.signal.aborted) return;
      setGrade((state) => ({ ...state, phase: 'error', error: describeError(error, 'Grading failed') }));
    }
  }, [classId, invalidate, map, terms]);

  /* ---------------------------------------------------------------- the concept list (in class) */
  const [termText, setTermText] = useState('');
  const [snapping, setSnapping] = useState(false);
  const [savingTerms, setSavingTerms] = useState(false);
  const snapRef = useRef<HTMLInputElement>(null);
  const create = useCreatePractice(classId);
  const queryClient = useQueryClient();

  /**
   * PATCH the list onto a map that has none. The device keeps a copy only until the backend has it: a
   * network/5xx failure retries on the next open; a 400 (the backend will never take it) drops it.
   */
  const pushTerms = useCallback(
    async (mapId: string, promptTerms: string[]) => {
      writeLocalTerms(browserStore(), mapId, promptTerms);
      try {
        await savePromptTerms(mapId, promptTerms);
        writeLocalTerms(browserStore(), mapId, []);

        return true;
      } catch (error) {
        const status = (error as { status?: unknown } | null)?.status;

        if (status === 400 || status === 404) writeLocalTerms(browserStore(), mapId, []);

        return false;
      } finally {
        void queryClient.invalidateQueries({ queryKey: conceptMapKeys.list(classId) });
      }
    },
    [classId, queryClient],
  );

  // A list kept on this device from an earlier open goes up again.
  useEffect(() => {
    if (!map) return;
    const pending = readLocalTerms(browserStore(), map.id);

    if (pending.length > 0) void pushTerms(map.id, pending);
  }, [map?.id]);

  const saveTerms = useCallback(async () => {
    const promptTerms = parseTermList(termText);

    if (promptTerms.length === 0) return;
    setSavingTerms(true);
    try {
      if (map) {
        // An assigned map that came without terms: the list goes onto it.
        const onServer = await pushTerms(map.id, promptTerms);

        setSavedTerms(promptTerms);
        setTermText('');
        onToast(
          onServer
            ? 'Concept list saved on the map.'
            : 'Concept list saved on this tablet — it syncs when the server accepts it.',
          'ok',
        );

        return;
      }
      if (!draft) return;
      const record = await create.mutateAsync({
        classId,
        promptTerms,
        ...(draft.lecture ? { lecture: draft.lecture } : {}),
        ...(draft.week !== null ? { week: draft.week } : {}),
      });

      adoptDraftLinks(draft.key, record.id);
      moveInk(draft.key, record.id);
      writeTicks(browserStore(), record.id, readTicks(browserStore(), draft.key));
      setTermText('');
      onMapCreated?.(record);
      onToast('Concept list saved — the map is in Practice now.', 'ok');
    } catch (error) {
      onToast(describeError(error, 'Could not save the concept list'), 'danger');
    } finally {
      setSavingTerms(false);
    }
  }, [classId, create, draft, map, onMapCreated, onToast, pushTerms, termText]);

  /** In class with no term list: grading makes the practice map from the lecture title alone (terms are optional). */
  const gradeDraft = useCallback(async () => {
    if (!draft || inkEmpty) return;
    try {
      const record = await create.mutateAsync({
        classId,
        lecture: draft.lecture,
        ...(draft.week !== null ? { week: draft.week } : {}),
      });

      adoptDraftLinks(draft.key, record.id);
      moveInk(draft.key, record.id);
      writeTicks(browserStore(), record.id, readTicks(browserStore(), draft.key));
      onMapCreated?.(record);
      await runGrade(record);
    } catch (error) {
      onToast(describeError(error, 'Could not start the map'), 'danger');
    }
  }, [classId, create, draft, inkEmpty, onMapCreated, onToast, runGrade]);

  /** «Snap the slide»: the tutor reads the concept-list slide; he checks the list before saving. */
  const snapSlide = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setSnapping(true);
      try {
        const found = termsFromReply(await readSlideTerms(classId, await fileToMapPngB64(file)));

        if (found.length === 0) onToast('No terms found on that photo — type them instead.', 'danger');
        else setTermText(found.join(', '));
      } catch (error) {
        onToast(describeError(error, 'Could not read the slide — type the terms instead'), 'danger');
      } finally {
        setSnapping(false);
      }
    },
    [classId, onToast],
  );

  /* ---------------------------------------------------------------- layout */
  const shellRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(() => readSplit(browserStore()));
  const [narrow, setNarrow] = useState(false);
  const [view, setView] = useState<NarrowView>('notes');
  const dragRef = useRef<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const fit = () => setNarrow(window.innerWidth < NARROW_PX);

    fit();
    window.addEventListener('resize', fit);

    return () => window.removeEventListener('resize', fit);
  }, []);

  // Paste a slide photo straight into the notes (a screenshot, or an image copied from the slides).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'));

      if (!file) return;
      event.preventDefault();
      setPasted(file);
      if (narrow) setView('notes');
    };

    window.addEventListener('paste', onPaste);

    return () => window.removeEventListener('paste', onPaste);
  }, [narrow]);

  // Esc closes an open side panel first, then nothing (leaving is the explicit back button).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSide(null);
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = shellRef.current?.getBoundingClientRect();

    if (!box) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { left: box.left, width: box.width };
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;

    if (drag) setSplit(clampSplit((event.clientX - drag.left) / drag.width));
  };
  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    writeSplit(browserStore(), split);
  };
  const nudge = (event: React.KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0;

    if (!step) return;
    event.preventDefault();
    const next = clampSplit(split + step);

    setSplit(next);
    writeSplit(browserStore(), next);
  };

  const title = map ? mapTitle(map) : (draft?.lecture ?? 'In class');
  const notesPane = (
    <NotesPane
      activeKey={activeKey}
      annotateByDefault={!!draft}
      classId={classId}
      compact={narrow}
      links={notes.links}
      pastedImage={pasted}
      onActiveKey={setActiveKey}
      onLinkNotes={() => setLinking(true)}
      onPastedImageTaken={() => setPasted(null)}
      onUnlink={notes.remove}
    />
  );
  const mapPane = <MapPane ref={inkRef} disabled={running} inkKey={mapKey} onEmptyChange={setInkEmpty} />;

  return (
    <div aria-label='Notes and map' className='bg-st-bg fixed inset-0 z-40 flex flex-col' role='dialog'>
      {/* ---- top bar: back, title and actions; under it the professor's concept list */}
      <header className='border-st-line bg-st-surface flex flex-col gap-1.5 border-b px-3 pb-2 pt-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <ActionButton aria-label='Back' className='min-h-10 shrink-0 px-2.5' variant='ghost' onClick={onClose}>
            <ArrowLeft className='h-4 w-4' />
          </ActionButton>
          <div className='min-w-0 flex-1'>
            <h2 className='text-st-fg truncate text-sm font-semibold'>{title}</h2>
            <p className='text-st-muted truncate text-xs'>
              {week !== null ? `Week ${week} · ` : ''}
              {notes.links.length} note{notes.links.length === 1 ? '' : 's'}
              {notes.source === 'device' && notes.links.length > 0 ? ' · links saved on this tablet' : ''}
            </p>
          </div>
          {narrow && (
            <div className='border-st-line flex shrink-0 rounded-full border p-0.5'>
              {(['notes', 'map'] as const).map((item) => (
                <button
                  key={item}
                  aria-pressed={view === item}
                  className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium ${
                    view === item ? 'bg-st-accent text-st-accent-fg' : 'text-st-fg'
                  }`}
                  type='button'
                  onClick={() => setView(item)}
                >
                  {item === 'notes' ? <NotebookPen className='h-4 w-4' /> : <MapIcon className='h-4 w-4' />}
                  {item === 'notes' ? 'Notes' : 'Map'}
                </button>
              ))}
            </div>
          )}
          <div className='flex shrink-0 items-center gap-1.5'>
            {questions.length > 0 && (
              <SideButton
                active={side === 'questions'}
                badge={questions.length}
                icon={HelpCircle}
                label='Questions'
                tone='neutral'
                onClick={() => setSide((current) => (current === 'questions' ? null : 'questions'))}
              />
            )}
            {digestShown && (
              <SideButton
                active={side === 'digest'}
                badge={digest.digest?.missingFromNotes.length || undefined}
                icon={NotebookText}
                label='Notes digest'
                onClick={() => setSide((current) => (current === 'digest' ? null : 'digest'))}
              />
            )}
            {map && grade.phase !== 'idle' && (
              <SideButton
                active={side === 'grade'}
                icon={GraduationCap}
                label='Result'
                onClick={() => setSide((current) => (current === 'grade' ? null : 'grade'))}
              />
            )}
            {(map || draft) && (
              <ActionButton
                className='min-h-10 px-3'
                disabled={inkEmpty}
                loading={running || create.isPending}
                variant='primary'
                onClick={() => void (map ? runGrade() : gradeDraft())}
              >
                <Sparkles className='h-4 w-4' /> Grade
              </ActionButton>
            )}
          </div>
        </div>

        {terms.length > 0 ? (
          <ConceptStrip chips={chips} onToggle={tick} />
        ) : (
          <form
            className='flex min-w-0 items-center gap-2'
            onSubmit={(event) => {
              event.preventDefault();
              void saveTerms();
            }}
          >
            <input
              ref={snapRef}
              accept='image/*'
              capture='environment'
              className='hidden'
              type='file'
              onChange={(event) => {
                const file = event.target.files?.[0];

                event.target.value = '';
                void snapSlide(file);
              }}
            />
            <ActionButton
              className='min-h-10 shrink-0 px-3'
              loading={snapping}
              title='Photo of the term-list slide; the AI reads the terms, you check them'
              onClick={() => snapRef.current?.click()}
            >
              <Camera className='h-4 w-4' /> {snapping ? 'Reading the slide…' : 'Snap the slide'}
            </ActionButton>
            <input
              aria-label='Term list'
              className={`${INPUT_CLASS} min-h-10 flex-1`}
              placeholder='Term list (optional) — snap the slide or type it, comma-separated'
              value={termText}
              onChange={(event) => setTermText(event.target.value)}
            />
            <ActionButton
              className='min-h-10 shrink-0 px-3'
              disabled={parseTermList(termText).length === 0 || snapping}
              loading={savingTerms}
              type='submit'
              variant='primary'
            >
              <Plus className='h-4 w-4' /> Save list
            </ActionButton>
          </form>
        )}
      </header>

      {/* ---- body: notes | divider | map, and the side panel over the map's edge */}
      <div ref={shellRef} className='relative flex min-h-0 flex-1'>
        {narrow ? (
          <>
            <div className={view === 'notes' ? 'min-w-0 flex-1' : 'hidden'}>{notesPane}</div>
            <div className={view === 'map' ? 'min-w-0 flex-1' : 'hidden'}>{mapPane}</div>
          </>
        ) : (
          <>
            <div className='min-w-0' style={{ width: `${split * 100}%` }}>
              {notesPane}
            </div>
            {/* A focusable separator with a value is the ARIA window-splitter pattern; the rules predate it. */}
            {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
            <div
              aria-label='Resize notes and map'
              aria-orientation='vertical'
              aria-valuemax={75}
              aria-valuemin={25}
              aria-valuenow={Math.round(split * 100)}
              className='bg-st-line hover:bg-st-accent/50 focus-visible:bg-st-accent group relative w-1.5 shrink-0 cursor-col-resize touch-none outline-none transition-colors'
              role='separator'
              tabIndex={0}
              onDoubleClick={() => {
                setSplit(0.5);
                writeSplit(browserStore(), 0.5);
              }}
              onKeyDown={nudge}
              onPointerCancel={endDrag}
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
            >
              {/* A wider invisible grip for a finger; the visible bar stays thin. */}
              <span className='absolute inset-y-0 -left-2.5 -right-2.5' />
              <span className='bg-st-surface border-st-clay-edge shadow-clay absolute left-1/2 top-1/2 h-12 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2' />
            </div>
            {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
            <div className='min-w-0 flex-1'>{mapPane}</div>
          </>
        )}

        {side && (
          <aside className='border-st-clay-edge bg-st-surface absolute inset-y-0 right-0 z-20 flex w-full max-w-[400px] flex-col border-l-[1.5px]'>
            <div className='border-st-line flex items-center gap-1 border-b px-3 py-2'>
              {(
                [
                  ['questions', 'Questions', questions.length > 0],
                  ['digest', 'Notes digest', digestShown],
                  ['grade', 'Result', grade.phase !== 'idle'],
                ] as const
              )
                .filter(([, , shown]) => shown)
                .map(([id, label]) => (
                  <button
                    key={id}
                    aria-pressed={side === id}
                    className={`min-h-9 rounded-full px-3 text-sm font-medium ${
                      side === id ? 'bg-st-accent text-st-accent-fg' : 'text-st-fg hover:bg-st-raised'
                    }`}
                    type='button'
                    onClick={() => setSide(id)}
                  >
                    {label}
                  </button>
                ))}
              <span className='flex-1' />
              <button
                aria-label='Close panel'
                className='text-st-muted hover:bg-st-raised flex h-9 w-9 items-center justify-center rounded-full'
                type='button'
                onClick={() => setSide(null)}
              >
                <X className='h-4 w-4' />
              </button>
            </div>
            <div className='flex-1 overflow-y-auto p-4'>
              {side === 'questions' ? (
                <>
                  <p className='text-st-muted mb-3 text-xs'>
                    Leading questions for this lecture. Answer them in your notes — the map links the answers.
                  </p>
                  <QuestionsList answers={answers} questions={questions} />
                </>
              ) : side === 'digest' ? (
                <DigestPanel
                  digest={digest.digest}
                  error={digest.phase === 'error' ? digest.error : null}
                  loading={digest.phase === 'reading'}
                  pages={digest.pages}
                  progress={digest.progress}
                  sample={digest.sample}
                  terms={terms}
                  titleOf={(pageId) => notes.links.find((row) => row.kind === 'page' && row.pageId === pageId)?.title}
                  onRetry={digest.run}
                />
              ) : (
                <GradePanel state={grade} onRetry={() => void runGrade()} />
              )}
            </div>
          </aside>
        )}
      </div>

      {linking && (
        <LinkNotesDialog
          classId={classId}
          linked={notes.links}
          week={week}
          onClose={() => setLinking(false)}
          onLink={link}
        />
      )}
    </div>
  );
}

function SideButton({
  icon: Icon,
  label,
  active,
  badge,
  tone = 'warn',
  onClick,
}: {
  icon: typeof HelpCircle;
  label: string;
  active: boolean;
  badge?: number;
  tone?: 'warn' | 'neutral';
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm font-medium ${
        active ? 'border-st-accent-lip bg-st-accent text-st-accent-fg' : 'border-st-line bg-st-surface text-st-fg hover:bg-st-raised'
      }`}
      type='button'
      onClick={onClick}
    >
      <Icon className='h-4 w-4' />
      <span className='hidden xl:inline'>{label}</span>
      {badge ? <Badge tone={tone}>{badge}</Badge> : null}
    </button>
  );
}
