/**
 * Overscan backdrop — geometry.
 *
 * ## The problem it solves
 *
 * A live pan/pinch/fling is previewed by CSS-transforming the canvas-layer wrapper (see the
 * zoom-preview block in hooks/useWhiteboardCanvas). The two scene canvases inside it — the background
 * (pattern + PDF page + pinned images) and the Fabric ink canvas — are exactly viewport-sized, and
 * Fabric additionally skips every object outside the viewport (`skipOffscreen`). So whatever the
 * gesture drags into view was never rasterised: the teacher sees the container's plain white until the
 * gesture settles and the commit re-renders. "The board is hidden outside the screen."
 *
 * ## The fix
 *
 * A third, LOW-RESOLUTION canvas sits BEHIND both crisp layers inside the same transformed wrapper. It
 * holds the same content (background + ink) over the viewport expanded by `overscan` viewports on each
 * side, rendered at a fraction of a CSS pixel and softened, so a revealed region shows the real board —
 * blurred — instead of nothing. Inside the viewport the opaque background canvas covers it entirely.
 *
 * Everything in this file is pure (no DOM, no Fabric) so the clamping is unit-tested.
 */

/** A Fabric viewport transform: [a, b, c, d, e, f]. Only uniform scale + translation are used here. */
export type ViewportTransformLike = readonly number[] | undefined | null;

export interface BackdropBudget {
  /** Viewports of overscan on EACH side (1 → a 3×3-viewport area). */
  overscan: number;
  /** Backdrop pixels per CSS pixel (no DPR — this layer is deliberately soft). */
  quality: number;
  /** Lowest `quality` before the overscan itself is shrunk to fit the pixel budget. */
  minQuality: number;
  /** Hard ceiling on backdrop pixels (width × height) PER LAYER — there are two (background + ink).
   *  One RGBA pixel = 4 bytes. */
  maxPixels: number;
  /** Largest edge, in pixels — stays well inside every WebView's canvas size limit. */
  maxEdge: number;
}

export const DEFAULT_BACKDROP_BUDGET: BackdropBudget = {
  maxEdge: 4096,
  maxPixels: 1_600_000,
  minQuality: 0.2,
  overscan: 1,
  quality: 0.4,
};

/**
 * The budget for this device. `deviceMemoryGb` is `navigator.deviceMemory` (Chrome/WebView only; it is
 * capped at 8 and rounded, and absent elsewhere → treated as a capable device).
 */
export function resolveBackdropBudget(deviceMemoryGb?: number | null): BackdropBudget {
  if (typeof deviceMemoryGb === 'number' && Number.isFinite(deviceMemoryGb) && deviceMemoryGb > 0) {
    if (deviceMemoryGb <= 2) {
      return { ...DEFAULT_BACKDROP_BUDGET, maxPixels: 550_000, quality: 0.33 };
    }

    if (deviceMemoryGb <= 4) {
      return { ...DEFAULT_BACKDROP_BUDGET, maxPixels: 1_000_000, quality: 0.33 };
    }
  }

  return DEFAULT_BACKDROP_BUDGET;
}

/**
 * One backdrop raster: which part of the scene it holds and at what resolution, captured against the
 * viewport transform it was planned for.
 */
export interface BackdropPlan {
  /** The covered rect in SCREEN px of the planning viewport (left/top are ≤ 0 when overscanning). */
  screenLeft: number;
  screenTop: number;
  screenWidth: number;
  screenHeight: number;
  /** Backdrop pixels per CSS pixel. */
  ratio: number;
  pixelWidth: number;
  pixelHeight: number;
  /** The overscan actually used (may be below the budget's when the pixel cap forced it). */
  overscan: number;
  /** The planning viewport: uniform zoom + translation. */
  zoom: number;
  offsetX: number;
  offsetY: number;
  /** The covered rect in SCENE units. */
  sceneLeft: number;
  sceneTop: number;
  sceneWidth: number;
  sceneHeight: number;
}

