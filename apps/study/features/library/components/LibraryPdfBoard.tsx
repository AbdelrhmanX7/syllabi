import type { WhiteboardDocument, WhiteboardStorage } from '@repo/whiteboard-core';
import type { LibraryDocDetail, Page } from '@/lib/api/types';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { NotebookBoard } from '@/components/notebook/NotebookBoard';
import { ErrorNote, LoadingRows } from '@/components/ui/primitives';
import { createPage, getLibraryDoc, listPages, patchPage } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { rememberPages } from '@/lib/notebooks/pages-cache';
import { buildPdfNotebookDocument, restorePdfAsset } from '@/lib/notebooks/pdf-import';
import { useStudyBoardAi } from '@/features/tutor';

/**
 * A library PDF opened as a notebook (ink over the pages), like a Canvas file on the item page.
 * The notebook is linked to the document on the server (`Page.libraryId`), so every tablet opens the
 * same one and asking again never makes a copy. An older notebook this device remembered per library
 * id (`study_library_pages`, from before the link) is linked on first open; the device map stays as a
 * fallback for a server without the link. The PDF itself comes from a freshly signed url every time.
 */
const STORAGE_KEY = 'study_library_pages';

function readPageMap(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function rememberPageFor(libraryId: string, pageId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readPageMap(), [libraryId]: pageId }));
  } catch {
    // storage refusal — a new notebook page next time, nothing lost on the server
  }
}

/**
 * The notebook on this Library document: the one the server links to it, else the one this device
 * remembered (linked now), else a new one (the server returns an existing linked one instead of a copy).
 * Offline with a remembered notebook: that one, unlinked for now.
 */
async function findOrCreateNotebook(classId: string, libraryId: string, title: string): Promise<Page> {
  const known = readPageMap()[libraryId];
  let pages: Page[] | null = null;

  try {
    pages = await listPages({ classId });
  } catch (error) {
    if (known) return { id: known, title } as Page;
    throw error;
  }
  const linked = pages.find((candidate) => candidate.libraryId === libraryId);

  if (linked) return linked;
  const remembered = known ? pages.find((candidate) => candidate.id === known) : undefined;

  if (remembered) {
    // A server that predates the link answers without `libraryId`: the device map keeps working.
    if (!('libraryId' in remembered)) return remembered;
    if (!remembered.libraryId) {
      return patchPage(remembered.id, { libraryId }).catch(() => remembered);
    }
  }

  return createPage({ classId, title, kind: 'pdf', libraryId });
}

export function LibraryPdfBoard({
  classId,
  doc,
  onBack,
}: {
  classId: string;
  doc: LibraryDocDetail;
  onBack: () => void;
}) {
  const [page, setPage] = useState<Pick<Page, 'id' | 'title'> | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const boardAi = useStudyBoardAi(page?.id ?? '', classId);
  const title = doc.title.replace(/\.pdf$/i, '');
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => findOrCreateNotebook(classId, doc.id, title),
    onSuccess: (found) => {
      rememberPages([found]);
      rememberPageFor(doc.id, found.id);
      setPage(found);
      // The Library row shows «Your notes» and the Notes page lists it.
      void queryClient.invalidateQueries({ queryKey: ['study', 'pages'] });
    },
  });
  // Once per document (a double mount must not ask twice).
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (asked.current === doc.id) return;
    asked.current = doc.id;
    create.mutate();
  }, [doc.id]);

  const freshUrl = useCallback(async () => (await getLibraryDoc(doc.id)).url ?? null, [doc.id]);
  const fileName = doc.path.split('/').pop() || `${doc.title}.pdf`;

  const seed = useCallback(
    async (storage: WhiteboardStorage): Promise<WhiteboardDocument | null> => {
      const fileUrl = await freshUrl();

      if (!fileUrl || !page) return null;
      setProgress('Downloading PDF…');

      return buildPdfNotebookDocument({
        pageId: page.id,
        title: page.title,
        fileUrl,
        fileName,
        storage,
        onProgress: (value) => setProgress(`Rendering PDF ${Math.round(value * 100)}%`),
      });
    },
    [fileName, freshUrl, page],
  );
  const restore = useCallback(
    async (storage: WhiteboardStorage, assetId: string) => {
      const fileUrl = await freshUrl();

      if (!fileUrl) return;
      setProgress('Downloading PDF…');
      await restorePdfAsset({
        assetId,
        fileUrl,
        fileName,
        storage,
        onProgress: (value) => setProgress(`Rendering PDF ${Math.round(value * 100)}%`),
      });
    },
    [fileName, freshUrl],
  );

  if (create.error) return <ErrorNote message={describeError(create.error)} onRetry={() => create.mutate()} />;
  if (!page) return <LoadingRows rows={4} />;

  // The library sits in a height-less flex column: the board takes the whole screen, like the item page.
  return (
    <div className='bg-st-bg fixed inset-0 z-40'>
      <NotebookBoard
        boardAi={boardAi}
        pageId={page.id}
        restorePdfAsset={restore}
        seed={seed}
        seedProgress={progress}
        title={page.title}
        onBack={onBack}
      />
    </div>
  );
}
