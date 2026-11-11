/**
 * Hold-to-snap shape recognition — the Apple Notes / Samsung Notes gesture: draw a rough shape, keep
 * the pen down and still at the end, and the stroke becomes a perfect line / triangle / rectangle /
 * ellipse / circle.
 *
 * PURE: points in, geometry out, no Fabric and no DOM, so every threshold is unit-tested. All tolerances
 * are RELATIVE to the stroke's own size, so the same rough square snaps at any zoom; the only absolute
 * input is `minSize` (scene units), which the caller derives from a screen-px floor and the live zoom.
 *
 * THE BIAS IS "DO NOTHING". This runs on a pen held still mid-lesson, and a teacher who pauses on the
 * last letter of a word must get their letter back, not a triangle. Every test below rejects
 * aggressively and the result is `none` whenever two readings disagree or a fit is merely "close".
 *
 * Method:
 *   1. Resample the stroke to equal arc-length steps (raw digitizer samples bunch where the pen slows).
 *   2. Open vs closed: the end must come back near the start (an overshoot past the start is trimmed),
 *      and a closed loop must turn through roughly ONE revolution (a spiral or a scribble does not).
 *   3. Open → a square-root sign (`radicalSign.ts`: tick, stem and a LONG vinculum), else a bracket,
 *      brace, integral sign or one-stroke arrow (`mathSymbols.ts`), else a straight line: least-squares line fit, every point within a few % of the length, no doubling back.
 *      Angle snaps to 0/45/90°.
 *   4. Closed → two independent fits:
 *        polygon  Ramer–Douglas–Peucker corners, near-straight joints merged, and EVERY edge must be
 *                 straight on its own (this is what tells a rough circle — whose RDP "edges" are arcs —
 *                 from a polygon). Vertices are refined by intersecting per-edge line fits.
 *        ellipse  PCA axes + extents, then every point's normalised radius must sit near 1.
 *      Rectangles (4 corners near 90°) are regularised and squared; ellipses become circles when the
 *      axes nearly match; both snap to the screen axes within a few degrees.
 */

import { MATH_SYMBOL_KINDS, mathSymbolScenePoints, normalizeMathSymbolParams, recognizeMathSymbol, stretchMathSymbol } from './mathSymbols';
import type { MathSymbolKind, MathSymbolShape } from './mathSymbols';
import { normalizeRadicalParams, radicalScenePoints, recognizeRadical } from './radicalSign';
import type { RadicalShape } from './radicalSign';

export interface Vec {
  x: number;
  y: number;
}

/** `smooth`: not a shape at all — a freehand stroke smoothed on hold (`utils/smoothStroke`). */
export type ShapeKind = 'line' | 'triangle' | 'rectangle' | 'polygon' | 'ellipse' | 'circle' | 'radical' | MathSymbolKind | 'smooth';

/** True for the clean math symbols (`utils/mathSymbols`): brackets, braces, integral, arrow. */
export function isMathSymbolKind(kind: string | null | undefined): kind is MathSymbolKind {
  return (MATH_SYMBOL_KINDS as readonly string[]).includes(kind ?? '');
}

/** A straight-edged shape: an open polyline (line) or a closed polygon (vertices in drawing order). */
export interface PolyGeometry {
  type: 'poly';
  points: Vec[];
  closed: boolean;
}

/** `angle` in radians, the rotation of the `rx` axis from scene +x. */
export interface EllipseGeometry {
  type: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  angle: number;
}

export type ShapeGeometry = PolyGeometry | EllipseGeometry;

export type RecognizedShape =
  | { kind: 'none' }
  | { kind: 'line'; geometry: PolyGeometry }
  | { kind: 'triangle'; geometry: PolyGeometry }
  | { kind: 'rectangle'; geometry: PolyGeometry; square: boolean }
  | { kind: 'polygon'; geometry: PolyGeometry }
  | { kind: 'ellipse' | 'circle'; geometry: EllipseGeometry }
  /** A square-root sign (`utils/radicalSign`): `geometry` is its polyline, `radical` its parameters. */
  | { kind: 'radical'; geometry: PolyGeometry; radical: RadicalShape }
  /** A clean math symbol (`utils/mathSymbols`): `geometry` is its polyline, `symbol` its parameters. */
  | { kind: MathSymbolKind; geometry: PolyGeometry; symbol: MathSymbolShape }
  /** A freehand stroke smoothed on hold: fixed once made (no hold-drag resize). */
  | { kind: 'smooth'; geometry: PolyGeometry };

