import { createWhiteboardId } from './id';
import { normalizeCanvasWidthPx, normalizePaperSpacingMm, normalizeSheetAspect } from './page-geometry';
import { isInsertedSheet } from './inserted-sheets';

import type { BackgroundType, WhiteboardPage } from './types';

/**
 * Free-writing notebooks (no PDF) split into real pages: a vertical stack of paper sheets, shown by
 * the same continuous layout as a PDF notebook (whiteboard-react utils/pdfScrollSession).
 *
 * Each page is a SHEET ({@link WhiteboardPage.sheetAspect}) with {@link WhiteboardPage.boardRuled} set,
 * so its lines are drawn exactly like a plain board page's. Ink stays stored per page in its own frame
 * (`canvasWidthPx` wide, from the page's top-left corner) — the format every free page already uses.
 *
 * OLD NOTEBOOKS. Before this, a free page was one endless sheet. {@link splitFreeNotebookIntoSheets}
 * turns each such page into one sheet tall enough for all of its ink — usually just an A4 page, longer
 * when the student wrote further down — and never touches `canvasJSON`: no stroke is moved, re-framed
 * or dropped. When a page's ink cannot be proven to sit inside its frame (ink left of / right of / above
 * the sheet, an unreadable scene, ink but no recorded width, or a page longer than a sheet may be), the
 * notebook is left exactly as it was, in the endless layout.
 */

/** A new page: A4 portrait, height ÷ width. */
export const NOTEBOOK_SHEET_ASPECT = 297 / 210;
/** The longest a converted old page may be (the sheet-aspect limit, see normalizeSheetAspect). */
export const NOTEBOOK_SHEET_MAX_ASPECT = 20;

export interface InkExtent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Json = Record<string, unknown>;

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Where on the object its (left, top) point sits, as a fraction of its size. Absent → both old and new defaults. */
function originFractions(value: unknown, start: string, end: string): number[] {
  if (value === start) return [0];
  if (value === 'center') return [0.5];
  if (value === end) return [1];
  if (typeof value === 'number' && Number.isFinite(value)) return [value];

  // Fabric ≤ 6 defaulted to the top-left corner, Fabric 7 to the centre: cover both.
  return [0, 0.5];
}

