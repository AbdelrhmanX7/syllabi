import { boardPatternSpacingPx, sheetPatternPitch } from './paperSpacing';

import type { PdfScrollLayoutEntry } from './pdfScrollLayout';
import type { WhiteboardPage } from '../types';

/**
 * «Straighten line» / Straighten — the pure half (no DOM, no Fabric). Handwritten ink is levelled the way
 * Samsung Notes does it: one skew angle for the whole selection, the strokes cut into written lines
 * and the lines into words, then every line turned level about its own centre and every word slid
 * VERTICALLY so its baseline lands on the line's — on lined / grid paper, on the paper's rule. Rigid
 * moves only (a rotation and a vertical shift per stroke): nothing is ever scaled or bent, so the
 * writing stays the writer's. Dots (i, j), accents and apostrophes ride with the word they sit over;
 * they never become a word of their own (that would drop them onto the baseline).
 *
 * Coordinates are scene px, y down. Rotation is degrees clockwise on screen (Fabric's `angle`).
 * The Fabric half is `straightenInkCanvas.ts`.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface InkStroke {
  id: string;
  /** Scene points along the stroke (a flattened path). */
  points: readonly Vec[];
}

/** Horizontal rules at `origin + k × pitch`, `kMin ≤ k ≤ kMax` (both optional: an endless board). */
export interface RuleGrid {
  origin: number;
  pitch: number;
  kMin?: number;
  kMax?: number;
}

export interface StrokeTransform {
  id: string;
  /** Rotate the stroke about `pivot` by this many degrees (clockwise on screen) … */
  rotateDeg: number;
  pivot: Vec;
  /** … then move it. `dx` is always 0 today; kept so a caller applies one shape of transform. */
  dx: number;
  dy: number;
}

export interface StraightenOptions {
  /** The paper's horizontal rules; null/absent = level only, nothing to snap to. */
  rules?: RuleGrid | null;
  /** Largest skew corrected, degrees. Default 15. */
  maxSkewDeg?: number;
  /** Skew search step, degrees. Default 0.5. */
  skewStepDeg?: number;
}

export const MAX_SKEW_DEG = 15;
export const SKEW_STEP_DEG = 0.5;

// ---------------------------------------------------------------------------
// Small geometry
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const boxOf = (points: readonly Vec[]): Box => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const point of points) {
    if (point.x < left) left = point.x;
    if (point.x > right) right = point.x;
    if (point.y < top) top = point.y;
    if (point.y > bottom) bottom = point.y;
  }

  return { left, top, right, bottom };
};

const width = (box: Box) => box.right - box.left;
const height = (box: Box) => box.bottom - box.top;
const centreY = (box: Box) => (box.top + box.bottom) / 2;

/** Rotate `p` about `pivot` by `deg` degrees, clockwise on a y-down screen (Fabric's `angle` sense). */
export function rotatePoint(p: Vec, pivot: Vec, deg: number): Vec {
  if (deg === 0) return { x: p.x, y: p.y };

  const cos = Math.cos(deg * DEG);
  const sin = Math.sin(deg * DEG);
  const x = p.x - pivot.x;
  const y = p.y - pivot.y;

  return { x: pivot.x + x * cos - y * sin, y: pivot.y + x * sin + y * cos };
}

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));

  return sorted[index]!;
};

const median = (values: number[]): number => percentile(values, 0.5);

/** The value at which half the total weight is reached. */
const weightedMedian = (values: readonly number[], weights: readonly number[]): number => {
  const order = values.map((value, index) => ({ value, weight: Math.max(0, weights[index] ?? 0) })).sort((a, b) => a.value - b.value);
  const total = order.reduce((sum, entry) => sum + entry.weight, 0);

  if (total <= 0) return median([...values]);

  let seen = 0;

  for (const entry of order) {
    seen += entry.weight;

    if (seen >= total / 2) return entry.value;
  }

  return order[order.length - 1]?.value ?? 0;
};

