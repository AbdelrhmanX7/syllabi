// Where a linked notebook page's PDF comes from, for the board's first open (seed) and for a device
// that lacks the PDF asset (restore). A PDF picked from the device lives in memory until its first
// seed has stored it in the board's own storage; a library PDF is re-downloaded from a fresh url.
import type { NoteLink } from './links';
import type { WhiteboardDocument, WhiteboardStorage } from '@repo/whiteboard-core';

import { createBlankWhiteboardDocument } from '@repo/whiteboard-core';

import { createPage, getLibraryDoc } from '@/lib/api/endpoints';
import { rememberPages } from '@/lib/notebooks/pages-cache';
import { buildPdfNotebookDocument, restorePdfAsset } from '@/lib/notebooks/pdf-import';

const pickedFiles = new Map<string, File>();

const stripPdf = (name: string) => name.replace(/\.pdf$/i, '').trim() || 'Lecture notes';

/** A PDF from the device file picker → a new notebook page that opens with the PDF under the ink. */
export async function pageFromPickedPdf(classId: string, file: File): Promise<NoteLink> {
  const page = await createPage({ classId, title: stripPdf(file.name), kind: 'pdf' });

  rememberPages([page]);
  pickedFiles.set(page.id, file);

  return { kind: 'page', pageId: page.id, title: page.title, fileName: file.name };
}

/** A library PDF → a notebook page (same as opening it in the library, but owned by this map). */
export async function pageFromLibraryPdf(classId: string, doc: { id: string; title: string; path: string }) {
  const page = await createPage({ classId, title: stripPdf(doc.title), kind: 'pdf' });

  rememberPages([page]);

  return {
    kind: 'page',
    pageId: page.id,
    title: page.title,
    libraryId: doc.id,
    fileName: doc.path.split('/').pop() || `${doc.title}.pdf`,
  } satisfies NoteLink;
}

/** A blank lined page for writing in class. */
export async function blankNotesPage(classId: string, title: string): Promise<NoteLink> {
  const page = await createPage({ classId, title, kind: 'note' });

  rememberPages([page]);

  return { kind: 'page', pageId: page.id, title: page.title, paper: 'lined' };
}

async function pdfUrlFor(
  link: Extract<NoteLink, { kind: 'page' }>,
): Promise<{ url: string; revoke?: () => void } | null> {
  const file = pickedFiles.get(link.pageId);

  if (file) {
    const url = URL.createObjectURL(file);

    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  if (link.libraryId) {
    const url = (await getLibraryDoc(link.libraryId)).url;

    return url ? { url } : null;
  }

  return null;
}

/** Null when the page has no PDF behind it (a handwritten page): the board opens blank / from the backend. */
export function seedFor(link: Extract<NoteLink, { kind: 'page' }>, onProgress: (text: string | null) => void) {
  if (!pickedFiles.has(link.pageId) && !link.libraryId) {
    if (link.paper !== 'lined') return undefined;

    // Lined paper, like the pages he writes his lecture notes on.
    return async () => createBlankWhiteboardDocument({ id: link.pageId, title: link.title, backgroundType: 'lined' });
  }

  return async (storage: WhiteboardStorage): Promise<WhiteboardDocument | null> => {
    const source = await pdfUrlFor(link);

    if (!source) return null;
    onProgress('Reading PDF…');
    try {
      const doc = await buildPdfNotebookDocument({
        pageId: link.pageId,
        title: link.title,
        fileUrl: source.url,
        fileName: link.fileName ?? `${link.title}.pdf`,
        storage,
        onProgress: (value) => onProgress(`Rendering PDF ${Math.round(value * 100)}%`),
      });

      pickedFiles.delete(link.pageId);

      return doc;
    } finally {
      source.revoke?.();
      onProgress(null);
    }
  };
}

/** Library PDFs can be fetched again on another tablet; a picked PDF only exists where it was picked. */
export function restoreFor(link: Extract<NoteLink, { kind: 'page' }>, onProgress: (text: string | null) => void) {
  if (!link.libraryId) return undefined;

  return async (storage: WhiteboardStorage, assetId: string) => {
    const source = await pdfUrlFor(link);

    if (!source) return;
    onProgress('Downloading PDF…');
    try {
      await restorePdfAsset({ assetId, fileUrl: source.url, fileName: link.fileName ?? `${link.title}.pdf`, storage });
    } finally {
      onProgress(null);
    }
  };
}
