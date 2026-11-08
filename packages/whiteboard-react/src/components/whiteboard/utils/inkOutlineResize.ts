/**
 * Changing the size of FILLED ink — the brush and script pens, which save each stroke as the outline of
 * the mark (a filled polygon) instead of a line with a width. There is no width to set: the width is
 * the distance across the outline.
 *
 * Those outlines are traced as one closed loop: up one side of the stroke, round the far end, back down
 * the other side, round the near end. So the loop is mirror-symmetric in its point ORDER: point `i` sits
 * across the stroke from point `(a − i) mod n` for one fixed `a`. {@link findOutlineAxis} finds that `a`
 * (the pairing whose partners are closest together is the across-the-stroke one — any other pairing is
 * shifted along the stroke and so further apart). Resizing then moves every point away from (or toward)
 * the midpoint between it and its partner — the centre line — by the same factor, which keeps the
 * stroke's path, its tapers and the calligraphy nib's thick/thin pattern, only wider or thinner.
 *
 * The width estimate is a high percentile of the across distances, calibrated per pen (see
 * {@link OUTLINE_LAYOUTS}) so a stroke drawn at pen size `w` reads back as about `w`. Since resizing scales every across distance
 * by the same factor, the estimate scales with it: sizing 4 → 8 → 4 comes back to the same outline.
 */

export interface OutlinePoint {
  x: number;
  y: number;
}

type PathCommand = ReadonlyArray<string | number>;

/** Fewer points than this is not a stroke outline we can pair up safely. */
const MIN_POINTS = 6;
/** How many points score each candidate pairing (keeps the search linear on long strokes). */
const SCORE_SAMPLES = 96;
const SAME_POINT = 1e-6;
/** Percentile of the across distances taken as the stroke's width. */
const WIDTH_PERCENTILE = 0.9;
/**
 * The two pens that save outlines, told apart by how their loop is laid out: both trace one side, the
 * far end, the other side, then the near end — and the near end is a fixed number of points (the script
 * pen's round cap: 6 left after the repeated corner is dropped; the brush's nib arc: 10). So in a script
 * stroke point 0 sits across from point `n − 6`, in a brush stroke from point `n − 10`.
 *
 * `calibration`: a stroke drawn at pen size `w` has a 90th-percentile across distance of about
 * `w × calibration` (measured: the script pen's line is the pen size; the brush's slanted nib is fuller).
 */
const OUTLINE_LAYOUTS = {
  script: { nearEndPoints: 6, calibration: 1 },
  brush: { nearEndPoints: 10, calibration: 2.25 },
} as const;

/** Which pen drew the outline, when the stroke says so (newer strokes are marked when drawn). */
export type OutlinePen = keyof typeof OUTLINE_LAYOUTS;
/** A layout's pairing is trusted when it is within this factor of the closest pairing found. */
const LAYOUT_TOLERANCE = 2;

export interface OutlineFit {
  /** Point `i` sits across the stroke from point `(axis − i) mod n`. */
  axis: number;
  /** See {@link OUTLINE_LAYOUTS}; 1 for an outline of unknown origin. */
  calibration: number;
}

/**
 * The points of a single closed polygon path (`M`, then only `L`, then optional `Z`), with repeated
 * consecutive points (and a last point equal to the first) dropped. Null for anything else — curves,
 * several sub-paths, too few points.
 */
export function outlineLoopPoints(path: ReadonlyArray<PathCommand>): OutlinePoint[] | null {
  const points: OutlinePoint[] = [];

  for (let index = 0; index < path.length; index += 1) {
    const command = path[index]!;
    const op = String(command[0]).toUpperCase();

    if (op === 'Z') {
      if (index !== path.length - 1) return null;
      continue;
    }

    if ((op === 'M') !== (index === 0)) return null;
    if (op !== 'M' && op !== 'L') return null;

    const x = Number(command[1]);
    const y = Number(command[2]);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const last = points[points.length - 1];

    if (last && Math.abs(last.x - x) < SAME_POINT && Math.abs(last.y - y) < SAME_POINT) continue;

    points.push({ x, y });
  }

  const first = points[0];
  const last = points[points.length - 1];

  if (first && last && points.length > 1 && Math.abs(first.x - last.x) < SAME_POINT && Math.abs(first.y - last.y) < SAME_POINT) {
    points.pop();
  }

  return points.length >= MIN_POINTS ? points : null;
}

