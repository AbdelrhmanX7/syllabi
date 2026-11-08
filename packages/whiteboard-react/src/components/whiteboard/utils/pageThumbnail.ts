import type { WhiteboardPage } from '@repo/whiteboard-core';

import { createOffscreenOverlayCanvas } from './offscreenOverlayCanvas';
import { recordedPlacement, resolvePdfPageAspect } from './pdfScrollLayout';

/**
 * Page-list thumbnails drawn from the page's SAVED ink — the page-manager half of the thumbnail that
 * `snapshotPageFromCanvas` stopped writing (a whole-canvas `toDataURL` after every stroke froze long
 * drawings). Without it the strip showed a PDF page's bare background (no ink), a plain page's number,
 * or a thumbnail left over from an old version of the page: «sometimes works, sometimes not at all».
 *
 * One page at a time, on a canvas that is never in the DOM (`offscreenOverlayCanvas`): its paper +
 * ink as a transparent overlay at thumbnail scale, over the page's background picture (the PDF
 * thumbnail the caller resolved), on white. The frame is the one the ink was written in
 * (`canvasWidthPx`, and the recorded PDF placement when there is one), so ink lands where it sits on
 * the page.
 */

/** Frame width for a page that never recorded one (written before `canvasWidthPx` existed). */
const FALLBACK_FRAME_WIDTH = 1000;
/** height ÷ width of the page list's tile (140 × 80): the thumbnail is cut to it. */
const TILE_ASPECT = 80 / 140;
/** The view never zooms in past this fraction of the page width (one word stays a word, not a blob). */
const MIN_VIEW_WIDTH_RATIO = 0.4;
/** Breathing room around the ink, as a fraction of the ink box. */
const INK_MARGIN_RATIO = 0.08;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The part of the page the tile shows: the written area (padded, at the tile's aspect, never closer
 * than {@link MIN_VIEW_WIDTH_RATIO} of the page), kept inside the page where it fits; the page's top
 * when nothing is written yet. A whole A4 page in a landscape tile made the writing unreadably small.
 */
export function thumbnailView(page: Rect, ink: Rect[]): Rect {
  const minWidth = page.width * MIN_VIEW_WIDTH_RATIO;

  if (ink.length === 0) {
    return { left: page.left, top: page.top, width: page.width, height: page.width * TILE_ASPECT };
  }

  let left = Math.min(...ink.map((r) => r.left));
  let top = Math.min(...ink.map((r) => r.top));
  let right = Math.max(...ink.map((r) => r.left + r.width));
  let bottom = Math.max(...ink.map((r) => r.top + r.height));
  const marginX = (right - left) * INK_MARGIN_RATIO;
  const marginY = (bottom - top) * INK_MARGIN_RATIO;

  left -= marginX;
  right += marginX;
  top -= marginY;
  bottom += marginY;

  const width = Math.max(minWidth, right - left, (bottom - top) / TILE_ASPECT);
  const height = width * TILE_ASPECT;
  const clamp = (value: number, min: number, max: number) => (max < min ? (min + max) / 2 : Math.min(Math.max(value, min), max));
  const centreX = (left + right) / 2;
  const centreY = (top + bottom) / 2;

  return {
    left: clamp(centreX - width / 2, page.left, page.left + page.width - width),
    top: clamp(centreY - height / 2, page.top, page.top + page.height - height),
    width,
    height,
  };
}

/**
 * Changes whenever the page's ink does, without hashing the whole (multi-MB) JSON: its length plus a
 * strided sample. Cheap enough to compute on every render of a thumbnail row.
 */
export function pageInkKey(canvasJSON: string | undefined): string {
  if (!canvasJSON) return '0';
  const stride = Math.max(1, Math.floor(canvasJSON.length / 512));
  let hash = 2166136261;

  for (let i = 0; i < canvasJSON.length; i += stride) {
    hash ^= canvasJSON.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  // The tail always counts: a new stroke appends to the object list.
  for (let i = Math.max(0, canvasJSON.length - 64); i < canvasJSON.length; i += 1) {
    hash ^= canvasJSON.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `${canvasJSON.length}:${(hash >>> 0).toString(36)}`;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();

    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function loadBlobImage(blob: Blob): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(blob);

  return loadImage(url).finally(() => URL.revokeObjectURL(url));
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('[page-thumbnail] no image'))), 'image/webp', quality);
  });
}

