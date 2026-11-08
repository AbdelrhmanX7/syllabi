import type { SceneRect, ScenePoint } from './types';

/**
 * Lasso geometry — pure, so the crop maths is unit-tested without a canvas.
 *
 * Coordinates: SCREEN = CSS px relative to the canvas element's top-left; SCENE = Fabric's own
 * space (what object `left/top` live in). The board's viewport is a pure scale+translate
 * `[z, 0, 0, z, tx, ty]`, so screen = scene·z + t.
 */

export type ViewportTransform = readonly [number, number, number, number, number, number] | readonly number[];

export function screenToScene(point: ScenePoint, vpt: ViewportTransform): ScenePoint {
  const a = vpt[0] || 1;
  const d = vpt[3] || 1;

  return { x: (point.x - (vpt[4] ?? 0)) / a, y: (point.y - (vpt[5] ?? 0)) / d };
}

export function sceneToScreen(point: ScenePoint, vpt: ViewportTransform): ScenePoint {
  return { x: point.x * (vpt[0] || 1) + (vpt[4] ?? 0), y: point.y * (vpt[3] || 1) + (vpt[5] ?? 0) };
}

export function boundsOf(points: ScenePoint[]): SceneRect {
  if (points.length === 0) return { left: 0, top: 0, width: 0, height: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const { x, y } of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

/** Shoelace area (absolute). */
export function polygonArea(points: ScenePoint[]): number {
  let sum = 0;

  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;

    sum += a.x * b.y - b.x * a.y;
  }

  return Math.abs(sum) / 2;
}

/** Even-odd ray cast. */
export function pointInPolygon(point: ScenePoint, polygon: ScenePoint[]): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;

    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-12) + a.x) {
      inside = !inside;
    }
  }

  return inside;
}

/** Drops points closer than `minDistance` to the previous kept point (pointer events are dense). */
export function simplifyPath(points: ScenePoint[], minDistance = 2): ScenePoint[] {
  if (points.length <= 2) return points.slice();

  const kept: ScenePoint[] = [points[0]!];
  const minSq = minDistance * minDistance;

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    const last = kept[kept.length - 1]!;

    if ((point.x - last.x) ** 2 + (point.y - last.y) ** 2 >= minSq) kept.push(point);
  }

  const tail = points[points.length - 1]!;

  if (kept[kept.length - 1] !== tail) kept.push(tail);

  return kept;
}

export function rectToPolygon(rect: SceneRect): ScenePoint[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.left + rect.width, y: rect.top },
    { x: rect.left + rect.width, y: rect.top + rect.height },
    { x: rect.left, y: rect.top + rect.height },
  ];
}

export type LassoShape = { kind: 'polygon'; points: ScenePoint[] } | { kind: 'rect'; rect: SceneRect };

/**
 * Closes a finished lasso gesture into a shape.
 *  - too small (either side < `minSize` screen px) → null: a tap, not a selection;
 *  - `mode: 'rect'`, or a stroke that encloses almost nothing (a diagonal swipe — area under 12% of
 *    its bounding box) → the bounding rectangle, which is how a mouse user drags out a region;
 *  - otherwise the freehand polygon.
 */
export function finishLasso(
  rawPoints: ScenePoint[],
  { mode = 'free', minSize = 14 }: { mode?: 'free' | 'rect'; minSize?: number } = {},
): LassoShape | null {
  const points = simplifyPath(rawPoints, 1.5);
  const bounds = boundsOf(points);

  if (points.length < 2 || bounds.width < minSize || bounds.height < minSize) return null;

  if (mode === 'rect' || points.length < 4) return { kind: 'rect', rect: bounds };

  const boxArea = bounds.width * bounds.height;

  if (boxArea <= 0 || polygonArea(points) / boxArea < 0.12) return { kind: 'rect', rect: bounds };

  return { kind: 'polygon', points };
}

export function lassoPolygon(shape: LassoShape): ScenePoint[] {
  return shape.kind === 'rect' ? rectToPolygon(shape.rect) : shape.points;
}

