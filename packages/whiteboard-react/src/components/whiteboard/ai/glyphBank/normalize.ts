import type { GlyphPoint, GlyphSample } from './types';

/**
 * «My handwriting» — one sheet cell's raw ink → a normalised GlyphSample. The cell carries a guide
 * baseline and an x-height; the owner writes the glyph on the baseline with a short lead-in tail
 * from the left and a lead-out tail toward the right. The tails are trimmed where they cross the tail zone and the crossing points become
 * the join anchors. Pure: scene numbers in, normalised numbers out.
 */

export interface SceneStroke {
  points: GlyphPoint[];
}

export interface NormalizeInput {
  strokes: SceneStroke[] | GlyphPoint[][];
  /** Guide baseline, scene y. */
  baselineY: number;
  /** x-height of the guide, scene px (becomes 1). */
  xHeight: number;
  /** The cell box, scene units. */
  cell: { x: number; y: number; w: number; h: number };
  /** Writing direction (always left to right; kept for callers that pass the sheet cell's `dir`). */
  dir?: 'ltr';
  /** Width of each tail zone as a fraction of the cell width. */
  tailFraction?: number;
  /** RDP tolerance in normalised units. */
  epsilon?: number;
  source?: GlyphSample['source'];
  now?: number;
}

export const DEFAULT_TAIL_FRACTION = 0.12;
export const DEFAULT_EPSILON = 0.02;
/** Points this close to the baseline (in x-heights) count as "on the baseline band" for the anchor fallback. */
export const BASELINE_BAND = 0.35;

type Point = GlyphPoint;

const asPointArrays = (strokes: NormalizeInput['strokes']): Point[][] =>
  strokes.map((stroke) => (Array.isArray(stroke) ? stroke : stroke.points)).filter((points) => points.length > 0);

// ---------------------------------------------------------------------------
// Ramer–Douglas–Peucker, keeping pressure on the surviving points
// ---------------------------------------------------------------------------

function perpendicularDistance(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);

  if (length === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);

  return Math.abs(dy * point[0] - dx * point[1] + b[0] * a[1] - b[1] * a[0]) / length;
}

export function simplifyStroke(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2 || epsilon <= 0) return points.slice();

  const keep = new Array<boolean>(points.length).fill(false);

  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let farthest = -1;
    let maxDistance = 0;

    for (let index = start + 1; index < end; index += 1) {
      const distance = perpendicularDistance(points[index]!, points[start]!, points[end]!);

      if (distance > maxDistance) {
        maxDistance = distance;
        farthest = index;
      }
    }

    if (farthest !== -1 && maxDistance > epsilon) {
      keep[farthest] = true;
      stack.push([start, farthest], [farthest, end]);
    }
  }

  return points.filter((_, index) => keep[index]);
}

// ---------------------------------------------------------------------------
// Tails and anchors
// ---------------------------------------------------------------------------

interface TailResult {
  strokes: Point[][];
  anchor: [number, number] | null;
}

const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Trim the entry tail: the first stroke that starts inside the entry zone loses its points inside the
 * zone; the crossing with the zone's edge is the entry anchor. `inZone` tests normalised x.
 */
function trimEntry(strokes: Point[][], inZone: (x: number) => boolean, edgeX: number): TailResult {
  const index = strokes.findIndex((stroke) => inZone(stroke[0]![0]));

  if (index === -1) return { strokes, anchor: null };

  const stroke = strokes[index]!;
  const out = strokes.slice();
  let cross = stroke.findIndex((point) => !inZone(point[0]));

  if (cross === -1) {
    // The whole stroke is a tail: drop it, anchor at its last point.
    const last = stroke[stroke.length - 1]!;

    out.splice(index, 1);

    return { strokes: out, anchor: [last[0], last[1]] };
  }

  if (cross === 0) cross = 1;

  const before = stroke[cross - 1]!;
  const after = stroke[cross]!;
  const t = after[0] === before[0] ? 0 : (edgeX - before[0]) / (after[0] - before[0]);
  const anchorPoint = lerp(before, after, Math.max(0, Math.min(1, t)));

  out[index] = [anchorPoint, ...stroke.slice(cross)];

  return { strokes: out, anchor: [anchorPoint[0], anchorPoint[1]] };
}

