/**
 * Hand-drawn math symbols that clean up like the square root (`radicalSign.ts`): round brackets ( ),
 * square brackets [ ], curly braces { }, the integral sign ∫ and a one-stroke arrow →.
 * PURE: no Fabric, no DOM.
 *
 * GEOMETRY. Every symbol is described by a few lengths, never by a scale, and generated in a LOCAL frame
 * whose origin is the symbol's FIRST point (the anchor): the top end of a bracket / brace / integral, the
 * tail of an arrow. Stretching changes one length (a bracket's height, an arrow's length) and regenerates
 * the points with the rest unchanged — the curl of a brace, the serifs of a bracket and an arrow's head
 * keep their size, and the line keeps its width.
 *
 * RECOGNITION is deliberately strict — the bias is "do nothing": a c, C, l, 1, f, S, J, v or ✓ in
 * ordinary writing must stay ink. Each recogniser reads ONE stroke and checks the few things that make
 * its symbol what it is (see each function). `strict` is the pen-LIFT reading (no pause): tighter
 * thresholds, and the integral is never recognised there (a one-stroke "f" body is the same shape and
 * would snap before its crossbar is drawn) — it needs the deliberate hold.
 */

export interface SymbolVec {
  x: number;
  y: number;
}

/** Which way a bracket opens: `left` is «(», «[», «{»; `right` is «)», «]», «}». */
export type BracketSide = 'left' | 'right';

export type MathSymbolParams =
  /** Arc: `height` end to end, `bow` its depth (constant under stretching). */
  | { kind: 'paren'; side: BracketSide; height: number; bow: number }
  /** Stem `height`, serif `arm` (constant). */
  | { kind: 'bracket'; side: BracketSide; height: number; arm: number }
  /** End to end `height`, `depth` from the ends to the middle point (constant). */
  | { kind: 'brace'; side: BracketSide; height: number; depth: number }
  /** Hook tip to hook tip `height`, `hook` width (constant). */
  | { kind: 'integral'; height: number; hook: number }
  /** Tail → tip `length` along `angle` (radians, screen), barb length `head` (constant). */
  | { kind: 'arrow'; length: number; angle: number; head: number };

export type MathSymbolKind = MathSymbolParams['kind'];

export const MATH_SYMBOL_KINDS: readonly MathSymbolKind[] = ['paren', 'bracket', 'brace', 'integral', 'arrow'];

/** A symbol placed in the scene: `anchor` is its first point (top end, or an arrow's tail). */
export interface MathSymbolShape {
  anchor: SymbolVec;
  params: MathSymbolParams;
}

const DEG = Math.PI / 180;

/** Proportions of the clean symbols. */
export const MATH_SYMBOL_PROPORTIONS = {
  /** Height floors, as multiples of the constant part. */
  minParenHeightPerBow: 2.4,
  minBracketHeightPerArm: 1.6,
  minBraceHeightPerDepth: 2.4,
  minIntegralHeightPerHook: 2.5,
  minArrowLengthPerHead: 1.5,
  /** Arrow barbs, degrees either side of the shaft. */
  arrowBarbDeg: 28,
  /** Points per arc. */
  arcSegments: 24,
} as const;

const P = MATH_SYMBOL_PROPORTIONS;

const finite = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);
const positive = (value: number, fallback: number): number => (Number.isFinite(value) && value > 0 ? value : fallback);

/** Clamp `params` to a well-formed symbol (finite, positive, never shorter than its constant part allows). */
export function normalizeMathSymbolParams(params: MathSymbolParams): MathSymbolParams {
  switch (params.kind) {
    case 'paren': {
      const bow = positive(params.bow, 8);

      return { kind: 'paren', side: params.side === 'right' ? 'right' : 'left', bow, height: Math.max(finite(params.height, 0), bow * P.minParenHeightPerBow) };
    }
    case 'bracket': {
      const arm = positive(params.arm, 8);

      return { kind: 'bracket', side: params.side === 'right' ? 'right' : 'left', arm, height: Math.max(finite(params.height, 0), arm * P.minBracketHeightPerArm) };
    }
    case 'brace': {
      const depth = positive(params.depth, 10);

      return { kind: 'brace', side: params.side === 'right' ? 'right' : 'left', depth, height: Math.max(finite(params.height, 0), depth * P.minBraceHeightPerDepth) };
    }
    case 'integral': {
      const hook = positive(params.hook, 10);

      return { kind: 'integral', hook, height: Math.max(finite(params.height, 0), hook * P.minIntegralHeightPerHook) };
    }
    case 'arrow': {
      const head = positive(params.head, 10);

      return { kind: 'arrow', head, angle: finite(params.angle, 0), length: Math.max(finite(params.length, 0), head * P.minArrowLengthPerHead) };
    }
  }
}

