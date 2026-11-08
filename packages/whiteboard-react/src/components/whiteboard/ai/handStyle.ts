import { Point, util } from 'fabric';

import type { FabricObject, Path } from 'fabric';

/**
 * «Match my handwriting» — the teacher's hand as four numbers, read from the ink already on the board: slant,
 * stroke width, letter size and colour. Plain statistics over the pen strokes (no model): the
 * length-weighted median lean of the near-vertical segments, the median stroke width, the median
 * height of the letter-sized strokes, the most used colour. Too little ink → null, and the answer is
 * written in the default hand.
 */

export interface InkSample {
  /** Polyline in scene coordinates. */
  points: Array<{ x: number; y: number }>;
  width: number;
  color: string;
}

export interface HandStyle {
  /** Lean of the up-strokes in degrees; positive = the top leans right. */
  slantDeg: number;
  /** Median pen width, scene units. */
  strokeWidth: number;
  /** Median height of a letter-sized stroke, scene units. */
  letterHeight: number;
  color: string;
  samples: number;
}

export const MIN_HAND_SAMPLES = 8;
const MAX_SLANT = 15;

const median = (values: number[]): number => {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;

  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

function weightedMedian(pairs: Array<{ value: number; weight: number }>): number {
  if (pairs.length === 0) return 0;

  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, pair) => sum + pair.weight, 0);
  let running = 0;

  for (const pair of sorted) {
    running += pair.weight;

    if (running >= total / 2) return pair.value;
  }

  return sorted[sorted.length - 1]!.value;
}

export function estimateHandStyle(samples: InkSample[]): HandStyle | null {
  const usable = samples.filter((sample) => sample.points.length >= 2);

  if (usable.length < MIN_HAND_SAMPLES) return null;

  const heights = usable.map((sample) => {
    const ys = sample.points.map((point) => point.y);

    return Math.max(...ys) - Math.min(...ys);
  });
  const typical = median(heights);
  // Underlines, frames and arrows are not letters: keep strokes no taller than 3× the typical one.
  const isLetter = (height: number) => height > 0 && height <= typical * 3;
  const letterHeights = heights.filter(isLetter);
  const lean: Array<{ value: number; weight: number }> = [];

  // The lean is read from letters only — one long vertical rule would outweigh a page of writing.
  for (const sample of usable.filter((_, index) => isLetter(heights[index]!))) {
    for (let index = 1; index < sample.points.length; index += 1) {
      const a = sample.points[index - 1]!;
      const b = sample.points[index]!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const length = Math.hypot(dx, dy);

      if (length < 1e-6) continue;

      // Point every segment upward so a down-stroke and an up-stroke lean the same way.
      if (dy > 0) {
        dx = -dx;
        dy = -dy;
      }

      const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;

      if (Math.abs(angle) <= 35) lean.push({ value: angle, weight: length });
    }
  }

  const colors = new Map<string, number>();

  usable.forEach((sample) => colors.set(sample.color, (colors.get(sample.color) ?? 0) + 1));

  const color = Array.from(colors.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '#18204a';

  return {
    slantDeg: Math.max(-MAX_SLANT, Math.min(MAX_SLANT, lean.length >= 4 ? weightedMedian(lean) : 0)),
    strokeWidth: median(usable.map((sample) => sample.width)),
    letterHeight: median(letterHeights.length > 0 ? letterHeights : heights),
    color,
    samples: usable.length,
  };
}

/**
 * The pen strokes on the canvas (newest last), as samples: Fabric paths with a stroke and no fill
 * that are not AI objects, in scene coordinates. At most `limit` of the most recent.
 */
export function inkSamplesFromObjects(objects: FabricObject[], { limit = 400, aiProp = 'wbAi' }: { limit?: number; aiProp?: string } = {}): InkSample[] {
  const out: InkSample[] = [];

  for (let index = objects.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const object = objects[index]!;

    if (!object.isType('Path') || (object as unknown as Record<string, unknown>)[aiProp]) continue;
    if (typeof object.stroke !== 'string' || !object.stroke || object.visible === false) continue;
    if ((object as unknown as { globalCompositeOperation?: string }).globalCompositeOperation === 'destination-out') continue;

    const fill = object.fill;

    if (typeof fill === 'string' && fill && fill !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(fill)) continue;

    const { path, pathOffset } = object as Path;
    const matrix = object.calcTransformMatrix();
    const { scaleX, scaleY } = util.qrDecompose(matrix);
    const points: Array<{ x: number; y: number }> = [];

    for (const segment of path as unknown as Array<Array<string | number>>) {
      const n = segment.length;

      if (n < 3) continue;

      const x = Number(segment[n - 2]);
      const y = Number(segment[n - 1]);

      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const scene = util.transformPoint(new Point(x - pathOffset.x, y - pathOffset.y), matrix);

      points.push({ x: scene.x, y: scene.y });
    }

    out.push({ points, width: (object.strokeWidth ?? 0) * Math.max(Math.abs(scaleX), Math.abs(scaleY)), color: object.stroke });
  }

  return out.reverse();
}
