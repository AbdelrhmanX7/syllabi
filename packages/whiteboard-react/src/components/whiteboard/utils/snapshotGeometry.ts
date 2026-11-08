import { getRotatedScreenFitPlacement, normalizeRotationDeg } from './backgroundLayers';
import { isSamePdfPlacement, normalizeCanvasWidthPx, normalizePdfPlacement } from '../types';

import type { PdfPlacementRect, WhiteboardPage } from '../types';

/**
 * Per-page canvas geometry recorded into a snapshot for the server-side ink renderer
 * (`WhiteboardPage.canvasWidthPx` / `WhiteboardPage.pdfPlacement`), and the frame bookkeeping that
 * keeps that record STABLE across reopens.
 *
 * COORDINATE FRAME. Everything here is in the page's SCENE frame: Fabric's canvas CSS-pixel
 * coordinates with the viewport at identity. That is the frame `canvasJSON` stores ink `left`/`top`
 * in, and the frame the background painter lays the PDF out in — `drawScreenFitImage` computes the
 * fit in scene space and only then applies the live `viewportTransform` (WhiteboardCanvas.tsx
 * updateBackgroundLayers). So pan/zoom is deliberately NOT folded in: the PDF rect and the ink share
 * one frame regardless of how the page is scrolled.
 *
 * WHICH FRAME. A PDF page is fitted against a FROZEN size, not the live canvas size: on a window
 * resize useWhiteboardCanvas re-fills the width with viewport ZOOM so the ink stays glued to the
 * page. The frozen size is chosen ONCE per page open by {@link resolveFrozenPdfFit}:
 *   - a page whose record already carries `canvasWidthPx` is pinned to THAT width (height rebuilt
 *     from the recorded placement), whatever window it is reopened in — so the ink written at
 *     3436 px stays aligned with the PDF on a 1096 px window, and the record never changes;
 *   - a page without a record freezes at the live container size (today's behaviour) and gets
 *     recorded on its first save.
 * A page without a PDF has no frozen frame; its record is the live canvas width at capture.
 *
 * VIEWPORT UNITS. Because the frame can be wider or narrower than the window it is shown in, a PDF
 * page's saved `viewportZoom` / `viewportOffsetX/Y` are stored FRAME-relative — as they would read
 * on a canvas exactly `canvasWidthPx` wide ({@link toFrameViewport}) — and scaled back to the live
 * window on load ({@link toScreenViewport}). On the device the page was written on the scale is
 * exactly 1 and nothing changes.
 */

/** What the background painter knows about the current page's PDF background (published by WhiteboardCanvas). */
export interface PdfBackgroundFrame {
  /** Page the frame was captured for. A frame is never applied to any other page. */
  pageId: string;
  /** Frozen fit size, CSS px (see {@link resolveFrozenPdfFit}). This IS the ink frame. */
  fitWidth: number;
  fitHeight: number;
  /** Natural size of the loaded background raster, or null while it is still loading. Only its aspect ratio enters the fit. */
  image: { width: number; height: number } | null;
}

export interface PdfFitSize {
  width: number;
  height: number;
}

/** Sub-pixel drift between two fits of the same page is bookkeeping noise, not a new frame. */
const PLACEMENT_TOLERANCE_PX = 1;

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Choose the size a PDF page is fitted against for the whole time it is open.
 *
 * Recorded frame first: `canvasWidthPx` is the width, and the height comes back out of the recorded
 * placement — the fit centres vertically (`top = (fitHeight − fittedHeight) / 2`), so
 * `fitHeight = 2·y + height`. Without a usable placement the height is rebuilt from the live
 * container's aspect ratio at the recorded width (exact on the same device, approximate elsewhere;
 * only the vertical centring depends on it). Without a record: the live container size, exactly as
 * before. `null` = nothing to freeze (0-sized container and no record).
 */
