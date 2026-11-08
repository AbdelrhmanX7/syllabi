/**
 * The vertical notebook page (`WhiteboardEditor.verticalNotebook`): a board page with no PDF behind it
 * shown as a fixed-width sheet that scrolls down, instead of an infinite canvas.
 *
 * FRAME. The page is `frameWidth` scene px wide, starting at scene x = 0. The width is chosen once per
 * page and then kept: a page that already records `canvasWidthPx` (the frame its ink was written in) is
 * that wide on every device; a page without a record takes the live pane width, capped at
 * {@link NOTEBOOK_PAGE_MAX_WIDTH_PX}, and records it on its first save. Ink is never moved: the page rect
 * only grows to cover ink already outside the frame (an older free board), so nothing is ever hidden.
 *
 * SCALE. The page is shown `min(pane, max(pageWidth, cap))` CSS px wide. On the device and pane the
 * page was written in that is zoom 1; a narrower pane shows the same page smaller and a wider one
 * centres it with margins (or scales it up, for a page written in a narrow pane), so a stroke sits at
 * the same place on the sheet on every device. That zoom is the floor: zooming out stops there.
 *
 * HEIGHT. Endless paper, like continuous-scroll notebooks: the page runs from the top of the ink (or 0)
 * down to the lowest of one screen, the last ink and the furthest the reader has scrolled
 * (`viewedBottom`), plus {@link NOTEBOOK_PAGE_ROOM_AHEAD} screens of blank paper. As the view nears that
 * bottom ({@link shouldGrowNotebookPage}) the editor records the new furthest point and the page grows
 * again, so scrolling down never hits a wall — with or without ink. The page only ever grows under the
 * view (the furthest point is a high-water mark). Pure functions; scene coordinates throughout.
 */

import { clampViewportTransform, clampZoom, refitViewportToConstraints } from './viewportConstraints';

import type { SceneRect, ViewportConstraints, ViewportTransform6 } from './viewportConstraints';

/** A new page is never wider than this (CSS px at zoom 1); a wider pane centres it with margins. */
export const NOTEBOOK_PAGE_MAX_WIDTH_PX = 1150;
/**
 * Below the last ink / the furthest the view has reached, how many screens (at the fit zoom) of blank
 * paper the page keeps ready to scroll into.
 */
export const NOTEBOOK_PAGE_ROOM_AHEAD = 2;
/** Grow the page once the view's bottom is within this many screens of the page bottom. */
export const NOTEBOOK_PAGE_GROW_WITHIN = 1.5;
/** What shows beside the page on a pane wider than it. */
export const NOTEBOOK_MARGIN_COLOR = '#e9ebee';
export const NOTEBOOK_EDGE_COLOR = '#d5d8dd';

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The page's frame width: its recorded frame, else the live pane width capped. `null` before layout. */
export function resolveNotebookFrameWidth(recordedWidth: number | undefined, canvasWidth: number): number | null {
  if (isPositiveFinite(recordedWidth)) return recordedWidth;
  if (!isPositiveFinite(canvasWidth)) return null;

  return Math.min(canvasWidth, NOTEBOOK_PAGE_MAX_WIDTH_PX);
}

export interface NotebookLayout {
  /** The viewport cage: the page rect, the fit zoom as the floor. */
  constraints: ViewportConstraints;
  /** The page's horizontal extent in scene px (what the paper is drawn across). */
  pageLeft: number;
  pageRight: number;
}

/**
 * The page rect and viewport cage for a canvas of the given CSS size. `ink` is the scene bounding box
 * of everything on the page (null when empty). `null` when the canvas has no size yet.
 */
