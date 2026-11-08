// Pure helpers for opening exported pages (Samsung Notes, GoodNotes, OneNote PDFs / screenshots) as a
// new notebook. No DOM, no pdf.js: the browser half lives in `import-notebook.ts`, these are tested.
import type { WhiteboardDocument, WhiteboardPage } from '@repo/whiteboard-core';

export const DEFAULT_IMPORT_TITLE = 'Imported notes';
const TITLE_MAX = 200;

/** `Lecture 3 – vectors.pdf` → `Lecture 3 – vectors`. Only the LAST extension goes; empty → a default. */
export function notebookTitleFromFileName(name: string | null | undefined): string {
  const base = (name ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return (base || DEFAULT_IMPORT_TITLE).slice(0, TITLE_MAX);
}

/** Several images as one notebook: named after the first, plus how many more. */
export function notebookTitleForImages(names: readonly string[]): string {
  if (names.length === 0) return DEFAULT_IMPORT_TITLE;
  const first = notebookTitleFromFileName(names[0]);

  return names.length === 1 ? first : `${first} +${names.length - 1}`;
}

export type ImportKind = 'pdf' | 'image' | 'other';

export function importKindOf(file: { type?: string; mime?: string; name: string }): ImportKind {
  const mime = (file.type ?? file.mime ?? '').toLowerCase();

  if (mime === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(file.name)) return 'image';

  return 'other';
}

export type ImportPlan<T> = { kind: 'pdf'; file: T } | { kind: 'images'; files: T[] } | { kind: 'error'; message: string };

/** One PDF, or any number of images, become one notebook. Anything else is a clear «pick again». */
export function planImport<T extends { type?: string; mime?: string; name: string }>(files: readonly T[]): ImportPlan<T> {
  if (files.length === 0) return { kind: 'error', message: 'Pick a PDF or some images.' };
  const kinds = files.map(importKindOf);

  if (kinds.includes('other')) return { kind: 'error', message: 'Only PDFs and images can open as a notebook.' };
  const pdfs = files.filter((_, index) => kinds[index] === 'pdf');

  if (pdfs.length === 0) return { kind: 'images', files: [...files] };
  if (pdfs.length === 1 && files.length === 1) return { kind: 'pdf', file: pdfs[0] };

  return { kind: 'error', message: 'Pick one PDF at a time, or only images.' };
}

/**
 * Where the board should start scrolled for a page of `pageWidth × pageHeight` px. The editor fills
 * the board width and centres the page vertically (that frame anchors the ink, so it never moves); a
 * page taller than the screen would open on its middle, so its first viewport is offset to its top.
 * Same arithmetic as the editor's `getScreenFitPlacement`.
 */
export function topAlignedViewportOffsetY(
  pageWidth: number,
  pageHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return 0;
  const width = Math.max(1, canvasWidth);
  const height = Math.max(1, canvasHeight);
  const fittedHeight = pageHeight * (width / pageWidth);
  const top = (height - fittedHeight) / 2;

  return top < 0 ? -top : 0;
}

export interface ImageBackground {
  dataUrl: string;
  width: number;
  height: number;
  name: string;
}

/**
 * One board page per image, the image as the page's locked BACKGROUND (`pdfImageUrl`, the field the
 * editor's own «add photos as pages» writes), fitted to the page width. No per-page thumbnail: it
 * would ride along in every autosave and the background already is the picture.
 */
export function buildImageNotebookDocument({
  pageId,
  title,
  images,
  canvas,
  newId,
  now = Date.now(),
  schemaVersion,
}: {
  pageId: string;
  title: string;
  images: readonly ImageBackground[];
  canvas: { width: number; height: number };
  newId: () => string;
  now?: number;
  schemaVersion: number;
}): WhiteboardDocument {
  const pages: WhiteboardPage[] = images.map((image) => ({
    id: newId(),
    canvasJSON: '',
    thumbnail: '',
    backgroundType: 'blank',
    pdfImageUrl: image.dataUrl,
    pdfSourceName: image.name,
    viewportOffsetX: 0,
    viewportOffsetY: topAlignedViewportOffsetY(image.width, image.height, canvas.width, canvas.height),
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
    schemaVersion,
  };
}

/** The one-line progress copy shown while an import runs. pdf.js reports a 0–1 fraction, not a page count. */
export function importProgressLabel(stage: 'reading' | 'rendering' | 'images' | 'saving', value = 0, total = 0): string {
  if (stage === 'reading') return 'Reading file…';
  if (stage === 'saving') return 'Saving notebook…';
  if (stage === 'images') return `Preparing image ${Math.min(value + 1, total)} of ${total}…`;

  return `Rendering pages ${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}
