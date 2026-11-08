import type { PageLectureInput } from '../lib/pageImages';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Network, X } from 'lucide-react';

import { Toast, useToast } from '../components/Toast';
import { BOARD_DRAW_EVENT, queueBoardDraw } from '../lib/boardDraw';

import { browserStore } from './links';
import { blobToReferenceImage, streamReference, useMapLectureContext } from './MapFromPhoto';

import { ActionButton } from '@/components/ui/primitives';
import { describeError } from '@/lib/api/errors';

/** A picture to turn into a concept map; `id` is new per request so the same picture can be sent again. */
export interface ImageMapJob {
  id: number;
  blob: Blob;
}

/** How long the «Make concept map» offer stays after a picture lands on the board. */
const OFFER_MS = 15_000;

/**
 * A picture → `/concept-maps/reference` (the backend reads the image) → the map drawn beside it in hand
 * ink (the board places it clear of everything already on the page). Two entry points feed it:
 * the «Concept map» button on a selected picture, and the offer that follows a picture import.
 */
export function ImageConceptMapLayer({
  classId,
  pageId,
  lecture = null,
  job,
  offer,
  onJobTaken,
  onMake,
  onDismissOffer,
}: {
  classId: string;
  pageId: string;
  lecture?: PageLectureInput | null;
  job: ImageMapJob | null;
  /** The picture just imported, while the offer is showing. */
  offer: File | null;
  onJobTaken: () => void;
  onMake: (blob: Blob) => void;
  onDismissOffer: () => void;
}) {
  const context = useMapLectureContext(classId, pageId, lecture);
  const { toast, show, dismiss } = useToast();
  const [status, setStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const contextRef = useRef(context);

  contextRef.current = context;
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!offer) return;
    const timer = window.setTimeout(onDismissOffer, OFFER_MS);

    return () => window.clearTimeout(timer);
  }, [offer, onDismissOffer]);

  useEffect(() => {
    if (!job) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    const { signal } = controller;
    const { blob } = job;

    abortRef.current = controller;
    onJobTaken();

    void (async () => {
      try {
        setStatus('Reading the picture…');
        const image = await blobToReferenceImage(blob);

        if (!image) throw new Error('Could not read that picture.');
        const current = contextRef.current;

        setStatus('Drafting the concept map…');
        const graph = await streamReference(
          {
            classId,
            ...(current.mapId ? { mapId: current.mapId } : {}),
            pageId,
            ...(current.lecture || current.week !== null
              ? { lecture: { number: null, key: null, date: null, ...current.lecture, week: current.week } }
              : {}),
            images: [image],
          },
          { onStatus: setStatus, signal },
        );

        if (signal.aborted) return;
        queueBoardDraw(browserStore(), pageId, graph);
        window.dispatchEvent(new CustomEvent(BOARD_DRAW_EVENT, { detail: { pageId } }));
      } catch (err) {
        if (!signal.aborted) show(describeError(err, 'Could not make a concept map from that picture'), { tone: 'danger' });
      } finally {
        if (!signal.aborted) setStatus(null);
      }
    })();
  }, [classId, job, onJobTaken, pageId, show]);

  const busy = status !== null;

  return (
    <>
      {(busy || offer) && (
        <div
          className='pointer-events-none absolute inset-x-4 bottom-28 z-30 flex justify-center'
          data-testid='cm-image-map-bar'
        >
          <div
            className='border-st-clay-edge bg-st-surface/95 shadow-clay pointer-events-auto flex max-w-full items-center gap-2 rounded-2xl border-2 py-1.5 pl-3 pr-1.5 text-xs backdrop-blur'
            onPointerDown={(event) => event.stopPropagation()}
          >
            {busy ? (
              <>
                <span className='border-st-accent h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-t-transparent' />
                <span aria-live='polite' className='text-st-muted truncate'>
                  {status}
                </span>
              </>
            ) : (
              offer && (
                <>
                  <span className='text-st-fg truncate'>Picture added</span>
                  <ActionButton
                    className='min-h-9 px-3 text-xs'
                    data-testid='cm-make-from-import'
                    variant='primary'
                    onClick={() => {
                      onDismissOffer();
                      onMake(offer);
                    }}
                  >
                    <Network className='h-3.5 w-3.5' /> <span data-chip-label>Make concept map</span>
                  </ActionButton>
                  <button
                    aria-label='Dismiss'
                    className='text-st-muted hover:text-st-fg inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full'
                    type='button'
                    onClick={onDismissOffer}
                  >
                    <X className='h-4 w-4' />
                  </button>
                </>
              )
            )}
          </div>
        </div>
      )}
      <Toast toast={toast} onDismiss={dismiss} />
    </>
  );
}

/** The selection raster (PNG, base64) as a blob for the job. */
export async function pngBase64ToBlob(pngBase64: string): Promise<Blob> {
  return (await fetch(`data:image/png;base64,${pngBase64}`)).blob();
}