/** True when `value` is a usable persisted {@link MathSymbolParams}. */
export function isMathSymbolParams(value: unknown): value is MathSymbolParams {
  if (!value || typeof value !== 'object') return false;

  const p = value as Record<string, unknown>;
  const num = (key: string) => typeof p[key] === 'number' && Number.isFinite(p[key] as number);

  switch (p.kind) {
    case 'paren':
      return num('height') && num('bow');
    case 'bracket':
      return num('height') && num('arm');
    case 'brace':
      return num('height') && num('depth');
    case 'integral':
      return num('height') && num('hook');
    case 'arrow':
      return num('length') && num('angle') && num('head');
    default:
      return false;
  }
}

const mirror = (points: SymbolVec[]): SymbolVec[] => points.map((p) => ({ x: -p.x, y: p.y }));

function arc(cx: number, cy: number, r: number, from: number, to: number, segments: number): SymbolVec[] {
  const out: SymbolVec[] = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = from + ((to - from) * i) / segments;

    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }

  return out;
}

function cubic(a: SymbolVec, b: SymbolVec, c: SymbolVec, d: SymbolVec, segments: number): SymbolVec[] {
  const out: SymbolVec[] = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const u = 1 - t;

    out.push({
      x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
      y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
    });
  }

  return out;
}

/** Append `next` to `out`, dropping a first point that repeats the last one. */
function join(out: SymbolVec[], next: SymbolVec[]): SymbolVec[] {
  const last = out[out.length - 1];
  const start = last && next.length && Math.hypot(next[0].x - last.x, next[0].y - last.y) < 1e-9 ? 1 : 0;

  for (let i = start; i < next.length; i += 1) out.push(next[i]);

  return out;
}

/** The symbol's polyline in its LOCAL frame: the first point is the origin (the anchor). */
export function mathSymbolLocalPoints(input: MathSymbolParams): SymbolVec[] {
  const points = generateLocalPoints(normalizeMathSymbolParams(input));
  const origin = points[0];

  // Exactly at the origin, whatever the trigonometry rounded to.
  return points.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y }));
}

function generateLocalPoints(input: MathSymbolParams): SymbolVec[] {
  const params = normalizeMathSymbolParams(input);

  switch (params.kind) {
    case 'paren': {
      // A circular arc from (0, 0) to (0, h) bulging left by `bow`.
      const { height: h, bow: b } = params;
      const r = (h * h) / 4 / (2 * b) + b / 2;
      const phi = Math.asin(Math.min(1, h / 2 / r));
      const points = arc(r - b, h / 2, r, Math.PI + phi, Math.PI - phi, P.arcSegments);

      points[0] = { x: 0, y: 0 };
      points[points.length - 1] = { x: 0, y: h };

      return params.side === 'left' ? points : mirror(points);
    }
    case 'bracket': {
      const { height: h, arm: a } = params;
      const points = [
        { x: 0, y: 0 },
        { x: -a, y: 0 },
        { x: -a, y: h },
        { x: 0, y: h },
      ];

      return params.side === 'left' ? points : mirror(points);
    }
    case 'brace': {
      // Quarter-circle curls of radius depth/2 at the ends and into the middle point, straight between.
      const { height: h, depth: d } = params;
      const r = d / 2;
      const n = 8;
      const points: SymbolVec[] = [];

      join(points, arc(0, r, r, -Math.PI / 2, -Math.PI, n));
      join(points, arc(-2 * r, h / 2 - r, r, 0, Math.PI / 2, n));
      join(points, arc(-2 * r, h / 2 + r, r, -Math.PI / 2, 0, n));
      join(points, arc(0, h - r, r, Math.PI, Math.PI / 2, n));

      return params.side === 'left' ? points : mirror(points);
    }
    case 'integral': {
      // A leaning stem with a hook over the top to the right and one under the bottom to the left
      // (point-symmetric), the tips 0.45·hook in from the very top / bottom.
      const w = params.hook;
      const total = params.height + 0.9 * w;
      const lean = Math.min(0.16 * total, 0.8 * w);
      const a = { x: lean / 2, y: w };
      const b = { x: -lean / 2, y: total - w };
      const stem = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const u = { x: (b.x - a.x) / stem, y: (b.y - a.y) / stem };
      const tip = { x: lean / 2 + w, y: 0.45 * w };
      const top = cubic(tip, { x: tip.x, y: -0.1 * w }, { x: a.x - 0.75 * w * u.x, y: a.y - 0.75 * w * u.y }, a, 12);
      const bottom = top
        .slice()
        .reverse()
        .map((p) => ({ x: -p.x, y: total - p.y }));
      const points = join(top.slice(), bottom);

      return points;
    }
    case 'arrow': {
      // tail → tip → barb → tip → barb: one polyline, the tip retraced (round joins hide it).
      const { length, angle, head } = params;
      const tip = { x: length * Math.cos(angle), y: length * Math.sin(angle) };
      const barb = (side: number) => {
        const t = angle + Math.PI + side * P.arrowBarbDeg * DEG;

        return { x: tip.x + head * Math.cos(t), y: tip.y + head * Math.sin(t) };
      };

      return [{ x: 0, y: 0 }, tip, barb(1), { ...tip }, barb(-1)];
    }
  }
}

