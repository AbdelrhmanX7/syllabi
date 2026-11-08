/**
 * Coverage raster → filled vector outline, for «Write it by hand».
 *
 * A word is drawn once with the handwriting font on an offscreen canvas (the browser's own text
 * engine does the shaping and kerning), and its alpha channel is traced back into contours here: marching
 * squares at the 50 % iso-line with linear interpolation along each cell edge, Ramer–Douglas–Peucker
 * to drop the points a straight run does not need, then quadratic curves through the midpoints so the
 * outline is smooth instead of stair-stepped. KaTeX formulas go through the same door from their PNG.
 *
 * The result is plain SVG path data in the raster's pixel space; holes come out as separate rings, so
 * the path is filled with the even-odd rule. Pure — no DOM — so it runs in tests.
 */

export interface TracePoint {
  x: number;
  y: number;
}

/**
 * Oriented segments per marching-squares case (d3-contour's table). Bits: 1 = bottom-left,
 * 2 = bottom-right, 4 = top-right, 8 = top-left corner inside. Coordinates are cell-relative, in
 * units where pixel (i, j) is centred on (i + 0.5, j + 0.5).
 */
const CASES: ReadonlyArray<ReadonlyArray<readonly [readonly [number, number], readonly [number, number]]>> = [
  [],
  [[[1.0, 1.5], [0.5, 1.0]]],
  [[[1.5, 1.0], [1.0, 1.5]]],
  [[[1.5, 1.0], [0.5, 1.0]]],
  [[[1.0, 0.5], [1.5, 1.0]]],
  [
    [[1.0, 1.5], [0.5, 1.0]],
    [[1.0, 0.5], [1.5, 1.0]],
  ],
  [[[1.0, 0.5], [1.0, 1.5]]],
  [[[1.0, 0.5], [0.5, 1.0]]],
  [[[0.5, 1.0], [1.0, 0.5]]],
  [[[1.0, 1.5], [1.0, 0.5]]],
  [
    [[0.5, 1.0], [1.0, 0.5]],
    [[1.5, 1.0], [1.0, 1.5]],
  ],
  [[[1.5, 1.0], [1.0, 0.5]]],
  [[[0.5, 1.0], [1.5, 1.0]]],
  [[[1.0, 1.5], [1.5, 1.0]]],
  [[[0.5, 1.0], [1.0, 1.5]]],
  [],
];

/**
 * Closed rings around every region of `alpha` at or above `threshold`, in pixel coordinates of the
 * raster (pixel (i, j) covers [i, i+1] × [j, j+1]). `alpha` is one byte per pixel, row-major.
 */
export function traceAlpha(alpha: ArrayLike<number>, width: number, height: number, threshold = 128): TracePoint[][] {
  // A one-pixel empty border closes every ring that touches the raster's edge.
  const w = width + 2;
  const h = height + 2;
  const value = (i: number, j: number) => (i < 1 || j < 1 || i > width || j > height ? 0 : alpha[(j - 1) * width + (i - 1)] ?? 0);
  const inside = (i: number, j: number) => value(i, j) >= threshold;
  // Points live on half-integer lattice positions; ×2 makes them integers for the key.
  const keyOf = (x: number, y: number) => Math.round(y * 2) * (w * 2 + 4) + Math.round(x * 2);
  const next = new Map<number, number>();
  const points = new Map<number, TracePoint>();

  for (let j = 0; j < h - 1; j += 1) {
    for (let i = 0; i < w - 1; i += 1) {
      const index = (inside(i, j + 1) ? 1 : 0) | (inside(i + 1, j + 1) ? 2 : 0) | (inside(i + 1, j) ? 4 : 0) | (inside(i, j) ? 8 : 0);

      for (const [start, end] of CASES[index]!) {
        const a = { x: start[0] + i, y: start[1] + j };
        const b = { x: end[0] + i, y: end[1] + j };
        const ka = keyOf(a.x, a.y);
        const kb = keyOf(b.x, b.y);

        next.set(ka, kb);
        points.set(ka, a);
        points.set(kb, b);
      }
    }
  }

  // Each lattice point starts exactly one segment and ends exactly one: follow the chain to close it.
  const rings: TracePoint[][] = [];
  const seen = new Set<number>();

  for (const startKey of Array.from(next.keys())) {
    if (seen.has(startKey)) continue;

    const ring: TracePoint[] = [];
    let key: number | undefined = startKey;

    while (key !== undefined && !seen.has(key)) {
      seen.add(key);
      ring.push(interpolate(points.get(key)!, value, threshold));
      key = next.get(key);
    }

    if (ring.length >= 3) rings.push(ring);
  }

  return rings;
}

