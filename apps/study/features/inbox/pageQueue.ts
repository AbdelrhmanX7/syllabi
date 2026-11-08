// A note page's «waiting from Claude» queue, as a board hook. Claude files inbox items into a note
// (`add_inbox_to_page`: `pageId` set, `usedAt` cleared); the open board lists them (`GET
// /inbox?pageId=` on open + the live store's SSE frames) and appends them one at a time on a tap:
// a photo through the editor's image insert, a PDF through its import sheet (pages at the end).
// An item is marked used only once it is in — a photo when the editor took it, a PDF when its pages
// were imported (the board's `onPdfImported` marks it). A cancelled import sheet sends no signal:
// the run just stops there and the PDF stays queued, so the next tap re-opens it. A PDF whose pages
// are all in the note already (filed twice) is not offered: the sheet would refuse it with Import
// disabled, so the item could never leave the queue. It is marked used and the run moves on.
import type { InboxItem } from './types';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addToast } from '@repo/ui';

import { listInboxForPage } from './api';
import { pageQueue } from './lib/pageQueue';
import { dispatchInbox, loadInboxFile, markItemUsed, useInbox } from './store';

const PDF_SHEET_CLOSE_MS = 400;

export interface PageInboxQueue {
  /** Still to append, oldest first. */
  waiting: InboxItem[];
  /** Downloading the next file. */
  busy: boolean;
  /** Append the queue from its head (re-opens a PDF whose import sheet was cancelled). */
  start: () => void;
  /** The board inserted the photo it was handed (`onPendingImageImportHandled` on the phone-image path). */
  imageHandled: () => void;
  /** The board imported an inbox PDF's pages (`onPdfImported`, item id from `inboxIdFromPdfFileName`). */
  pdfImported: (itemId: string) => void;
}

export function usePageInboxQueue({
  pageId,
  enabled,
  placeImage,
  placePdf,
  pdfOnPage,
}: {
  pageId: string;
  /** Off for a read-only board. */
  enabled: boolean;
  placeImage: (file: File, item: InboxItem) => void;
  placePdf: (file: File, item: InboxItem) => void;
  /** Every page of this downloaded inbox PDF is in the open note already (see `pdfWhollyOnPage`). */
  pdfOnPage?: (file: File) => Promise<boolean>;
}): PageInboxQueue {
  const live = useInbox().items;
  const [fetched, setFetched] = useState<{ pageId: string; items: InboxItem[] } | null>(null);
  // Per board visit: an item appended here is never offered again until the note is reopened (a reload
  // racing the usedAt PATCH, or a re-queue while open, would otherwise append it twice).
  const appendedRef = useRef<{ pageId: string; ids: Set<string> }>({ pageId, ids: new Set() });
  const [appendedVersion, setAppendedVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<{ id: string; kind: InboxItem['kind'] } | null>(null);
  const runningRef = useRef(false);

  if (appendedRef.current.pageId !== pageId) appendedRef.current = { pageId, ids: new Set() };

  useEffect(() => {
    currentRef.current = null;
    runningRef.current = false;
    setBusy(false);
    if (!enabled) return;
    let cancelled = false;

    // A 404 (older backend) or no network: the live store still brings what Claude files from now on.
    listInboxForPage(pageId)
      .then((items) => {
        if (cancelled) return;
        setFetched({ pageId, items });
        // Into the store too: a re-queue it missed (no SSE frame for a REST PATCH, a dropped stream) would
        // otherwise keep the store's stale local usedAt, which wins in `pageQueue` and hides the item.
        dispatchInbox({ type: 'arrived', items });
      })
      .catch(() => !cancelled && setFetched({ pageId, items: [] }));

    return () => {
      cancelled = true;
    };
  }, [enabled, pageId]);

  const waiting = useMemo(
    () =>
      enabled
        ? pageQueue({
            pageId,
            fetched: fetched?.pageId === pageId ? fetched.items : [],
            live,
            appended: appendedRef.current.ids,
          })
        : [],
    // `appendedVersion` stands for the ref's set.

    [appendedVersion, enabled, fetched, live, pageId],
  );
  const latest = useRef({ waiting, pageId, placeImage, placePdf, pdfOnPage });

  latest.current = { waiting, pageId, placeImage, placePdf, pdfOnPage };
  // `advance` is declared below `startItem`, which calls it for a skipped PDF.
  const advanceRef = useRef<(id: string) => void>(() => {});

  const markAppended = useCallback((id: string) => {
    appendedRef.current.ids.add(id);
    setAppendedVersion((version) => version + 1);
  }, []);

  const startItem = useCallback(
    async (item: InboxItem) => {
      const forPage = latest.current.pageId;

      currentRef.current = { id: item.id, kind: item.kind };
      setBusy(true);
      try {
        const file = await loadInboxFile(item);

        if (latest.current.pageId !== forPage || currentRef.current?.id !== item.id) return;
        if (item.kind === 'pdf' && (await latest.current.pdfOnPage?.(file).catch(() => false))) {
          if (latest.current.pageId !== forPage || currentRef.current?.id !== item.id) return;
          markAppended(item.id);
          void markItemUsed(item.id);
          addToast({
            title: 'Already in this note',
            description: 'Its pages are here — skipped it.',
            color: 'default',
          });
          // After this call's `finally` has cleared `busy`, or it would clear the next item's.
          window.setTimeout(() => advanceRef.current(item.id), 0);

          return;
        }
        if (item.kind === 'pdf') latest.current.placePdf(file, item);
        else latest.current.placeImage(file, item);
      } catch (error) {
        if (currentRef.current?.id === item.id) currentRef.current = null;
        runningRef.current = false;
        addToast({
          title: 'Could not download it from the inbox',
          description: error instanceof Error ? error.message : String(error),
          color: 'danger',
        });
      } finally {
        setBusy(false);
      }
    },
    [markAppended],
  );

  /** `id` is in: on to the next one while a run is going. */
  const advance = useCallback(
    (id: string) => {
      if (currentRef.current?.id === id) currentRef.current = null;
      if (!runningRef.current) return;
      const next = latest.current.waiting.find(
        (candidate) => candidate.id !== id && !appendedRef.current.ids.has(candidate.id),
      );

      if (next) void startItem(next);
      else runningRef.current = false;
    },
    [startItem],
  );

  advanceRef.current = advance;

  const start = useCallback(() => {
    const head = latest.current.waiting[0];

    if (!head) return;
    runningRef.current = true;
    void startItem(head);
  }, [startItem]);

  const imageHandled = useCallback(() => {
    const current = currentRef.current;

    if (!current || current.kind === 'pdf') return;
    markAppended(current.id);
    void markItemUsed(current.id);
    advance(current.id);
  }, [advance, markAppended]);

  const pdfImported = useCallback(
    (itemId: string) => {
      // Marked used by the board. Also covers a queued PDF added through «From phone» instead.
      markAppended(itemId);
      // The editor reports the import before its sheet closes: let it close, or the next PDF's sheet
      // would open into the closing one and be dropped.
      if (currentRef.current?.id === itemId) window.setTimeout(() => advance(itemId), PDF_SHEET_CLOSE_MS);
    },
    [advance, markAppended],
  );

  return { waiting, busy, start, imageHandled, pdfImported };
}