// ---------------------------------------------------------------------------
// Skew
// ---------------------------------------------------------------------------

/** At most this many points feed the skew search — enough for the histogram, cheap on a long page. */
const SKEW_SAMPLE_CAP = 4000;

/**
 * The rotation (degrees, clockwise on screen) that levels the writing: the angle in
 * `[-maxDeg, maxDeg]` at which the points' horizontal projection histogram is peakiest (ink of a level
 * line piles into few bins; a slanted line smears across many). The histogram is binned finely and
 * scored through a sliding window `windowPx` tall (≈ a third of a letter height), so where a bin edge happens
 * to fall never decides the angle. Ties go to the smaller angle.
 */
export function estimateSkewDeg(points: readonly Vec[], windowPx: number, maxDeg = MAX_SKEW_DEG, stepDeg = SKEW_STEP_DEG): number {
  if (points.length < 2 || !(windowPx > 0)) return 0;

  const WINDOW_BINS = 4;
  const binPx = windowPx / WINDOW_BINS;

  const stride = Math.max(1, Math.ceil(points.length / SKEW_SAMPLE_CAP));
  const sample: Vec[] = [];

  for (let index = 0; index < points.length; index += stride) sample.push(points[index]!);

  let cx = 0;
  let cy = 0;

  for (const point of sample) {
    cx += point.x;
    cy += point.y;
  }

  cx /= sample.length;
  cy /= sample.length;

  let bestDeg = 0;
  let bestScore = -Infinity;
  const steps = Math.round(maxDeg / stepDeg);

  for (let step = -steps; step <= steps; step += 1) {
    const deg = step * stepDeg;
    const cos = Math.cos(deg * DEG);
    const sin = Math.sin(deg * DEG);
    const bins = new Map<number, number>();
    let low = Infinity;
    let high = -Infinity;

    for (const point of sample) {
      const y = cy + (point.x - cx) * sin + (point.y - cy) * cos;
      const bin = Math.floor(y / binPx);

      bins.set(bin, (bins.get(bin) ?? 0) + 1);
      if (bin < low) low = bin;
      if (bin > high) high = bin;
    }

    let score = 0;

    for (let bin = low - WINDOW_BINS + 1; bin <= high; bin += 1) {
      let window = 0;

      for (let offset = 0; offset < WINDOW_BINS; offset += 1) window += bins.get(bin + offset) ?? 0;

      score += window * window;
    }

    // Strictly better, or as good and closer to zero: never tilt for nothing.
    if (score > bestScore || (score === bestScore && Math.abs(deg) < Math.abs(bestDeg))) {
      bestScore = score;
      bestDeg = deg;
    }
  }

  return bestDeg;
}

// ---------------------------------------------------------------------------
// Lines and words
// ---------------------------------------------------------------------------

interface Measured {
  index: number;
  /** In the shared deskewed frame (every stroke rotated by the skew about one pivot). */
  box: Box;
  points: Vec[];
}

/** A stroke this much shorter than the letter height, and not wide, is a dot / hamza / diacritic. */
const SMALL_HEIGHT = 0.4;
const SMALL_WIDTH = 0.8;
/** A stroke taller than this many letter heights spans lines (a bracket, a margin line): left alone. */
const TALL = 2;
/** Two main strokes share a line when their vertical spans overlap by this share of the shorter … */
const LINE_OVERLAP = 0.5;
/** … or their centres are this close (in letter heights). */
const LINE_CENTRE_GAP = 0.3;
/** Words split at a horizontal gap wider than this share of the line's letter height. */
const WORD_GAP = 0.6;
/** A word narrower than this share of the letter height has no baseline of its own: it rides the line. */
const TINY_WORD = 0.6;

const unionFind = (count: number) => {
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;

    while (parent[root] !== root) root = parent[root]!;

    while (parent[index] !== root) {
      const next = parent[index]!;

      parent[index] = root;
      index = next;
    }

    return root;
  };
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const groups = (): number[][] => {
    const byRoot = new Map<number, number[]>();

    for (let index = 0; index < count; index += 1) {
      const root = find(index);

      byRoot.set(root, [...(byRoot.get(root) ?? []), index]);
    }

    return Array.from(byRoot.values());
  };

  return { join, groups };
};