/** The symbol's polyline in scene coordinates. */
export function mathSymbolScenePoints(shape: MathSymbolShape): SymbolVec[] {
  return mathSymbolLocalPoints(shape.params).map((p) => ({ x: p.x + shape.anchor.x, y: p.y + shape.anchor.y }));
}

/** Index of the point the stretch handle sits on: the bottom end, or an arrow's tip. */
export function mathSymbolStretchIndex(params: MathSymbolParams): number {
  return params.kind === 'arrow' ? 1 : mathSymbolLocalPoints(params).length - 1;
}

/**
 * New params with the stretch point dragged to `local` (relative to the anchor, in the symbol's own
 * frame): a vertical symbol takes the pointer's depth as its height; an arrow's tip follows the pointer.
 */
export function stretchMathSymbol(params: MathSymbolParams, local: SymbolVec): MathSymbolParams {
  if (params.kind === 'arrow') {
    const length = Math.hypot(local.x, local.y);

    return normalizeMathSymbolParams(length > 0 ? { ...params, length, angle: Math.atan2(local.y, local.x) } : params);
  }

  return normalizeMathSymbolParams({ ...params, height: local.y });
}

// ---------------------------------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------------------------------

export interface RecognizeMathSymbolOptions {
  /** Smallest bounding-box diagonal (scene units) that may become a symbol. */
  minSize: number;
  /** The pen-lift reading: tighter thresholds, and no integral. */
  strict?: boolean;
}

/** Every tunable in one place; the tests document what each guards. `[hold, lift]` pairs. */
export const MATH_SYMBOL_THRESHOLDS = {
  resample: 64,
  paren: {
    /** Height / width. A c or C is about as wide as tall. */
    minAspect: [2.2, 2.5],
    /** Bow depth / height: an l or 1 is straighter than this; a C bulges more. */
    minBow: [0.08, 0.1],
    maxBow: 0.38,
    /** End-to-end chord, degrees from vertical. */
    maxChordTiltDeg: [20, 14],
    /** Deviation from an ideal bow profile, fraction of the bow (+2% of the height). */
    maxProfileDev: 0.32,
    /** Largest turn over a short window — a paren has no corners. */
    maxWindowTurnDeg: 28,
    /** Each half's own bend (deviation from its chord / its length): a rounded «<» is straight. */
    minHalfBend: 0.025,
  },
  bracket: {
    minAspect: [1.6, 1.8],
    maxStemTiltDeg: 12,
    maxArmTiltDeg: [22, 18],
    /** Serif length / height. */
    minArm: 0.1,
    maxArm: 0.7,
    maxArmRatio: 2.5,
    stemMaxDev: 0.05,
    armMaxDev: 0.22,
    maxLengthRatio: 1.25,
  },
  brace: {
    minAspect: [1.8, 2.0],
    /** The middle point's height on the brace, fraction from the top. */
    cuspMin: 0.32,
    cuspMax: 0.68,
    /** Turning through the middle point (±4 samples), degrees: sharp, unlike a paren's smooth bow. */
    minCuspTurnDeg: [45, 55],
    /** Each end curls by at least this much, the same way the middle point turns. */
    minCurlTurnDeg: 20,
  },
  integral: {
    minAspect: 2.5,
    /** Each hook's reach past the stem, fraction of the height. */
    minHook: 0.06,
    /** Each hook's turning, degrees; the two turn opposite ways (an S-like stroke). */
    minHookTurnDeg: 60,
    stemMaxDev: 0.08,
    maxStemTiltDeg: 30,
  },
  arrow: {
    rdpEpsilon: 0.045,
    shaftMaxDev: [0.06, 0.05],
    /** Barb length / shaft length. */
    minBarb: 0.12,
    maxBarb: 0.6,
    maxBarbRatio: 2.2,
    /** Barb angle off the reversed shaft, degrees. */
    minBarbDeg: 12,
    maxBarbDeg: 70,
    maxBarbAsymmetryDeg: 30,
    /** The pen returns to the tip within this fraction of the shorter barb. */
    maxReturnGap: 0.4,
    barbMaxDev: 0.25,
    angleSnapDeg: 6,
  },
} as const;