/** Mirror of trimEntry for the lead-out tail: the LAST stroke that ends inside the exit zone. */
function trimExit(strokes: Point[][], inZone: (x: number) => boolean, edgeX: number): TailResult {
  let index = -1;

  for (let i = strokes.length - 1; i >= 0; i -= 1) {
    const stroke = strokes[i]!;

    if (inZone(stroke[stroke.length - 1]![0])) {
      index = i;
      break;
    }
  }

  if (index === -1) return { strokes, anchor: null };

  const stroke = strokes[index]!;
  const out = strokes.slice();
  let cross = -1;

  for (let i = stroke.length - 1; i >= 0; i -= 1) {
    if (!inZone(stroke[i]![0])) {
      cross = i;
      break;
    }
  }

  if (cross === -1) {
    const first = stroke[0]!;

    out.splice(index, 1);

    return { strokes: out, anchor: [first[0], first[1]] };
  }

  if (cross === stroke.length - 1) cross = stroke.length - 2;

  const before = stroke[cross]!;
  const after = stroke[cross + 1]!;
  const t = after[0] === before[0] ? 0 : (edgeX - before[0]) / (after[0] - before[0]);
  const anchorPoint = lerp(before, after, Math.max(0, Math.min(1, t)));

  out[index] = [...stroke.slice(0, cross + 1), anchorPoint];

  return { strokes: out, anchor: [anchorPoint[0], anchorPoint[1]] };
}

/** The extreme-x point on the baseline band (or anywhere, when no point sits on the band). */
function extremePoint(strokes: Point[][], side: 'min' | 'max'): [number, number] {
  const all = strokes.reduce<Point[]>((acc, stroke) => acc.concat(stroke), []);
  const banded = all.filter((point) => Math.abs(point[1]) <= BASELINE_BAND);
  const pool = banded.length > 0 ? banded : all;
  const pick = pool.reduce((best, point) => (side === 'max' ? (point[0] > best[0] ? point : best) : point[0] < best[0] ? point : best), pool[0]!);

  return [pick[0], pick[1]];
}

export function strokesBbox(strokes: Point[][]): GlyphSample['bbox'] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  strokes.forEach((stroke) =>
    stroke.forEach(([x, y]) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }),
  );

  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * Scene ink of one cell → a GlyphSample: scale so the x-height is 1 and the baseline is y = 0, trim the
 * tails into anchors (falling back to the extreme baseline points), simplify, and shift so the entry
 * sits at x = 0. Returns null when the cell has no ink.
 */
export function normalizeGlyph(input: NormalizeInput): GlyphSample | null {
  const { baselineY, xHeight, cell, tailFraction = DEFAULT_TAIL_FRACTION, epsilon = DEFAULT_EPSILON } = input;

  if (!(xHeight > 0)) return null;

  const raw = asPointArrays(input.strokes);

  if (raw.length === 0) return null;

  const toNorm = ([x, y, p]: Point): Point => [(x - cell.x) / xHeight, (y - baselineY) / xHeight, Math.max(0, Math.min(1, p ?? 0.5))];
  const normalised = raw.map((stroke) => stroke.map(toNorm));
  const cellW = cell.w / xHeight;
  const tail = cellW * tailFraction;
  const rightEdge = cellW - tail;
  const leftEdge = tail;
  const inRight = (x: number) => x >= rightEdge;
  const inLeft = (x: number) => x <= leftEdge;

  const entryTrim = trimEntry(normalised, inLeft, leftEdge);
  const exitTrim = trimExit(entryTrim.strokes, inRight, rightEdge);
  const body = exitTrim.strokes.filter((stroke) => stroke.length > 0);

  if (body.length === 0) return null;

  const simplified = body.map((stroke) => simplifyStroke(stroke, epsilon));
  const entry = entryTrim.anchor ?? extremePoint(simplified, 'min');
  const exit = exitTrim.anchor ?? extremePoint(simplified, 'max');
  const shift = entry[0];
  const strokes = simplified.map((stroke) => stroke.map(([x, y, p]): Point => [x - shift, y, p]));

  return {
    strokes,
    advance: Math.abs(exit[0] - entry[0]),
    entry: [0, entry[1]],
    exit: [exit[0] - shift, exit[1]],
    bbox: strokesBbox(strokes),
    source: input.source ?? 'sheet',
    createdAt: input.now ?? Date.now(),
  };
}
