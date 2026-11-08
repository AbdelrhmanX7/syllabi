import type { MapLectureContext, PageImage, PageLectureInput } from '../lib/pageImages';
import type { Provenance } from '../lib/provenance';
import type { ReferenceImage, ReferenceMap, ReferenceRequest } from '../types';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWhiteboardStorage } from '@repo/whiteboard-react';
import { Images, X } from 'lucide-react';

import { referenceMap, referenceReadsImages } from '../api';
import { BuiltFrom } from '../components/BuiltFrom';
import { useConceptMaps } from '../hooks';
import { BOARD_DRAW_EVENT, queueBoardDraw } from '../lib/boardDraw';
import { parseReferenceFrame } from '../lib/frames';
import {
  collectPageImages,
  docHasImages,
  lectureContextFor,
  mergeImageTerms,
  planImageDownscale,
  PHONE_IMAGE_EVENT,
  readPhoneMarks,
  withImageSources,
} from '../lib/pageImages';
import { mapsLinkedToPage, newestFirst } from '../lib/pickMap';
import { withStreamRetry } from '../lib/streamRetry';

import { readSlideTerms } from './api';
import { browserStore, pageIdsOf, readLinks } from './links';
import { PHOTO_TERMS_QUESTION } from './slide-terms';
import { termsFromReply } from './terms-store';

import { ActionButton, BOARD_CHIP_OVERRIDE } from '@/components/ui/primitives';
import { blobToB64 } from '@/features/tutor/lib/image';
import { describeError, isRetryableStreamError } from '@/lib/api/errors';

/**
 * A board picture → the wire's JPEG (long edge ≤ 1600 px), cut to the board's crop when it has one.
 * Null when the browser cannot decode it.
 */
async function toReferenceImage(image: PageImage): Promise<ReferenceImage | null> {
  try {
    const blob = await (await fetch(image.src)).blob();
    const plan = planImageDownscale(image);

    if (!image.crop && !plan.resize && blob.type === 'image/jpeg') {
      return wireImage(image, await blobToB64(blob), plan.width, plan.height);
    }
    const bitmap = image.crop
      ? await createImageBitmap(blob, image.crop.x, image.crop.y, image.width, image.height)
      : await createImageBitmap(blob);
    const size = planImageDownscale({ width: bitmap.width, height: bitmap.height });
    const canvas = document.createElement('canvas');

    canvas.width = Math.max(1, size.width);
    canvas.height = Math.max(1, size.height);
    const ctx = canvas.getContext('2d');

    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));

    return jpeg ? wireImage(image, await blobToB64(jpeg), canvas.width, canvas.height) : null;
  } catch {
    return null;
  }
}

const wireImage = (image: PageImage, jpegB64: string, width: number, height: number): ReferenceImage => ({
  jpegB64,
  width,
  height,
  origin: image.origin,
  ...(image.inboxItemId ? { inboxItemId: image.inboxItemId } : {}),
});

/** `/concept-maps/reference`, one retry on a cut; `terms` frames (the backend read the pictures) through `onTerms`. */
export async function streamReference(
  body: ReferenceRequest,
  {
    onStatus,
    onTerms,
    signal,
  }: { onStatus: (text: string) => void; onTerms?: (terms: string[]) => void; signal: AbortSignal },
): Promise<ReferenceMap> {
  let graph: ReferenceMap | null = null;
  let complete = false;
  const run = () =>
    referenceMap(
      body,
      (frame) => {
        if (frame.event === 'status' || frame.event === 'thinking') {
          const data = frame.data as { text?: string } | string | null;
          const text = typeof data === 'string' ? data : data?.text;

          if (text) onStatus(text);

          return;
        }
        if (frame.event === 'terms') {
          const terms = (frame.data as { terms?: unknown } | null)?.terms;

          if (Array.isArray(terms)) onTerms?.(terms.filter((term): term is string => typeof term === 'string'));

          return;
        }
        if (frame.event === 'done') complete = true;
        const parsed = parseReferenceFrame(frame);

        if (parsed) graph = parsed;
        if (parsed && frame.event === 'result') complete = true;
      },
      signal,
    );

  try {
    await withStreamRetry(run, {
      signal,
      finished: () => complete,
      onRetry: () => onStatus('Connection dropped — retrying…'),
    });
  } catch (error) {
    if (!(complete && graph && isRetryableStreamError(error))) throw error;
  }
  if (!graph) throw new Error('The map came back empty — try again.');

  return graph;
}