const T = MATH_SYMBOL_THRESHOLDS;

const pick = <V>(pair: readonly [V, V], strict: boolean | undefined): V => (strict ? pair[1] : pair[0]);

const dist = (a: SymbolVec, b: SymbolVec): number => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(points: SymbolVec[], from = 0, to = points.length - 1): number {
  let total = 0;

  for (let i = from + 1; i <= to; i += 1) total += dist(points[i - 1], points[i]);

  return total;
}

function resample(points: SymbolVec[], count: number): SymbolVec[] {
  const total = pathLength(points);

  if (points.length < 2 || total === 0) return points.slice();

  const step = total / (count - 1);
  const out: SymbolVec[] = [{ ...points[0] }];
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

function segmentDistance(p: SymbolVec, a: SymbolVec, b: SymbolVec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;

  if (lengthSq === 0) return dist(p, a);

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq));

  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/** Max deviation of the samples between two indices from their chord, over the chord length. */
function pieceDeviation(points: SymbolVec[], from: number, to: number): number {
  const length = dist(points[from], points[to]);

  if (length === 0) return Infinity;

  let worst = 0;

  for (let i = from + 1; i < to; i += 1) worst = Math.max(worst, segmentDistance(points[i], points[from], points[to]));

  return worst / length;
}

function wrap(angle: number): number {
  let a = angle;

  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;

  return a;
}

const headingOf = (a: SymbolVec, b: SymbolVec): number => Math.atan2(b.y - a.y, b.x - a.x);

/**
 * Signed turn at sample `i`, measured between chords `k` samples long on either side — chords, not
 * neighbouring samples, so pen jitter on a small symbol does not read as corners.
 */
function chordTurn(points: SymbolVec[], i: number, k: number): number {
  const a = points[Math.max(0, i - k)];
  const b = points[i];
  const c = points[Math.min(points.length - 1, i + k)];

  return wrap(headingOf(b, c) - headingOf(a, b));
}

/** Total signed turning between samples `from` and `to`, summed over `k`-sample chords. */
function turnBetween(points: SymbolVec[], from: number, to: number, k = 3): number {
  let total = 0;

  for (let i = Math.max(k, from); i + k <= Math.min(points.length - 1, to); i += k) {
    total += wrap(headingOf(points[i], points[i + k]) - headingOf(points[i - k], points[i]));
  }

  return total;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
}

function boxOf(points: SymbolVec[]): Box {
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

  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Finite, de-duplicated points; null when too few or too small. */
function prepare(input: readonly SymbolVec[], minSize: number): { raw: SymbolVec[]; box: Box } | null {
  const raw: SymbolVec[] = [];

  for (const p of input) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;

    const prev = raw[raw.length - 1];

    if (!prev || prev.x !== p.x || prev.y !== p.y) raw.push({ x: p.x, y: p.y });
  }

  if (raw.length < 6) return null;

  const box = boxOf(raw);
  const diagonal = Math.hypot(box.w, box.h);

  if (!(diagonal >= minSize) || diagonal === 0) return null;

  return { raw, box };
}

/** Top-to-bottom, resampled. */
function downward(raw: SymbolVec[]): SymbolVec[] {
  const ordered = raw[0].y <= raw[raw.length - 1].y ? raw : raw.slice().reverse();

  return resample(ordered, T.resample);
}

/** The ends sit at the very top and bottom of the drawing (no overshoot, no hook past them). */
function endsAtTopAndBottom(points: SymbolVec[], box: Box, slack: number): boolean {
  return points[0].y - box.minY <= slack * box.h && box.maxY - points[points.length - 1].y <= slack * box.h;
}

function monotoneDown(points: SymbolVec[], from: number, to: number, slack: number): boolean {
  for (let i = from + 1; i <= to; i += 1) if (points[i].y < points[i - 1].y - slack) return false;

  return true;
}

/**
 * ( or ): one smooth bow, tall and narrow, ends one above the other. The aspect rejects c and C, the
 * minimum bow rejects l, 1 and straight lines, the bow profile rejects a J's hook or an S, and the
 * corner check leaves square brackets and braces to their own recognisers.
 */