export interface RecognizeOptions {
  /** Smallest bounding-box diagonal (scene units) that may become a shape. Below it → none. */
  minSize: number;
  /**
   * Also recognise the clean math symbols (brackets, braces, integral, arrow). Off unless set: the
   * owner's «Clean up math symbols» pen setting. The square root is recognised either way.
   */
  mathSymbols?: boolean;
}

/** Every tunable in one place; exported so the tests document what each one guards. */
export const SHAPE_THRESHOLDS = {
  /** Resample density for open / closed strokes. */
  resampleOpen: 64,
  resampleClosed: 96,

  /** Closed: end-to-start gap, as a fraction of the bbox diagonal (after overshoot trimming). */
  closeGapRatio: 0.2,
  /** Closed: |signed total turning| in revolutions — a loop is ~1; a spiral or a scribble is not. */
  minTurns: 0.8,
  maxTurns: 1.3,

  /** Line: deviation from the fitted line, as a fraction of its length. */
  lineMaxDev: 0.06,
  lineMeanDev: 0.022,
  /** Line: path length / line length — a stroke that doubles back on itself is not a line. */
  lineMaxLengthRatio: 1.15,
  /** Line: snap to the nearest multiple of 45° within this many degrees. */
  lineAngleSnapDeg: 5,

  /** Polygon: RDP tolerance as a fraction of the bbox diagonal. */
  rdpEpsilon: 0.06,
  /** Polygon: a vertex whose direction change is below this is not a corner. */
  minCornerTurnDeg: 28,
  /** Polygon: per-edge straightness — max / mean deviation of the edge's middle from its own fitted
   *  line, as a fraction of the edge length. */
  edgeMaxDev: 0.08,
  edgeMeanDev: 0.03,
  /** Polygon: share of the net turning that must fall inside the corner windows, and each window's
   *  half-width as a fraction of the neighbouring edge. */
  minCornerTurnShare: 0.8,
  cornerWindow: 0.2,
  /** Polygon: the shortest edge, as a fraction of the bbox diagonal. */
  minEdgeRatio: 0.12,
  /** Rectangle: every interior angle within this many degrees of 90. */
  rectAngleToleranceDeg: 20,
  /** Rectangle → square when the sides differ by less than this fraction. */
  squareRatio: 0.12,

  /** Ellipse: |normalised radius − 1|, mean and max. */
  ellipseMeanDev: 0.075,
  ellipseMaxDev: 0.22,
  /** Ellipse: minor/major below this is a squashed loop, not an ellipse. */
  ellipseMinAspect: 0.15,
  /** Ellipse → circle when minor/major is at least this. */
  circleAspect: 0.84,

  /** Rectangles, ellipses and triangle edges snap to the screen axes within this many degrees. */
  axisSnapDeg: 8,
} as const;

const T = SHAPE_THRESHOLDS;
const DEG = Math.PI / 180;

const NONE: RecognizedShape = { kind: 'none' };

// ---------------------------------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------------------------------

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(points: Vec[]): number {
  let total = 0;

  for (let i = 1; i < points.length; i += 1) {
    total += dist(points[i - 1], points[i]);
  }

  return total;
}

function bboxDiagonal(points: Vec[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return Math.hypot(maxX - minX, maxY - minY);
}

function mean(points: Vec[]): Vec {
  let x = 0;
  let y = 0;

  for (const p of points) {
    x += p.x;
    y += p.y;
  }

  return { x: x / points.length, y: y / points.length };
}

/** Principal axis angle (radians) of a point cloud around its mean. */
function principalAngle(points: Vec[], center: Vec): number {
  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;

    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

const rotate = (p: Vec, pivot: Vec, angle: number): Vec => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;

  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
};

/** Distance from p to the infinite line through a with unit direction u. */
const lineDistance = (p: Vec, a: Vec, u: Vec): number => Math.abs((p.x - a.x) * u.y - (p.y - a.y) * u.x);

function segmentDistance(p: Vec, a: Vec, b: Vec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;

  if (lengthSq === 0) return dist(p, a);

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq));

  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/** Wrap to (-π, π]. */
function wrapAngle(angle: number): number {
  let a = angle;

  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;

  return a;
}

