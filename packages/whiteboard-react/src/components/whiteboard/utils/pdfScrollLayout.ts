import { getRotatedBoundingSize, normalizeRotationDeg } from './backgroundLayers';
import { boardPatternSpacingPx, LEGACY_SHEET_LINES_PER_WIDTH, sheetPatternPitch } from './paperSpacing';
import { normalizeCanvasWidthPx, normalizePdfPlacement } from '../types';

import type { PdfPlacementRect, WhiteboardPage } from '../types';

/**
 * Geometry of the CONTINUOUS PDF layout (`WhiteboardEditor.pdfLayout = 'scroll'`): every page of the
 * document stacked top-to-bottom in ONE scene, all pages the same width, a small neutral gap between
 * them. The single Fabric canvas shows a window of that scene through its viewport transform; the
 * pages inside (and just outside) the viewport are hydrated onto it, the rest live only as JSON.
 *
 * A page's ink is STORED in its own page-local frame (utils/snapshotGeometry): a canvas
 * `canvasWidthPx` wide with the PDF fitted to the width and centred vertically, so the PDF rect is
 * `pdfPlacement`. Nothing about that format changes here. In the scroll scene page `i` occupies the
 * rect `(0, top_i, width, height_i)`; mapping an object between the two frames is a uniform scale
 * (`width / canvasWidthPx`, exactly 1 on the device the page was written on) plus a translation —
 * {@link pageToSceneTransform}. Objects go through that map on hydration and back on flush.
 *
 * A page's scene height is `width × aspect` where aspect (h/w) comes from, in order: the recorded
 * placement, the loaded raster (rotated bounding box), or an A4 portrait guess until the raster lands.
 */

/** A4 portrait, height ÷ width — what a page is assumed to be until its raster or record says otherwise. */
export const DEFAULT_PDF_PAGE_ASPECT = 297 / 210;
/** Gap between stacked pages at fit-width, in scene px (= CSS px at zoom 1). */
export const PDF_SCROLL_GAP_PX = 24;
/** The neutral board colour that shows in the gaps. */
export const PDF_SCROLL_GAP_COLOR = '#e4e4e7';
/** A hairline around each page so two white pages read as two sheets, not one. */
export const PDF_SCROLL_PAGE_EDGE_COLOR = '#d4d4d8';

export interface PdfScrollLayoutEntry {
  pageId: string;
  index: number;
  /** Scene y of the page's top edge. */
  top: number;
  /** Scene height (= layout width × aspect). */
  height: number;
  /** height ÷ width. */
  aspect: number;
}

export interface PdfScrollLayout {
  /** Scene width shared by every page. */
  width: number;
  gap: number;
  totalHeight: number;
  entries: PdfScrollLayoutEntry[];
}

export interface PdfScrollViewport {
  zoom: number;
  offsetY: number;
}

export interface PdfScrollRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/** The page-local frame a page's ink is stored in: its width and where the page rect sits inside it. */
export interface PdfScrollPageFrame {
  frameWidth: number;
  frameHeight: number;
  placement: PdfPlacementRect;
  /** Whether `placement` came from the page's own record (vs. being derived here). */
  recorded: boolean;
}

export interface SceneTransform {
  scale: number;
  dx: number;
  dy: number;
}

/** What the background layer hands a scroll-layout painter for one pass. */
export interface PdfScrollPaintArgs {
  viewportTransform: readonly number[];
  pixelRatio: number;
  quality: ImageSmoothingQuality;
  /** Canvas CSS size. */
  width: number;
  height: number;
  /**
   * The on-screen board is dark (utils/darkBoard): pages without a PDF are painted as dark paper, so
   * the ink — remapped to light colours on screen — stays readable. Captures and exports leave it off.
   */
  dark?: boolean;
}

/**
 * Paints the stacked pages (gaps, sheets, rasters) into the background layer in place of the single
 * fitted page raster. Installed through `WhiteboardCanvas.pdfScrollPainterRef` by the session that owns
 * the layout and the page images.
 */
