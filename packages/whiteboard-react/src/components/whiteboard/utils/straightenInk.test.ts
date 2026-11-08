import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assignRules,
  boardRuleGrid,
  estimateSkewDeg,
  nearestRuleIndex,
  rotatePoint,
  sheetRuleGrid,
  straightenInk,
  wordBaseline,
} from './straightenInk';

import type { InkStroke, StrokeTransform, Vec } from './straightenInk';

// ---------------------------------------------------------------------------
// Synthetic handwriting: a «word» is a run of humps on a flat baseline (most of its bottom contour
// sits ON the baseline, like letters do; the humps are the bodies), a «dot» is a tiny square.
// ---------------------------------------------------------------------------

const H = 30;

function word(id: string, x0: number, baseline: number, widthPx: number, h = H): InkStroke {
  const points: Vec[] = [];

  for (let x = x0; x <= x0 + widthPx; x += 2) {
    const wave = Math.sin(((x - x0) / widthPx) * Math.PI * 6);

    points.push({ x, y: baseline - (h * Math.max(0, wave - 0.3)) / 0.7 });
  }

  return { id, points };
}

function dot(id: string, cx: number, cy: number, size = H * 0.15): InkStroke {
  const half = size / 2;

  return {
    id,
    points: [
      { x: cx - half, y: cy - half },
      { x: cx + half, y: cy - half },
      { x: cx + half, y: cy + half },
      { x: cx - half, y: cy + half },
      { x: cx, y: cy },
    ],
  };
}

const rotateStroke = (stroke: InkStroke, pivot: Vec, deg: number): InkStroke => ({
  id: stroke.id,
  points: stroke.points.map((point) => rotatePoint(point, pivot, deg)),
});

function apply(strokes: readonly InkStroke[], transforms: readonly StrokeTransform[]): Map<string, Vec[]> {
  const byId = new Map(transforms.map((transform) => [transform.id, transform]));
  const out = new Map<string, Vec[]>();

  for (const stroke of strokes) {
    const transform = byId.get(stroke.id);

    out.set(
      stroke.id,
      stroke.points.map((point) => {
        if (!transform) return { ...point };

        const rotated = rotatePoint(point, transform.pivot, transform.rotateDeg);

        return { x: rotated.x + transform.dx, y: rotated.y + transform.dy };
      }),
    );
  }

  return out;
}

/** Least-squares slope (dy/dx) of a point cloud. */
function slopeOf(points: readonly Vec[]): number {
  const n = points.length;
  const mx = points.reduce((sum, point) => sum + point.x, 0) / n;
  const my = points.reduce((sum, point) => sum + point.y, 0) / n;
  let sxy = 0;
  let sxx = 0;

  for (const point of points) {
    sxy += (point.x - mx) * (point.y - my);
    sxx += (point.x - mx) ** 2;
  }

  return sxx === 0 ? 0 : sxy / sxx;
}

