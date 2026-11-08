import type { WhiteboardSelectionAction } from '@repo/whiteboard-react';
import type { ReactNode } from 'react';
import { BOARD_CHIP_OVERRIDE } from '@/components/ui/primitives';
import type { PageLectureInput } from '../lib/pageImages';
import type { MapWithNotes } from './api';
import type { ImageMapJob } from './ImageConceptMap';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Circle, Network } from 'lucide-react';

import { DrawOnBoardButton, useDrawOnBoard } from '../components/DrawOnBoard';
import { useConceptMaps } from '../hooks';
import { mapsDrawnOnPage } from '../lib/boardDraw';
import { mapsLinkedToPage, newestFirst } from '../lib/pickMap';
import { mapTitle } from '../lib/score';

import { normalizeDigest } from './api';
import { browserStore, pageIdsOf, readLinks } from './links';
import { ImageConceptMapLayer, pngBase64ToBlob } from './ImageConceptMap';
import { MapFromPhotoButton } from './MapFromPhoto';
import { SelectionMapSheet } from './SelectionMapSheet';
import { withLocalTerms } from './terms-store';
import { normTerm, readTicks, toggleTick, writeTicks } from './workspace-state';
import { useAiEnabled } from '@/hooks/useAiEnabled';

/**
 * Concept maps inside a notebook page: the «Concept map» button on the board's selection bar (the
 * lassoed handwriting becomes a graded attempt) and, once the page is linked to a map, a collapsible
 * strip of that map's concept list along the top edge. Hosts pass `selectionActions` to the board and
 * render `overlay` inside the board's positioned container.
 */
const noop = () => {};

export function useNotebookConceptMaps({
  classId,
  pageId,
  pageTitle,
  lecture = null,
}: {
  classId: string | null | undefined;
  pageId: string;
  pageTitle: string;
  /** The page's lecture-note record (`pageLecture(pageId)` from features/lecturenotes), when it has one. */
  lecture?: PageLectureInput | null;
}): {
  selectionActions: WhiteboardSelectionAction[] | undefined;
  overlay: ReactNode;
  topRight: ReactNode;
  /** For the board's `onImagePlaced`: a picture was just imported — offer «Make concept map». */
  onImagePlaced: (file: File) => void;
  /** Make the map right away (an inbox photo opened with «Concept map»): no offer chip for this picture. */
  makeFromFile: (file: File) => void;
} {
  const aiOn = useAiEnabled();
  const [sheet, setSheet] = useState<{ imagePngB64: string } | null>(null);
  // Bumped when the sheet closes: a grade may have linked the page or ticked terms.
  const [revision, setRevision] = useState(0);

  const [imageJob, setImageJob] = useState<ImageMapJob | null>(null);
  const [offer, setOffer] = useState<File | null>(null);
  const skipOffer = useRef(false);
  const onImagePlaced = useCallback((file: File) => {
    if (skipOffer.current) skipOffer.current = false;
    else setOffer(file);
  }, []);
  const startImageMap = useCallback((blob: Blob) => setImageJob({ id: Date.now(), blob }), []);
  const makeFromFile = useCallback(
    (file: File) => {
      skipOffer.current = true;
      startImageMap(file);
    },
    [startImageMap],
  );
  const takeImageJob = useCallback(() => setImageJob(null), []);
  const dismissOffer = useCallback(() => setOffer(null), []);

  const selectionActions = useMemo<WhiteboardSelectionAction[] | undefined>(
    () =>
      classId
        ? [
            {
              id: 'concept-map',
              label: 'Concept map',
              icon: <Network aria-hidden className='h-5 w-5' />,
              scope: 'other',
              onSelect: (selection) => {
                if (selection.raster) setSheet({ imagePngB64: selection.raster.pngBase64 });
              },
            },
            {
              id: 'image-concept-map',
              label: 'Concept map',
              icon: <Network aria-hidden className='h-5 w-5' />,
              scope: 'picture',
              onSelect: (selection) => {
                if (selection.raster) void pngBase64ToBlob(selection.raster.pngBase64).then(startImageMap);
              },
            },
          ]
        : undefined,
    [classId, startImageMap],
  );

  const close = useCallback(() => {
    setSheet(null);
    setRevision((value) => value + 1);
  }, []);

  const overlay = classId ? (
    <>
      <PageConceptStrip classId={classId} noteMapId={lecture?.mapId ?? null} pageId={pageId} revision={revision} />
      <ImageConceptMapLayer
        classId={classId}
        job={imageJob}
        lecture={lecture}
        offer={offer}
        pageId={pageId}
        onDismissOffer={dismissOffer}
        onJobTaken={takeImageJob}
        onMake={startImageMap}
      />
      {sheet && (
        <SelectionMapSheet
          classId={classId}
          imagePngB64={sheet.imagePngB64}
          pageId={pageId}
          pageTitle={pageTitle}
          lecture={lecture}
          onClose={close}
        />
      )}
    </>
  ) : null;

  const topRight = classId ? (
    // empty:hidden — both buttons can render nothing, and an empty box still took a gap in the top bar.
    <div className='flex items-start gap-2 empty:hidden'>
      <MapFromPhotoButton classId={classId} lecture={lecture} pageId={pageId} />
      <DrawReferenceButton classId={classId} noteMapId={lecture?.mapId ?? null} pageId={pageId} revision={revision} />
    </div>
  ) : null;

  // Every action here reads or grades with AI: none of it for an account without AI.
  if (!aiOn) {
    // The concept list strip is plain (no AI): it stays.
    const strip = classId ? <PageConceptStrip classId={classId} noteMapId={lecture?.mapId ?? null} pageId={pageId} revision={revision} /> : null;

    return { selectionActions: undefined, overlay: strip, topRight: null, onImagePlaced: noop, makeFromFile: noop };
  }

  return { selectionActions, overlay, topRight, onImagePlaced, makeFromFile };
}

