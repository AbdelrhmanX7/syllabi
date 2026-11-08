import type { ConceptMapRecord } from '../types';
import type { MapWithNotes } from './api';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, ExternalLink, Images, Network, Save, Target } from 'lucide-react';

import { gradeConceptMap } from '../api';
import { GetToTen } from '../components/GetToTen';
import { GradePanel } from '../components/GradePanel';
import { conceptMapKeys, useConceptMaps, useInvalidateConceptMaps } from '../hooks';
import { buildChecklist, isNoPromptTerms } from '../lib/checklist';
import { INITIAL_GRADE, reduceGradeFrame } from '../lib/frames';
import { readingGraph } from '../lib/mapDiff';
import { mapsLinkedToPage, newestFirst, PICK_REASON_TEXT, pickMapForPage } from '../lib/pickMap';
import { b64ToDataUrl, fileToMapPngB64 } from '../lib/raster';
import { mapTitle } from '../lib/score';
import { matchTerms, parseTermList } from '../lib/terms';

import { readSlideTerms, savePromptTerms } from './api';
import { useNoteLinks } from './hooks';
import { pagePhotosForWire, readImageTerms, usePagePhotos } from './MapFromPhoto';
import { browserStore, pageIdsOf, readLinks } from './links';
import { termsFromReply, withLocalTerms, writeLocalTerms } from './terms-store';
import { readTicks, writeTicks } from './workspace-state';

import { ActionButton, Badge, ErrorNote, Field, INPUT_CLASS, LoadingRows } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { describeError } from '@/lib/api/errors';

/**
 * «Concept map» on a notebook's selection bar: the lassoed handwriting is an attempt at one of the
 * class's concept maps. Picks the map (linked page → week → lecture → newest unscored), shows its
 * concept list (or takes one: typed or read off a slide photo), and grades the picture live. Grading
 * links the page to the map, so the notes digest reads the rest of the page as context.
 */
export interface SelectionMapSheetProps {
  classId: string;
  pageId: string;
  pageTitle: string;
  /** The page's lecture-note record, when it has one (wins over the title). */
  lecture?: { week?: number | null; lecture?: number | null; mapId?: string | null } | null;
  /** The selection on white, base64 PNG (long side ≤ 2000 px). */
  imagePngB64: string;
  onClose: () => void;
}

type Mode = 'preview' | 'attempt';