/**
 * Snap `angle` to the nearest multiple of `step` when within `tolerance` (both radians). Returns the
 * (possibly unchanged) angle.
 */
export function snapAngle(angle: number, step: number, tolerance: number): number {
  const nearest = Math.round(angle / step) * step;

  return Math.abs(angle - nearest) <= tolerance ? nearest : angle;
}

// ---------------------------------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------------------------------

/** Resample to `count` points equally spaced along the path ($1-recognizer style). */
export function resample(points: Vec[], count: number): Vec[] {
  const total = pathLength(points);

  if (points.length < 2 || total === 0) return points.slice();

  const step = total / (count - 1);
  const out: Vec[] = [{ ...points[0] }];
  let carried = 0;
  let prev = points[0];

  for (let i = 1; i < points.length; i += 1) {
    let current = points[i];
    let segment = dist(prev, current);

    while (carried + segment >= step && segment > 0) {
      const t = (step - carried) / segment;
      const q = { x: prev.x + t * (current.x - prev.x), y: prev.y + t * (current.y - prev.y) };

      out.push(q);
      prev = q;
      segment = dist(prev, current);
      carried = 0;

      if (out.length === count) return out;
    }

    carried += segment;
    prev = current;
    current = points[i];
  }

  while (out.length < count) out.push({ ...points[points.length - 1] });

  return out;
}

// ---------------------------------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------------------------------

function recognizeLine(raw: Vec[], minSize: number): RecognizedShape {
  const points = resample(raw, T.resampleOpen);
  const first = points[0];
  const last = points[points.length - 1];
  const center = mean(points);
  const angle = principalAngle(points, center);
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const project = (p: Vec): Vec => {
    const t = (p.x - center.x) * u.x + (p.y - center.y) * u.y;

    return { x: center.x + t * u.x, y: center.y + t * u.y };
  };
  const a = project(first);
  const b = project(last);
  const length = dist(a, b);

  if (length < minSize) return NONE;

  let maxDev = 0;
  let sumDev = 0;

  for (const p of points) {
    const d = lineDistance(p, center, u);

    sumDev += d;
    if (d > maxDev) maxDev = d;
  }

  if (maxDev / length > T.lineMaxDev) return NONE;
  if (sumDev / points.length / length > T.lineMeanDev) return NONE;
  if (pathLength(points) / length > T.lineMaxLengthRatio) return NONE;

  return { kind: 'line', geometry: { type: 'poly', closed: false, points: snapLineEnd(a, b) } };
}

/**
 * Keep `start` fixed and rotate `end` around it onto the nearest multiple of 45° when within the snap
 * tolerance. Shared by recognition and by the hold-drag adjustment.
 */
export function snapLineEnd(start: Vec, end: Vec): [Vec, Vec] {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const snapped = snapAngle(angle, Math.PI / 4, T.lineAngleSnapDeg * DEG);
  const length = dist(start, end);

  return [{ ...start }, { x: start.x + length * Math.cos(snapped), y: start.y + length * Math.sin(snapped) }];
}

// ---------------------------------------------------------------------------------------------------
// Closed-loop preparation
// ---------------------------------------------------------------------------------------------------

/**
 * If the stroke comes back near its start, return it trimmed at the closest return point (the part
 * after it is an overshoot along the first edge). Otherwise null.
 */
function closeLoop(points: Vec[], diagonal: number): Vec[] | null {
  const start = points[0];
  const from = Math.floor(points.length * 0.55);
  let bestIndex = points.length - 1;
  let bestDistance = dist(points[bestIndex], start);

  for (let i = from; i < points.length; i += 1) {
    const d = dist(points[i], start);

    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }

  if (bestDistance > T.closeGapRatio * diagonal) return null;

  // Back off a tail that has crept to within a couple of steps of the start. When the closest return
  // lands just PAST the start, the closing joint is a near-180° reversal whose wrapped turn is ±π at
  // random — enough to flip the loop's total turning to 0 or 2 revolutions.
  const step = pathLength(points) / (points.length - 1);
  let end = bestIndex;

  while (end > points.length * 0.5 && dist(points[end], start) < 2 * step) end -= 1;

  return points.slice(0, end + 1);
}