/** Main strokes → lines (union-find on vertical overlap), top to bottom. */
function clusterLines(main: Measured[], letterHeight: number): Measured[][] {
  const { join, groups } = unionFind(main.length);

  for (let i = 0; i < main.length; i += 1) {
    const a = main[i]!.box;

    for (let j = i + 1; j < main.length; j += 1) {
      const b = main[j]!.box;
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const shorter = Math.max(1e-6, Math.min(height(a), height(b)));

      if (overlap / shorter >= LINE_OVERLAP || Math.abs(centreY(a) - centreY(b)) <= LINE_CENTRE_GAP * letterHeight) join(i, j);
    }
  }

  return groups()
    .map((members) => members.map((index) => main[index]!))
    .sort((a, b) => median(a.map((m) => centreY(m.box))) - median(b.map((m) => centreY(m.box))));
}

/** One line's main strokes → words, by horizontal gap. */
function clusterWords(line: Measured[], letterHeight: number): Measured[][] {
  const sorted = [...line].sort((a, b) => a.box.left - b.box.left);
  const words: Measured[][] = [];
  let current: Measured[] = [];
  let right = -Infinity;

  for (const stroke of sorted) {
    if (current.length > 0 && stroke.box.left - right > WORD_GAP * letterHeight) {
      words.push(current);
      current = [];
    }

    current.push(stroke);
    right = Math.max(right, stroke.box.right);
  }

  if (current.length > 0) words.push(current);

  return words;
}

/**
 * Where a word sits: the median of its bottom contour. Each column (a fifth of a letter height wide)
 * contributes its lowest ink; most columns of a word bottom out ON the baseline, descenders (g j p q y) are the minority that dips below — so the median is the baseline, not the bbox bottom.
 */
