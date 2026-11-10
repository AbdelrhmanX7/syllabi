import type { BackgroundType, WhiteboardDocument, WhiteboardPage, WhiteboardSummary } from './types';
import { createWhiteboardId } from './id';
import {
  normalizeBoardRuled,
  normalizeCanvasWidthPx,
  normalizePageBookmark,
  normalizePaperSpacingMm,
  normalizePdfPlacement,
  normalizeSheetAspect,
} from './page-geometry';
import { WHITEBOARD_SCHEMA_VERSION } from './types';

function clampSharedBackgroundOpacity(opacity: number | null | undefined): number {
  if (typeof opacity !== 'number' || Number.isNaN(opacity)) {
    return 1;
  }

  return Math.min(1, Math.max(0.05, opacity));
}

function clampViewportZoom(zoom: number | null | undefined): number {
  if (typeof zoom !== 'number' || Number.isNaN(zoom)) {
    return 1;
  }

  return Math.min(4, Math.max(0.25, zoom));
}

export function createBlankWhiteboardPage(backgroundType: BackgroundType = 'blank'): WhiteboardPage {
  return {
    id: createWhiteboardId(),
    canvasJSON: '',
    thumbnail: '',
    backgroundType,
    viewportOffsetX: 0,
    viewportOffsetY: 0,
  };
}

/**
 * A PDF page carries no inline (data-URL) thumbnail. Import used to store its preview JPEG on every
 * page, so a 108-page exam was a 4.7 MB document that every autosave and every sync enqueue
 * re-serialized on the main thread — the pen lag on PDF boards (2026-09-13). The page strip renders
 * PDF thumbnails from the asset on demand, so dropping them here migrates existing boards on load
 * and the next save persists the lean record. A remote URL thumbnail is kept: it costs nothing.
 */
function persistedPageThumbnail(page: WhiteboardPage | null | undefined): string {
  const thumbnail = page?.thumbnail ?? '';

  if (page?.pdfAssetId && thumbnail.startsWith('data:')) {
    return '';
  }

  return thumbnail;
}

function normalizeWhiteboardPage(page: WhiteboardPage | null | undefined): WhiteboardPage {
  const hasPdfBackground = Boolean(page?.pdfAssetId || page?.pdfImageUrl);
  const sheetAspect = hasPdfBackground ? undefined : normalizeSheetAspect(page?.sheetAspect);
  const boardRuled = normalizeBoardRuled(page?.boardRuled, sheetAspect);
  const bookmark = normalizePageBookmark(page?.bookmark);

  return {
    id: page?.id ?? createWhiteboardId(),
    canvasJSON: page?.canvasJSON ?? '',
    thumbnail: persistedPageThumbnail(page),
    pdfAssetId: page?.pdfAssetId,
    pdfFingerprint: page?.pdfFingerprint,
    pdfPageIndex: page?.pdfPageIndex,
    pdfSourcePageNumber: page?.pdfSourcePageNumber,
    pdfImageUrl: page?.pdfImageUrl,
    pdfSourceName: page?.pdfSourceName,
    // Recorded capture geometry rides through validated (junk → absent, never 0). A placement only
    // means something on a page that has a PDF/image background to place.
    canvasWidthPx: normalizeCanvasWidthPx(page?.canvasWidthPx),
    pdfPlacement: hasPdfBackground ? normalizePdfPlacement(page?.pdfPlacement) : undefined,
    sheetAspect,
    // Optional page flags ride through only when set, so an untouched page stays byte-identical.
    ...(boardRuled ? { boardRuled } : {}),
    ...(bookmark ? { bookmark } : {}),
    backgroundType: page?.backgroundType ?? 'blank',
    paperSpacingMm: normalizePaperSpacingMm(page?.paperSpacingMm),
    viewportOffsetX: page?.viewportOffsetX ?? 0,
    viewportOffsetY: page?.viewportOffsetY ?? 0,
    // Preserve a page's own saved zoom across reload. Keep undefined (not forced to 1) when a page
    // was never zoomed, so PDF pages still open fit-and-centered on first view.
    viewportZoom:
      typeof page?.viewportZoom === 'number' && Number.isFinite(page.viewportZoom)
        ? Math.min(4, Math.max(0.25, page.viewportZoom))
        : undefined,
  };
}

export function createBlankWhiteboardDocument({
  id = createWhiteboardId(),
  title = 'New board',
  backgroundType = 'blank',
}: {
  id?: string;
  title?: string;
  backgroundType?: BackgroundType;
} = {}): WhiteboardDocument {
  const now = Date.now();

  return {
    id,
    title,
    pages: [createBlankWhiteboardPage(backgroundType)],
    currentPageIndex: 0,
    createdAt: now,
    updatedAt: now,
    thumbnail: '',
    viewportZoom: 1,
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  };
}

export function normalizeWhiteboardDocument(doc: WhiteboardDocument | null | undefined): WhiteboardDocument | null {
  if (!doc) return null;

  const pages = (doc.pages ?? []).map((page) => normalizeWhiteboardPage(page));
  const normalizedPages = pages.length > 0 ? pages : [createBlankWhiteboardPage()];
  const maxPageIndex = normalizedPages.length - 1;
  const currentPageIndex = Math.min(Math.max(doc.currentPageIndex ?? 0, 0), maxPageIndex);
  const createdAt = doc.createdAt ?? Date.now();
  const updatedAt = doc.updatedAt ?? createdAt;

  return {
    ...doc,
    title: doc.title?.trim() || 'New board',
    pages: normalizedPages,
    currentPageIndex,
    createdAt,
    updatedAt,
    thumbnail: doc.thumbnail ?? '',
    sharedBackgroundImageOpacity: clampSharedBackgroundOpacity(doc.sharedBackgroundImageOpacity),
    viewportZoom: clampViewportZoom(doc.viewportZoom),
    schemaVersion: doc.schemaVersion ?? WHITEBOARD_SCHEMA_VERSION,
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Project a document down to the {@link WhiteboardSummary} the library list renders. Defensive
 * about every field because it also runs over RAW persisted records during the summaries-store
 * backfill (a legacy row may carry a missing title or a non-numeric timestamp), and the fallbacks
 * mirror {@link normalizeWhiteboardDocument} so a summary row reads identically to the document
 * the old full-document list used to return.
 *
 * Page CONTENT must never leak in here — only `pages.length`.
 */
export function toWhiteboardSummary(doc: WhiteboardDocument): WhiteboardSummary {
  const createdAt = finiteOr(doc.createdAt, Date.now());
  const summary: WhiteboardSummary = {
    id: doc.id,
    title: doc.title?.trim() || 'New board',
    createdAt,
    updatedAt: finiteOr(doc.updatedAt, createdAt),
    thumbnail: typeof doc.thumbnail === 'string' ? doc.thumbnail : '',
    pageCount: Array.isArray(doc.pages) ? doc.pages.length : 0,
  };

  // The teacher tag is OPTIONAL by design: an untagged board belongs to everyone and must always
  // stay visible, so absence has to survive the round-trip as absence — never as an empty string.
  if (typeof doc.teacherId === 'string') {
    summary.teacherId = doc.teacherId;
  }

  if (doc.teacherType === 'Teacher' || doc.teacherType === 'StudioTeacher') {
    summary.teacherType = doc.teacherType;
  }

  if (typeof doc.teacherName === 'string') {
    summary.teacherName = doc.teacherName;
  }

  return summary;
}