const readZoom = (vpt: ViewportTransformLike): number => {
  const zoom = Number(vpt?.[0]);

  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
};

const readOffset = (vpt: ViewportTransformLike, index: 4 | 5): number => {
  const value = Number(vpt?.[index]);

  return Number.isFinite(value) ? value : 0;
};

/** The ratio that fits a w×h CSS-px area into the pixel and edge caps (never above `ceiling`). */
function fitRatio(width: number, height: number, ceiling: number, budget: BackdropBudget): number {
  return Math.min(
    ceiling,
    Math.sqrt(budget.maxPixels / (width * height)),
    budget.maxEdge / width,
    budget.maxEdge / height,
  );
}

/**
 * Plan a backdrop for a `viewWidth × viewHeight` viewport under `vpt`.
 *
 * Clamping order, cheapest visual loss first:
 *  1. lower the resolution from `quality` toward `minQuality` until the area fits the pixel/edge caps;
 *  2. still too big at `minQuality` → shrink the overscan (in 0.1-viewport steps) at `minQuality`;
 *  3. even overscan 0 does not fit (absurd viewport) → overscan 0 at whatever ratio fits.
 *
 * Returns null for a degenerate (zero-sized) viewport.
 */
export function planBackdrop(
  viewWidth: number,
  viewHeight: number,
  vpt: ViewportTransformLike,
  budget: BackdropBudget = DEFAULT_BACKDROP_BUDGET,
): BackdropPlan | null {
  if (!(viewWidth > 0) || !(viewHeight > 0)) return null;

  const areaFor = (overscan: number) => ({
    height: viewHeight * (1 + 2 * overscan),
    width: viewWidth * (1 + 2 * overscan),
  });

  let overscan = Math.max(0, budget.overscan);
  let { height, width } = areaFor(overscan);
  let ratio = fitRatio(width, height, budget.quality, budget);

  if (ratio < budget.minQuality) {
    ratio = budget.minQuality;

    while (overscan > 0) {
      overscan = Math.max(0, Math.round((overscan - 0.1) * 10) / 10);
      ({ height, width } = areaFor(overscan));

      if (fitRatio(width, height, budget.minQuality, budget) >= budget.minQuality) break;
    }

    ratio = fitRatio(width, height, budget.minQuality, budget);
  }

  const zoom = readZoom(vpt);
  const offsetX = readOffset(vpt, 4);
  const offsetY = readOffset(vpt, 5);
  const screenLeft = -overscan * viewWidth;
  const screenTop = -overscan * viewHeight;

  return {
    offsetX,
    offsetY,
    overscan,
    pixelHeight: Math.max(1, Math.floor(height * ratio)),
    pixelWidth: Math.max(1, Math.floor(width * ratio)),
    ratio,
    sceneHeight: height / zoom,
    sceneLeft: (screenLeft - offsetX) / zoom,
    sceneTop: (screenTop - offsetY) / zoom,
    sceneWidth: width / zoom,
    screenHeight: height,
    screenLeft,
    screenTop,
    screenWidth: width,
    zoom,
  };
}

/**
 * The viewport transform to paint the backdrop with, in CSS px of the backdrop's own area (the caller
 * folds `plan.ratio` in as the pixel ratio, exactly like the live layers fold in the DPR): the planning
 * viewport shifted so the overscan's top-left corner lands on the backdrop's origin.
 */
export function backdropPaintTransform(plan: BackdropPlan): [number, number, number, number, number, number] {
  return [plan.zoom, 0, 0, plan.zoom, plan.offsetX - plan.screenLeft, plan.offsetY - plan.screenTop];
}

export interface BackdropPlacement {
  /** CSS translate of the backdrop element's top-left corner, in container px. */
  x: number;
  y: number;
  /** CSS scale from backdrop pixels to container px. */
  scale: number;
}