export function wordBaseline(points: readonly Vec[], letterHeight: number): number {
  if (points.length === 0) return 0;

  const column = Math.max(1e-6, letterHeight / 5);
  const bottoms = new Map<number, number>();

  for (const point of points) {
    const key = Math.floor(point.x / column);
    const current = bottoms.get(key);

    if (current === undefined || point.y > current) bottoms.set(key, point.y);
  }

  return median(Array.from(bottoms.values()));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The rule nearest `y`, as a rule index, within the grid's bounds. */
export function nearestRuleIndex(y: number, rules: RuleGrid): number {
  let k = Math.round((y - rules.origin) / rules.pitch);

  if (rules.kMin !== undefined) k = Math.max(rules.kMin, k);
  if (rules.kMax !== undefined) k = Math.min(rules.kMax, k);

  return k;
}

export const ruleY = (rules: RuleGrid, k: number): number => rules.origin + k * rules.pitch;

/**
 * Lines (top to bottom, by baseline) → the rule each lands on. Two lines wanting the same rule: the
 * later one takes the next rule down, so lines never pile up.
 */
export function assignRules(baselines: readonly number[], rules: RuleGrid): number[] {
  const out: number[] = [];
  let last = -Infinity;

  for (const baseline of baselines) {
    let k = nearestRuleIndex(baseline, rules);

    if (k <= last) k = last + 1;

    last = k;
    out.push(ruleY(rules, k));
  }

  return out;
}

/** A board page's rules (lined / grid): every multiple of the pattern spacing from scene y = 0. */
export function boardRuleGrid(page: Pick<WhiteboardPage, 'backgroundType' | 'paperSpacingMm'> | null | undefined): RuleGrid | null {
  if (!page || (page.backgroundType !== 'lined' && page.backgroundType !== 'grid')) return null;

  return { origin: 0, pitch: boardPatternSpacingPx(page) };
}

/**
 * An inserted sheet's rules in the continuous layout: the first line two pitches under the sheet's
 * top (`sheetRuleLineYs`), the last at least half a pitch above its bottom.
 */
export function sheetRuleGrid(
  entry: Pick<PdfScrollLayoutEntry, 'top' | 'height'>,
  layoutWidth: number,
  page: Pick<WhiteboardPage, 'backgroundType' | 'paperSpacingMm'> | null | undefined,
): RuleGrid | null {
  if (!page || (page.backgroundType !== 'lined' && page.backgroundType !== 'grid')) return null;

  const pitch = sheetPatternPitch(layoutWidth, page.paperSpacingMm);
  const origin = entry.top + 2 * pitch;
  const kMax = Math.floor((entry.top + entry.height - pitch / 2 - origin) / pitch);

  return kMax < 0 ? null : { origin, pitch, kMin: 0, kMax };
}

/** A free notebook sheet's rules (`boardRuled`): every `pitch` from the sheet's top, top edge excluded. */
export function boardSheetRuleGrid(
  entry: Pick<PdfScrollLayoutEntry, 'top' | 'height'>,
  pitch: number,
  page: Pick<WhiteboardPage, 'backgroundType'> | null | undefined,
): RuleGrid | null {
  if (!page || (page.backgroundType !== 'lined' && page.backgroundType !== 'grid') || !(pitch > 0)) return null;

  const origin = entry.top + pitch;
  const kMax = Math.floor((entry.top + entry.height - pitch / 4 - origin) / pitch);

  return kMax < 0 ? null : { origin, pitch, kMin: 0, kMax };
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

interface WordPlan {
  strokes: Measured[];
  box: Box;
  /** Shared-frame baseline; null for a word too narrow to measure (it rides the line). */
  baseline: number | null;
}

interface LinePlan {
  words: WordPlan[];
  box: Box;
  /** Shared-frame baseline. */
  baseline: number;
  /** Scene point the line turns about. */
  centre: Vec;
  /** Shared-frame y + this = scene y after the line is rotated about `centre` instead. */
  ownOffset: number;
}

const distanceToSpan = (value: number, low: number, high: number) => (value < low ? low - value : value > high ? value - high : 0);

/**
 * Transforms that straighten `strokes` (fewer than 2 → nothing to level). Strokes that end up where
 * they were are omitted. Every move is rigid: rotate about `pivot`, then shift by `(dx, dy)`.
 */
export function straightenInk(strokes: readonly InkStroke[], options: StraightenOptions = {}): StrokeTransform[] {
  const input = strokes.filter((stroke) => stroke.points.length > 0);

  if (input.length < 2) return [];

  const rawBoxes = input.map((stroke) => boxOf(stroke.points));
  // Letter height: the stroke height where half the writing's WIDTH is reached — a dot or a vertical
  // bracket is narrow and weighs nothing, a word weighs its length; so it is a word's height.
  const letterHeight = Math.max(1e-6, weightedMedian(rawBoxes.map(height), rawBoxes.map((box) => Math.max(1, width(box)))));
  const isSmall = (box: Box) => height(box) < SMALL_HEIGHT * letterHeight && width(box) < SMALL_WIDTH * letterHeight;
  const isTall = (box: Box) => height(box) > TALL * letterHeight;
  const mainIndexes = input.map((_, index) => index).filter((index) => !isSmall(rawBoxes[index]!) && !isTall(rawBoxes[index]!));

  if (mainIndexes.length === 0) return [];

  const mainPoints: Vec[] = [];

  for (const index of mainIndexes) mainPoints.push(...input[index]!.points);

  const skew = estimateSkewDeg(mainPoints, letterHeight / 3, options.maxSkewDeg ?? MAX_SKEW_DEG, options.skewStepDeg ?? SKEW_STEP_DEG);
  const cos = Math.cos(skew * DEG);
  const sin = Math.sin(skew * DEG);

  // One shared pivot for the clustering frame: shapes and relative places are what matter here.
  const all = boxOf(mainPoints);
  const pivot = { x: (all.left + all.right) / 2, y: centreY(all) };
  const measured = input.map((stroke, index): Measured => {
    const points = stroke.points.map((point) => rotatePoint(point, pivot, skew));

    return { index, box: boxOf(points), points };
  });
  const main = mainIndexes.map((index) => measured[index]!);
  const smalls = measured.filter((m) => isSmall(rawBoxes[m.index]!));

  const plans: LinePlan[] = clusterLines(main, letterHeight).map((line) => {
    const box = boxOf(line.flatMap((m) => m.points));
    const lineLetter = Math.max(1e-6, median(line.map((m) => height(m.box))));
    const words: WordPlan[] = clusterWords(line, lineLetter).map((members) => {
      const points = members.flatMap((m) => m.points);
      const wordBox = boxOf(points);

      return { strokes: members, box: wordBox, baseline: width(wordBox) < TINY_WORD * lineLetter ? null : wordBaseline(points, lineLetter) };
    });
    const known = words.map((word) => word.baseline).filter((value): value is number => value !== null);
    const baseline = known.length > 0 ? median(known) : wordBaseline(line.flatMap((m) => m.points), lineLetter);
    // The line turns about its own centre (scene), not the shared pivot — that keeps it where it was
    // horizontally. The two rotations differ by a translation; its vertical part is `ownOffset`.
    const centre = rotatePoint({ x: (box.left + box.right) / 2, y: centreY(box) }, pivot, -skew);
    const vx = centre.x - pivot.x;
    const vy = centre.y - pivot.y;

    return { words, box, baseline, centre, ownOffset: vy * (1 - cos) - vx * sin };
  });

  // Where each baseline goes, in scene y: its own level (no rules) or the paper's rule.
  const levelled = plans.map((plan) => plan.baseline + plan.ownOffset);
  const targets = options.rules ? assignRules(levelled, options.rules) : levelled;
  const lineShift = plans.map((plan, index) => targets[index]! - (plan.baseline + plan.ownOffset));

  const out: StrokeTransform[] = [];
  const push = (index: number, lineIndex: number, dy: number) => {
    out.push({ id: input[index]!.id, rotateDeg: skew, pivot: plans[lineIndex]!.centre, dx: 0, dy });
  };

  plans.forEach((plan, lineIndex) => {
    for (const word of plan.words) {
      const dy = lineShift[lineIndex]! + (word.baseline === null ? 0 : plan.baseline - word.baseline);

      for (const stroke of word.strokes) push(stroke.index, lineIndex, dy);
    }
  });

  // Dots, hamzas and marks: each goes with the word it sits over (or under) — the nearest word whose
  // span (a little padded: a final dot often overshoots the last letter) covers its centre. A mark over
  // no word takes the nearest line's move, so it is never left floating where its word used to be.
  for (const small of smalls) {
    const sx = (small.box.left + small.box.right) / 2;
    const sy = centreY(small.box);
    let best: { lineIndex: number; dy: number; distance: number } | null = null;

    plans.forEach((plan, lineIndex) => {
      for (const word of plan.words) {
        const pad = Math.max(2, height(word.box) * 0.25);

        if (sx < word.box.left - pad || sx > word.box.right + pad) continue;

        const distance = distanceToSpan(sy, word.box.top, word.box.bottom);

        if (!best || distance < best.distance) {
          best = { lineIndex, distance, dy: lineShift[lineIndex]! + (word.baseline === null ? 0 : plan.baseline - word.baseline) };
        }
      }
    });

    if (!best) {
      let nearest = 0;

      plans.forEach((plan, lineIndex) => {
        if (Math.abs(sy - plan.baseline) < Math.abs(sy - plans[nearest]!.baseline)) nearest = lineIndex;
      });

      best = { lineIndex: nearest, distance: 0, dy: lineShift[nearest]! };
    }

    push(small.index, best.lineIndex, best.dy);
  }

  return out.filter((transform) => transform.rotateDeg !== 0 || Math.abs(transform.dy) > 1e-6);
}