export function resolveFrozenPdfFit(input: {
  container: { width: number; height: number };
  record: Pick<WhiteboardPage, 'canvasWidthPx' | 'pdfPlacement'> | null | undefined;
}): PdfFitSize | null {
  const { container, record } = input;
  const recordedWidth = normalizeCanvasWidthPx(record?.canvasWidthPx);
  const hasContainer = isPositiveFinite(container.width) && isPositiveFinite(container.height);

  if (recordedWidth === undefined) {
    return hasContainer ? { height: container.height, width: container.width } : null;
  }

  const placement = normalizePdfPlacement(record?.pdfPlacement);

  // The fill-width fit makes placement.width == canvasWidthPx; a placement that disagrees was not
  // recorded against this frame and must not shape it.
  if (placement && Math.abs(placement.width - recordedWidth) <= PLACEMENT_TOLERANCE_PX) {
    const height = 2 * placement.y + placement.height;

    if (height > 0) {
      return { height, width: recordedWidth };
    }
  }

  if (hasContainer) {
    return { height: (recordedWidth * container.height) / container.width, width: recordedWidth };
  }

  return null;
}

/**
 * The frame an EXPORT / merge-overlay composer must fit the PDF against for `page`: the very frame
 * the live painter laid the page out in, which is the frame the ink coordinates live in.
 *
 * The painter's pinned frame ({@link PdfBackgroundFrame}, published per page) wins when it is for
 * THIS page; otherwise the page's own record through {@link resolveFrozenPdfFit}; and a page with no
 * record composes against the live canvas, exactly as it always did. Composing against the live
 * canvas for a RECORDED page is the shifted-ink bug: a window taller than the frame the page was
 * written in centres the page `(H_live − H_frame) / 2` lower, so every stroke floats that far above
 * its target in the exported page and in the merged download.
 */
export function resolvePageExportFrame(input: {
  live: PdfFitSize;
  page: Pick<WhiteboardPage, 'id' | 'canvasWidthPx' | 'pdfPlacement'>;
  pinned: PdfBackgroundFrame | null;
}): PdfFitSize {
  const { live, page, pinned } = input;

  if (pinned && pinned.pageId === page.id && isPositiveFinite(pinned.fitWidth) && isPositiveFinite(pinned.fitHeight)) {
    return { height: pinned.fitHeight, width: pinned.fitWidth };
  }

  return resolveFrozenPdfFit({ container: live, record: page }) ?? live;
}

/**
 * Screen-px per frame-px: how much the live window scales the frozen frame. 1 when either width is
 * unknown (nothing to compensate) — which is also exactly 1 on the device the page was written on.
 */
export function getFrameScale(liveCanvasWidth: number, frameWidth: number | undefined): number {
  if (!isPositiveFinite(liveCanvasWidth) || !isPositiveFinite(frameWidth)) {
    return 1;
  }

  return liveCanvasWidth / frameWidth;
}

/**
 * The scale a PDF page opens at, from its own record and the live canvas — the load-side twin of the
 * frame WhiteboardCanvas freezes, computed through the same {@link resolveFrozenPdfFit} so the two
 * can never disagree. 1 for pages without a PDF.
 */
export function getPageFrameScale(input: {
  canvasHeight: number;
  canvasWidth: number;
  page: Pick<WhiteboardPage, 'pdfAssetId' | 'pdfImageUrl' | 'canvasWidthPx' | 'pdfPlacement'>;
}): number {
  const { canvasHeight, canvasWidth, page } = input;

  if (!(page.pdfAssetId || page.pdfImageUrl)) {
    return 1;
  }

  const fit = resolveFrozenPdfFit({ container: { height: canvasHeight, width: canvasWidth }, record: page });

  return getFrameScale(canvasWidth, fit?.width);
}

