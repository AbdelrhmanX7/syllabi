// A PNG of a notebook page, for the AI endpoints that read handwriting (`/questions/extract` with
// `imagePngB64`). The live backend has no OCR text for a page unless the client sent one, and this
// app runs no OCR — so the page's pixels go instead.
import type { WhiteboardStorage } from '@repo/whiteboard-core';

/** base64 payload (no `data:` prefix) or null when nothing renderable exists. */
export type PngBase64 = string;

function stripDataUrl(dataUrl: string): PngBase64 | null {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);

  return match ? match[1] : null;
}

/**
 * The board that is OPEN right now: Fabric's lower canvas holds the page exactly as drawn (ink over
 * the PDF/background), so `toDataURL` is the faithful raster. Null when no board is mounted.
 */
export function rasterizeOpenBoard(): PngBase64 | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.lower-canvas');

  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;

  try {
    return stripDataUrl(canvas.toDataURL('image/png'));
  } catch {
    // tainted canvas (cross-origin background) — fall back to the stored thumbnail
    return null;
  }
}

/**
 * Best available PNG for a page: the open board when it is this page, otherwise the thumbnail the
 * editor saved with the document (smaller, but it is what exists offline).
 */
export async function rasterizeNotebookPage(
  pageId: string,
  storage?: WhiteboardStorage | null,
  options: { preferOpenBoard?: boolean } = {},
): Promise<PngBase64 | null> {
  const openBoardIsThisPage =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('id') === pageId;

  if (options.preferOpenBoard !== false && openBoardIsThisPage) {
    const live = rasterizeOpenBoard();

    if (live) return live;
  }

  if (!storage) return null;

  try {
    const doc = await storage.loadWhiteboard(pageId);
    const page = doc?.pages[Math.min(Math.max(doc.currentPageIndex, 0), doc.pages.length - 1)];
    const thumbnail = page?.thumbnail || doc?.thumbnail || '';

    return thumbnail ? stripDataUrl(thumbnail) : null;
  } catch {
    return null;
  }
}