export function SelectionMapSheet({ classId, pageId, pageTitle, lecture = null, imagePngB64, onClose }: SelectionMapSheetProps) {
  const maps = useConceptMaps(classId);
  const store = browserStore();
  const mapList = useMemo(
    () => (maps.data ?? []).map((map) => withLocalTerms(map, store) as MapWithNotes).sort(newestFirst),
    [maps.data, store],
  );
  const pick = useMemo(
    () =>
      pickMapForPage(mapList, {
        pageId,
        title: pageTitle,
        week: lecture?.week ?? null,
        lecture: lecture?.lecture ?? null,
        mapId: lecture?.mapId ?? null,
        linkedMapIds: mapsLinkedToPage(mapList, pageId, (mapId) => pageIdsOf(readLinks(store, mapId))),
      }),
    [lecture?.lecture, lecture?.mapId, lecture?.week, mapList, pageId, pageTitle, store],
  );
  const [mapId, setMapId] = useState<string | null>(null);
  const map: MapWithNotes | null = mapList.find((row) => row.id === (mapId ?? pick?.map.id)) ?? null;

  useEffect(() => {
    if (mapId === null && pick) setMapId(pick.map.id);
  }, [mapId, pick]);

  const notes = useNoteLinks(map?.id ?? `none:${pageId}`, map, classId);
  const invalidate = useInvalidateConceptMaps();
  const queryClient = useQueryClient();
  const [grade, setGrade] = useState(INITIAL_GRADE);
  const [mode, setMode] = useState<Mode | null>(null);
  const [showChecklist, setShowChecklist] = useState(false);
  const [termsRefused, setTermsRefused] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // A different map: a new grade.
  useEffect(() => {
    abortRef.current?.abort();
    setGrade(INITIAL_GRADE);
    setMode(null);
    setShowChecklist(false);
    setTermsRefused(false);
  }, [map?.id]);

  const terms = map?.promptTerms ?? [];
  // Terms are optional: only a server that still refuses (400 NO_PROMPT_TERMS) blocks grading.
  const needsTerms = termsRefused;

  /* ---------------------------------------------------------------- the concept list, when the map has none */
  const [termText, setTermText] = useState('');
  const [snapping, setSnapping] = useState(false);
  const [savingTerms, setSavingTerms] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  const snapRef = useRef<HTMLInputElement>(null);

  const saveTerms = useCallback(async () => {
    const promptTerms = parseTermList(termText);

    if (!map || promptTerms.length === 0) return;
    setSavingTerms(true);
    setTermsError(null);
    // Same rule as the workspace: the device keeps the list until the backend has it.
    writeLocalTerms(store, map.id, promptTerms);
    try {
      await savePromptTerms(map.id, promptTerms);
      writeLocalTerms(store, map.id, []);
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;

      if (status === 400 || status === 404) writeLocalTerms(store, map.id, []);
      setTermsError(describeError(error, 'Saved on this tablet — it syncs when the server accepts it'));
    } finally {
      setSavingTerms(false);
      setTermText('');
      setTermsRefused(false);
      void queryClient.invalidateQueries({ queryKey: conceptMapKeys.list(classId) });
    }
  }, [classId, map, queryClient, store, termText]);

  // A photo sent from the phone (or any picture on this page): its terms fill the list.
  const photos = usePagePhotos(pageId);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const fillFromPhoto = useCallback(async () => {
    setReadingPhoto(true);
    setTermsError(null);
    try {
      const wire = await pagePhotosForWire(await photos.scan());
      const found = wire.length > 0 ? await readImageTerms(classId, wire) : [];

      if (found.length === 0) setTermsError('No terms found on the photo — type them instead.');
      else setTermText(found.join(', '));
    } catch (error) {
      setTermsError(describeError(error, 'Could not read the photo — type the terms instead'));
    } finally {
      setReadingPhoto(false);
    }
  }, [classId, photos]);

  const snapSlide = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setSnapping(true);
      setTermsError(null);
      try {
        const found = termsFromReply(await readSlideTerms(classId, await fileToMapPngB64(file)));

        if (found.length === 0) setTermsError('No terms found on that photo — type them instead.');
        else setTermText(found.join(', '));
      } catch (error) {
        setTermsError(describeError(error, 'Could not read the slide — type the terms instead'));
      } finally {
        setSnapping(false);
      }
    },
    [classId],
  );

  /* ---------------------------------------------------------------- grading */
  const runGrade = useCallback(
    async (next: Mode) => {
      if (!map) return;
      abortRef.current?.abort();
      const controller = new AbortController();

      abortRef.current = controller;
      setMode(next);
      setGrade({ ...INITIAL_GRADE, phase: 'sending' });
      // The page joins the map's notes: the digest reads the rest of it as context.
      if (!notes.links.some((link) => link.kind === 'page' && link.pageId === pageId)) {
        notes.add({ kind: 'page', pageId, title: pageTitle });
      }
      let final = { ...INITIAL_GRADE, phase: 'sending' as const } as typeof INITIAL_GRADE;

      try {
        await gradeConceptMap(
          {
            classId,
            imagePngB64,
            ...(next === 'attempt' ? { mapId: map.id } : {}),
            ...(terms.length > 0 ? { promptTerms: terms } : {}),
          },
          (frame) => {
            final = reduceGradeFrame(final, frame);
            setGrade(final);
          },
          controller.signal,
        );
        final = final.phase === 'done' ? final : { ...final, phase: 'done' };
        setGrade(final);
        // Terms the grader read on the map tick themselves on the page's concept strip.
        if (final.reading) {
          const placed = matchTerms(terms, final.reading.nodes)
            .filter((row) => row.node !== null)
            .map((row) => row.term);

          if (placed.length > 0) writeTicks(store, map.id, [...new Set([...readTicks(store, map.id), ...placed])]);
        }
        if (next === 'attempt') {
          void invalidate.attempts(map.id);
          void invalidate.maps(classId);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (isNoPromptTerms(error)) {
          setTermsRefused(true);
          setGrade(INITIAL_GRADE);
          setMode(null);

          return;
        }
        setGrade((state) => ({ ...state, phase: 'error', error: describeError(error, 'Grading failed') }));
      }
    },
    [classId, imagePngB64, invalidate, map, notes, pageId, pageTitle, store, terms],
  );

  const checklist = useMemo(
    () =>
      grade.reading || grade.verdict
        ? buildChecklist({
            his: grade.reading ? readingGraph(grade.reading) : null,
            promptTerms: terms,
            verdict: grade.verdict,
            criteria: grade.criteria,
            modelAnswer: map?.instructor?.modelAnswer ?? null,
          })
        : [],
    [grade.criteria, grade.reading, grade.verdict, map?.instructor?.modelAnswer, terms],
  );
  const running = grade.phase === 'sending' || grade.phase === 'reading' || grade.phase === 'grading';
  const saved = mode === 'attempt' && grade.phase === 'done';
  const compareHref = map
    ? `/concept-maps/?classId=${encodeURIComponent(classId)}&compare=${encodeURIComponent(map.id)}${
        saved && grade.attemptId ? `&attempt=${encodeURIComponent(grade.attemptId)}` : ''
      }`
    : null;

  return (
    <Sheet
      wide
      footer={
        <div className='flex flex-wrap items-center gap-2'>
          <ActionButton
            data-testid='cm-grade'
            disabled={!map || needsTerms}
            loading={running && mode === 'preview'}
            variant='primary'
            onClick={() => void runGrade('preview')}
          >
            <Network className='h-4 w-4' /> Grade it
          </ActionButton>
          <ActionButton
            data-testid='cm-checklist'
            disabled={!map || needsTerms || running}
            onClick={() => {
              setShowChecklist(true);
              if (grade.phase !== 'done') void runGrade('preview');
            }}
          >
            <Target className='h-4 w-4' /> Compare / Get to 10/10
          </ActionButton>
          <ActionButton
            data-testid='cm-save'
            disabled={!map || needsTerms || saved}
            loading={running && mode === 'attempt'}
            onClick={() => void runGrade('attempt')}
          >
            <Save className='h-4 w-4' /> {saved ? 'Saved as attempt' : 'Save as attempt'}
          </ActionButton>
          {compareHref && (grade.phase === 'done' || showChecklist) && (
            <a
              className='text-st-accent ml-auto inline-flex min-h-10 items-center gap-1.5 px-2 text-sm font-medium hover:underline'
              data-testid='cm-open'
              href={compareHref}
            >
              Open in Concept Maps <ExternalLink className='h-3.5 w-3.5' />
            </a>
          )}
        </div>
      }
      subtitle={pageTitle}
      title='Concept map from your notes'
      onClose={onClose}
    >
      <div className='grid gap-5 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]'>
        <div className='flex flex-col gap-3'>
          <img
            alt='Your lassoed map'
            className='border-st-line w-full rounded-xl border bg-st-surface object-contain'
            src={b64ToDataUrl(imagePngB64)}
          />
          {maps.isLoading ? (
            <LoadingRows rows={2} />
          ) : mapList.length === 0 ? (
            <p className='text-st-muted text-sm'>This class has no concept maps yet.</p>
          ) : (
            <Field
              hint={pick && map?.id === pick.map.id ? `Picked: ${PICK_REASON_TEXT[pick.reason]}` : undefined}
              label='Attempt at'
            >
              <select
                className={INPUT_CLASS}
                data-testid='cm-map'
                value={map?.id ?? ''}
                onChange={(event) => setMapId(event.target.value)}
              >
                {mapList.map((row: ConceptMapRecord) => (
                  <option key={row.id} value={row.id}>
                    {mapTitle(row)}
                    {row.week !== null ? ` · week ${row.week}` : ''}
                    {row.score !== null ? ` · ${row.score}/${row.maxScore}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <div className='flex min-w-0 flex-col gap-4'>
          {map && !needsTerms && terms.length > 0 && (
            <section>
              <h3 className='text-st-muted mb-2 text-xs font-medium uppercase tracking-wide'>Term list</h3>
              <div className='flex flex-wrap gap-1.5' data-testid='cm-terms'>
                {terms.map((term) => (
                  <Badge key={term}>{term}</Badge>
                ))}
              </div>
            </section>
          )}

          {map && (needsTerms || terms.length === 0) && (
            <section className='flex flex-col gap-2'>
              <p className='text-st-fg text-sm'>
                {termsRefused
                  ? 'This map needs a term list first.'
                  : 'No term list — optional. Add one and the grader checks each term.'}
              </p>
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
              <textarea
                className={`${INPUT_CLASS} min-h-20`}
                data-testid='cm-terms-input'
                placeholder='Term list, comma-separated'
                value={termText}
                onChange={(event) => setTermText(event.target.value)}
              />
              <div className='flex flex-wrap gap-2'>
                {photos.count > 0 && (
                  <ActionButton
                    data-testid='cm-terms-photo'
                    loading={readingPhoto}
                    onClick={() => void fillFromPhoto()}
                  >
                    <Images className='h-4 w-4' /> {readingPhoto ? 'Reading the photo…' : 'Use the photo on this page'}
                  </ActionButton>
                )}
                <ActionButton loading={snapping} onClick={() => snapRef.current?.click()}>
                  <Camera className='h-4 w-4' /> {snapping ? 'Reading the slide…' : 'Snap the slide'}
                </ActionButton>
                <ActionButton
                  disabled={parseTermList(termText).length === 0 || snapping || readingPhoto}
                  loading={savingTerms}
                  variant='primary'
                  onClick={() => void saveTerms()}
                >
                  Save the list
                </ActionButton>
              </div>
              {termsError && <ErrorNote message={termsError} />}
            </section>
          )}

          {showChecklist && grade.phase === 'done' && (
            <GetToTen grade={grade.verdict ? { score: grade.verdict.score, max: grade.verdict.max } : null} items={checklist} />
          )}

          <GradePanel state={grade} onRetry={mode ? () => void runGrade(mode) : undefined} />
        </div>
      </div>
    </Sheet>
  );
}
