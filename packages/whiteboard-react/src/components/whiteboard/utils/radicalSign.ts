/**
 * The square-root sign (√) — geometry and recognition. PURE: no Fabric, no DOM.
 *
 * GEOMETRY. A radical is described by three lengths, never by a scale:
 *   height  stem top (where the vinculum starts) down to the stem's bottom vertex
 *   bar     the vinculum's length, to the right of the stem top
 *   tick    the short left stroke that drops into the bottom vertex
 * Its points are generated in a LOCAL frame whose origin is the stem top, so stretching the bar or the
 * depth regenerates the polyline with the tick unchanged and the stroke width untouched — the object is
 * never scaled. The stem leans right like a typeset radical; its lean grows with the height only until
 * it reaches the tick's own size, so a very deep radical stands up straighter (as in TeX).
 *
 * RECOGNITION is deliberately strict — the bias is "do nothing": a "v", a ✓ or a cursive letter in
 * ordinary writing must stay ink. The stroke must be ONE stroke made of exactly three straight pieces:
 *   1. a short tick going DOWN (and to the right),
 *   2. a long stem going UP (and to the right), clearly longer than the tick,
 *   3. a horizontal vinculum going RIGHT, at least `minBarRatio` × the stem's height.
 * The third piece is what tells a radical from a "v" or a tick mark: without a long, flat bar at the
 * top nothing is recognised. An optional tiny lead-in serif before the tick and a tiny flick at the
 * bar's end are tolerated.
 */

export interface RadicalVec {
  x: number;
  y: number;
}

export interface RadicalParams {
  /** Stem top → bottom vertex, vertical, scene px. */
  height: number;
  /** Vinculum length, scene px. */
  bar: number;
  /** Tick (short left stroke) length, scene px. Constant under stretching. */
  tick: number;
}

/** A radical placed in the scene: `anchor` is the stem top / vinculum start. */
export interface RadicalShape {
  anchor: RadicalVec;
  params: RadicalParams;
}

/** Proportions of the clean radical. Exported so tests and the controls share them. */
export const RADICAL_PROPORTIONS = {
  /** Stem lean (horizontal run) as a fraction of the height… */
  slantPerHeight: 0.3,
  /** …capped at this multiple of the tick, so deep radicals stand up straighter. */
  maxSlantPerTick: 1.1,
  /** The tick's angle below horizontal, degrees (it drops steeply into the bottom vertex). */
  tickAngleDeg: 58,
  /** The lead-in serif, as a fraction of the tick, and its rise angle above horizontal. */
  serif: 0.3,
  serifAngleDeg: 28,
  /** Tick as a fraction of the height, when recognised: clamp range and the default. */
  minTickPerHeight: 0.26,
  maxTickPerHeight: 0.55,
  defaultTickPerHeight: 0.42,
  /** Stretch floors: the stem is never shorter than this × the tick, the bar never shorter than the tick. */
  minHeightPerTick: 1.6,
  minBarPerTick: 1,
} as const;

const P = RADICAL_PROPORTIONS;
const DEG = Math.PI / 180;

/** Clamp `params` to a well-formed radical (finite, positive, stem longer than the tick). */
export function normalizeRadicalParams(params: RadicalParams): RadicalParams {
  const tick = Number.isFinite(params.tick) && params.tick > 0 ? params.tick : 10;
  const height = Math.max(Number.isFinite(params.height) ? params.height : 0, tick * P.minHeightPerTick);
  const bar = Math.max(Number.isFinite(params.bar) ? params.bar : 0, tick * P.minBarPerTick);

  return { height, bar, tick };
}

/** The stem's horizontal lean for a radical of this size. */
export function radicalSlant(params: RadicalParams): number {
  return Math.min(params.height * P.slantPerHeight, params.tick * P.maxSlantPerTick);
}

/** Named vertices of a radical in its LOCAL frame (stem top at the origin, y down). */
export interface RadicalVertices {
  serif: RadicalVec;
  tickTop: RadicalVec;
  bottom: RadicalVec;
  top: RadicalVec;
  barEnd: RadicalVec;
}

export function radicalVertices(input: RadicalParams): RadicalVertices {
  const params = normalizeRadicalParams(input);
  const { height, bar, tick } = params;
  const bottom = { x: -radicalSlant(params), y: height };
  const tickAngle = P.tickAngleDeg * DEG;
  const tickTop = { x: bottom.x - tick * Math.cos(tickAngle), y: bottom.y - tick * Math.sin(tickAngle) };
  const serifAngle = P.serifAngleDeg * DEG;
  const serifLength = tick * P.serif;
  const serif = { x: tickTop.x - serifLength * Math.cos(serifAngle), y: tickTop.y + serifLength * Math.sin(serifAngle) };

  return { serif, tickTop, bottom, top: { x: 0, y: 0 }, barEnd: { x: bar, y: 0 } };
}

/** The radical's polyline in its LOCAL frame: serif → tick top → bottom → stem top → bar end. */
export function radicalLocalPoints(params: RadicalParams): RadicalVec[] {
  const v = radicalVertices(params);

  return [v.serif, v.tickTop, v.bottom, v.top, v.barEnd];
}