/** Signed total turning of a closed loop, in revolutions. */
function totalTurns(loop: Vec[]): number {
  let total = 0;
  const n = loop.length;

  for (let i = 0; i < n; i += 1) {
    const a = loop[(i - 1 + n) % n];
    const b = loop[i];
    const c = loop[(i + 1) % n];
    const h1 = Math.atan2(b.y - a.y, b.x - a.x);
    const h2 = Math.atan2(c.y - b.y, c.x - b.x);

    if (dist(a, b) === 0 || dist(b, c) === 0) continue;
    total += wrapAngle(h2 - h1);
  }

  return total / (2 * Math.PI);
}

// ---------------------------------------------------------------------------------------------------
// Polygon
// ---------------------------------------------------------------------------------------------------

function rdp(points: Vec[], epsilon: number): number[] {
  const keep = new Array<boolean>(points.length).fill(false);

  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let worstDistance = 0;

    for (let i = lo + 1; i < hi; i += 1) {
      const d = segmentDistance(points[i], points[lo], points[hi]);

      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }

    if (worst !== -1 && worstDistance > epsilon) {
      keep[worst] = true;
      stack.push([lo, worst], [worst, hi]);
    }
  }

  return keep.flatMap((k, i) => (k ? [i] : []));
}

/** Turning angle (radians, unsigned) at vertex b of a → b → c. */
function turnAt(a: Vec, b: Vec, c: Vec): number {
  return Math.abs(wrapAngle(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)));
}

interface PolygonFit {
  /** Indices into the loop, one per corner, in loop order. */
  corners: number[];
  vertices: Vec[];
}

function fitPolygon(loop: Vec[], diagonal: number): PolygonFit | null {
  const n = loop.length;
  const center = mean(loop);
  // Start the RDP split at the point farthest from the centre — on a polygon that is a corner, so the
  // seam the algorithm needs (first point == last point) never lands mid-edge.
  let seam = 0;
  let seamDistance = -1;

  for (let i = 0; i < n; i += 1) {
    const d = dist(loop[i], center);

    if (d > seamDistance) {
      seamDistance = d;
      seam = i;
    }
  }

  const order = Array.from({ length: n + 1 }, (_, i) => (seam + i) % n);
  const rotated = order.map((i) => loop[i]);
  const kept = rdp(rotated, T.rdpEpsilon * diagonal);
  let corners = kept.slice(0, -1).map((i) => order[i]);

  // Drop joints that barely turn, the smallest first, until every remaining one is a real corner.
  for (;;) {
    if (corners.length < 3) return null;

    let weakest = -1;
    let weakestTurn = T.minCornerTurnDeg * DEG;

    for (let k = 0; k < corners.length; k += 1) {
      const a = loop[corners[(k - 1 + corners.length) % corners.length]];
      const b = loop[corners[k]];
      const c = loop[corners[(k + 1) % corners.length]];
      const turn = turnAt(a, b, c);

      if (turn < weakestTurn) {
        weakestTurn = turn;
        weakest = k;
      }
    }

    if (weakest === -1) break;
    corners = corners.filter((_, k) => k !== weakest);
  }

  corners.sort((a, b) => a - b);

  if (corners.length < 3 || corners.length > 6) return null;

  const strictness = corners.length >= 5 ? 0.7 : 1;

  const fits = fitEdges(loop, corners);

  // Every edge must be straight on its own, measured on its middle (the corners are rounded by hand,
  // so their neighbourhoods are excluded) against its own least-squares line.
  for (let k = 0; k < corners.length; k += 1) {
    const edgeLength = dist(loop[corners[k]], loop[corners[(k + 1) % corners.length]]);

    if (edgeLength < T.minEdgeRatio * diagonal) return null;

    const { center, u, points } = fits[k];
    let maxDev = 0;
    let sumDev = 0;

    for (const p of points) {
      const d = lineDistance(p, center, u);

      sumDev += d;
      if (d > maxDev) maxDev = d;
    }

    if (maxDev / edgeLength > T.edgeMaxDev * strictness) return null;
    if (sumDev / points.length / edgeLength > T.edgeMeanDev * strictness) return null;
  }

  // The turning must happen AT the corners. On a polygon the edges carry no net turn and each corner
  // window holds its whole share; on a loop of arcs (a «D», a rough circle cut into pieces) the turn is
  // spread evenly, so the windows hold only their width's share. Signed sums, so hand jitter cancels.
  const concentration = cornerTurnConcentration(loop, corners);

  if (concentration < T.minCornerTurnShare) return null;

  return { corners, vertices: refineVertices(loop, corners, fits, diagonal) };
}