export interface ViewportState {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

/** Drop float noise from a screen→frame→screen round trip so an untouched viewport compares equal. */
function snapViewportValue(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Live (screen) viewport → the frame-relative viewport that is persisted. Identity at scale 1. */
export function toFrameViewport(viewport: ViewportState, frameScale: number): ViewportState {
  if (frameScale === 1 || !isPositiveFinite(frameScale)) {
    return viewport;
  }

  return {
    offsetX: snapViewportValue(viewport.offsetX / frameScale),
    offsetY: snapViewportValue(viewport.offsetY / frameScale),
    zoom: snapViewportValue(viewport.zoom / frameScale),
  };
}

/** Persisted (frame-relative) viewport → the live viewport to apply on this window. Identity at scale 1. */
export function toScreenViewport(viewport: ViewportState, frameScale: number): ViewportState {
  if (frameScale === 1 || !isPositiveFinite(frameScale)) {
    return viewport;
  }

  return {
    offsetX: viewport.offsetX * frameScale,
    offsetY: viewport.offsetY * frameScale,
    zoom: viewport.zoom * frameScale,
  };
}

export interface SnapshotGeometry {
  canvasWidthPx: number;
  /**
   * The rect to record; `'none'` on a page without a PDF/image background (any stale record is
   * removed); `'unknown'` while the raster has not loaded (an existing record for this frame is kept).
   */
  pdfPlacement: PdfPlacementRect | 'none' | 'unknown';
}

/** Map the painter's fit placement (`left`/`top`/`width`/`height`/`scale`) onto the wire rect. Same frame, no math. */
export function toPdfPlacementRect(placement: {
  height: number;
  left: number;
  scale?: number;
  top: number;
  width: number;
}): PdfPlacementRect {
  return {
    height: placement.height,
    width: placement.width,
    x: placement.left,
    y: placement.top,
  };
}

/**
 * Resolve the geometry to record for `page` right now, or `null` when it is not known — in which
 * case the caller must leave whatever the page already carries untouched (never write a guess).
 */
export function resolveSnapshotGeometry(input: {
  canvasWidth: number;
  page: Pick<WhiteboardPage, 'id' | 'pdfAssetId' | 'pdfImageUrl' | 'pdfRotation'>;
  pdfFrame: PdfBackgroundFrame | null;
}): SnapshotGeometry | null {
  const { canvasWidth, page, pdfFrame } = input;
  const hasPdfBackground = Boolean(page.pdfAssetId || page.pdfImageUrl);

  if (!hasPdfBackground) {
    const canvasWidthPx = normalizeCanvasWidthPx(canvasWidth);

    return canvasWidthPx === undefined ? null : { canvasWidthPx, pdfPlacement: 'none' };
  }

  if (
    !pdfFrame ||
    pdfFrame.pageId !== page.id ||
    !isPositiveFinite(pdfFrame.fitWidth) ||
    !isPositiveFinite(pdfFrame.fitHeight)
  ) {
    return null;
  }

  const image = pdfFrame.image;

  if (!image || !isPositiveFinite(image.width) || !isPositiveFinite(image.height)) {
    return { canvasWidthPx: pdfFrame.fitWidth, pdfPlacement: 'unknown' };
  }

  // The exact call the painter makes (drawScreenFitImage → getScreenFitPlacement at rotation 0,
  // getRotatedScreenFitPlacement otherwise), with the page's SAVED rotation — never the slider draft.
  const placement = getRotatedScreenFitPlacement(
    pdfFrame.fitWidth,
    pdfFrame.fitHeight,
    image.width,
    image.height,
    normalizeRotationDeg(page.pdfRotation),
  );

  return {
    canvasWidthPx: pdfFrame.fitWidth,
    pdfPlacement: toPdfPlacementRect(placement),
  };
}

/**
 * Write `geometry` onto `page`. Identity-preserving: returns the very same object when nothing
 * would change (so snapshot builders can keep their "did anything change" checks), and never
 * mutates the input. A `null` geometry is "unknown" and leaves the page as it is. A recorded
 * placement within {@link PLACEMENT_TOLERANCE_PX} of the fresh one is kept as recorded, so a page
 * reopened on another window (raster rounded differently) does not rewrite its record.
 */
export function applySnapshotGeometry(page: WhiteboardPage, geometry: SnapshotGeometry | null): WhiteboardPage {
  if (!geometry) {
    return page;
  }

  const sameWidth = page.canvasWidthPx === geometry.canvasWidthPx;

  if (geometry.pdfPlacement === 'unknown') {
    // Keep an existing placement only if it belongs to this frame; one recorded against another
    // width would describe a frame the ink was never drawn in, which is worse than none.
    const keepPlacement =
      page.pdfPlacement !== undefined &&
      Math.abs(page.pdfPlacement.width - geometry.canvasWidthPx) <= PLACEMENT_TOLERANCE_PX;

    if (sameWidth && (keepPlacement || page.pdfPlacement === undefined)) {
      return page;
    }

    const next: WhiteboardPage = { ...page, canvasWidthPx: geometry.canvasWidthPx };

    if (!keepPlacement) {
      delete next.pdfPlacement;
    }

    return next;
  }

  if (geometry.pdfPlacement === 'none') {
    if (sameWidth && page.pdfPlacement === undefined) {
      return page;
    }

    const next: WhiteboardPage = { ...page, canvasWidthPx: geometry.canvasWidthPx };

    // A page that lost its PDF must not keep describing where one sits.
    delete next.pdfPlacement;

    return next;
  }

  if (sameWidth && isSamePdfPlacement(page.pdfPlacement, geometry.pdfPlacement, PLACEMENT_TOLERANCE_PX)) {
    return page;
  }

  return { ...page, canvasWidthPx: geometry.canvasWidthPx, pdfPlacement: geometry.pdfPlacement };
}

/**
 * Where "reset zoom" lands, in SCREEN units: the page filling the width (zoom = frame scale), and
 * — for a PDF page taller than its frame, whose fit starts above the canvas (negative placement y) —
 * scrolled so the page's TOP sits at the top of the view, exactly where a freshly imported page
 * opens. Identity for everything else (blank pages, a page shorter than the frame is already
 * centred, an unknown frame).
 */
export function resolveResetViewport(input: {
  canvasWidth: number;
  page: WhiteboardPage;
  pdfFrame: PdfBackgroundFrame | null;
}): ViewportState {
  const { canvasWidth, page, pdfFrame } = input;
  const geometry = resolveSnapshotGeometry({ canvasWidth, page, pdfFrame });

  if (!geometry) {
    return { offsetX: 0, offsetY: 0, zoom: 1 };
  }

  const zoom = getFrameScale(canvasWidth, geometry.canvasWidthPx);
  const placement = typeof geometry.pdfPlacement === 'object' ? geometry.pdfPlacement : page.pdfPlacement;
  const offsetY = placement && placement.y < 0 ? -placement.y * zoom : 0;

  return { offsetX: 0, offsetY, zoom };
}

export interface SnapshotCapture {
  /** `page` with the geometry record applied (the same object when nothing changed). */
  page: WhiteboardPage;
  /** Frame-relative viewport to persist alongside it. */
  viewportOffsetX: number;
  viewportOffsetY: number;
  viewportZoom: number;
}

/**
 * Everything a snapshot builder needs from the live canvas for one page, in one place: the
 * geometry record and the viewport converted to the units that record is persisted in.
 */
export function captureSnapshotState(input: {
  canvasWidth: number;
  defaultZoom: number;
  page: WhiteboardPage;
  pdfFrame: PdfBackgroundFrame | null;
  viewportTransform: readonly number[] | undefined;
}): SnapshotCapture {
  const { canvasWidth, defaultZoom, page, pdfFrame, viewportTransform } = input;
  const geometry = resolveSnapshotGeometry({ canvasWidth, page, pdfFrame });
  const frameScale = geometry ? getFrameScale(canvasWidth, geometry.canvasWidthPx) : 1;
  const viewport = toFrameViewport(
    {
      offsetX: viewportTransform?.[4] ?? 0,
      offsetY: viewportTransform?.[5] ?? 0,
      zoom: viewportTransform?.[0] ?? defaultZoom,
    },
    frameScale,
  );

  return {
    page: applySnapshotGeometry(page, geometry),
    viewportOffsetX: viewport.offsetX,
    viewportOffsetY: viewport.offsetY,
    viewportZoom: viewport.zoom,
  };
}
