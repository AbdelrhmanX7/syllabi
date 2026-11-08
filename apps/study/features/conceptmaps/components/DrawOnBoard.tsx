import type { ConceptMapRecord, ReferenceMap } from '../types';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NotebookPen } from 'lucide-react';
import { useRouter } from 'next/router';

import { referenceMap } from '../api';
import {
  BOARD_DRAW_EVENT,
  forgetReferencePage,
  graphSignature,
  queueBoardDraw,
  referencePageFor,
  referencePageTitle,
  rememberReferencePage,
} from '../lib/boardDraw';
import { parseReferenceFrame } from '../lib/frames';
import { mapTitle } from '../lib/score';
import { withStreamRetry } from '../lib/streamRetry';
import { browserStore } from '../notes/links';

import { ActionButton } from '@/components/ui/primitives';
import { studyKeys } from '@/lib/api/hooks';
import { createPage, getPage } from '@/lib/api/endpoints';
import { describeError, isRetryableStreamError, isStudyApiError } from '@/lib/api/errors';
import { rememberPages } from '@/lib/notebooks/pages-cache';

/** The AI reference map for `map`, streamed (`status` lines through `onStatus`), one retry on a cut. */
export async function fetchReferenceGraph(
  classId: string,
  map: Pick<ConceptMapRecord, 'id' | 'promptTerms'>,
  { onStatus, signal }: { onStatus?: (text: string | null) => void; signal?: AbortSignal } = {},
): Promise<ReferenceMap> {
  let graph: ReferenceMap | null = null;
  let complete = false;
  const run = () =>
    referenceMap(
      { classId, mapId: map.id, ...(map.promptTerms.length > 0 ? { promptTerms: map.promptTerms } : {}) },
      (frame) => {
        if (frame.event === 'status' || frame.event === 'thinking') {
          const text = (frame.data as { text?: string } | string | null) ?? null;

          onStatus?.(typeof text === 'string' ? text : (text?.text ?? null));

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
    await withStreamRetry(run, { signal, finished: () => complete, onRetry: () => onStatus?.('Connection dropped — retrying…') });
  } catch (error) {
    // A cut after the `result` frame loses nothing.
    if (!(complete && graph && isRetryableStreamError(error))) throw error;
  }

  if (!graph) throw new Error('The reference map came back empty — try again.');

  return graph;
}

/**
 * «Draw on board»: the reference map → its own notebook page (made once per map, reused after), the
 * graph queued for that page's board, then the page opens and the board draws it in hand ink. A
 * graph not loaded yet is fetched first. Already on that page (the board's own button) → no
 * navigation: the open board picks the queued draw up from the event.
 */
export function useDrawOnBoard(classId: string | null | undefined) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const draw = useCallback(
    async (map: ConceptMapRecord, given: ReferenceMap | null, { pageId: hereId }: { pageId?: string } = {}) => {
      if (!classId || busy) return;
      abortRef.current?.abort();
      const controller = new AbortController();

      abortRef.current = controller;
      setBusy(true);
      setError(null);

      try {
        let graph = given;

        if (!graph) {
          setStatus('Drafting the reference map…');
          graph = await fetchReferenceGraph(classId, map, { onStatus: setStatus, signal: controller.signal });
        }
        if (controller.signal.aborted) return;

        const store = browserStore();
        const signature = graphSignature(graph);
        let pageId = hereId ?? null;
        let known = hereId ? null : referencePageFor(store, map.id);

        if (!pageId && known) {
          // A page deleted since → a fresh one; offline / an older backend → trust the record.
          try {
            rememberPages([await getPage(known.pageId)]);
          } catch (err) {
            if (isStudyApiError(err, 404)) {
              forgetReferencePage(store, map.id);
              known = null;
            }
          }
          pageId = known?.pageId ?? null;
        }

        // The same graph is already drawn on its page: just open it.
        const alreadyDrawn = Boolean(known && known.signature === signature && !hereId);

        if (!pageId) {
          setStatus('Making a notebook page…');
          const page = await createPage({ classId, title: referencePageTitle(mapTitle(map)), kind: 'note' });

          rememberPages([page]);
          pageId = page.id;
          void queryClient.invalidateQueries({ queryKey: studyKeys.pages(classId) });
        }

        if (!alreadyDrawn) {
          queueBoardDraw(store, pageId, graph);
          window.dispatchEvent(new CustomEvent(BOARD_DRAW_EVENT, { detail: { pageId } }));
        }
        rememberReferencePage(store, map.id, { pageId, signature });

        if (!hereId) await router.push(`/notebook/?id=${encodeURIComponent(pageId)}&classId=${encodeURIComponent(classId)}`);
      } catch (err) {
        if (!controller.signal.aborted) setError(describeError(err, 'Could not draw the map on a board'));
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          setStatus(null);
        }
      }
    },
    [busy, classId, queryClient, router],
  );

  return { draw, busy, status, error };
}

export function DrawOnBoardButton({
  busy,
  disabled,
  label = 'Draw on board',
  className = 'min-h-9 shrink-0 px-3 text-xs',
  onClick,
}: {
  busy: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <ActionButton
      className={className}
      disabled={disabled}
      loading={busy}
      title='Draw this map on a notebook page in handwriting — then edit it like your own ink'
      onClick={onClick}
    >
      {!busy && <NotebookPen className='h-3.5 w-3.5' />} <span data-chip-label>{label}</span>
    </ActionButton>
  );
}