/**
 * The map this page belongs to: the lecture note's own map, a map linked to the page, or the map whose
 * reference was drawn here («Draw on board») — only one with a concept list (nothing to draw without).
 */
function usePageMap({
  classId,
  pageId,
  noteMapId,
  revision,
}: {
  classId: string;
  pageId: string;
  noteMapId: string | null;
  revision: number;
}): MapWithNotes | null {
  const maps = useConceptMaps(classId);
  const store = browserStore();

  return useMemo(() => {
    const rows = (maps.data ?? []).map((row) => withLocalTerms(row, store) as MapWithNotes).sort(newestFirst);
    const linked = mapsLinkedToPage(rows, pageId, (mapId) => pageIdsOf(readLinks(store, mapId)));
    const drawn = mapsDrawnOnPage(store, pageId);
    const usable = (row: MapWithNotes) => row.promptTerms.length > 0;

    return (
      rows.find((row) => row.id === noteMapId && usable(row)) ??
      rows.find((row) => linked.includes(row.id) && usable(row)) ??
      rows.find((row) => drawn.includes(row.id) && usable(row)) ??
      null
    );
    // `revision`: links live on the device too, so a fresh read after the sheet closes.
  }, [maps.data, noteMapId, pageId, revision, store]);
}

/** «Draw reference map» in the board's top-right cluster: the linked map's AI reference, drawn on THIS page. */
function DrawReferenceButton({
  classId,
  pageId,
  noteMapId,
  revision,
}: {
  classId: string;
  pageId: string;
  noteMapId: string | null;
  revision: number;
}) {
  const map = usePageMap({ classId, pageId, noteMapId, revision });
  const { draw, busy, status, error } = useDrawOnBoard(classId);

  if (!map) return null;

  return (
    <div className='flex items-center gap-2'>
      {(status || error) && (
        <span
          className={`bg-st-surface/90 border-st-clay-edge shadow-clay border-2 max-w-[16rem] truncate rounded-sm px-3 py-1 text-xs ${error ? 'text-st-danger' : 'text-st-muted'}`}
          title={error ?? status ?? undefined}
        >
          {error ?? status}
        </span>
      )}
      <DrawOnBoardButton
        busy={busy}
        className={BOARD_CHIP_OVERRIDE}
        label='Draw reference map'
        onClick={() => void draw(map, null, { pageId })}
      />
    </div>
  );
}