/** Fraction of the loop's net turning that happens within a window around each corner. */
function cornerTurnConcentration(loop: Vec[], corners: number[]): number {
  const n = loop.length;
  const heading = (i: number) => {
    const a = loop[i % n];
    const b = loop[(i + 1) % n];

    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  // turn[i] = heading change AT sample i.
  const turn = Array.from({ length: n }, (_, i) => wrapAngle(heading(i) - heading((i - 1 + n) % n)));
  const total = Math.abs(turn.reduce((sum, t) => sum + t, 0));

  if (total === 0) return 0;

  let inWindows = 0;

  corners.forEach((corner, k) => {
    const prev = corners[(k - 1 + corners.length) % corners.length];
    const next = corners[(k + 1) % corners.length];
    const before = Math.floor(((corner - prev + n) % n) * T.cornerWindow);
    const after = Math.floor(((next - corner + n) % n) * T.cornerWindow);
    let sum = 0;

    for (let i = corner - before; i <= corner + after; i += 1) sum += turn[((i % n) + n) % n];

    inWindows += Math.abs(sum);
  });

  return inWindows / total;
}

interface EdgeFit {
  center: Vec;
  u: Vec;
  /** The edge's middle samples the line was fitted to. */
  points: Vec[];
}

/** Least-squares line through the middle of each edge (corner neighbourhoods trimmed off). */
function fitEdges(loop: Vec[], corners: number[]): EdgeFit[] {
  const n = loop.length;

  return corners.map((i0, k) => {
    const i1 = corners[(k + 1) % corners.length];
    const span = (i1 - i0 + n) % n;
    const trim = Math.floor(span * 0.15);
    const segment: Vec[] = [];

    for (let s = trim; s <= span - trim; s += 1) segment.push(loop[(i0 + s) % n]);

    const points = segment.length >= 2 ? segment : [loop[i0], loop[i1]];
    const center = mean(points);
    const angle = principalAngle(points, center);

    return { center, u: { x: Math.cos(angle), y: Math.sin(angle) }, points };
  });
}

/**
 * Sharpen each corner to the intersection of its two neighbouring edges' least-squares lines, which
 * is where the teacher MEANT the corner to be (the drawn corner is rounded). Falls back to the drawn
 * corner when the lines are near-parallel or the intersection lands far away.
 */
function refineVertices(loop: Vec[], corners: number[], lines: EdgeFit[], diagonal: number): Vec[] {
  return corners.map((cornerIndex, k) => {
    const raw = loop[cornerIndex];
    const l1 = lines[(k - 1 + lines.length) % lines.length];
    const l2 = lines[k];
    const cross = l1.u.x * l2.u.y - l1.u.y * l2.u.x;

    if (Math.abs(cross) < Math.sin(15 * DEG)) return { ...raw };

    const t = ((l2.center.x - l1.center.x) * l2.u.y - (l2.center.y - l1.center.y) * l2.u.x) / cross;
    const hit = { x: l1.center.x + t * l1.u.x, y: l1.center.y + t * l1.u.y };

    return dist(hit, raw) > 0.15 * diagonal ? { ...raw } : hit;
  });
}

function interiorAnglesDeg(vertices: Vec[]): number[] {
  return vertices.map((b, k) => {
    const a = vertices[(k - 1 + vertices.length) % vertices.length];
    const c = vertices[(k + 1) % vertices.length];

    return 180 - turnAt(a, b, c) / DEG;
  });
}

function regularizeRectangle(vertices: Vec[]): { points: Vec[]; square: boolean } {
  // Dominant orientation: circular mean of the edge directions on the 4θ circle (so 0/90/180/270 agree).
  let sx = 0;
  let sy = 0;

  vertices.forEach((a, k) => {
    const b = vertices[(k + 1) % vertices.length];
    const theta = Math.atan2(b.y - a.y, b.x - a.x);
    const weight = dist(a, b);

    sx += weight * Math.cos(4 * theta);
    sy += weight * Math.sin(4 * theta);
  });

  let angle = Math.atan2(sy, sx) / 4;

  angle = snapAngle(angle, Math.PI / 2, T.axisSnapDeg * DEG);

  const center = mean(vertices);
  const local = vertices.map((p) => rotate(p, center, -angle));
  const xs = local.map((p) => p.x).sort((a, b) => a - b);
  const ys = local.map((p) => p.y).sort((a, b) => a - b);
  let left = (xs[0] + xs[1]) / 2;
  let right = (xs[2] + xs[3]) / 2;
  let top = (ys[0] + ys[1]) / 2;
  let bottom = (ys[2] + ys[3]) / 2;
  const width = right - left;
  const height = bottom - top;
  const square = Math.abs(width - height) / Math.max(width, height) < T.squareRatio;

  if (square) {
    const side = (width + height) / 2;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;

    left = cx - side / 2;
    right = cx + side / 2;
    top = cy - side / 2;
    bottom = cy + side / 2;
  }

  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ].map((p) => rotate(p, center, angle));

  return { points: corners, square };
}

