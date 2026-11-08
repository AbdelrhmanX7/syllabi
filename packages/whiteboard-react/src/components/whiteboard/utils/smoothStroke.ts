import type { PolyGeometry, Vec } from './shapeRecognition';

/**
 * Hold-to-smooth — the fallback of hold-to-snap (`brushes/shapeSnap.ts`). When the pen rests at the end
 * of a stroke that is NOT a line / triangle / rectangle / ellipse (a curve, a contour, a freehand
 * outline), the stroke is replaced by a smoothed copy of itself: the shaky hand goes, the shape stays.
 *
 * Pure geometry on scene points; `zoom` converts the screen-px tunables (what the eye judges) to scene.
 * Steps: drop the hold's resting tail → resample evenly → Gaussian-smooth (wrapping when the stroke
 * closes on itself, endpoints pinned otherwise) → Douglas–Peucker thin to keep the object light.
 */

export const SMOOTH_THRESHOLDS = {
  /** Smaller than this bbox diagonal (screen px) is a letter or a mark, never smoothed. */
  minDiagonalPx: 40,
  /** Shorter than this path (screen px) is too little ink to have a "shape". */
  minLengthPx: 60,
  /** Resample spacing, screen px. */
  spacingPx: 3,
  /** Smoothing strength: sigma = diagonal × this, clamped to [minSigmaPx, maxSigmaPx] (screen px). */
  sigmaRatio: 0.02,
  minSigmaPx: 3,
  maxSigmaPx: 10,
  /** Closed when the end returns within this fraction of the diagonal (or minClosePx) of the start. */
  closeGapRatio: 0.12,
  minClosePx: 14,
  /** Points of the resting tail within this radius of the last point are dropped (screen px). */
  tailRadiusPx: 8,
  /** Douglas–Peucker tolerance of the output, screen px. */
  simplifyPx: 0.35,
  maxPoints: 600,
} as const;

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(points: readonly Vec[]): number {
  let length = 0;

  for (let i = 1; i < points.length; i += 1) length += dist(points[i - 1], points[i]);

  return length;
}

function resampleBySpacing(points: readonly Vec[], spacing: number): Vec[] {
  const out: Vec[] = [{ ...points[0] }];
  let carry = 0;

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const segment = dist(a, b);

    if (segment === 0) continue;
    let t = spacing - carry;

    while (t <= segment) {
      out.push({ x: a.x + ((b.x - a.x) * t) / segment, y: a.y + ((b.y - a.y) * t) / segment });
      t += spacing;
    }
    carry = segment - (t - spacing);
  }

  const last = points[points.length - 1];

  if (dist(out[out.length - 1], last) > spacing * 0.25) out.push({ ...last });

  return out;
}

function gaussianSmooth(points: readonly Vec[], sigma: number, closed: boolean): Vec[] {
  const n = points.length;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const weights: number[] = [];

  for (let k = -radius; k <= radius; k += 1) weights.push(Math.exp(-(k * k) / (2 * sigma * sigma)));

  const out: Vec[] = [];

  for (let i = 0; i < n; i += 1) {
    let x = 0;
    let y = 0;
    let total = 0;

    for (let k = -radius; k <= radius; k += 1) {
      let j = i + k;

      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      // Open stroke: a symmetric window near the ends, so the end does not get dragged inward.
      if (!closed && (i - Math.abs(k) < 0 || i + Math.abs(k) >= n)) continue;
      const w = weights[k + radius];

      x += points[j].x * w;
      y += points[j].y * w;
      total += w;
    }
    out.push({ x: x / total, y: y / total });
  }

  if (!closed) {
    out[0] = { ...points[0] };
    out[n - 1] = { ...points[n - 1] };
  }

  return out;
}

function simplify(points: readonly Vec[], tolerance: number): Vec[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  keep[0] = 1;
  keep[points.length - 1] = 1;

  while (stack.length) {
    const [start, end] = stack.pop()!;
    const a = points[start];
    const b = points[end];
    const length = dist(a, b);
    let worst = -1;
    let worstAt = -1;

    for (let i = start + 1; i < end; i += 1) {
      const p = points[i];
      const d =
        length === 0 ? dist(p, a) : Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length;

      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }

    if (worst > tolerance && worstAt > 0) {
      keep[worstAt] = 1;
      stack.push([start, worstAt], [worstAt, end]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}

/**
 * The smoothed stroke, or null when it is too small / too short to smooth (a letter, a dot) — the
 * caller then leaves the ink as it is.
 */
export function smoothStroke(input: readonly Vec[], zoom: number): PolyGeometry | null {
  const T = SMOOTH_THRESHOLDS;
  const toScene = (px: number) => px / Math.max(zoom, 1e-6);

  if (input.length < 4) return null;

  // The resting tail: every sample of the hold sits around the last point.
  let end = input.length - 1;
  const last = input[end];

  while (end > 1 && dist(input[end - 1], last) <= toScene(T.tailRadiusPx)) end -= 1;
  const points = [...input.slice(0, end), last];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  const diagonal = Math.hypot(maxX - minX, maxY - minY);

  if (diagonal < toScene(T.minDiagonalPx) || pathLength(points) < toScene(T.minLengthPx)) return null;

  const closed = dist(points[0], points[points.length - 1]) <= Math.max(diagonal * T.closeGapRatio, toScene(T.minClosePx));
  const spacing = toScene(T.spacingPx);
  let even = resampleBySpacing(points, spacing);

  // A closed stroke's last sample duplicates its first once wrapped.
  if (closed && even.length > 2 && dist(even[0], even[even.length - 1]) < spacing) even = even.slice(0, -1);
  if (even.length < 4) return null;

  const sigmaPx = Math.min(T.maxSigmaPx, Math.max(T.minSigmaPx, diagonal * zoom * T.sigmaRatio));
  const smoothed = gaussianSmooth(even, sigmaPx / T.spacingPx, closed);
  let thin = simplify(smoothed, toScene(T.simplifyPx));

  if (thin.length > T.maxPoints) {
    const step = thin.length / T.maxPoints;

    thin = Array.from({ length: T.maxPoints }, (_, i) => thin[Math.floor(i * step)]);
  }

  return { type: 'poly', points: thin, closed };
}
