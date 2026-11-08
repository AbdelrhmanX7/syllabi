// Turn a Canvas PDF into a notebook document: one board page per PDF page, the PDF kept as the
// board's asset so the editor renders it underneath the ink (the same shape the whiteboard's own
// import modal produces — see WhiteboardEditor's PDF import handler).
import type { WhiteboardDocument, WhiteboardPage, WhiteboardStorage } from '@repo/whiteboard-core';

import { createWhiteboardId, WHITEBOARD_SCHEMA_VERSION } from '@repo/whiteboard-core';
import { importPdfFile } from '@repo/whiteboard-react';

import { topAlignedViewportOffsetY } from './import-pages';

import { fetchBlobFromUrl } from '@/lib/api/upload';

/**
 * Open each PDF page scrolled to its TOP (see `topAlignedViewportOffsetY`), with the window standing in
 * for the not-yet-mounted canvas — the board is full-screen.
 */
function initialViewportOffsetY(pageWidth: number, pageHeight: number): number {
  if (typeof window === 'undefined') return 0;

  return topAlignedViewportOffsetY(pageWidth, pageHeight, window.innerWidth, window.innerHeight);
}

export interface BuildPdfNotebookInput {
  pageId: string;
  title: string;
  /** Where to download the PDF from — or `file`, a PDF already on the device (picked / shared). */
  fileUrl?: string;
  file?: Blob;
  fileName: string;
  storage: WhiteboardStorage;
  onProgress?: (progress: number) => void;
}

export async function buildPdfNotebookDocument({
  pageId,
  title,
  fileUrl,
  file: source,
  fileName,
  storage,
  onProgress,
}: BuildPdfNotebookInput): Promise<WhiteboardDocument> {
  const blob = source ?? (fileUrl ? await fetchBlobFromUrl(fileUrl) : null);

  if (!blob) throw new Error('No PDF to import.');
  const file =
    blob instanceof File && blob.name === fileName
      ? blob
      : new File([blob], fileName || 'document.pdf', { type: 'application/pdf' });
  // English warnings/errors.
  const result = await importPdfFile(file, { locale: 'en', onProgress });

  await storage.savePdfAsset(result.asset);

  const now = Date.now();
  const pages: WhiteboardPage[] = result.pages.map((preview) => ({
    viewportOffsetY: initialViewportOffsetY(preview.width, preview.height),
    id: createWhiteboardId(),
    canvasJSON: '',
    thumbnail: '',
    backgroundType: 'blank',
    pdfAssetId: result.asset.id,
    pdfFingerprint: result.asset.fingerprint,
    pdfPageIndex: preview.pageIndex,
    pdfSourcePageNumber: preview.pageNumber,
    pdfImageUrl: undefined,
    pdfSourceName: result.asset.fileName,
    viewportOffsetX: 0,
    viewportZoom: 1,
  }));

  return {
    id: pageId,
    title,
    pages,
    currentPageIndex: 0,
    createdAt: now,
    updatedAt: now,
    thumbnail: '',
    viewportZoom: 1,
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  };
}

export interface RestorePdfAssetInput {
  assetId: string;
  fileUrl: string;
  fileName: string;
  storage: WhiteboardStorage;
  onProgress?: (progress: number) => void;
}

/**
 * Re-creates a notebook's PDF asset on a device that opened the document from the backend (assets
 * never leave the device that imported them). Same file → same pages; it is stored under the id the
 * document's pages already reference.
 */
export async function restorePdfAsset({ assetId, fileUrl, fileName, storage, onProgress }: RestorePdfAssetInput) {
  const blob = await fetchBlobFromUrl(fileUrl);
  const file = new File([blob], fileName || 'document.pdf', { type: 'application/pdf' });
  const result = await importPdfFile(file, { locale: 'en', onProgress });

  await storage.savePdfAsset({ ...result.asset, id: assetId });
}