const partner = (axis: number, index: number, count: number) => (((axis - index) % count) + count) % count;

function pairingScore(points: ReadonlyArray<OutlinePoint>, axis: number, stride: number, stopAbove = Number.POSITIVE_INFINITY): number {
  const count = points.length;
  let score = 0;

  for (let index = 0; index < count && score < stopAbove; index += stride) {
    const a = points[index]!;
    const b = points[partner(axis, index, count)]!;

    score += (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  }

  return score;
}

/** The `a` whose partners `i` ↔ `(a − i) mod n` are closest together overall. */
export function findOutlineAxis(points: ReadonlyArray<OutlinePoint>): number {
  const count = points.length;
  const stride = Math.max(1, Math.floor(count / SCORE_SAMPLES));
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let axis = 0; axis < count; axis += 1) {
    const score = pairingScore(points, axis, stride, bestScore);

    if (score < bestScore) {
      bestScore = score;
      best = axis;
    }
  }

  return best;
}

/**
 * Which pen made the outline and how its sides pair up. A known pen's layout gives an exact, stable
 * pairing (so resizing back and forth returns to the same outline); anything else falls back to the
 * closest pairing. `pen` (the stroke's mark) settles it; without one the layout that pairs best is
 * taken, which is reliable on handwriting but can mistake a dead-straight brush line for script.
 */
export function fitOutline(points: ReadonlyArray<OutlinePoint>, pen?: OutlinePen): OutlineFit {
  const count = points.length;

  if (pen && count > OUTLINE_LAYOUTS[pen].nearEndPoints * 2) {
    return { axis: count - OUTLINE_LAYOUTS[pen].nearEndPoints, calibration: OUTLINE_LAYOUTS[pen].calibration };
  }

  const stride = Math.max(1, Math.floor(count / SCORE_SAMPLES));
  const closest = findOutlineAxis(points);
  const closestScore = pairingScore(points, closest, stride);
  let fit: OutlineFit | null = null;
  let fitScore = Number.POSITIVE_INFINITY;

  for (const layout of Object.values(OUTLINE_LAYOUTS)) {
    if (count <= layout.nearEndPoints * 2) continue;

    const axis = count - layout.nearEndPoints;
    const score = pairingScore(points, axis, stride);

    if (score < fitScore) {
      fitScore = score;
      fit = { axis, calibration: layout.calibration };
    }
  }

  return fit && fitScore <= closestScore * LAYOUT_TOLERANCE ? fit : { axis: closest, calibration: 1 };
}

/** The stroke's width as the pen size it was most likely drawn with. */
export function estimateOutlineWidth(points: ReadonlyArray<OutlinePoint>, { axis, calibration }: OutlineFit): number {
  const count = points.length;
  const across: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const b = points[partner(axis, index, count)]!;

    across.push(Math.hypot(points[index]!.x - b.x, points[index]!.y - b.y));
  }

  across.sort((x, y) => x - y);

  const value = across[Math.min(across.length - 1, Math.floor(across.length * WIDTH_PERCENTILE))] ?? 0;

  return value / calibration;
}

/** Every point moved from its centre-line midpoint by `scale` (2 = twice as wide). */
export function scaleOutline(points: ReadonlyArray<OutlinePoint>, axis: number, scale: number): OutlinePoint[] {
  const count = points.length;

  return points.map((point, index) => {
    const other = points[partner(axis, index, count)]!;
    const mx = (point.x + other.x) / 2;
    const my = (point.y + other.y) / 2;

    return { x: mx + (point.x - mx) * scale, y: my + (point.y - my) * scale };
  });
}

/**
 * A filled stroke outline resized so it reads as pen size `width`. Null when the path is not an outline
 * we understand, or it already has that width.
 */
export function resizeOutlinePath(
  path: ReadonlyArray<PathCommand>,
  width: number,
  pen?: OutlinePen,
): Array<Array<string | number>> | null {
  if (!(width > 0)) return null;

  const points = outlineLoopPoints(path);

  if (!points) return null;

  const fit = fitOutline(points, pen);
  const current = estimateOutlineWidth(points, fit);

  if (!(current > 0)) return null;

  const scale = width / current;

  if (Math.abs(scale - 1) < 0.01) return null;

  const next = scaleOutline(points, fit.axis, scale);

  return [...next.map((point, index): Array<string | number> => [index === 0 ? 'M' : 'L', point.x, point.y]), ['Z']];
}
