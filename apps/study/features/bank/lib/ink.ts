/**
 * Ink model shared by the solve canvas and the mock-exam runner. Pure geometry lives here so the
 * crop / scale / erase maths can be unit-tested without a DOM; `rasterizeInk` is the only function
 * that touches a canvas.
 */

export interface InkPoint {
  x: number;
  y: number;
  /** 0..1, pressure as the digitizer reported it (0.5 for mice). */
  p: number;
}

export interface InkStroke {
  points: InkPoint[];
  /** CSS colour. */
  color: string;
  /** Base width in CSS px at pressure 0.5. */
  width: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RasterPlan extends Bounds {
  /** Multiplier from ink space to output pixels. */
  scale: number;
  outW: number;
  outH: number;
}

export const MAX_RASTER_PX = 1600;
/** Rendered width = width * (MIN_PRESSURE_GAIN + p * PRESSURE_GAIN) → 0.5p..1.5p of the base. */
const MIN_PRESSURE_GAIN = 0.5;
const PRESSURE_GAIN = 2;

export const strokeWidthFor = (base: number, pressure: number): number =>
  Math.max(0.5, base * (MIN_PRESSURE_GAIN + Math.min(1, Math.max(0, pressure)) * PRESSURE_GAIN * 0.5));

export const isInkEmpty = (strokes: InkStroke[]): boolean => strokes.every((s) => s.points.length === 0);

/** Tight bounds around every point, grown by each stroke's max width and `pad`. Null for empty ink. */
export function inkBounds(strokes: InkStroke[], pad = 24): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stroke of strokes) {
    const half = strokeWidthFor(stroke.width, 1) / 2;

    for (const point of stroke.points) {
      if (point.x - half < minX) minX = point.x - half;
      if (point.y - half < minY) minY = point.y - half;
      if (point.x + half > maxX) maxX = point.x + half;
      if (point.y + half > maxY) maxY = point.y + half;
    }
  }

  if (!Number.isFinite(minX)) return null;

  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/**
 * Chooses the output size: ink is upscaled up to 2× (handwriting reads better for the model at
 * ~2 device px per CSS px) but never beyond `maxPx` on the long side, and never below 1 px.
 */
export function planRaster(bounds: Bounds, maxPx = MAX_RASTER_PX, preferredScale = 2): RasterPlan {
  const w = Math.max(1, bounds.w);
  const h = Math.max(1, bounds.h);
  const fit = maxPx / Math.max(w, h);
  const scale = Math.min(preferredScale, fit);

  return {
    ...bounds,
    w,
    h,
    scale,
    outW: Math.max(1, Math.round(w * scale)),
    outH: Math.max(1, Math.round(h * scale)),
  };
}

const dist2 = (a: InkPoint, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Squared distance from `pt` to the segment a→b. */
function segmentDist2(a: InkPoint, b: InkPoint, pt: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;

  if (len2 === 0) return dist2(a, pt);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));

  return dist2({ x: a.x + t * dx, y: a.y + t * dy, p: 0 }, pt);
}

/** True when the stroke passes within `radius` of `pt`. */
export function strokeHits(stroke: InkStroke, pt: { x: number; y: number }, radius: number): boolean {
  const r2 = (radius + strokeWidthFor(stroke.width, 1) / 2) ** 2;
  const { points } = stroke;

  if (points.length === 1) return dist2(points[0]!, pt) <= r2;

  for (let i = 1; i < points.length; i += 1) {
    if (segmentDist2(points[i - 1]!, points[i]!, pt) <= r2) return true;
  }

  return false;
}

/** Stroke eraser: drops every stroke within `radius` of `pt`. Returns the same array when nothing hit. */
export function eraseAt(strokes: InkStroke[], pt: { x: number; y: number }, radius: number): InkStroke[] {
  const kept = strokes.filter((stroke) => !strokeHits(stroke, pt, radius));

  return kept.length === strokes.length ? strokes : kept;
}

/**
 * Draws one stroke as a chain of quadratic curves through midpoints, width following pressure.
 * Shared by the live canvas and the rasteriser so what you see is what the model gets.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  from = 0,
  transform: (x: number, y: number) => [number, number] = (x, y) => [x, y],
  widthScale = 1,
): void {
  const { points } = stroke;

  if (points.length === 0) return;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (points.length === 1) {
    const [x, y] = transform(points[0]!.x, points[0]!.y);

    ctx.beginPath();
    ctx.arc(x, y, (strokeWidthFor(stroke.width, points[0]!.p) * widthScale) / 2, 0, Math.PI * 2);
    ctx.fill();

    return;
  }

  for (let i = Math.max(1, from); i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const prevPrev = points[i - 2] ?? prev;
    const [sx, sy] = transform((prevPrev.x + prev.x) / 2, (prevPrev.y + prev.y) / 2);
    const [cx, cy] = transform(prev.x, prev.y);
    const [ex, ey] = transform((prev.x + curr.x) / 2, (prev.y + curr.y) / 2);

    ctx.lineWidth = strokeWidthFor(stroke.width, (prev.p + curr.p) / 2) * widthScale;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(cx, cy, ex, ey);
    ctx.stroke();
  }
}

/**
 * Ink → PNG (base64 without the data-URL prefix), cropped to the ink, white background, long side
 * ≤ `maxPx`. Ink colour is forced to black so dark-mode white ink stays legible. Null for empty ink.
 */
export function rasterizeInk(strokes: InkStroke[], maxPx = MAX_RASTER_PX): { b64: string; plan: RasterPlan } | null {
  const bounds = inkBounds(strokes);

  if (!bounds) return null;
  const plan = planRaster(bounds, maxPx);
  const canvas = document.createElement('canvas');

  canvas.width = plan.outW;
  canvas.height = plan.outH;
  const ctx = canvas.getContext('2d');

  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.outW, plan.outH);
  const transform = (x: number, y: number): [number, number] => [(x - plan.x) * plan.scale, (y - plan.y) * plan.scale];

  for (const stroke of strokes) {
    drawStroke(ctx, { ...stroke, color: '#111111' }, 0, transform, plan.scale);
  }
  const dataUrl = canvas.toDataURL('image/png');

  return { b64: dataUrl.slice(dataUrl.indexOf(',') + 1), plan };
}