export function recognizeParen(input: readonly SymbolVec[], options: RecognizeMathSymbolOptions): MathSymbolShape | null {
  const ready = prepare(input, options.minSize);

  if (!ready) return null;

  const { raw, box } = ready;
  const t = T.paren;

  if (box.h < pick(t.minAspect, options.strict) * box.w || box.w < pick(t.minBow, options.strict) * box.h * 0.8) return null;

  const points = downward(raw);
  const start = points[0];
  const end = points[points.length - 1];
  const dy = end.y - start.y;

  if (dy <= 0 || !endsAtTopAndBottom(points, box, 0.08)) return null;
  if (Math.atan2(Math.abs(end.x - start.x), dy) / DEG > pick(t.maxChordTiltDeg, options.strict)) return null;
  if (!monotoneDown(points, 0, points.length - 1, 0.015 * box.h)) return null;

  // Signed distance from the chord: positive = left of a downward chord.
  const chord = dist(start, end);
  const devs = points.map((p) => ((end.x - start.x) * (p.y - start.y) - (end.y - start.y) * (p.x - start.x)) / chord);
  let peak = 0;

  for (let i = 1; i < devs.length; i += 1) if (Math.abs(devs[i]) > Math.abs(devs[peak])) peak = i;

  const sign = Math.sign(devs[peak]);
  const bow = Math.abs(devs[peak]);

  if (sign === 0 || bow < pick(t.minBow, options.strict) * dy || bow > t.maxBow * dy) return null;

  const peakAt = (points[peak].y - start.y) / dy;

  if (peakAt < 0.25 || peakAt > 0.75) return null;

  // Each half is itself curved — a narrow «<» or «v» with a rounded point has straight halves.
  if (pieceDeviation(points, 0, peak) < t.minHalfBend || pieceDeviation(points, peak, points.length - 1) < t.minHalfBend) return null;

  for (let i = 0; i < points.length; i += 1) {
    const u = Math.min(1, Math.max(0, (points[i].y - start.y) / dy));
    // A bow profile peaking where the drawing does (hands rarely bow exactly at mid-height).
    const v = u < peakAt ? (peakAt - u) / peakAt : (u - peakAt) / (1 - peakAt);
    const expected = bow * (1 - v * v);

    if (Math.abs(devs[i] * sign - expected) > t.maxProfileDev * bow + 0.02 * dy) return null;
  }

  for (let i = 4; i < points.length - 4; i += 1) {
    if (Math.abs(chordTurn(points, i, 4)) > t.maxWindowTurnDeg * DEG) return null;
  }

  return {
    anchor: { x: (start.x + end.x) / 2, y: start.y },
    params: normalizeMathSymbolParams({ kind: 'paren', side: sign > 0 ? 'left' : 'right', height: dy, bow }),
  };
}

interface Line {
  point: SymbolVec;
  dir: SymbolVec;
}