export type PdfScrollPainter = (ctx: CanvasRenderingContext2D, args: PdfScrollPaintArgs) => void;

const PLACEMENT_TOLERANCE_PX = 1;

const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export const hasPdfBackground = (page: Pick<WhiteboardPage, 'pdfAssetId' | 'pdfImageUrl'>): boolean =>
  Boolean(page.pdfAssetId || page.pdfImageUrl);

/** A page's recorded placement, when it belongs to the page's recorded frame width. */
export function recordedPlacement(
  page: Pick<WhiteboardPage, 'canvasWidthPx' | 'pdfPlacement'>,
): { frameWidth: number; placement: PdfPlacementRect } | null {
  const frameWidth = normalizeCanvasWidthPx(page.canvasWidthPx);
  const placement = normalizePdfPlacement(page.pdfPlacement);

  if (frameWidth === undefined || !placement) return null;
  if (Math.abs(placement.width - frameWidth) > PLACEMENT_TOLERANCE_PX) return null;
  if (!isPositive(placement.height)) return null;

  return { frameWidth, placement };
}

/**
 * height ÷ width of a page in the scroll layout: the recorded placement first (exact), else an
 * inserted sheet's own aspect, else the raster's rotated bounding box, else A4.
 */
export function resolvePdfPageAspect(
  page: Pick<WhiteboardPage, 'canvasWidthPx' | 'pdfPlacement' | 'pdfRotation'> & Partial<Pick<WhiteboardPage, 'sheetAspect'>>,
  imageSize?: { width: number; height: number } | null,
): number {
  const recorded = recordedPlacement(page);

  if (recorded) {
    return recorded.placement.height / recorded.placement.width;
  }

  if (isPositive(page.sheetAspect)) {
    return page.sheetAspect;
  }

  if (imageSize && isPositive(imageSize.width) && isPositive(imageSize.height)) {
    const bbox = getRotatedBoundingSize(imageSize.width, imageSize.height, normalizeRotationDeg(page.pdfRotation));

    return bbox.height / bbox.width;
  }

  return DEFAULT_PDF_PAGE_ASPECT;
}

export function buildPdfScrollLayout(
  pages: ReadonlyArray<Pick<WhiteboardPage, 'id'>>,
  options: { width: number; gap?: number; aspectOf: (page: Pick<WhiteboardPage, 'id'>, index: number) => number },
): PdfScrollLayout {
  const width = Math.max(1, options.width);
  const gap = Math.max(0, options.gap ?? PDF_SCROLL_GAP_PX);
  const entries: PdfScrollLayoutEntry[] = [];
  let cursor = 0;

  pages.forEach((page, index) => {
    const rawAspect = options.aspectOf(page, index);
    const aspect = isPositive(rawAspect) ? rawAspect : DEFAULT_PDF_PAGE_ASPECT;
    const height = width * aspect;

    entries.push({ aspect, height, index, pageId: page.id, top: cursor });
    cursor += height + gap;
  });

  return { entries, gap, totalHeight: entries.length > 0 ? cursor - gap : 0, width };
}

/** A string that changes exactly when {@link buildPdfScrollLayout} would produce different geometry. */
export function pdfScrollLayoutKey(layout: PdfScrollLayout): string {
  return `${layout.width}|${layout.gap}|${layout.entries.map((entry) => `${entry.pageId}:${entry.height.toFixed(2)}`).join(',')}`;
}

/** Same pages in the same order (ink can be shifted in place) vs. a different page sequence. */
export function samePdfScrollPageSequence(a: PdfScrollLayout, b: PdfScrollLayout): boolean {
  if (a.entries.length !== b.entries.length) return false;

  return a.entries.every((entry, index) => entry.pageId === b.entries[index]?.pageId);
}

/**
 * Index of the page at scene `y`. The gap below a page belongs to that page; above the first page
 * resolves to 0, below the last to the last. -1 for an empty layout.
 */
