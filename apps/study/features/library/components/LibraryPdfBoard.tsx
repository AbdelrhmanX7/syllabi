import type { WhiteboardDocument, WhiteboardStorage } from '@repo/whiteboard-core';
import type { LibraryDocDetail, Page } from '@/lib/api/types';

import { useCallback, useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { NotebookBoard } from '@/components/notebook/NotebookBoard';
import { ErrorNote, LoadingRows } from '@/components/ui/primitives';
import { createPage, getLibraryDoc } from '@/lib/api/endpoints';
import { describeError } from '@/lib/api/errors';
import { rememberPages } from '@/lib/notebooks/pages-cache';
import { buildPdfNotebookDocument, restorePdfAsset } from '@/lib/notebooks/pdf-import';
import { useStudyBoardAi } from '@/features/tutor';

/**
 * A library PDF opened as a notebook (ink over the pages), like a Canvas file on the item page.
 * Library docs are not Canvas items, so the notebook page is remembered per library id on this
 * device (`study_library_pages`); the PDF itself comes from a freshly signed url every time.
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
  const create = useMutation({
    mutationFn: async () => {
      const created = await createPage({ classId, title: doc.title.replace(/\.pdf$/i, ''), kind: 'pdf' });

      rememberPages([created]);
      rememberPageFor(doc.id, created.id);

      return created;
    },
    onSuccess: (created) => setPage(created),
  });

  useEffect(() => {
    const known = readPageMap()[doc.id];

    if (known) setPage({ id: known, title: doc.title.replace(/\.pdf$/i, '') });
    else if (!create.isPending && !create.data) create.mutate();
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