/** The radical's polyline in scene coordinates (unrotated, anchored at the stem top). */
export function radicalScenePoints(shape: RadicalShape): RadicalVec[] {
  return radicalLocalPoints(shape.params).map((p) => ({ x: p.x + shape.anchor.x, y: p.y + shape.anchor.y }));
}

/** A fresh radical of a given height (the explicit «insert» path). */
export function defaultRadicalParams(height: number): RadicalParams {
  const tick = height * P.defaultTickPerHeight;

  return normalizeRadicalParams({ height, tick, bar: height * 1.6 });
}

// ---------------------------------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------------------------------

export interface RecognizeRadicalOptions {
  /** Smallest bounding-box diagonal (scene units) that may become a radical. */
  minSize: number;
  /** Vinculum length / stem height must reach this. Defaults to {@link RADICAL_THRESHOLDS.minBarRatio}. */
  minBarRatio?: number;
}

/** Every tunable in one place; the tests document what each guards. */
export const RADICAL_THRESHOLDS = {
  resample: 72,
  /** Tick direction (screen angle, y down): from down-right to just past straight down. */
  tickMinDeg: 20,
  tickMaxDeg: 115,
  /** Stem direction: up, leaning right at most this far from vertical, left at most `stemMaxLeftDeg`. */
  stemMaxRightDeg: 50,
  stemMaxLeftDeg: 15,
  /** Vinculum: within this many degrees of horizontal, going right. */
  barMaxTiltDeg: 14,
  /** Stem length / tick length. */
  minStemPerTick: 1.3,
  /** Vinculum length / stem height (the "long vinculum" rule). */
  minBarRatio: 0.65,
  /** Vinculum length / tick length. */
  minBarPerTick: 1.4,
  /** The tick must start below the vinculum by this fraction of the height. */
  tickTopBelowBar: 0.15,
  /** Per-piece straightness: max deviation from the chord, fraction of the piece's length. */
  tickMaxDev: 0.2,
  stemMaxDev: 0.12,
  barMaxDev: 0.12,
  /** Arc length / sum of the three chords — no scribbles or doubled-back strokes. */
  maxLengthRatio: 1.25,
  /** A lead-in serif / end flick is dropped when shorter than this fraction of the bbox diagonal. */
  maxStubRatio: 0.14,
} as const;

const T = RADICAL_THRESHOLDS;

const dist = (a: RadicalVec, b: RadicalVec): number => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(points: RadicalVec[]): number {
  let total = 0;

  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1], points[i]);

  return total;
}

function resample(points: RadicalVec[], count: number): RadicalVec[] {
  const total = pathLength(points);

  if (points.length < 2 || total === 0) return points.slice();

  const step = total / (count - 1);
  const out: RadicalVec[] = [{ ...points[0] }];
  let carried = 0;
  let prev = points[0];

  for (let i = 1; i < points.length; i += 1) {
    const current = points[i];
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
  }

  while (out.length < count) out.push({ ...points[points.length - 1] });

  return out;
}

function segmentDistance(p: RadicalVec, a: RadicalVec, b: RadicalVec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;

  if (lengthSq === 0) return dist(p, a);

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq));

  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

const heading = (a: RadicalVec, b: RadicalVec): number => Math.atan2(b.y - a.y, b.x - a.x);

interface FittedLine {
  point: RadicalVec;
  dir: RadicalVec;
}