/** Rotate a polygon about its centroid so its most nearly axis-aligned edge becomes exactly aligned. */
function snapPolygonToAxis(vertices: Vec[]): Vec[] {
  let bestCorrection = 0;
  let bestMagnitude = Infinity;

  vertices.forEach((a, k) => {
    const b = vertices[(k + 1) % vertices.length];
    const theta = Math.atan2(b.y - a.y, b.x - a.x);
    const snapped = snapAngle(theta, Math.PI / 2, T.axisSnapDeg * DEG);
    const correction = snapped - theta;

    if (snapped !== theta && Math.abs(correction) < bestMagnitude) {
      bestMagnitude = Math.abs(correction);
      bestCorrection = correction;
    }
  });

  if (bestMagnitude === Infinity) return vertices;

  const center = mean(vertices);

  return vertices.map((p) => rotate(p, center, bestCorrection));
}

// ---------------------------------------------------------------------------------------------------
// Ellipse
// ---------------------------------------------------------------------------------------------------

function fitEllipse(loop: Vec[]): EllipseGeometry | null {
  const centroid = mean(loop);
  const angle = principalAngle(loop, centroid);
  const local = loop.map((p) => rotate(p, centroid, -angle));
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (const p of local) {
    if (p.x < minU) minU = p.x;
    if (p.x > maxU) maxU = p.x;
    if (p.y < minV) minV = p.y;
    if (p.y > maxV) maxV = p.y;
  }

  const rx = (maxU - minU) / 2;
  const ry = (maxV - minV) / 2;

  if (rx <= 0 || ry <= 0) return null;
  if (Math.min(rx, ry) / Math.max(rx, ry) < T.ellipseMinAspect) return null;

  const localCenter = { x: (minU + maxU) / 2, y: (minV + maxV) / 2 };
  let sumDev = 0;
  let maxDev = 0;

  for (const p of local) {
    const r = Math.hypot((p.x - localCenter.x) / rx, (p.y - localCenter.y) / ry);
    const d = Math.abs(r - 1);

    sumDev += d;
    if (d > maxDev) maxDev = d;
  }

  if (sumDev / local.length > T.ellipseMeanDev || maxDev > T.ellipseMaxDev) return null;

  const center = rotate(localCenter, centroid, angle);

  return { type: 'ellipse', cx: center.x, cy: center.y, rx, ry, angle };
}

function regularizeEllipse(e: EllipseGeometry): { geometry: EllipseGeometry; circle: boolean } {
  const major = Math.max(e.rx, e.ry);
  const minor = Math.min(e.rx, e.ry);

  if (minor / major >= T.circleAspect) {
    const r = (e.rx + e.ry) / 2;

    return { geometry: { ...e, rx: r, ry: r, angle: 0 }, circle: true };
  }

  // Normalise so rx is the major axis, then snap the axis to the screen.
  let angle = e.rx >= e.ry ? e.angle : e.angle + Math.PI / 2;

  angle = wrapAngle(angle);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;

  const snapped = snapAngle(angle, Math.PI / 2, T.axisSnapDeg * DEG);
  let rx = major;
  let ry = minor;

  if (Math.abs(Math.abs(snapped) - Math.PI / 2) < 1e-9) {
    // A vertical major axis: express it as an unrotated ellipse with the axes swapped.
    rx = minor;
    ry = major;

    return { geometry: { ...e, rx, ry, angle: 0 }, circle: false };
  }

  return { geometry: { ...e, rx, ry, angle: snapped }, circle: false };
}