/** A full page never gets taller than this × its width in a page image (ink run far below the sheet). */
const MAX_FULL_PAGE_ASPECT = 3;

/** The whole page, stretched down to any ink written below its bottom edge. */
export function fullPageView(page: Rect, ink: Rect[]): Rect {
  const inkBottom = ink.length ? Math.max(...ink.map((r) => r.top + r.height)) : 0;
  const bottom = Math.min(Math.max(page.top + page.height, inkBottom), page.top + page.width * MAX_FULL_PAGE_ASPECT);

  return { left: page.left, top: page.top, width: page.width, height: bottom - page.top };
}

export interface RenderPageThumbnailOptions {
  /** Output width in px (2× the tile, crisp on a 2× screen). */
  width: number;
  /** `'thumbnail'` (default): cropped to the writing at the tile's aspect. `'page'`: the whole page. */
  view?: 'thumbnail' | 'page';
  /** webp quality. */
  quality?: number;
  /** The page's background picture (PDF page / image), already rotated; absent for paper pages. */
  backgroundUrl?: string;
  /** Yield / abort between the heavy steps (see `offscreenOverlayCanvas`). */
  checkpoint?: () => Promise<void>;
}

export type RenderablePage = Pick<
  WhiteboardPage,
  'backgroundType' | 'canvasJSON' | 'canvasWidthPx' | 'pdfPlacement' | 'pdfRotation' | 'sheetAspect'
>;

/** The page's thumbnail as an object URL (webp). The caller owns it. */
export async function renderPageThumbnail(page: RenderablePage, options: RenderPageThumbnailOptions): Promise<string> {
  return URL.createObjectURL(await renderPageImage(page, options));
}

/**
 * The page as a webp image: paper + ink over its background picture. With `view: 'page'` it is the
 * whole page and `width` is its LONG edge (a portrait page comes out `width` tall).
 */
export async function renderPageImage(
  page: RenderablePage,
  { backgroundUrl, checkpoint, quality = 0.8, view: mode = 'thumbnail', width: requestedWidth }: RenderPageThumbnailOptions,
): Promise<Blob> {
  const recorded = recordedPlacement(page);
  const frameWidth = recorded?.frameWidth ?? (page.canvasWidthPx && page.canvasWidthPx > 0 ? page.canvasWidthPx : FALLBACK_FRAME_WIDTH);
  const rect: Rect = recorded
    ? { left: recorded.placement.x, top: recorded.placement.y, width: recorded.placement.width, height: recorded.placement.height }
    : { left: 0, top: 0, width: frameWidth, height: frameWidth * resolvePdfPageAspect(page) };
  const offscreen = createOffscreenOverlayCanvas({
    width: Math.ceil(frameWidth),
    height: Math.ceil(Math.max(rect.top + rect.height, rect.height)),
  });
  const output = document.createElement('canvas');

  try {
    await offscreen.load(page.canvasJSON);
    const inkBounds = offscreen.getExportableObjectBounds();
    const view = mode === 'page' ? fullPageView(rect, inkBounds) : thumbnailView(rect, inkBounds);
    const width = mode === 'page' && view.height > view.width ? Math.round((requestedWidth * view.width) / view.height) : requestedWidth;
    const scale = width / view.width;
    const height = Math.round(view.height * scale);
    const overlay = await offscreen.renderOverlayPng({
      backgroundType: page.backgroundType,
      bounds: view,
      checkpoint,
      multiplier: scale,
      sharedBackgroundImageOpacity: 0,
    });
    const [background, ink] = await Promise.all([
      backgroundUrl ? loadImage(backgroundUrl) : Promise.resolve(null),
      loadBlobImage(overlay),
    ]);
    const context = output.getContext('2d');

    if (!context) throw new Error('[page-thumbnail] no 2D context');
    output.width = width;
    output.height = height;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    // The background picture spans the whole page rect, positioned against the view.
    if (background) {
      context.drawImage(background, (rect.left - view.left) * scale, (rect.top - view.top) * scale, rect.width * scale, rect.height * scale);
    }
    if (ink) context.drawImage(ink, 0, 0, width, height);

    return await encode(output, quality);
  } finally {
    output.width = 0;
    output.height = 0;
    await offscreen.dispose();
  }
}