export function resolveNotebookLayout(input: {
  canvasHeight: number;
  canvasWidth: number;
  frameWidth: number;
  ink: SceneRect | null;
  maxZoom: number;
  /** The lowest scene y the view's bottom edge has reached on this page (a high-water mark). */
  viewedBottom?: number | null;
  /** Fill the pane's width at the fit zoom (no {@link NOTEBOOK_PAGE_MAX_WIDTH_PX} cap, no side margins). */
  fillWidth?: boolean;
}): NotebookLayout | null {
  const { canvasHeight, canvasWidth, frameWidth, ink, maxZoom, viewedBottom, fillWidth = false } = input;

  if (!isPositiveFinite(canvasWidth) || !isPositiveFinite(canvasHeight) || !isPositiveFinite(frameWidth)) {
    return null;
  }

  const hasInk = ink !== null && [ink.left, ink.top, ink.right, ink.bottom].every(Number.isFinite);
  const pageLeft = hasInk ? Math.min(0, ink.left) : 0;
  const pageRight = hasInk ? Math.max(frameWidth, ink.right) : frameWidth;
  const pageWidth = pageRight - pageLeft;
  const displayWidth = fillWidth ? canvasWidth : Math.min(canvasWidth, Math.max(pageWidth, NOTEBOOK_PAGE_MAX_WIDTH_PX));
  const minZoom = displayWidth / pageWidth;
  const screenInScene = canvasHeight / minZoom;
  const top = hasInk ? Math.min(0, ink.top) : 0;
  const reached = Math.max(
    top + screenInScene,
    hasInk ? ink.bottom : top,
    typeof viewedBottom === 'number' && Number.isFinite(viewedBottom) ? viewedBottom : top,
  );
  const bottom = reached + screenInScene * NOTEBOOK_PAGE_ROOM_AHEAD;

  return {
    constraints: {
      maxZoom: Math.max(maxZoom, minZoom),
      minZoom,
      scene: { bottom, left: pageLeft, right: pageRight, top },
    },
    pageLeft,
    pageRight,
  };
}

/** The scene y at the bottom edge of the view (`canvasHeight` CSS px tall). */
export function notebookViewBottom(viewportTransform: readonly number[] | undefined, canvasHeight: number): number {
  const zoom = viewportTransform?.[3] || 1;
  const offsetY = viewportTransform?.[5] ?? 0;

  return (canvasHeight - offsetY) / zoom;
}

/**
 * Whether the page should grow: the view's bottom (`viewBottom`, scene y) is within
 * {@link NOTEBOOK_PAGE_GROW_WITHIN} screens (at the fit zoom) of the page bottom.
 */
export function shouldGrowNotebookPage(constraints: ViewportConstraints, viewBottom: number, canvasHeight: number): boolean {
  if (!Number.isFinite(viewBottom) || !isPositiveFinite(canvasHeight) || !isPositiveFinite(constraints.minZoom)) {
    return false;
  }

  const screenInScene = canvasHeight / constraints.minZoom;

  return constraints.scene.bottom - viewBottom < screenInScene * NOTEBOOK_PAGE_GROW_WITHIN;
}

/**
 * The page at its fit zoom, keeping the scene row at the top of the view where it is (the reading
 * position survives a resize, a reopen on another device, «reset zoom»).
 */
export function fitNotebookViewport(
  viewportTransform: readonly number[] | undefined,
  constraints: ViewportConstraints,
  canvasWidth: number,
  canvasHeight: number,
): ViewportTransform6 {
  return refitViewportToConstraints(viewportTransform, null, constraints, canvasWidth, canvasHeight);
}

/**
 * The viewport after the cage changed (a resize, the page growing): a view that sat at the old fit
 * zoom follows to the new fit zoom (the page keeps filling its width); a zoomed-in view keeps its
 * zoom and is only pulled back inside.
 */
export function refitNotebookViewport(
  viewportTransform: readonly number[] | undefined,
  previous: ViewportConstraints | null,
  next: ViewportConstraints,
  canvasWidth: number,
  canvasHeight: number,
): ViewportTransform6 {
  return refitViewportToConstraints(viewportTransform, previous, next, canvasWidth, canvasHeight);
}

/**
 * VIEW MEMORY. Where the reader left a page — remembered per device (localStorage, keyed by board and
 * page) so reopening it comes back at the same zoom and scroll instead of the fit width. The zoom is
 * stored as a multiple of the fit zoom, so a page left at «fit» reopens at fit on any pane width.
 */
export const NOTEBOOK_VIEW_STORAGE_PREFIX = 'wb-notebook-view:';