// ---------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------

export function recognizeShape(input: Vec[], options: RecognizeOptions): RecognizedShape {
  // Drop exact duplicates (a held pen repeats its last sample) so lengths and headings are defined.
  const points: Vec[] = [];

  for (const p of input) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;

    const prev = points[points.length - 1];

    if (!prev || prev.x !== p.x || prev.y !== p.y) points.push({ x: p.x, y: p.y });
  }

  if (points.length < 4) return NONE;

  const diagonal = bboxDiagonal(points);

  if (diagonal < options.minSize) return NONE;

  const sampled = resample(points, T.resampleClosed);
  const loop = closeLoop(sampled, diagonal);

  if (!loop) {
    // A √ (tick, stem, long vinculum) is open and bent, so the line fit below would reject it anyway.
    const radical = recognizeRadical(points, { minSize: options.minSize });

    if (radical) return radicalShape(radical);

    const symbol = options.mathSymbols === true ? recognizeMathSymbol(points, { minSize: options.minSize }) : null;

    if (symbol) return mathSymbolShape(symbol);

    return recognizeLine(points, options.minSize);
  }

  // The trimmed loop's closing point duplicates the start; drop it so the loop wraps cleanly.
  const closed = resample(loop, T.resampleClosed).slice(0, -1);
  const turns = Math.abs(totalTurns(closed));

  if (turns < T.minTurns || turns > T.maxTurns) return NONE;

  // The ellipse is tried FIRST and wins outright. A corner pokes out past any ellipse through the same
  // extents (a square's corners sit at 1.41× the radius), so a real polygon can never pass this fit —
  // while a rough circle CAN pass the polygon fit, because its RDP pieces are shallow arcs.
  const ellipse = fitEllipse(closed);

  if (ellipse) {
    const { geometry, circle } = regularizeEllipse(ellipse);

    return { kind: circle ? 'circle' : 'ellipse', geometry };
  }

  const polygon = fitPolygon(closed, diagonal);

  if (!polygon) return NONE;

  const vertices = polygon.vertices;

  if (vertices.length === 4 && interiorAnglesDeg(vertices).every((a) => Math.abs(a - 90) <= T.rectAngleToleranceDeg)) {
    const { points: rect, square } = regularizeRectangle(vertices);

    return { kind: 'rectangle', square, geometry: { type: 'poly', closed: true, points: rect } };
  }

  return {
    kind: vertices.length === 3 ? 'triangle' : 'polygon',
    geometry: { type: 'poly', closed: true, points: snapPolygonToAxis(vertices) },
  };
}

// ---------------------------------------------------------------------------------------------------
// Hold-drag adjustment (after the snap, before the pen lifts)
// ---------------------------------------------------------------------------------------------------

/** A {@link RecognizedShape} for a radical: its scene polyline plus the parameters that regenerate it. */
export function radicalShape(radical: RadicalShape): Extract<RecognizedShape, { kind: 'radical' }> {
  return { kind: 'radical', radical, geometry: { type: 'poly', closed: false, points: radicalScenePoints(radical) } };
}

/** A {@link RecognizedShape} for a math symbol: its scene polyline plus the parameters that regenerate it. */
export function mathSymbolShape(symbol: MathSymbolShape): Extract<RecognizedShape, { symbol: MathSymbolShape }> {
  return { kind: symbol.params.kind, symbol, geometry: { type: 'poly', closed: false, points: mathSymbolScenePoints(symbol) } };
}

/**
 * The post-snap drag for a math symbol: the end the pen finished at follows it, the other end stays —
 * a bracket / brace / integral only grows or shrinks in height, an arrow's tip (or tail, when it was
 * drawn head-first) follows the pen. Regenerated from the params, never scaled.
 */