export interface RegionRasterPlan {
  /** Scene rectangle to render (padded, whole scene units). */
  region: SceneRect;
  /** Output pixels per scene unit. */
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * How big to rasterise a scene region. The image must be sharper than the screen it was circled on
 * (the model reads small handwriting and exponents): at least `minScreenFactor` × what the teacher
 * sees — on-screen size is `zoom` px per scene unit — and at least the device pixel ratio, but never
 * past `maxEdge` px on the long side (upload size, model input limits).
 */
export function planRegionRaster(
  bounds: SceneRect,
  {
    zoom = 1,
    devicePixelRatio = 1,
    minScreenFactor = 1.5,
    maxEdge = 2048,
    paddingScreenPx = 6,
  }: { zoom?: number; devicePixelRatio?: number; minScreenFactor?: number; maxEdge?: number; paddingScreenPx?: number } = {},
): RegionRasterPlan {
  const safeZoom = zoom > 0 ? zoom : 1;
  const pad = paddingScreenPx / safeZoom;
  const left = Math.floor(bounds.left - pad);
  const top = Math.floor(bounds.top - pad);
  const right = Math.ceil(bounds.left + bounds.width + pad);
  const bottom = Math.ceil(bounds.top + bounds.height + pad);
  const region = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  const wanted = safeZoom * Math.max(minScreenFactor, devicePixelRatio || 1);
  const longest = Math.max(region.width, region.height);
  const scale = Math.max(0.05, Math.min(wanted, maxEdge / longest));

  return {
    region,
    scale,
    pixelWidth: Math.max(1, Math.round(region.width * scale)),
    pixelHeight: Math.max(1, Math.round(region.height * scale)),
  };
}

/** Scene polygon → pixel coordinates of the rendered region image. */
export function polygonToPixels(polygon: ScenePoint[], plan: Pick<RegionRasterPlan, 'region' | 'scale'>): ScenePoint[] {
  return polygon.map(({ x, y }) => ({
    x: (x - plan.region.left) * plan.scale,
    y: (y - plan.region.top) * plan.scale,
  }));
}

/**
 * Whitens every pixel OUTSIDE the polygon in an RGBA buffer (the lasso crop). The live path uses a
 * canvas even-odd fill — this is the reference implementation the tests pin it against, and the
 * fallback where a 2D context cannot path-fill.
 */
export function maskOutsidePolygon(data: Uint8ClampedArray, width: number, height: number, polygon: ScenePoint[]): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!pointInPolygon({ x: x + 0.5, y: y + 0.5 }, polygon)) {
        const offset = (y * width + x) * 4;

        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
        data[offset + 3] = 255;
      }
    }
  }
}

/**
 * Where a panel / inserted answer goes beside a selection, in screen px: the side with room (the
 * END side first — left in RTL), else below, else on top of the selection's corner. Clamped inside
 * the container.
 */
export function placeBeside(
  anchor: SceneRect,
  size: { width: number; height: number },
  container: { width: number; height: number },
  gap = 12,
): { left: number; top: number } {
  const clampTop = (top: number) => Math.max(8, Math.min(top, container.height - size.height - 8));
  const clampLeft = (left: number) => Math.max(8, Math.min(left, container.width - size.width - 8));

  if (anchor.left - gap - size.width >= 8) return { left: anchor.left - gap - size.width, top: clampTop(anchor.top) };

  if (anchor.left + anchor.width + gap + size.width <= container.width - 8) {
    return { left: anchor.left + anchor.width + gap, top: clampTop(anchor.top) };
  }

  if (anchor.top + anchor.height + gap + size.height <= container.height - 8) {
    return { left: clampLeft(anchor.left), top: anchor.top + anchor.height + gap };
  }

  return { left: clampLeft(anchor.left), top: clampTop(anchor.top - size.height - gap) };
}

const intersects = (a: SceneRect, b: SceneRect) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * A spot inside `view` where `size` overlaps none of `occupied`: rows from `minTop` downward, and in
 * each row the centre first, then the right (RTL start) and left edges. Null when the view is full —
 * the caller then accepts an overlap rather than dropping content off-screen.
 */
