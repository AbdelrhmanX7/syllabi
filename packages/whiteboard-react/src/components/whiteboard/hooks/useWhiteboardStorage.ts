import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createIndexedDbWhiteboardStorage } from '@repo/whiteboard-core';

import type {
  WhiteboardDocument,
  WhiteboardPage,
  WhiteboardPdfAsset,
  WhiteboardStorage,
  WhiteboardSummary,
} from '@repo/whiteboard-core';

export const WHITEBOARD_STORAGE_UPDATED_EVENT = 'whiteboard:storage-updated';

export interface WhiteboardStorageUpdatedEventDetail {
  id: string;
  pageCount: number;
  title: string;
  updatedAt: number;
}

interface UseWhiteboardStorageReturn {
  deleteWhiteboard: (id: string) => Promise<void>;
  /** Tier-2 re-key a local board (UUID) to its claimed server `_id` (see WhiteboardStorage.rekeyWhiteboard). */
  rekeyWhiteboard: (oldId: string, newId: string) => Promise<void>;
  isReady: boolean;
  /** Human-readable storage-init failure, or null. Surface this so the user knows saves are at risk. */
  storageError: string | null;
  /** Re-attempt storage initialization (fresh connection) after a failure. */
  retryStorage: () => void;
  listWhiteboards: () => Promise<WhiteboardDocument[]>;
  /** List rows only — no page content is deserialized. Use this for anything that just paints a
   *  library list; `listWhiteboards` is for callers that genuinely need the pages. */
  listWhiteboardSummaries: () => Promise<WhiteboardSummary[]>;
  loadWhiteboard: (id: string) => Promise<WhiteboardDocument | null>;
  loadPdfAsset: (id: string) => Promise<WhiteboardPdfAsset | null>;
  saveWhiteboard: (doc: WhiteboardDocument, options?: { changedPageIds?: string[] }) => Promise<void>;
  /**
   * Persist ONE page (the write-behind autosave path) instead of rewriting the whole document —
   * see `WhiteboardStorage.savePageSnapshot`. `meta` is what the storage-updated event carries, so
   * the sync layer notices the edit exactly as it does for a full save; it is passed in rather than
   * read off a document because this path deliberately never materializes one.
   */
  savePageSnapshot: (
    documentId: string,
    page: WhiteboardPage,
    meta: { pageCount: number; title: string; updatedAt: number },
  ) => Promise<void>;
  savePdfAsset: (asset: WhiteboardPdfAsset) => Promise<void>;
  storage: WhiteboardStorage | null;
}

// If init neither resolves nor rejects within this window, treat it as failed (and let the user
// retry) rather than leaving the app silently unable to save forever.
const STORAGE_READY_TIMEOUT_MS = 20000;

export function useWhiteboardStorage(): UseWhiteboardStorageReturn {
  const storageRef = useRef<WhiteboardStorage | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const retryStorage = useCallback(() => {
    setStorageError(null);
    setIsReady(false);
    setRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const storage = createIndexedDbWhiteboardStorage();

    storageRef.current = storage;

    // A blocked/hung upgrade can leave ready() pending forever; race it against a timeout so the
    // failure becomes visible (and retryable) instead of silently disabling all saves.
    let readyTimer: ReturnType<typeof setTimeout> | undefined;

    Promise.race([
      storage.ready(),
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('Storage initialization timed out')), STORAGE_READY_TIMEOUT_MS);
      }),
    ])
      .then(() => {
        if (!cancelled) {
          setIsReady(true);
          setStorageError(null);
        }
      })
      .catch((error) => {
        console.error('Failed to initialize whiteboard storage:', error);

        if (!cancelled) {
          setStorageError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (readyTimer !== undefined) {
          clearTimeout(readyTimer);
        }
      });

    return () => {
      cancelled = true;
      storage.close();
      storageRef.current = null;
      setIsReady(false);
    };
  }, [retryNonce]);

  const saveWhiteboard = useCallback(async (doc: WhiteboardDocument, options?: { changedPageIds?: string[] }) => {
    await storageRef.current?.saveWhiteboard(doc, options);

    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<WhiteboardStorageUpdatedEventDetail>(WHITEBOARD_STORAGE_UPDATED_EVENT, {
          detail: {
            id: doc.id,
            pageCount: doc.pages.length,
            title: doc.title,
            updatedAt: doc.updatedAt,
          },
        }),
      );
    }
  }, []);

  const savePageSnapshot = useCallback(
    async (documentId: string, page: WhiteboardPage, meta: { pageCount: number; title: string; updatedAt: number }) => {
      await storageRef.current?.savePageSnapshot(documentId, page, meta.updatedAt);

      // Same event a full save dispatches. Without it the sync layer would treat a whole writing
      // session of page saves as "nothing changed" and never enqueue a snapshot.
      if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent<WhiteboardStorageUpdatedEventDetail>(WHITEBOARD_STORAGE_UPDATED_EVENT, {
            detail: {
              id: documentId,
              pageCount: meta.pageCount,
              title: meta.title,
              updatedAt: meta.updatedAt,
            },
          }),
        );
      }
    },
    [],
  );

  const loadWhiteboard = useCallback(async (id: string) => {
    if (!storageRef.current) return null;

    return storageRef.current.loadWhiteboard(id);
  }, []);

  const savePdfAsset = useCallback(async (asset: WhiteboardPdfAsset) => {
    await storageRef.current?.savePdfAsset(asset);
  }, []);

  const loadPdfAsset = useCallback(async (id: string) => {
    if (!storageRef.current) return null;

    return storageRef.current.loadPdfAsset(id);
  }, []);

  const listWhiteboards = useCallback(async () => {
    if (!storageRef.current) return [];

    return storageRef.current.listWhiteboards();
  }, []);

  const listWhiteboardSummaries = useCallback(async () => {
    if (!storageRef.current) return [];

    return storageRef.current.listWhiteboardSummaries();
  }, []);

  const deleteWhiteboard = useCallback(async (id: string) => {
    await storageRef.current?.deleteWhiteboard(id);
  }, []);

  const rekeyWhiteboard = useCallback(async (oldId: string, newId: string) => {
    await storageRef.current?.rekeyWhiteboard(oldId, newId);
  }, []);

  return useMemo(
    () => ({
      deleteWhiteboard,
      rekeyWhiteboard,
      isReady,
      storageError,
      retryStorage,
      listWhiteboards,
      listWhiteboardSummaries,
      loadPdfAsset,
      loadWhiteboard,
      savePageSnapshot,
      savePdfAsset,
      saveWhiteboard,
      storage: storageRef.current,
    }),
    [
      deleteWhiteboard,
      rekeyWhiteboard,
      isReady,
      storageError,
      retryStorage,
      listWhiteboards,
      listWhiteboardSummaries,
      loadPdfAsset,
      loadWhiteboard,
      savePageSnapshot,
      savePdfAsset,
      saveWhiteboard,
    ],
  );
}