export interface NotebookView {
  /** Zoom ÷ the page's fit zoom (1 = fit width). */
  zoomRatio: number;
  /** Scene point at the view's top-left corner. */
  left: number;
  top: number;
}

export function notebookViewStorageKey(boardId: string, pageId: string): string {
  return `${NOTEBOOK_VIEW_STORAGE_PREFIX}${boardId}:${pageId}`;
}

/** The view to remember for this viewport. Null when the viewport is unusable. */
export function captureNotebookView(
  viewportTransform: readonly number[] | undefined,
  constraints: ViewportConstraints,
): NotebookView | null {
  const zoom = viewportTransform?.[0];
  const offsetX = viewportTransform?.[4];
  const offsetY = viewportTransform?.[5];

  if (!isPositiveFinite(zoom) || !isPositiveFinite(constraints.minZoom)) return null;
  if (typeof offsetX !== 'number' || typeof offsetY !== 'number') return null;
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null;

  const round = (value: number) => Math.round(value * 1000) / 1000;

  return { left: round(-offsetX / zoom), top: round(-offsetY / zoom), zoomRatio: round(zoom / constraints.minZoom) };
}

/** A stored view read back (JSON string or parsed); null for anything malformed. */
export function parseNotebookView(raw: unknown): NotebookView | null {
  let value = raw;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== 'object') return null;

  const { left, top, zoomRatio } = value as Partial<NotebookView>;

  if (!isPositiveFinite(zoomRatio)) return null;
  if (typeof left !== 'number' || !Number.isFinite(left) || typeof top !== 'number' || !Number.isFinite(top)) {
    return null;
  }

  return { left, top, zoomRatio };
}

/** The viewport for a remembered view: its zoom (kept within the cage's range) and top-left, clamped inside. */
export function restoreNotebookViewport(
  view: NotebookView,
  constraints: ViewportConstraints,
  canvasWidth: number,
  canvasHeight: number,
): ViewportTransform6 {
  const zoom = clampZoom(view.zoomRatio * constraints.minZoom, constraints);

  return clampViewportTransform(
    [zoom, 0, 0, zoom, -view.left * zoom, -view.top * zoom],
    constraints,
    canvasWidth,
    canvasHeight,
  );
}

/** Union of scene boxes (`getBoundingRect()` results); null for none. */
export function unionInkBounds(
  boxes: ReadonlyArray<{ left: number; top: number; width: number; height: number }>,
): SceneRect | null {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const box of boxes) {
    if (![box.left, box.top, box.width, box.height].every(Number.isFinite)) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.left + box.width);
    bottom = Math.max(bottom, box.top + box.height);
  }

  return Number.isFinite(left) ? { bottom, left, right, top } : null;
}

/**
 * Paint the margins beside the page: everything left of `pageLeft` and right of `pageRight` (scene px)
 * in the margin colour, with a hairline at each page edge. Drawn over the paper pattern, under the ink.
 * `cssWidth`/`cssHeight` are the target's CSS size; `pixelRatio` its device px per CSS px.
 */
export function drawNotebookMargins(
  ctx: CanvasRenderingContext2D,
  page: { pageLeft: number; pageRight: number },
  viewportTransform: readonly number[] | undefined,
  pixelRatio: number,
  cssWidth: number,
  cssHeight: number,
): void {
  const zoom = viewportTransform?.[0] || 1;
  const offsetX = viewportTransform?.[4] ?? 0;
  const ratio = pixelRatio > 0 ? pixelRatio : 1;
  const left = Math.max(0, page.pageLeft * zoom + offsetX);
  const right = Math.min(cssWidth, page.pageRight * zoom + offsetX);

  if (left <= 0 && right >= cssWidth) return;

  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = NOTEBOOK_MARGIN_COLOR;
  if (left > 0) ctx.fillRect(0, 0, left, cssHeight);
  if (right < cssWidth) ctx.fillRect(right, 0, cssWidth - right, cssHeight);
  ctx.fillStyle = NOTEBOOK_EDGE_COLOR;
  if (left > 0) ctx.fillRect(left - 1, 0, 1, cssHeight);
  if (right < cssWidth) ctx.fillRect(right, 0, 1, cssHeight);
  ctx.restore();
}