const near = (actual: number, expected: number, eps: number, label = '') => assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≠ ${expected} (±${eps})`);
const span = (points: readonly Vec[]) => ({
  left: Math.min(...points.map((point) => point.x)),
  right: Math.max(...points.map((point) => point.x)),
  top: Math.min(...points.map((point) => point.y)),
  bottom: Math.max(...points.map((point) => point.y)),
});
const centre = (points: readonly Vec[]) => {
  const box = span(points);

  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
};

// ---------------------------------------------------------------------------

test('skew: two level lines tilted 6° clockwise want a −6° correction (±½ step)', () => {
  const level = [...word('a', 0, 100, 200).points, ...word('b', 240, 100, 150).points, ...word('c', 0, 160, 220).points];
  const tilted = level.map((point) => rotatePoint(point, { x: 0, y: 100 }, 6));

  near(estimateSkewDeg(tilted, H / 3), -6, 0.5);
  assert.equal(estimateSkewDeg(level, H / 3), 0);
});

test('word baseline is the bottom contour median, not the bbox bottom', () => {
  const w = word('w', 0, 100, 200);
  // A descender under the word would pull a bbox bottom down; the contour median stays put.
  const withTail: Vec[] = [...w.points, ...Array.from({ length: 10 }, (_, index) => ({ x: 180 + index, y: 100 + index * 1.5 }))];

  near(wordBaseline(w.points, H), 100, 0.5);
  near(wordBaseline(withTail, H), 100, 1);
});

test('empty and single-stroke input: nothing to straighten', () => {
  assert.deepEqual(straightenInk([]), []);
  assert.deepEqual(straightenInk([rotateStroke(word('only', 0, 100, 200), { x: 0, y: 100 }, 8)]), []);
  assert.deepEqual(straightenInk([{ id: 'empty', points: [] }, { id: 'empty2', points: [] }]), []);
});

test('two slanted wavy lines with dots come out level, each word on a rule, dots over their words', () => {
  const pivot = { x: 0, y: 100 };
  const line1 = [word('w1', 0, 100, 150), word('w2', 175, 100, 120), word('w3', 320, 100, 160)];
  const line2 = [word('w4', 10, 160, 140), word('w5', 180, 160, 170), word('w6', 380, 160, 110)];
  const dots = [
    dot('d1', 60, 100 - H * 1.3), // over w1
    dot('d2', 235, 100 - H * 1.25), // over w2
    dot('d3', 90, 100 + H * 0.4), // UNDER w1 — stays below, never a word of its own
    dot('d4', 260, 160 - H * 1.3), // over w5
  ];
  const level = [...line1, ...line2, ...dots];
  const strokes = level.map((stroke) => rotateStroke(stroke, pivot, 7));
  const transforms = straightenInk(strokes, { rules: { origin: 0, pitch: 30 } });
  const after = apply(strokes, transforms);

  // Every stroke moved (the writing was tilted), rotation clamped.
  assert.equal(transforms.length, strokes.length);
  for (const transform of transforms) assert.ok(Math.abs(transform.rotateDeg) <= 15 && transform.dx === 0);

  // Level: each line's ink has no slope left.
  const slope1 = slopeOf(['w1', 'w2', 'w3'].flatMap((id) => after.get(id)!));
  const slope2 = slopeOf(['w4', 'w5', 'w6'].flatMap((id) => after.get(id)!));

  near(slope1, 0, 0.01, 'line 1 slope');
  near(slope2, 0, 0.01, 'line 2 slope');

  // On the rule: every word's baseline is a multiple of the pitch, and the two lines differ.
  const baselineOf = (id: string) => wordBaseline(after.get(id)!, H);
  const rule1 = Math.round(baselineOf('w1') / 30) * 30;
  const rule2 = Math.round(baselineOf('w4') / 30) * 30;

  for (const id of ['w1', 'w2', 'w3']) near(baselineOf(id), rule1, 1, id);
  for (const id of ['w4', 'w5', 'w6']) near(baselineOf(id), rule2, 1, id);
  assert.notEqual(rule1, rule2);

  // Dots: above (or below) the word they belong to, inside its span.
  const over = (dotId: string, wordId: string) => {
    const d = centre(after.get(dotId)!);
    const w = span(after.get(wordId)!);

    assert.ok(d.x > w.left && d.x < w.right, `${dotId} x inside ${wordId}`);
    assert.ok(d.y < w.top, `${dotId} above ${wordId} (${d.y} vs top ${w.top})`);
  };

  over('d1', 'w1');
  over('d2', 'w2');
  over('d4', 'w5');

  const d3 = centre(after.get('d3')!);
  const w1 = span(after.get('w1')!);

  assert.ok(d3.x > w1.left && d3.x < w1.right);
  assert.ok(d3.y > w1.bottom - 1 && d3.y < w1.bottom + H, `d3 stays under w1 (${d3.y} vs bottom ${w1.bottom})`);
  // And the dot moved WITH its word (same rotation + shift), so it never sat on the baseline.
  const d3t = transforms.find((transform) => transform.id === 'd3')!;
  const w1t = transforms.find((transform) => transform.id === 'w1')!;

  near(d3t.dy, w1t.dy, 1e-9);
  near(d3t.rotateDeg, w1t.rotateDeg, 1e-9);
});

test('a single word with its dot: the dot rides the word, never gets a baseline of its own', () => {
  const strokes = [word('w', 0, 100, 160), dot('d', 50, 100 - H * 1.3)].map((stroke) => rotateStroke(stroke, { x: 0, y: 100 }, 5));
  const transforms = straightenInk(strokes, { rules: { origin: 0, pitch: 30 } });
  const after = apply(strokes, transforms);
  const d = centre(after.get('d')!);
  const w = span(after.get('w')!);

  assert.ok(d.y < w.top, `dot above word (${d.y} vs ${w.top})`);
  assert.ok(d.x > w.left && d.x < w.right);

  const baseline = wordBaseline(after.get('w')!, H);

  near(baseline, Math.round(baseline / 30) * 30, 1, 'on a rule');
});

test('a vertical stroke spanning lines (a bracket) is left alone', () => {
  const tall: InkStroke = { id: 'bar', points: Array.from({ length: 50 }, (_, index) => ({ x: 400 + (index % 2), y: 10 + index * 2 })) };
  const strokes = [word('a', 0, 100, 180), word('b', 200, 100, 150), tall].map((stroke) => rotateStroke(stroke, { x: 0, y: 100 }, 4));
  const transforms = straightenInk(strokes, { rules: { origin: 0, pitch: 30 } });

  assert.ok(transforms.some((transform) => transform.id === 'a'));
  assert.ok(transforms.some((transform) => transform.id === 'b'));
  assert.ok(!transforms.some((transform) => transform.id === 'bar'), 'the bar is untouched');
});

test('two lines wanting the same rule: the lower one takes the next rule', () => {
  // Wide ruling (60 px): both baselines round to the rule at 120.
  const strokes = [word('a', 0, 100, 180), word('b', 0, 128, 180)];
  const transforms = straightenInk(strokes, { rules: { origin: 0, pitch: 60 } });
  const after = apply(strokes, transforms);

  near(wordBaseline(after.get('a')!, H), 120, 1);
  near(wordBaseline(after.get('b')!, H), 180, 1);
  assert.deepEqual(assignRules([100, 128], { origin: 0, pitch: 60 }), [120, 180]);
  assert.deepEqual(assignRules([88, 150], { origin: 0, pitch: 30 }), [90, 150]);
});

test('no rules: lines are levelled where they are', () => {
  const strokes = [word('a', 0, 100, 150), word('b', 170, 104, 150)].map((stroke) => rotateStroke(stroke, { x: 0, y: 100 }, 6));
  const transforms = straightenInk(strokes);
  const after = apply(strokes, transforms);

  near(slopeOf([...after.get('a')!, ...after.get('b')!]), 0, 0.01);
  // Both words land on ONE baseline (the line's), which stays near where the writing was.
  near(wordBaseline(after.get('a')!, H), wordBaseline(after.get('b')!, H), 1);
  near(wordBaseline(after.get('a')!, H), 100, 20);
});

test('rule grids: board rules are multiples of the spacing; sheet rules start two pitches under its top', () => {
  assert.equal(boardRuleGrid({ backgroundType: 'blank' }), null);
  assert.equal(boardRuleGrid({ backgroundType: 'dotted' }), null);
  assert.deepEqual(boardRuleGrid({ backgroundType: 'lined' }), { origin: 0, pitch: 30 });
  assert.deepEqual(boardRuleGrid({ backgroundType: 'grid' }), { origin: 0, pitch: 30 });

  const sheet = sheetRuleGrid({ top: 1000, height: 2970 }, 2100, { backgroundType: 'lined', paperSpacingMm: 10 });

  assert.ok(sheet);
  assert.equal(sheet.pitch, 100);
  assert.equal(sheet.origin, 1200);
  assert.equal(sheet.kMin, 0);
  assert.equal(sheet.kMax, Math.floor((1000 + 2970 - 50 - 1200) / 100));
  assert.equal(sheetRuleGrid({ top: 0, height: 100 }, 2100, { backgroundType: 'blank' }), null);
  assert.equal(nearestRuleIndex(1130, sheet), 0);
  assert.equal(nearestRuleIndex(1260, sheet), 1);
  assert.equal(nearestRuleIndex(99999, sheet), sheet.kMax);
});