/** Least-squares line through the middle of a piece (its rounded ends left out). */
function fitPieceLine(points: RadicalVec[], from: number, to: number): FittedLine | null {
  const span = to - from;
  const lo = from + Math.floor(span * 0.2);
  const hi = to - Math.floor(span * 0.2);

  if (hi - lo < 1) return null;

  let mx = 0;
  let my = 0;

  for (let i = lo; i <= hi; i += 1) {
    mx += points[i].x;
    my += points[i].y;
  }

  const count = hi - lo + 1;

  mx /= count;
  my /= count;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for (let i = lo; i <= hi; i += 1) {
    const dx = points[i].x - mx;
    const dy = points[i].y - my;

    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);

  return { point: { x: mx, y: my }, dir: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function refineCorner(l1: FittedLine | null, l2: FittedLine | null, fallback: RadicalVec, maxShift: number): RadicalVec {
  if (!l1 || !l2) return fallback;

  const cross = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;

  if (Math.abs(cross) < 0.2) return fallback;

  const t = ((l2.point.x - l1.point.x) * l2.dir.y - (l2.point.y - l1.point.y) * l2.dir.x) / cross;
  const corner = { x: l1.point.x + t * l1.dir.x, y: l1.point.y + t * l1.dir.y };

  return dist(corner, fallback) <= maxShift ? corner : fallback;
}

/** Max deviation of the samples between two vertex indices from their chord, over the chord length. */
function pieceDeviation(points: RadicalVec[], from: number, to: number): number {
  const a = points[from];
  const b = points[to];
  const length = dist(a, b);

  if (length === 0) return Infinity;

  let worst = 0;

  for (let i = from + 1; i < to; i += 1) worst = Math.max(worst, segmentDistance(points[i], a, b));

  return worst / length;
}

/**
 * Recognise a hand-drawn √ (tick down, stem up, vinculum right) in ONE stroke. Returns the clean radical
 * sized to the drawing — anchored at the drawn stem top, with the drawn height and bar length — or null.
 */
export function recognizeRadical(input: readonly RadicalVec[], options: RecognizeRadicalOptions): RadicalShape | null {
  const raw: RadicalVec[] = [];

  for (const p of input) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;

    const prev = raw[raw.length - 1];

    if (!prev || prev.x !== p.x || prev.y !== p.y) raw.push({ x: p.x, y: p.y });
  }

  if (raw.length < 6) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of raw) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  const diagonal = Math.hypot(maxX - minX, maxY - minY);

  if (!(diagonal >= options.minSize) || diagonal === 0) return null;

  const points = resample(raw, T.resample);
  const n = points.length;
  const stub = T.maxStubRatio * diagonal;

  // The bottom vertex is the lowest point; the stem top is the corner farthest from the bottom → end
  // chord; the tick top is the start, or — with a lead-in serif — the corner farthest from start → bottom.
  let ib = 0;

  for (let i = 1; i < n; i += 1) if (points[i].y > points[ib].y) ib = i;

  if (ib === 0 || ib >= n - 2) return null;

  const farthest = (from: number, to: number, a: RadicalVec, b: RadicalVec): number => {
    let best = -1;
    let bestDistance = -1;

    for (let i = from; i <= to; i += 1) {
      const d = segmentDistance(points[i], a, b);

      if (d > bestDistance) {
        bestDistance = d;
        best = i;
      }
    }

    return best;
  };

  // The bar ends at the point farthest from the bottom vertex; anything after it is a flick.
  let id = ib + 1;

  for (let i = ib + 1; i < n; i += 1) if (dist(points[i], points[ib]) > dist(points[id], points[ib])) id = i;

  if (pathLength(points.slice(id)) > stub) return null;

  const ic = farthest(ib + 1, id - 1, points[ib], points[id]);

  if (ic <= ib) return null;

  let ia = 0;
  const serifCorner = ib > 1 ? farthest(1, ib - 1, points[0], points[ib]) : -1;

  if (serifCorner > 0 && pieceDeviation(points, 0, ib) > T.tickMaxDev) {
    // Only a SHORT lead-in may precede the tick.
    if (pathLength(points.slice(0, serifCorner + 1)) > stub) return null;
    ia = serifCorner;
  }

  const a = points[ia];
  const d = points[id];
  // A hand rounds its corners, so the raw vertices sit inside the curve: take the corners where the
  // pieces' own fitted lines meet instead (falling back to the raw vertex when the fit is unstable).
  const tickLine = fitPieceLine(points, ia, ib);
  const stemLine = fitPieceLine(points, ib, ic);
  const barLine = fitPieceLine(points, ic, id);
  const b = refineCorner(tickLine, stemLine, points[ib], 0.15 * diagonal);
  const c = refineCorner(stemLine, barLine, points[ic], 0.15 * diagonal);

  const tickLength = dist(a, b);
  const stemLength = dist(b, c);
  const barLength = d.x - c.x;
  const height = b.y - c.y;

  if (tickLength === 0 || stemLength === 0 || height <= 0 || barLength <= 0) return null;

  // 1. Tick: down (and right).
  const tickDeg = heading(a, b) / DEG;

  if (tickDeg < T.tickMinDeg || tickDeg > T.tickMaxDeg) return null;

  // 2. Stem: up, near vertical, leaning right (screen −90° is straight up).
  const stemFromVertical = heading(b, c) / DEG + 90;

  if (stemFromVertical > T.stemMaxRightDeg || stemFromVertical < -T.stemMaxLeftDeg) return null;
  if (stemLength < T.minStemPerTick * tickLength) return null;

  // 3. Vinculum: flat, going right, and LONG.
  const barDeg = heading(c, d) / DEG;

  if (Math.abs(barDeg) > T.barMaxTiltDeg) return null;
  if (barLength < (options.minBarRatio ?? T.minBarRatio) * height) return null;
  if (barLength < T.minBarPerTick * tickLength) return null;

  // The tick starts well below the bar, and the bar sits at the top of the drawing.
  if (a.y < c.y + T.tickTopBelowBar * height) return null;
  if (d.x < b.x) return null;

  // Each piece straight on its own; no scribbling.
  if (pieceDeviation(points, ia, ib) > T.tickMaxDev) return null;
  if (pieceDeviation(points, ib, ic) > T.stemMaxDev) return null;
  if (pieceDeviation(points, ic, id) > T.barMaxDev) return null;
  if (pathLength(points.slice(ia, id + 1)) / (tickLength + stemLength + dist(c, d)) > T.maxLengthRatio) return null;

  const tick = Math.min(Math.max(tickLength, height * P.minTickPerHeight), height * P.maxTickPerHeight);

  return {
    anchor: { x: c.x, y: c.y },
    params: normalizeRadicalParams({ height, bar: barLength, tick }),
  };
}