/** Where a planned backdrop sits under the CURRENT viewport transform (it is scene-anchored). */
export function placeBackdrop(plan: BackdropPlan, vpt: ViewportTransformLike): BackdropPlacement {
  const zoom = readZoom(vpt);

  return {
    scale: zoom / (plan.zoom * plan.ratio),
    x: readOffset(vpt, 4) + zoom * plan.sceneLeft,
    y: readOffset(vpt, 5) + zoom * plan.sceneTop,
  };
}

/**
 * Whether the backdrop should be re-rendered for the current viewport (content changes are tracked by
 * the caller). True when there is none, when the zoom drifted so far that it is either too blurry or
 * wastefully sharp, or when it no longer covers the viewport plus `marginViewports` on each side —
 * i.e. the next gesture could reveal past its edge.
 */
export function backdropNeedsRefresh(
  plan: BackdropPlan | null,
  viewWidth: number,
  viewHeight: number,
  vpt: ViewportTransformLike,
  marginViewports = 0.5,
): boolean {
  if (!plan) return true;

  const zoom = readZoom(vpt);
  const zoomRatio = zoom / plan.zoom;

  if (zoomRatio > 1.5 || zoomRatio < 1 / 1.5) return true;

  // The margin can never exceed what the plan could hold (a pixel-capped plan with overscan 0.3 must
  // not demand 0.5 forever and refresh on every commit).
  const margin = Math.min(marginViewports, plan.overscan / 2);
  const left = (-margin * viewWidth - readOffset(vpt, 4)) / zoom;
  const top = (-margin * viewHeight - readOffset(vpt, 5)) / zoom;
  const right = ((1 + margin) * viewWidth - readOffset(vpt, 4)) / zoom;
  const bottom = ((1 + margin) * viewHeight - readOffset(vpt, 5)) / zoom;
  // Half a CSS px of slack so float noise never forces a refresh.
  const eps = 0.5 / zoom;

  return (
    left < plan.sceneLeft - eps ||
    top < plan.sceneTop - eps ||
    right > plan.sceneLeft + plan.sceneWidth + eps ||
    bottom > plan.sceneTop + plan.sceneHeight + eps
  );
}

/** Scene-space axis-aligned rect test used to cull ink before rendering it into the backdrop. */
export function sceneRectIntersectsPlan(
  plan: BackdropPlan,
  rect: { left: number; top: number; width: number; height: number },
): boolean {
  return (
    rect.left <= plan.sceneLeft + plan.sceneWidth &&
    rect.top <= plan.sceneTop + plan.sceneHeight &&
    rect.left + rect.width >= plan.sceneLeft &&
    rect.top + rect.height >= plan.sceneTop
  );
}

export interface BackdropPatternTile {
  /** Integer tile edge in pixels. */
  tilePx: number;
  /** Pattern matrix (backdrop px): scale the tile to the true spacing, origin at scene (0,0). */
  scale: number;
  translateX: number;
  translateY: number;
}

/**
 * The repeating tile for a grid/lined/dotted pattern of `spacing` scene units. The live layer strokes
 * one path per line (and one arc per dot), which at a 3×3-viewport overscan and minimum zoom is hundreds
 * of thousands of arcs; a single pattern fill costs the same at any density. Null when a cell would be
 * under `minCellPx` backdrop pixels — after the blur that is just a flat tint, so the plain board
 * colour is drawn instead.
 */
export function backdropPatternTile(plan: BackdropPlan, spacing: number, minCellPx = 3): BackdropPatternTile | null {
  const cellPx = spacing * plan.zoom * plan.ratio;

  if (!(cellPx >= minCellPx)) return null;

  const tilePx = Math.max(1, Math.round(cellPx));
  const [, , , , translateX, translateY] = backdropPaintTransform(plan);

  return {
    scale: cellPx / tilePx,
    tilePx,
    translateX: translateX * plan.ratio,
    translateY: translateY * plan.ratio,
  };
}