function adjustMathSymbol(snapped: Extract<RecognizedShape, { symbol: MathSymbolShape }>, holdPoint: Vec, pen: Vec): RecognizedShape {
  const { anchor, params } = snapped.symbol;
  const dx = pen.x - holdPoint.x;
  const dy = pen.y - holdPoint.y;

  if (params.kind === 'arrow') {
    const tip = { x: anchor.x + params.length * Math.cos(params.angle), y: anchor.y + params.length * Math.sin(params.angle) };

    if (dist(holdPoint, tip) <= dist(holdPoint, anchor)) {
      return mathSymbolShape({ anchor, params: stretchMathSymbol(params, { x: tip.x + dx - anchor.x, y: tip.y + dy - anchor.y }) });
    }

    const tail = { x: anchor.x + dx, y: anchor.y + dy };

    return mathSymbolShape({ anchor: tail, params: stretchMathSymbol(params, { x: tip.x - tail.x, y: tip.y - tail.y }) });
  }

  const bottom = anchor.y + params.height;

  if (Math.abs(holdPoint.y - bottom) <= Math.abs(holdPoint.y - anchor.y)) {
    return mathSymbolShape({ anchor, params: normalizeMathSymbolParams({ ...params, height: params.height + dy }) });
  }

  const next = normalizeMathSymbolParams({ ...params, height: params.height - dy });

  return mathSymbolShape({ anchor: { x: anchor.x, y: bottom - (next as { height: number }).height }, params: next });
}

/** Pivot a shape transforms around while the pen keeps moving after the snap. */
export function shapeCenter(geometry: ShapeGeometry): Vec {
  return geometry.type === 'ellipse' ? { x: geometry.cx, y: geometry.cy } : mean(geometry.points);
}

/** Uniformly scale and rotate a shape around `pivot`. */
export function transformShape(geometry: ShapeGeometry, pivot: Vec, scale: number, rotation: number): ShapeGeometry {
  if (geometry.type === 'ellipse') {
    const c = rotate({ x: pivot.x + (geometry.cx - pivot.x) * scale, y: pivot.y + (geometry.cy - pivot.y) * scale }, pivot, rotation);

    return {
      ...geometry,
      cx: c.x,
      cy: c.y,
      rx: geometry.rx * scale,
      ry: geometry.ry * scale,
      angle: geometry.rx === geometry.ry ? 0 : geometry.angle + rotation,
    };
  }

  return {
    ...geometry,
    points: geometry.points.map((p) =>
      rotate({ x: pivot.x + (p.x - pivot.x) * scale, y: pivot.y + (p.y - pivot.y) * scale }, pivot, rotation),
    ),
  };
}

/** Rotation (radians) under which a hold-drag counts as "just resizing" and stays unrotated. */
export const HOLD_DRAG_ROTATION_DEADBAND = 6 * DEG;

/**
 * Apple's post-snap drag: the pen keeps adjusting the snapped shape until it lifts.
 *   line     the end under the pen follows it (start fixed), with the same 45° snapping.
 *   closed   scale + rotate around the shape's centre by how the pen moved relative to that centre
 *            since the snap; a small rotation is held at zero so resizing alone never tilts the shape.
 */
export function adjustSnappedShape(snapped: RecognizedShape, holdPoint: Vec, pen: Vec): RecognizedShape {
  if (snapped.kind === 'none' || snapped.kind === 'smooth') return snapped;

  if (snapped.kind === 'radical') {
    // The pen is at the end of the vinculum: dragging it stretches the bar, never the tick or the line.
    const { anchor, params } = snapped.radical;

    return radicalShape({ anchor, params: normalizeRadicalParams({ ...params, bar: params.bar + (pen.x - holdPoint.x) }) });
  }

  if ('symbol' in snapped) return adjustMathSymbol(snapped, holdPoint, pen);

  if (snapped.kind === 'line') {
    const [start, end] = snapped.geometry.points;
    const moved = { x: end.x + (pen.x - holdPoint.x), y: end.y + (pen.y - holdPoint.y) };

    if (dist(start, moved) === 0) return snapped;

    return { ...snapped, geometry: { ...snapped.geometry, points: snapLineEnd(start, moved) } };
  }

  const pivot = shapeCenter(snapped.geometry);
  const from = dist(holdPoint, pivot);
  const to = dist(pen, pivot);

  if (from < 1e-6 || to < 1e-6) return snapped;

  const scale = to / from;
  let rotation = wrapAngle(Math.atan2(pen.y - pivot.y, pen.x - pivot.x) - Math.atan2(holdPoint.y - pivot.y, holdPoint.x - pivot.x));

  if (Math.abs(rotation) < HOLD_DRAG_ROTATION_DEADBAND) rotation = 0;

  const geometry = transformShape(snapped.geometry, pivot, scale, rotation);

  return { ...snapped, geometry } as RecognizedShape;
}