/** Axis-aligned box of one serialized Fabric object in its page frame (generous: full stroke width added). */
function objectExtent(object: Json): InkExtent | null {
  const scaleX = Math.abs(num(object.scaleX, 1));
  const scaleY = Math.abs(num(object.scaleY, 1));
  const width = Math.max(0, num(object.width, 0)) * scaleX;
  const height = Math.max(0, num(object.height, 0)) * scaleY;
  const left = num(object.left, 0);
  const top = num(object.top, 0);
  const strokeWidth = object.stroke ? Math.max(0, num(object.strokeWidth, 0)) * Math.max(scaleX, scaleY, 1) : 0;
  const angle = (num(object.angle, 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Skew is rare on ink; a skewed object gets a box as large as its diagonal on every side.
  const skewed = num(object.skewX, 0) !== 0 || num(object.skewY, 0) !== 0;
  const pad = strokeWidth + (skewed ? Math.hypot(width, height) : 0);
  let extent: InkExtent | null = null;

  for (const fx of originFractions(object.originX, 'left', 'right')) {
    for (const fy of originFractions(object.originY, 'top', 'bottom')) {
      const x0 = -fx * width;
      const y0 = -fy * height;

      for (const [cx, cy] of [
        [x0, y0],
        [x0 + width, y0],
        [x0, y0 + height],
        [x0 + width, y0 + height],
      ] as const) {
        const x = left + cx * cos - cy * sin;
        const y = top + cx * sin + cy * cos;

        extent = extent
          ? { maxX: Math.max(extent.maxX, x), maxY: Math.max(extent.maxY, y), minX: Math.min(extent.minX, x), minY: Math.min(extent.minY, y) }
          : { maxX: x, maxY: y, minX: x, minY: y };
      }
    }
  }

  return extent && { maxX: extent.maxX + pad, maxY: extent.maxY + pad, minX: extent.minX - pad, minY: extent.minY - pad };
}

/**
 * Box around everything on a page, in its frame. `null` = no objects; `'unreadable'` = the scene could
 * not be parsed (so nothing about it can be promised).
 */
export function canvasJsonInkExtent(canvasJSON: string | undefined): InkExtent | null | 'unreadable' {
  if (!canvasJSON?.trim()) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(canvasJSON);
  } catch {
    return 'unreadable';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';

  const objects = (parsed as Json).objects;

  if (objects === undefined) return null;
  if (!Array.isArray(objects)) return 'unreadable';

  let extent: InkExtent | null = null;

  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;

    const box = objectExtent(object as Json);

    if (!box) continue;

    extent = extent
      ? {
          maxX: Math.max(extent.maxX, box.maxX),
          maxY: Math.max(extent.maxY, box.maxY),
          minX: Math.min(extent.minX, box.minX),
          minY: Math.min(extent.minY, box.minY),
        }
      : box;
  }

  return extent;
}

const hasBackground = (page: Pick<WhiteboardPage, 'pdfAssetId' | 'pdfImageUrl'>): boolean => Boolean(page.pdfAssetId || page.pdfImageUrl);

/**
 * One old free page as a sheet, or `null` when that cannot be done without hiding or moving ink.
 * A page that is already a sheet comes back as it is (same object).
 */
export function toNotebookSheet(page: WhiteboardPage): WhiteboardPage | null {
  if (hasBackground(page)) return null;
  if (isInsertedSheet(page)) return page;

  const extent = canvasJsonInkExtent(page.canvasJSON);

  if (extent === 'unreadable') return null;
  if (!extent) return { ...page, sheetAspect: NOTEBOOK_SHEET_ASPECT, boardRuled: true };

  const frameWidth = normalizeCanvasWidthPx(page.canvasWidthPx);

  // Ink, but no record of the frame it was written in: its place on a sheet is unknown.
  if (frameWidth === undefined) return null;

  // A stroke that just kisses an edge is fine (the box is generous); real ink outside the sheet is not.
  const tolerance = Math.max(4, frameWidth * 0.01);

  if (extent.minX < -tolerance || extent.maxX > frameWidth + tolerance || extent.minY < -tolerance) return null;

  // Room under the last line, so the page never ends right at the writing.
  const room = Math.max(48, frameWidth * 0.06);
  const needed = (extent.maxY + room) / frameWidth;

  if (needed > NOTEBOOK_SHEET_MAX_ASPECT) return null;

  // An A4 page when the ink fits on one; else just long enough (rounded up, so it never falls short).
  const sheetAspect = normalizeSheetAspect(needed <= NOTEBOOK_SHEET_ASPECT ? NOTEBOOK_SHEET_ASPECT : Math.ceil(needed * 1000) / 1000);

  return sheetAspect === undefined ? null : { ...page, sheetAspect, boardRuled: true };
}

/**
 * The pages of a free notebook as a stack of sheets — `pages` itself when every page already is one,
 * `null` when it is not a free notebook (it has PDF pages) or some page cannot be converted safely
 * (the notebook then stays in its old endless layout, untouched).
 */
export function splitFreeNotebookIntoSheets(pages: readonly WhiteboardPage[]): WhiteboardPage[] | null {
  if (pages.length === 0 || pages.some(hasBackground)) return null;

  let changed = false;
  const out: WhiteboardPage[] = [];
  // A blank page that never recorded a frame takes the notebook's (the first recorded one), so its
  // lines and writing size match the pages around it instead of the screen it first opens on.
  const notebookFrame = pages.map((page) => normalizeCanvasWidthPx(page.canvasWidthPx)).find((width) => width !== undefined);

  for (const page of pages) {
    let sheet = toNotebookSheet(page);

    if (!sheet) return null;
    if (sheet !== page && notebookFrame !== undefined && normalizeCanvasWidthPx(sheet.canvasWidthPx) === undefined) {
      sheet = { ...sheet, canvasWidthPx: notebookFrame };
    }
    if (sheet !== page) changed = true;

    out.push(sheet);
  }

  return changed ? out : (pages as WhiteboardPage[]);
}

/** A free notebook already split into pages: no PDF page, every page a sheet. */
export function isSheetNotebook(pages: readonly WhiteboardPage[]): boolean {
  return pages.length > 0 && pages.every((page) => !hasBackground(page) && isInsertedSheet(page));
}

/** A new blank page for a free notebook split into pages. */
export function createNotebookSheet(backgroundType: BackgroundType, paperSpacingMm?: number): WhiteboardPage {
  const spacing = normalizePaperSpacingMm(paperSpacingMm);

  return {
    ...(spacing !== undefined ? { paperSpacingMm: spacing } : {}),
    id: createWhiteboardId(),
    canvasJSON: '',
    thumbnail: '',
    backgroundType,
    sheetAspect: NOTEBOOK_SHEET_ASPECT,
    boardRuled: true,
    viewportOffsetX: 0,
    viewportOffsetY: 0,
  };
}