/**
 * The pictures on a notebook page (phone photos first): `count` (> 0 = show the photo actions) is
 * checked on open with a string test (no parse — the scenes carry MB-size data URLs) and set the moment
 * a phone photo is placed; `scan` collects the list on tap.
 */
export function usePagePhotos(pageId: string): { count: number; scan: () => Promise<PageImage[]> } {
  const { storage } = useWhiteboardStorage();
  const [count, setCount] = useState(0);

  const scan = useCallback(async () => {
    if (!storage) return [];
    const doc = await storage.loadWhiteboard(pageId).catch(() => null);

    return collectPageImages(doc, readPhoneMarks(browserStore(), pageId));
  }, [pageId, storage]);

  useEffect(() => {
    if (!storage) return;
    let cancelled = false;

    setCount(0);
    void storage
      .loadWhiteboard(pageId)
      .catch(() => null)
      .then((doc) => {
        if (!cancelled && docHasImages(doc)) setCount((value) => Math.max(value, 1));
      });
    const handlePhone = (event: Event) => {
      if ((event as CustomEvent<{ pageId?: string }>).detail?.pageId === pageId) setCount((value) => value + 1);
    };

    window.addEventListener(PHONE_IMAGE_EVENT, handlePhone);

    return () => {
      cancelled = true;
      window.removeEventListener(PHONE_IMAGE_EVENT, handlePhone);
    };
  }, [pageId, storage]);

  return { count, scan };
}

/** The pictures' concept terms through the class tutor (vision `/ai/ask`), merged across pictures. */
export async function readImageTerms(
  classId: string,
  images: readonly ReferenceImage[],
  signal?: AbortSignal,
): Promise<string[]> {
  const replies = await Promise.allSettled(
    images.map((image) => readSlideTerms(classId, image.jpegB64, signal, PHOTO_TERMS_QUESTION)),
  );
  const read = replies.flatMap((row) => (row.status === 'fulfilled' ? [row.value] : []));
  const failed = replies.find((row): row is PromiseRejectedResult => row.status === 'rejected');

  // Every read failed (signed out, offline): that, not «no terms found».
  if (read.length === 0 && failed) throw failed.reason;

  return mergeImageTerms(read.map(termsFromReply));
}

/** The page's pictures → wire JPEGs (undecodable ones dropped). */
export async function pagePhotosForWire(images: readonly PageImage[]): Promise<ReferenceImage[]> {
  return (await Promise.all(images.map(toReferenceImage))).filter((row): row is ReferenceImage => row !== null);
}

/** The lecture / map the page belongs to, so a map built from a picture is grounded in that lecture's notes. */
export function useMapLectureContext(classId: string, pageId: string, lecture: PageLectureInput | null): MapLectureContext {
  const maps = useConceptMaps(classId);

  return useMemo(() => {
    const store = browserStore();
    const rows = (maps.data ?? []).slice().sort(newestFirst);
    const linked = mapsLinkedToPage(rows, pageId, (mapId) => pageIdsOf(readLinks(store, mapId)));

    return lectureContextFor(pageId, lecture, linked);
  }, [lecture, maps.data, pageId]);
}

/** A picture blob (any type, transparent PNG included) → the wire's white-backed JPEG, long edge ≤ 1600 px. */
export async function blobToReferenceImage(blob: Blob, origin: ReferenceImage['origin'] = 'page'): Promise<ReferenceImage | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = planImageDownscale({ width: bitmap.width, height: bitmap.height });
    const canvas = document.createElement('canvas');

    canvas.width = Math.max(1, size.width);
    canvas.height = Math.max(1, size.height);
    const ctx = canvas.getContext('2d');

    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));

    return jpeg ? { jpegB64: await blobToB64(jpeg), width: canvas.width, height: canvas.height, origin } : null;
  } catch {
    return null;
  }
}