export function findFreeSpot(
  view: SceneRect,
  size: { width: number; height: number },
  occupied: SceneRect[],
  { minTop = view.top, step = 24, margin = 8 }: { minTop?: number; step?: number; margin?: number } = {},
): { left: number; top: number } | null {
  if (size.width > view.width - margin * 2) return null;

  const centre = view.left + (view.width - size.width) / 2;
  const right = view.left + view.width - size.width - margin;
  const left = view.left + margin;
  const columns = [centre, right, left, (centre + right) / 2, (centre + left) / 2];
  const lastTop = view.top + view.height - size.height - margin;

  for (let top = minTop; top <= Math.max(minTop, lastTop); top += step) {
    for (const column of columns) {
      const candidate = { left: column, top, width: size.width, height: size.height };

      if (!occupied.some((rect) => intersects(rect, candidate))) return { left: column, top };
    }
  }

  return null;
}

/**
 * Where the «Added to the board» notice goes, in layer px, so it never covers what was just inserted: a
 * strip at the bottom (above any bottom chrome) first, else a strip under the top chrome, else
 * whichever of the two overlaps the inserted box less.
 */
export function noticeSpot(
  layerHeight: number,
  insets: { top: number; bottom: number },
  placed: SceneRect | null,
  { height = 44, margin = 12 }: { height?: number; margin?: number } = {},
): { top: number } | { bottom: number } {
  const bottomBand = { start: layerHeight - insets.bottom - margin - height, end: layerHeight - insets.bottom - margin };
  const topBand = { start: insets.top + margin, end: insets.top + margin + height };
  const overlap = (band: { start: number; end: number }) =>
    placed ? Math.max(0, Math.min(band.end, placed.top + placed.height) - Math.max(band.start, placed.top)) : 0;
  const bottomOverlap = overlap(bottomBand);
  const topOverlap = overlap(topBand);

  if (bottomOverlap === 0 || bottomOverlap <= topOverlap) return { bottom: insets.bottom + margin };

  return { top: insets.top + margin };
}

/**
 * Pixel box of everything that is not (near-)white in an RGBA buffer, padded, or null for a blank
 * image. A page snapshot is mostly margin; cropping to the ink makes handwriting several times
 * larger in the pixels a vision model actually looks at.
 */
export function contentPixelBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  { threshold = 240, padding = 24, stride = 2 }: { threshold?: number; padding?: number; stride?: number } = {},
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;

      if (data[offset + 3]! > 16 && (data[offset]! < threshold || data[offset + 1]! < threshold || data[offset + 2]! < threshold)) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);

  return { x, y, width: Math.min(width, maxX + padding + stride) - x, height: Math.min(height, maxY + padding + stride) - y };
}

/**
 * Text lines (and figure-sized bands) of a page image, top to bottom, normalised to 0..1: rows with
 * ink are grouped into bands (gaps shorter than `mergeGap` px close up), each with its horizontal
 * extent. The guest model reads the page through a text transcript and cannot see positions — these
 * boxes are handed to it so the remade layout lands where the original's lines actually are.
 */
export function detectInkLines(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  { threshold = 200, mergeGap = 6, minInk = 2 }: { threshold?: number; mergeGap?: number; minInk?: number } = {},
): Array<{ x: number; y: number; w: number; h: number }> {
  const inkAt = (x: number, y: number) => {
    const o = (y * width + x) * 4;

    return data[o + 3]! > 16 && Math.min(data[o]!, data[o + 1]!, data[o + 2]!) < threshold;
  };
  const bands: Array<{ top: number; bottom: number; left: number; right: number }> = [];
  let current: { top: number; bottom: number; left: number; right: number } | null = null;
  let gap = 0;

  for (let y = 0; y < height; y += 1) {
    let count = 0;
    let left = width;
    let right = -1;

    for (let x = 0; x < width; x += 1) {
      if (inkAt(x, y)) {
        count += 1;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }

    if (count >= minInk) {
      if (current && gap <= mergeGap) {
        current.bottom = y;
        current.left = Math.min(current.left, left);
        current.right = Math.max(current.right, right);
      } else {
        current = { top: y, bottom: y, left, right };
        bands.push(current);
      }

      gap = 0;
    } else {
      gap += 1;
    }
  }

  return bands
    .filter((band) => band.bottom - band.top >= 2)
    .map((band) => ({
      x: band.left / width,
      y: band.top / height,
      w: (band.right - band.left + 1) / width,
      h: (band.bottom - band.top + 1) / height,
    }));
}