/** Least-squares line through the middle of a piece (its rounded ends left out). */
function fitPieceLine(points: SymbolVec[], from: number, to: number): Line | null {
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

function meet(l1: Line | null, l2: Line | null, fallback: SymbolVec, maxShift: number): SymbolVec {
  if (!l1 || !l2) return fallback;

  const cross = l1.dir.x * l2.dir.y - l1.dir.y * l2.dir.x;

  if (Math.abs(cross) < 0.2) return fallback;

  const t = ((l2.point.x - l1.point.x) * l2.dir.y - (l2.point.y - l1.point.y) * l2.dir.x) / cross;
  const corner = { x: l1.point.x + t * l1.dir.x, y: l1.point.y + t * l1.dir.y };

  return dist(corner, fallback) <= maxShift ? corner : fallback;
}

function farthestFrom(points: SymbolVec[], from: number, to: number, a: SymbolVec, b: SymbolVec): number {
  let best = from;
  let bestDistance = -1;

  for (let i = from; i <= to; i += 1) {
    const d = segmentDistance(points[i], a, b);

    if (d > bestDistance) {
      bestDistance = d;
      best = i;
    }
  }

  return best;
}

/**
 * [ or ]: exactly three straight pieces — a short serif, a long vertical stem, a short serif — with both
 * serifs on the same side. An L has one serif, a C or 5 has curves, a Z's middle is slanted.
 */
export function recognizeBracket(input: readonly SymbolVec[], options: RecognizeMathSymbolOptions): MathSymbolShape | null {
  const ready = prepare(input, options.minSize);

  if (!ready) return null;

  const { raw, box } = ready;
  const t = T.bracket;

  if (box.h < pick(t.minAspect, options.strict) * box.w || box.w < t.minArm * box.h * 0.7) return null;

  const points = downward(raw);
  const n = points.length;

  if (!endsAtTopAndBottom(points, box, 0.15)) return null;

  let mid = 0;

  for (let i = 1; i < n; i += 1) {
    if (Math.abs(points[i].y - (box.minY + box.maxY) / 2) < Math.abs(points[mid].y - (box.minY + box.maxY) / 2)) mid = i;
  }

  if (mid < 3 || mid > n - 4) return null;

  const i1 = farthestFrom(points, 1, mid - 1, points[0], points[mid]);
  const i2 = farthestFrom(points, mid + 1, n - 2, points[mid], points[n - 1]);

  if (i1 < 2 || i2 > n - 3 || i2 - i1 < 4) return null;

  const diagonal = Math.hypot(box.w, box.h);
  const arm1Line = fitPieceLine(points, 0, i1);
  const stemLine = fitPieceLine(points, i1, i2);
  const arm2Line = fitPieceLine(points, i2, n - 1);
  const c1 = meet(arm1Line, stemLine, points[i1], 0.12 * diagonal);
  const c2 = meet(stemLine, arm2Line, points[i2], 0.12 * diagonal);
  const start = points[0];
  const end = points[n - 1];
  const height = c2.y - c1.y;

  if (height <= 0) return null;

  // Stem: vertical and most of the height.
  if (Math.atan2(Math.abs(c2.x - c1.x), height) / DEG > t.maxStemTiltDeg || height < 0.7 * box.h) return null;

  // Serifs: flat, short, on the same side (both pointing away from the stem the same way).
  const arm1 = start.x - c1.x;
  const arm2 = end.x - c2.x;
  const maxTilt = pick(t.maxArmTiltDeg, options.strict);

  if (Math.sign(arm1) !== Math.sign(arm2) || arm1 === 0) return null;
  if ((Math.atan2(Math.abs(start.y - c1.y), Math.abs(arm1)) / DEG) > maxTilt) return null;
  if ((Math.atan2(Math.abs(end.y - c2.y), Math.abs(arm2)) / DEG) > maxTilt) return null;

  // …right to their tips: a J's hook or a 5's bowl curls up at the end; a serif ends flat.
  const tipTilt = (a: SymbolVec, b: SymbolVec) => Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) / DEG;

  if (tipTilt(points[0], points[3]) > maxTilt || tipTilt(points[n - 4], points[n - 1]) > maxTilt) return null;
  if (Math.sign(points[3].x - points[0].x) === Math.sign(arm1) || Math.sign(points[n - 1].x - points[n - 4].x) !== Math.sign(arm2)) return null;

  const a1 = Math.abs(arm1);
  const a2 = Math.abs(arm2);

  if (Math.min(a1, a2) < t.minArm * height || Math.max(a1, a2) > t.maxArm * height) return null;
  if (Math.max(a1, a2) / Math.min(a1, a2) > t.maxArmRatio) return null;

  // Each piece straight on its own; no scribbling.
  if (pieceDeviation(points, i1, i2) > t.stemMaxDev) return null;
  if (pieceDeviation(points, 0, i1) > t.armMaxDev || pieceDeviation(points, i2, n - 1) > t.armMaxDev) return null;
  if (pathLength(points) / (dist(start, c1) + dist(c1, c2) + dist(c2, end)) > t.maxLengthRatio) return null;

  const arm = (a1 + a2) / 2;
  const stemX = (c1.x + c2.x) / 2;
  const side: BracketSide = arm1 > 0 ? 'left' : 'right';

  return {
    anchor: { x: stemX + (side === 'left' ? arm : -arm), y: c1.y },
    params: normalizeMathSymbolParams({ kind: 'bracket', side, height, arm }),
  };
}

/**
 * { or }: both ends on one side, a SHARP middle point on the other side at mid-height, and each end
 * curling the same way the middle point turns. A 3 or ε has its outermost points at its bulges (not at
 * mid-height), a paren's middle is a smooth bow, a < has no curls.
 */