/**
 * «Map the photo» on a notebook page: the pictures on it (phone photos first) → their concept terms →
 * a reference map grounded in the page's lecture (its notes, slides, transcripts) → drawn on this page
 * in hand ink. Shown only while the page has a picture.
 */
export function MapFromPhotoButton({
  classId,
  pageId,
  lecture = null,
}: {
  classId: string;
  pageId: string;
  lecture?: PageLectureInput | null;
}) {
  const { count, scan } = usePagePhotos(pageId);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const context = useMapLectureContext(classId, pageId, lecture);

  const run = useCallback(async () => {
    if (busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    const { signal } = controller;

    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setProvenance(null);

    try {
      setStatus('Reading the photo…');
      const images = await scan();
      const wire = await pagePhotosForWire(images);

      if (wire.length === 0) throw new Error('Could not read the picture on this page.');
      const store = browserStore();
      const serverReads = referenceReadsImages();
      let terms: string[] = [];

      if (!serverReads) {
        // The live route has no `images` yet: the class tutor reads each picture's terms first.
        terms = await readImageTerms(classId, wire, signal);
        if (terms.length === 0) throw new Error('No terms found on the photo.');
      }
      if (signal.aborted) return;

      // Today's backend reads notes only through a map (`mapId`); the page/lecture fields wait on the spec.
      setStatus(context.mapId || serverReads ? 'Reading your lecture notes…' : 'Drafting the map…');
      const graph = await streamReference(
        {
          classId,
          ...(terms.length > 0 ? { promptTerms: terms } : {}),
          ...(context.mapId ? { mapId: context.mapId } : {}),
          pageId,
          ...(context.lecture || context.week !== null
            ? { lecture: { number: null, key: null, date: null, ...context.lecture, week: context.week } }
            : {}),
          images: wire,
        },
        { onStatus: setStatus, signal },
      );

      if (signal.aborted) return;
      setProvenance(withImageSources(graph.provenance, wire));
      queueBoardDraw(store, pageId, graph);
      window.dispatchEvent(new CustomEvent(BOARD_DRAW_EVENT, { detail: { pageId } }));
    } catch (err) {
      if (!signal.aborted) setError(describeError(err, 'Could not map the photo'));
    } finally {
      if (!signal.aborted) {
        setBusy(false);
        setStatus(null);
      }
    }
  }, [busy, classId, context, pageId, scan]);

  if (count === 0) return null;

  return (
    <div className='flex flex-col items-end gap-1.5'>
      <div className='flex items-center gap-2'>
        {(status || error) && (
          <span
            className={`bg-st-surface/90 border-st-clay-edge shadow-clay border-2 max-w-[16rem] truncate rounded-sm px-3 py-1 text-xs ${error ? 'text-st-danger' : 'text-st-muted'}`}
            title={error ?? status ?? undefined}
          >
            {error ?? status}
          </span>
        )}
        <ActionButton
          className={BOARD_CHIP_OVERRIDE}
          data-testid='cm-map-photo'
          loading={busy}
          title='Concept map from the photo on this page — the terms from the picture, the explanations from your lecture notes'
          onClick={() => void run()}
        >
          {!busy && <Images className='h-3.5 w-3.5' />} <span data-chip-label>Map the photo</span>
        </ActionButton>
      </div>
      {provenance && (
        <div className='bg-st-surface/95 border-st-clay-edge shadow-clay border-2 flex max-w-[22rem] items-start gap-1 rounded-2xl px-3 py-1.5'>
          <BuiltFrom className='min-w-0 flex-1' provenance={provenance} />
          <button
            aria-label='Dismiss'
            className='text-st-muted hover:text-st-fg -mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full'
            type='button'
            onClick={() => setProvenance(null)}
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      )}
    </div>
  );
}
