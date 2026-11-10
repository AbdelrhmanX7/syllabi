import type { BackgroundType, WhiteboardDocument, WhiteboardPage } from '../types';
import {
  normalizeBoardRuled,
  normalizeCanvasWidthPx,
  normalizePageBookmark,
  normalizePaperSpacingMm,
  normalizePdfPlacement,
  normalizeSheetAspect,
  WHITEBOARD_SCHEMA_VERSION,
} from '../types';
import { wbT, type WbLocale } from '../../../i18n/strings';

/**
 * Parse + validate a whiteboard file exported via "export whiteboard file" (a serialized
 * {@link WhiteboardDocument} `.kawb.json`). The input is UNTRUSTED (a file the user picked off
 * disk), so this never throws — it returns a discriminated result and normalizes loose/legacy
 * shapes (clamps `currentPageIndex`, defaults optional fields) so the imported document is safe to
 * hand to the existing save/open flow.
 */
export type ParseWhiteboardFileResult = { ok: true; document: WhiteboardDocument } | { ok: false; error: string };

const BACKGROUND_TYPES: ReadonlySet<BackgroundType> = new Set<BackgroundType>(['blank', 'grid', 'lined', 'dotted']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeBackgroundType(value: unknown): BackgroundType {
  return typeof value === 'string' && BACKGROUND_TYPES.has(value as BackgroundType)
    ? (value as BackgroundType)
    : 'blank';
}

/** A page is valid enough to import if it has a string id and a string canvas payload. */
function normalizePage(value: unknown): WhiteboardPage | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.id !== 'string' || typeof value.canvasJSON !== 'string') {
    return null;
  }

  const page: WhiteboardPage = {
    id: value.id,
    canvasJSON: value.canvasJSON,
    thumbnail: typeof value.thumbnail === 'string' ? value.thumbnail : '',
    backgroundType: normalizeBackgroundType(value.backgroundType),
  };

  // Carry optional fields through only when they are the right type.
  if (typeof value.pdfAssetId === 'string') page.pdfAssetId = value.pdfAssetId;
  if (typeof value.pdfFingerprint === 'string') page.pdfFingerprint = value.pdfFingerprint;
  if (typeof value.pdfPageIndex === 'number') page.pdfPageIndex = value.pdfPageIndex;
  if (typeof value.pdfSourcePageNumber === 'number') page.pdfSourcePageNumber = value.pdfSourcePageNumber;
  if (typeof value.pdfImageUrl === 'string') page.pdfImageUrl = value.pdfImageUrl;
  if (typeof value.pdfSourceName === 'string') page.pdfSourceName = value.pdfSourceName;
  if (typeof value.viewportOffsetX === 'number') page.viewportOffsetX = value.viewportOffsetX;
  if (typeof value.viewportOffsetY === 'number') page.viewportOffsetY = value.viewportOffsetY;
  if (typeof value.viewportZoom === 'number') page.viewportZoom = value.viewportZoom;

  // Capture geometry for the server-side ink renderer: validated (junk → absent, never 0), and a
  // placement only where there is a PDF/image background to place.
  const canvasWidthPx = normalizeCanvasWidthPx(value.canvasWidthPx);
  const pdfPlacement = page.pdfAssetId || page.pdfImageUrl ? normalizePdfPlacement(value.pdfPlacement) : undefined;

  if (canvasWidthPx !== undefined) page.canvasWidthPx = canvasWidthPx;
  if (pdfPlacement !== undefined) page.pdfPlacement = pdfPlacement;

  if (typeof value.pdfRotation === 'number' && Number.isFinite(value.pdfRotation)) page.pdfRotation = value.pdfRotation;

  // A sheet's size and ruling, the paper spacing and the bookmark: without them a notebook split into
  // pages would come back as one endless page, with other lines and no bookmarks.
  const sheetAspect = page.pdfAssetId || page.pdfImageUrl ? undefined : normalizeSheetAspect(value.sheetAspect);
  const boardRuled = normalizeBoardRuled(value.boardRuled, sheetAspect);
  const paperSpacingMm = normalizePaperSpacingMm(value.paperSpacingMm);
  const bookmark = normalizePageBookmark(value.bookmark);

  if (sheetAspect !== undefined) page.sheetAspect = sheetAspect;
  if (boardRuled) page.boardRuled = boardRuled;
  if (paperSpacingMm !== undefined) page.paperSpacingMm = paperSpacingMm;
  if (bookmark) page.bookmark = bookmark;

  return page;
}

export function parseWhiteboardDocumentFile(text: string, locale: WbLocale = 'en'): ParseWhiteboardFileResult {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: wbT(locale, 'file.invalidJson') };
  }

  if (!isRecord(data)) {
    return { ok: false, error: wbT(locale, 'file.noDocument') };
  }

  if (!Array.isArray(data.pages) || data.pages.length === 0) {
    return { ok: false, error: wbT(locale, 'file.noPages') };
  }

  const pages: WhiteboardPage[] = [];

  for (const rawPage of data.pages) {
    const page = normalizePage(rawPage);

    if (!page) {
      return { ok: false, error: wbT(locale, 'file.badPage') };
    }

    pages.push(page);
  }

  const rawIndex = typeof data.currentPageIndex === 'number' ? data.currentPageIndex : 0;
  const currentPageIndex = Math.min(pages.length - 1, Math.max(0, Math.trunc(rawIndex)));

  const document: WhiteboardDocument = {
    id: typeof data.id === 'string' && data.id ? data.id : '',
    title: typeof data.title === 'string' && data.title.trim() ? data.title : wbT(locale, 'file.importedTitle'),
    pages,
    currentPageIndex,
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : (pages[0]?.thumbnail ?? ''),
    schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : WHITEBOARD_SCHEMA_VERSION,
  };

  if (typeof data.sharedBackgroundImageUrl === 'string') {
    document.sharedBackgroundImageUrl = data.sharedBackgroundImageUrl;
  }

  if (typeof data.sharedBackgroundImageOpacity === 'number') {
    document.sharedBackgroundImageOpacity = data.sharedBackgroundImageOpacity;
  }

  if (typeof data.viewportZoom === 'number') {
    document.viewportZoom = data.viewportZoom;
  }

  return { ok: true, document };
}

/**
 * Turn a parsed document into a fresh, importable one: a brand-new id and timestamps so it lands as
 * a NEW whiteboard in the library (never overwriting an existing one). `id`/`now` are injected so
 * this stays pure and unit-testable (no `crypto`/`Date` calls inside).
 */
export function prepareImportedDocument(
  document: WhiteboardDocument,
  opts: { id: string; now: number },
): WhiteboardDocument {
  return {
    ...document,
    id: opts.id,
    createdAt: opts.now,
    updatedAt: opts.now,
    currentPageIndex: Math.min(document.pages.length - 1, Math.max(0, document.currentPageIndex)),
  };
}