export function recognizeBrace(input: readonly SymbolVec[], options: RecognizeMathSymbolOptions): MathSymbolShape | null {
  const ready = prepare(input, options.minSize);

  if (!ready) return null;

  const { raw, box } = ready;
  const t = T.brace;

  if (box.h < pick(t.minAspect, options.strict) * box.w || box.w < 0.1 * box.h) return null;

  const points = downward(raw);
  const n = points.length;
  const start = points[0];
  const end = points[n - 1];

  if (!endsAtTopAndBottom(points, box, 0.12)) return null;
  if (!monotoneDown(points, 0, n - 1, 0.03 * box.h)) return null;

  // Ends on the right → «{» (middle point at the far left), and the mirror.
  const endsX = (start.x + end.x) / 2;
  const side: BracketSide = endsX > box.minX + box.w / 2 ? 'left' : 'right';
  const reach = (p: SymbolVec) => (side === 'left' ? p.x - box.minX : box.maxX - p.x);

  if (reach(start) < 0.6 * box.w || reach(end) < 0.6 * box.w) return null;

  let ic = 0;

  for (let i = 1; i < n; i += 1) if (reach(points[i]) < reach(points[ic])) ic = i;

  const cuspAt = (points[ic].y - box.minY) / box.h;

  if (cuspAt < t.cuspMin || cuspAt > t.cuspMax || ic < 8 || ic > n - 9) return null;

  // Moving towards the middle point from either end never backs away from it by much.
  let best = Infinity;

  for (let i = 0; i <= ic; i += 1) {
    if (reach(points[i]) > best + 0.1 * box.w) return null;
    best = Math.min(best, reach(points[i]));
  }

  best = Infinity;

  for (let i = n - 1; i >= ic; i -= 1) {
    if (reach(points[i]) > best + 0.1 * box.w) return null;
    best = Math.min(best, reach(points[i]));
  }

  // Sharp through the middle point (a true reversal reads as ±180°, so the size, not the sign).
  if (Math.abs(chordTurn(points, ic, 4)) < pick(t.minCuspTurnDeg, options.strict) * DEG) return null;

  // Each end curls towards the stem: drawn downwards, a «{» turns from going left to going down at the
  // top and from down to right at the bottom (screen headings decreasing); a «}» the other way.
  const sign = side === 'left' ? -1 : 1;
  const topSpan = Math.max(6, Math.round(ic * 0.45));
  const bottomSpan = Math.max(6, Math.round((n - 1 - ic) * 0.45));
  const curl = (from: number, to: number) => wrap(headingOf(points[to - 3], points[to]) - headingOf(points[from], points[from + 3])) * sign;
  const topCurl = curl(0, topSpan);
  const bottomCurl = curl(n - 1 - bottomSpan, n - 1);

  if (topCurl < t.minCurlTurnDeg * DEG || bottomCurl < t.minCurlTurnDeg * DEG) return null;

  const height = end.y - start.y;
  const depth = Math.abs(endsX - points[ic].x);

  if (height <= 0 || depth <= 0) return null;

  return {
    anchor: { x: endsX, y: start.y },
    params: normalizeMathSymbolParams({ kind: 'brace', side, height, depth }),
  };
}

/**
 * ∫: tall and narrow, starting top-right with a hook over the top, a straight steep stem, ending
 * bottom-left with a hook under the bottom — the two hooks turning opposite ways. S fails the aspect,
 * J has no top hook, a paren never turns both ways. HOLD ONLY: a one-stroke "f" body matches too.
 */
export function recognizeIntegral(input: readonly SymbolVec[], options: RecognizeMathSymbolOptions): MathSymbolShape | null {
  if (options.strict) return null;

  const ready = prepare(input, options.minSize);

  if (!ready) return null;

  const { raw, box } = ready;
  const t = T.integral;

  if (box.h < t.minAspect * box.w || box.w < 0.1 * box.h) return null;

  const points = downward(raw);
  const n = points.length;
  const start = points[0];
  const end = points[n - 1];

  if (!endsAtTopAndBottom(points, box, 0.25)) return null;
  if (start.x < box.minX + 0.5 * box.w || end.x > box.minX + 0.5 * box.w || start.x - end.x < 0.3 * box.w) return null;

  let i30 = -1;
  let i70 = -1;

  for (let i = 0; i < n; i += 1) {
    const u = (points[i].y - box.minY) / box.h;

    if (i30 < 0 && u >= 0.3) i30 = i;
    if (u <= 0.7) i70 = i;
  }

  if (i30 < 3 || i70 > n - 4 || i70 - i30 < 4) return null;
  if (!monotoneDown(points, i30, i70, 0.01 * box.h)) return null;
  if (pieceDeviation(points, i30, i70) > t.stemMaxDev) return null;

  const top = points[i30];
  const bottom = points[i70];

  if (Math.atan2(Math.abs(bottom.x - top.x), bottom.y - top.y) / DEG > t.maxStemTiltDeg) return null;
  if (start.x - top.x < t.minHook * box.h || bottom.x - end.x < t.minHook * box.h) return null;

  const topTurn = turnBetween(points, 0, i30);
  const bottomTurn = turnBetween(points, i70, n - 1);

  if (Math.sign(topTurn) === Math.sign(bottomTurn)) return null;
  if (Math.abs(topTurn) < t.minHookTurnDeg * DEG || Math.abs(bottomTurn) < t.minHookTurnDeg * DEG) return null;

  const hook = ((start.x - top.x) + (bottom.x - end.x)) / 2;

  return {
    anchor: { x: start.x, y: start.y },
    params: normalizeMathSymbolParams({ kind: 'integral', height: end.y - start.y, hook }),
  };
}