export function findPdfScrollPageAt(layout: PdfScrollLayout, y: number): number {
  const { entries } = layout;

  if (entries.length === 0) return -1;
  if (y < entries[0]!.top) return 0;

  let low = 0;
  let high = entries.length - 1;

  while (low < high) {
    const mid = (low + high + 1) >> 1;

    if (entries[mid]!.top <= y) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low;
}

/** Scene y range the canvas shows: `[top, bottom)`. */
export function visibleSceneBand(viewport: PdfScrollViewport, canvasHeight: number): { top: number; bottom: number } {
  const zoom = isPositive(viewport.zoom) ? viewport.zoom : 1;
  const top = -viewport.offsetY / zoom;

  return { bottom: top + canvasHeight / zoom, top };
}

/**
 * Pages intersecting the viewport grown by `overscanPx` SCREEN px above and below (what the
 * hydration window keeps on the canvas). `null` for an empty layout.
 */
export function resolvePdfScrollVisibleRange(
  layout: PdfScrollLayout,
  viewport: PdfScrollViewport,
  canvasHeight: number,
  overscanPx = 0,
): PdfScrollRange | null {
  if (layout.entries.length === 0) return null;

  const zoom = isPositive(viewport.zoom) ? viewport.zoom : 1;
  const band = visibleSceneBand(viewport, canvasHeight);
  const top = band.top - overscanPx / zoom;
  const bottom = band.bottom + overscanPx / zoom;
  let start = findPdfScrollPageAt(layout, top);
  let end = findPdfScrollPageAt(layout, bottom);

  // findPdfScrollPageAt hands the gap below a page to that page; a band that starts inside a gap
  // does not show the page above it.
  const startEntry = layout.entries[start]!;

  if (top >= startEntry.top + startEntry.height && start < layout.entries.length - 1) {
    start += 1;
  }

  // Likewise a band that ends above a page's top does not show it.
  const endEntry = layout.entries[end]!;

  if (bottom <= endEntry.top && end > 0) {
    end -= 1;
  }

  if (end < start) end = start;

  return { end, start };
}

/** The page the vertical centre of the view is on — what the page indicator shows. */
export function resolvePdfScrollCurrentPage(layout: PdfScrollLayout, viewport: PdfScrollViewport, canvasHeight: number): number {
  if (layout.entries.length === 0) return -1;

  const band = visibleSceneBand(viewport, canvasHeight);
  const centre = (band.top + band.bottom) / 2;
  const index = findPdfScrollPageAt(layout, centre);
  const entry = layout.entries[index]!;

  // In the gap below a page: the page that is about to arrive is the one being read.
  if (centre > entry.top + entry.height && index < layout.entries.length - 1) {
    return index + 1;
  }

  return index;
}

/** The viewport that shows page `index` from its top at `zoom`, left edge at the canvas's left edge. */
export function pdfScrollViewportForPage(
  layout: PdfScrollLayout,
  index: number,
  zoom: number,
): { zoom: number; offsetX: number; offsetY: number } {
  const entry = layout.entries[Math.min(Math.max(index, 0), layout.entries.length - 1)];
  const z = isPositive(zoom) ? zoom : 1;

  return { offsetX: 0, offsetY: entry ? -entry.top * z : 0, zoom: z };
}

/**
 * The page-local frame a page's ink lives in. A recorded page keeps its record; a page without one
 * is framed exactly as the paged layout would frame it on this canvas — the layout width as the
 * frame width, the live canvas height as the frame height, the page rect fitted to the width and
 * centred vertically (a page without a PDF is framed from its top instead, since it has no rect to
 * centre). Writing this frame back on flush is what turns a never-recorded page into a recorded one.
 */
export function resolvePdfScrollPageFrame(
  page: Pick<WhiteboardPage, 'canvasWidthPx' | 'pdfPlacement' | 'pdfAssetId' | 'pdfImageUrl'>,
  entry: Pick<PdfScrollLayoutEntry, 'aspect'>,
  layout: Pick<PdfScrollLayout, 'width'>,
  canvas: { width: number; height: number },
): PdfScrollPageFrame {
  const recorded = recordedPlacement(page);

  if (recorded) {
    return {
      frameHeight: 2 * recorded.placement.y + recorded.placement.height,
      frameWidth: recorded.frameWidth,
      placement: recorded.placement,
      recorded: true,
    };
  }

  const frameWidth = normalizeCanvasWidthPx(page.canvasWidthPx) ?? layout.width;
  const pageHeight = frameWidth * entry.aspect;
  const frameHeight =
    isPositive(canvas.width) && isPositive(canvas.height) ? (canvas.height * frameWidth) / canvas.width : pageHeight;
  const y = hasPdfBackground(page) ? (frameHeight - pageHeight) / 2 : 0;

  return {
    frameHeight,
    frameWidth,
    placement: { height: pageHeight, width: frameWidth, x: 0, y },
    recorded: false,
  };
}

/** page-local → scene: `scene = local × scale + (dx, dy)`. */
export function pageToSceneTransform(
  frame: Pick<PdfScrollPageFrame, 'frameWidth' | 'placement'>,
  entry: Pick<PdfScrollLayoutEntry, 'top'>,
  layout: Pick<PdfScrollLayout, 'width'>,
): SceneTransform {
  const scale = layout.width / Math.max(1, frame.frameWidth);

  return { dx: -frame.placement.x * scale, dy: entry.top - frame.placement.y * scale, scale };
}

export function invertSceneTransform(transform: SceneTransform): SceneTransform {
  const scale = 1 / transform.scale;

  return { dx: -transform.dx * scale, dy: -transform.dy * scale, scale };
}

export function applySceneTransformToPoint(transform: SceneTransform, point: { x: number; y: number }) {
  return { x: point.x * transform.scale + transform.dx, y: point.y * transform.scale + transform.dy };
}

/**
 * Marker a host's `loadFromJSON` reviver stamps on objects revived from stored JSON, so a host hook on
 * `_onObjectAdded` can tell "ink the teacher just drew" from "ink coming back from disk" (the Study
 * app's lecture stroke clock reads it). Scroll-mode hydration revives objects through
 * `enlivenObjects` + `canvas.add`, never `loadFromJSON`, so it has to set the same marker itself or
 * every page scrolling into view would look like freshly drawn ink.
 */
export const REVIVED_FROM_JSON_MARKER = '__studyRevived';

export function markRevivedFromJson<T extends object>(objects: readonly T[]): void {
  for (const object of objects) {
    (object as Record<string, unknown>)[REVIVED_FROM_JSON_MARKER] = true;
  }
}

/**
 * Move a serialized Fabric object between frames. Only the object's own transform is touched —
 * `left`/`top` move, `scaleX`/`scaleY` take the scale (a group's children are relative to it, and a
 * path's points are in object space, so neither needs rewriting). Returns a shallow copy.
 */
export function transformCanvasObjectJson<T extends Record<string, unknown>>(object: T, transform: SceneTransform): T {
  const next: Record<string, unknown> = { ...object };
  const left = typeof object.left === 'number' ? object.left : 0;
  const top = typeof object.top === 'number' ? object.top : 0;

  next.left = left * transform.scale + transform.dx;
  next.top = top * transform.scale + transform.dy;

  if (transform.scale !== 1) {
    const scaleX = typeof object.scaleX === 'number' ? object.scaleX : 1;
    const scaleY = typeof object.scaleY === 'number' ? object.scaleY : 1;

    next.scaleX = scaleX * transform.scale;
    next.scaleY = scaleY * transform.scale;
  }

  return next as T;
}

/**
 * The viewport transform that paints a page's raster at its scene rect through the SAME fit math the
 * paged layout uses (`drawScreenFitImage(frameWidth, frameHeight, …)`): the page→scene map folded
 * into the live viewport.
 */
export function pdfScrollPagePaintTransform(
  viewportTransform: readonly number[],
  transform: SceneTransform,
): [number, number, number, number, number, number] {
  const zoom = viewportTransform[0] || 1;
  const offsetX = viewportTransform[4] || 0;
  const offsetY = viewportTransform[5] || 0;

  return [zoom * transform.scale, 0, 0, zoom * transform.scale, offsetX + zoom * transform.dx, offsetY + zoom * transform.dy];
}

/**
 * Paint args that render the stacked pages of ONE scene rectangle into an off-screen canvas of
 * `region × scale` pixels — the same scene→pixel map the ink of that rectangle is rendered through
 * (`toCanvasElement` with `left/top` = the region's), so a capture's PDF lies exactly under its ink.
 */
export function pdfScrollRegionPaintArgs(
  region: { left: number; top: number; width: number; height: number },
  scale: number,
): PdfScrollPaintArgs {
  const s = isPositive(scale) ? scale : 1;

  return {
    height: Math.max(1, Math.round(region.height * s)),
    pixelRatio: 1,
    quality: 'high',
    viewportTransform: [s, 0, 0, s, -region.left * s, -region.top * s],
    width: Math.max(1, Math.round(region.width * s)),
  };
}

/**
 * Ruling of an inserted sheet's paper, in scene px: the line pitch is a fixed fraction of the page
 * WIDTH (not a screen constant), so on every device the lines sit at the same place relative to the
 * page — and to the ink written between them. The first line leaves a header band of two pitches.
 * A sheet's `paperSpacingMm` sets the pitch on an A4-wide page (utils/paperSpacing); absent keeps
 * the original width / 28.
 */
export const SHEET_RULE_LINES_PER_WIDTH = LEGACY_SHEET_LINES_PER_WIDTH;

export function sheetRulePitch(layoutWidth: number, paperSpacingMm?: number): number {
  return sheetPatternPitch(layoutWidth, paperSpacingMm);
}

/** Scene y of every ruled line of the sheet at `entry` that falls within `[bandTop, bandBottom]`. */
export function sheetRuleLineYs(
  entry: Pick<PdfScrollLayoutEntry, 'top' | 'height'>,
  layoutWidth: number,
  bandTop: number,
  bandBottom: number,
  paperSpacingMm?: number,
): number[] {
  const pitch = sheetRulePitch(layoutWidth, paperSpacingMm);
  const first = entry.top + 2 * pitch;
  const last = entry.top + entry.height - pitch / 2;
  const to = Math.min(last, bandBottom);
  const out: number[] = [];

  // Each line from its index (never by accumulation), so a line sits at the same y in every band.
  for (let k = Math.max(0, Math.ceil((bandTop - first) / pitch)); first + k * pitch <= to; k += 1) {
    out.push(first + k * pitch);
  }

  return out;
}

/**
 * Pitch, in scene px, of a {@link WhiteboardPage.boardRuled} sheet (a free notebook page): the plain
 * board's pattern spacing measured in the page's own frame, scaled onto the layout — so the lines sit
 * exactly where they sat when the page was one endless board page, under the same writing.
 */
export function boardRuledPitch(layoutWidth: number, frameWidth: number, page: Pick<WhiteboardPage, 'paperSpacingMm'>): number {
  const scale = Math.max(1, layoutWidth) / Math.max(1, frameWidth);

  return boardPatternSpacingPx(page) * scale;
}

/**
 * Scene y of every line of a board-ruled sheet within `[bandTop, bandBottom]`: at multiples of the
 * pitch from the page's top edge (the board's own alignment), the top edge itself left out.
 */
export function boardRuledLineYs(
  entry: Pick<PdfScrollLayoutEntry, 'top' | 'height'>,
  pitch: number,
  bandTop: number,
  bandBottom: number,
): number[] {
  if (!(pitch > 0)) return [];

  const last = Math.min(entry.top + entry.height - pitch / 4, bandBottom);
  const out: number[] = [];

  for (let k = Math.max(1, Math.ceil((bandTop - entry.top) / pitch)); entry.top + k * pitch <= last; k += 1) {
    out.push(entry.top + k * pitch);
  }

  return out;
}