/** Slides a lattice point along its cell edge to where the coverage actually crosses `threshold`. */
function interpolate(point: TracePoint, value: (i: number, j: number) => number, threshold: number): TracePoint {
  const horizontal = Math.abs(point.y - Math.floor(point.y) - 0.5) < 1e-6;
  // Undo the border: raster pixel (i, j) was padded to (i + 1, j + 1).
  const shift = (p: TracePoint) => ({ x: p.x - 1, y: p.y - 1 });

  if (horizontal) {
    // Between pixel centres (x − 0.5, y) and (x + 0.5, y).
    const i = Math.round(point.x - 1);
    const j = Math.round(point.y - 0.5);
    const v0 = value(i, j);
    const v1 = value(i + 1, j);
    const t = v1 === v0 ? 0.5 : clamp01((threshold - v0) / (v1 - v0));

    return shift({ x: i + 0.5 + t, y: point.y });
  }

  const i = Math.round(point.x - 0.5);
  const j = Math.round(point.y - 1);
  const v0 = value(i, j);
  const v1 = value(i, j + 1);
  const t = v1 === v0 ? 0.5 : clamp01((threshold - v0) / (v1 - v0));

  return shift({ x: point.x, y: j + 0.5 + t });
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Signed area (shoelace); its magnitude drops specks the eye cannot see. */
export function ringArea(ring: TracePoint[]): number {
  let area = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index]!;
    const b = ring[(index + 1) % ring.length]!;

    area += a.x * b.y - b.x * a.y;
  }

  return area / 2;
}

function perpendicularDistance(point: TracePoint, a: TracePoint, b: TracePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);

  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);

  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
}

function simplifyOpen(points: TracePoint[], epsilon: number): TracePoint[] {
  if (points.length <= 2) return points;

  const keep = new Uint8Array(points.length);
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  keep[0] = 1;
  keep[points.length - 1] = 1;

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = -1;
    let worstDistance = epsilon;

    for (let index = first + 1; index < last; index += 1) {
      const distance = perpendicularDistance(points[index]!, points[first]!, points[last]!);

      if (distance > worstDistance) {
        worst = index;
        worstDistance = distance;
      }
    }

    if (worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
}

/** Ramer–Douglas–Peucker on a closed ring (split at the point farthest from the first). */
export function simplifyRing(ring: TracePoint[], epsilon: number): TracePoint[] {
  if (ring.length <= 4) return ring;

  let far = 0;
  let farDistance = -1;

  for (let index = 1; index < ring.length; index += 1) {
    const distance = Math.hypot(ring[index]!.x - ring[0]!.x, ring[index]!.y - ring[0]!.y);

    if (distance > farDistance) {
      far = index;
      farDistance = distance;
    }
  }

  const a = simplifyOpen(ring.slice(0, far + 1), epsilon);
  const b = simplifyOpen([...ring.slice(far), ring[0]!], epsilon);

  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Rings → SVG path data. `map` places each raster point in the target space (scale, offset, jitter,
 * rotation); curves are quadratic through the midpoints of consecutive points.
 */
export function ringsToPathData(rings: TracePoint[][], map: (point: TracePoint) => TracePoint): string {
  const parts: string[] = [];

  for (const ring of rings) {
    const mapped = ring.map(map);
    const n = mapped.length;

    if (n < 3) continue;

    const mid = (a: TracePoint, b: TracePoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const start = mid(mapped[n - 1]!, mapped[0]!);

    parts.push(`M ${round(start.x)} ${round(start.y)}`);

    for (let index = 0; index < n; index += 1) {
      const control = mapped[index]!;
      const end = mid(control, mapped[(index + 1) % n]!);

      parts.push(`Q ${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`);
    }

    parts.push('Z');
  }

  return parts.join(' ');
}

/**
 * The whole pipeline for one raster: trace, drop specks under `minArea` px², simplify by `epsilon` px.
 */
export function traceToRings(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  { threshold = 128, epsilon = 0.55, minArea = 2 }: { threshold?: number; epsilon?: number; minArea?: number } = {},
): TracePoint[][] {
  return traceAlpha(alpha, width, height, threshold)
    .filter((ring) => Math.abs(ringArea(ring)) >= minArea)
    .map((ring) => simplifyRing(ring, epsilon))
    .filter((ring) => ring.length >= 3);
}