/** Ramer–Douglas–Peucker on an open polyline: the kept indices, in order. */
function rdp(points: SymbolVec[], epsilon: number): number[] {
  const keep = new Uint8Array(points.length);
  const stack: [number, number][] = [[0, points.length - 1]];

  keep[0] = 1;
  keep[points.length - 1] = 1;

  while (stack.length) {
    const [from, to] = stack.pop()!;
    let best = -1;
    let bestDistance = epsilon;

    for (let i = from + 1; i < to; i += 1) {
      const d = segmentDistance(points[i], points[from], points[to]);

      if (d > bestDistance) {
        bestDistance = d;
        best = i;
      }
    }

    if (best > 0) {
      keep[best] = 1;
      stack.push([from, best], [best, to]);
    }
  }

  const out: number[] = [];

  keep.forEach((k, i) => k && out.push(i));

  return out;
}

const angleBetween = (a: SymbolVec, b: SymbolVec): number => Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y) || 1))));

/**
 * → in ONE stroke, any direction: a long straight shaft, a short barb back from the tip, back to the
 * tip, and a short barb on the other side (or the same drawn head-first). A ✓, v, L, W, N or k never
 * has the "out, back to the same point, out the other side" head.
 */
export function recognizeArrow(input: readonly SymbolVec[], options: RecognizeMathSymbolOptions): MathSymbolShape | null {
  const ready = prepare(input, options.minSize);

  if (!ready) return null;

  const { raw, box } = ready;
  const points = resample(raw, T.resample);
  const diagonal = Math.hypot(box.w, box.h);
  const vertices = rdp(points, T.arrow.rdpEpsilon * diagonal);

  if (vertices.length !== 5) return null;

  return arrowFrom(points, vertices, options) ?? arrowFrom(points.slice().reverse(), vertices.map((i) => points.length - 1 - i).reverse(), options);
}

function arrowFrom(points: SymbolVec[], v: number[], options: RecognizeMathSymbolOptions): MathSymbolShape | null {
  const t = T.arrow;
  const [a, b, c, b2, d] = v.map((i) => points[i]);
  const length = dist(a, b);
  const l1 = dist(b, c);
  const l2 = dist(b2, d);

  if (length === 0 || l1 === 0 || l2 === 0) return null;
  if (pieceDeviation(points, v[0], v[1]) > pick(t.shaftMaxDev, options.strict)) return null;
  if (Math.min(l1, l2) < t.minBarb * length || Math.max(l1, l2) > t.maxBarb * length) return null;
  if (Math.max(l1, l2) / Math.min(l1, l2) > t.maxBarbRatio) return null;
  if (dist(b, b2) > t.maxReturnGap * Math.min(l1, l2)) return null;

  const back = { x: a.x - b.x, y: a.y - b.y };
  const barb1 = { x: c.x - b.x, y: c.y - b.y };
  const barb2 = { x: d.x - b2.x, y: d.y - b2.y };
  const angle1 = angleBetween(back, barb1) / DEG;
  const angle2 = angleBetween(back, barb2) / DEG;

  if (angle1 < t.minBarbDeg || angle1 > t.maxBarbDeg || angle2 < t.minBarbDeg || angle2 > t.maxBarbDeg) return null;
  if (Math.abs(angle1 - angle2) > t.maxBarbAsymmetryDeg) return null;

  const side1 = back.x * barb1.y - back.y * barb1.x;
  const side2 = back.x * barb2.y - back.y * barb2.x;

  if (Math.sign(side1) === Math.sign(side2)) return null;
  if (pieceDeviation(points, v[1], v[2]) > t.barbMaxDev || pieceDeviation(points, v[3], v[4]) > t.barbMaxDev) return null;

  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;

  if (Math.abs(wrap(angle - snapped)) <= t.angleSnapDeg * DEG) angle = snapped === 0 ? 0 : snapped;

  const head = Math.min(Math.max((l1 + l2) / 2, 0.12 * length), 0.45 * length);

  return {
    anchor: { x: a.x, y: a.y },
    params: normalizeMathSymbolParams({ kind: 'arrow', length, angle, head }),
  };
}

/**
 * Any of the symbols above, or null. The order matters only for speed: each recogniser rejects the
 * others' symbols on its own (the tests check every pair).
 */
export function recognizeMathSymbol(input: readonly SymbolVec[], options: RecognizeMathSymbolOptions): MathSymbolShape | null {
  return (
    recognizeArrow(input, options) ??
    recognizeBracket(input, options) ??
    recognizeBrace(input, options) ??
    recognizeParen(input, options) ??
    recognizeIntegral(input, options)
  );
}