/**
 * The linked map's concept list over the page while he writes. A term ticks itself when the cached
 * notes digest found it in his notes or a grade read it on his map; otherwise he ticks it. Sits on the
 * top edge, collapsed to one pill by default, absolutely positioned — the board never moves under it.
 */
export function PageConceptStrip({
  classId,
  pageId,
  noteMapId = null,
  revision = 0,
}: {
  classId: string;
  pageId: string;
  /** The lecture note's own map: shown even before the page is linked to it. */
  noteMapId?: string | null;
  revision?: number;
}) {
  const store = browserStore();
  const map = usePageMap({ classId, pageId, noteMapId, revision });
  const [ticked, setTicked] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (map) setTicked(readTicks(store, map.id));
  }, [map?.id, revision, store]);

  const fromNotes = useMemo(() => {
    if (!map?.notesDigest || typeof map.notesDigest !== 'object') return new Set<string>();
    const digest = normalizeDigest(map.notesDigest);

    return new Set(digest.concepts.filter((row) => row.definitionFromNotes).map((row) => normTerm(row.term)));
  }, [map?.notesDigest]);

  if (!map) return null;
  const done = new Set(ticked.map(normTerm));
  const isOn = (term: string) => done.has(normTerm(term)) || fromNotes.has(normTerm(term));
  const placed = map.promptTerms.filter(isOn).length;
  const total = map.promptTerms.length;

  const toggle = (term: string) => {
    setTicked((current) => {
      const next = toggleTick(current, term);

      writeTicks(store, map.id, next);

      return next;
    });
  };

  return (
    <div
      className='pointer-events-none absolute left-1/2 top-[7.75rem] z-20 flex w-[min(44rem,calc(100%-2rem))] -translate-x-1/2 justify-center'
      data-testid='cm-page-strip'
    >
      <div
        className='border-st-clay-edge bg-st-surface/95 shadow-clay pointer-events-auto flex max-w-full flex-col gap-1.5 rounded-2xl border-2 px-2 py-1.5 backdrop-blur'
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          aria-expanded={open}
          className='text-st-fg hover:bg-st-raised inline-flex min-h-9 items-center gap-2 rounded-xl px-2 text-xs font-semibold'
          type='button'
          onClick={() => setOpen((value) => !value)}
        >
          <Network className='text-st-accent h-4 w-4' />
          <span className='truncate'>{mapTitle(map)}</span>
          <span
            className={`rounded-sm px-2 py-0.5 tabular-nums ${placed === total ? 'bg-st-ok/15 text-st-ok' : 'bg-st-raised text-st-muted'}`}
          >
            {placed}/{total}
          </span>
          {open ? <ChevronUp className='h-4 w-4' /> : <ChevronDown className='h-4 w-4' />}
        </button>
        {open && (
          <div className='flex max-h-40 flex-wrap gap-1.5 overflow-y-auto px-1 pb-1'>
            {map.promptTerms.map((term) => {
              const on = isOn(term);
              const auto = !done.has(normTerm(term)) && fromNotes.has(normTerm(term));

              return (
                <button
                  key={term}
                  aria-pressed={on}
                  className={`inline-flex min-h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium ${
                    on ? 'border-st-ok/50 bg-st-ok/10 text-st-ok' : 'border-st-line bg-st-surface text-st-fg hover:bg-st-raised'
                  }`}
                  disabled={auto}
                  title={auto ? 'Found in your notes' : on ? 'Tap to untick' : 'Tap when it is on your map'}
                  type='button'
                  onClick={() => toggle(term)}
                >
                  {on ? <Check className='h-3.5 w-3.5' strokeWidth={2.5} /> : <Circle className='h-3.5 w-3.5 opacity-60' />}
                  {term}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
