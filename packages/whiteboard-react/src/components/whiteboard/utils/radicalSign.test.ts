import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultRadicalParams,
  normalizeRadicalParams,
  RADICAL_PROPORTIONS,
  radicalLocalPoints,
  radicalScenePoints,
  radicalVertices,
  recognizeRadical,
} from './radicalSign';

import type { RadicalVec as Vec } from './radicalSign';

// ---------------------------------------------------------------------------------------------------
// Synthetic hand-drawn strokes (seeded wobble + jitter, rounded corners), as in shapeRecognition.test.
// ---------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 2 ** 32;
  };
}

/** Round every corner with a quadratic fillet of about `radius`: a hand never makes a sharp corner. */
function roundCorners(path: Vec[], radius: number): Vec[] {
  const out: Vec[] = [path[0]];

  for (let i = 1; i < path.length - 1; i += 1) {
    const [a, b, c] = [path[i - 1], path[i], path[i + 1]];
    const lab = Math.hypot(b.x - a.x, b.y - a.y);
    const lbc = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, lab * 0.3, lbc * 0.3);
    const p = { x: b.x + ((a.x - b.x) * r) / lab, y: b.y + ((a.y - b.y) * r) / lab };
    const q = { x: b.x + ((c.x - b.x) * r) / lbc, y: b.y + ((c.y - b.y) * r) / lbc };

    for (let k = 0; k <= 6; k += 1) {
      const t = k / 6;

      out.push({
        x: (1 - t) ** 2 * p.x + 2 * (1 - t) * t * b.x + t * t * q.x,
        y: (1 - t) ** 2 * p.y + 2 * (1 - t) * t * b.y + t * t * q.y,
      });
    }
  }

  out.push(path[path.length - 1]);

  return out;
}

function hand(path: Vec[], { seed = 1, wobble = 0.01, jitter = 0.6, scale = 100, round = true } = {}): Vec[] {
  const random = rng(seed);
  const source = round ? roundCorners(path, scale * 0.08) : path;
  const out: Vec[] = [];
  let travelled = 0;
  const phase = random() * Math.PI * 2;

  for (let i = 1; i < source.length; i += 1) {
    const a = source[i - 1];
    const b = source[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / (length || 1);
    const ny = (b.x - a.x) / (length || 1);

    for (let t = 0; t < length; t += 1.5 + random() * 2.5) {
      const w = Math.sin(phase + (travelled + t) / 23) * wobble * scale;

      out.push({
        x: a.x + ((b.x - a.x) * t) / length + nx * w + (random() - 0.5) * jitter,
        y: a.y + ((b.y - a.y) * t) / length + ny * w + (random() - 0.5) * jitter,
      });
    }

    travelled += length;
  }

  out.push({ ...source[source.length - 1] });

  return out;
}

/** A hand-drawn √ whose stem top is at (x, y): tick, stem, bar. */
function drawnRadical(x: number, y: number, height: number, bar: number, { tick = 0.4, lean = 0.3, tilt = 0, serif = false } = {}): Vec[] {
  const bottom = { x: x - height * lean, y: y + height };
  const tickTop = { x: bottom.x - height * tick * 0.5, y: bottom.y - height * tick * 0.85 };
  const path = [tickTop, bottom, { x, y }, { x: x + bar, y: y + Math.tan((tilt * Math.PI) / 180) * bar }];

  if (serif) path.unshift({ x: tickTop.x - height * 0.08, y: tickTop.y + height * 0.05 });

  return path;
}

const OPTIONS = { minSize: 20 };

// ---------------------------------------------------------------------------------------------------
// Recognition — positives
// ---------------------------------------------------------------------------------------------------

describe('recognizeRadical — a drawn √ with a long bar', () => {
  for (const [label, height, bar, seed] of [
    ['small', 40, 60, 1],
    ['medium', 90, 140, 2],
    ['large, short bar', 160, 120, 3],
    ['huge', 320, 500, 4],
  ] as const) {
    it(`recognises a ${label} radical, sized to the drawing`, () => {
      const result = recognizeRadical(hand(drawnRadical(500, 300, height, bar), { seed, scale: height }), OPTIONS);

      assert.ok(result, 'expected a radical');
      assert.ok(Math.abs(result.anchor.x - 500) < height * 0.12, `anchor x ${result.anchor.x}`);
      assert.ok(Math.abs(result.anchor.y - 300) < height * 0.12, `anchor y ${result.anchor.y}`);
      assert.ok(Math.abs(result.params.height - height) / height < 0.15, `height ${result.params.height}`);
      assert.ok(Math.abs(result.params.bar - bar) / bar < 0.15, `bar ${result.params.bar}`);
      assert.ok(result.params.tick >= height * RADICAL_PROPORTIONS.minTickPerHeight * 0.85);
      assert.ok(result.params.tick <= height * RADICAL_PROPORTIONS.maxTickPerHeight * 1.15);
    });
  }

  it('tolerates a slightly tilted bar, a near-vertical stem and a lead-in serif', () => {
    assert.ok(recognizeRadical(hand(drawnRadical(0, 0, 100, 150, { tilt: -6 }), { seed: 7 }), OPTIONS));
    assert.ok(recognizeRadical(hand(drawnRadical(0, 0, 100, 150, { lean: 0.05 }), { seed: 8 }), OPTIONS));
    assert.ok(recognizeRadical(hand(drawnRadical(0, 0, 100, 150, { serif: true }), { seed: 9 }), OPTIONS));
  });

  it('is independent of where on the page it is drawn', () => {
    for (const [x, y] of [
      [0, 0],
      [-4000, 12000],
      [1e5, 1e5],
    ]) {
      const result = recognizeRadical(hand(drawnRadical(x, y, 100, 150), { seed: 11 }), OPTIONS);

      assert.ok(result, `at ${x},${y}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Recognition — negatives (normal writing must stay ink)
// ---------------------------------------------------------------------------------------------------

describe('recognizeRadical — conservative: ordinary writing stays ink', () => {
  const rejects = (label: string, path: Vec[], options = OPTIONS) =>
    it(`rejects ${label}`, () => {
      for (const seed of [1, 2, 3]) {
        assert.equal(recognizeRadical(hand(path, { seed }), options), null, `seed ${seed}`);
      }
    });

  rejects('a "v"', [
    { x: 0, y: 0 },
    { x: 30, y: 60 },
    { x: 60, y: 0 },
  ]);
  rejects('a √ with no bar', [
    { x: -20, y: 60 },
    { x: 0, y: 100 },
    { x: 30, y: 0 },
  ]);
  rejects('a ✓ check mark', [
    { x: 0, y: 50 },
    { x: 25, y: 80 },
    { x: 90, y: 0 },
  ]);
  rejects('a √ whose bar is only a short connector', drawnRadical(0, 0, 100, 35));
  rejects('a ✓ with a short tail', [
    { x: 0, y: 50 },
    { x: 25, y: 80 },
    { x: 70, y: 10 },
    { x: 95, y: 8 },
  ]);
  rejects('a "W"', [
    { x: 0, y: 0 },
    { x: 20, y: 80 },
    { x: 45, y: 20 },
    { x: 70, y: 80 },
    { x: 90, y: 0 },
  ]);
  rejects('an "N"', [
    { x: 0, y: 100 },
    { x: 0, y: 0 },
    { x: 70, y: 100 },
    { x: 70, y: 0 },
  ]);
  rejects('a "z"', [
    { x: 0, y: 0 },
    { x: 80, y: 0 },
    { x: 0, y: 80 },
    { x: 80, y: 80 },
  ]);
  rejects('a straight line', [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ]);
  rejects('a "v" followed by a rising cursive connector', [
    { x: 0, y: 0 },
    { x: 30, y: 60 },
    { x: 60, y: 0 },
    { x: 110, y: 25 },
  ]);
  rejects('a bar that slopes steeply (a "V" + diagonal)', drawnRadical(0, 0, 100, 150, { tilt: 30 }));
  rejects('a bar drawn to the LEFT', [
    { x: -40, y: 60 },
    { x: -20, y: 100 },
    { x: 0, y: 0 },
    { x: -150, y: 0 },
  ]);
  rejects('a stem that is not longer than the tick', [
    { x: -60, y: 0 },
    { x: -10, y: 100 },
    { x: 0, y: 30 },
    { x: 150, y: 30 },
  ]);
  rejects('something too small', drawnRadical(0, 0, 6, 9), { minSize: 20 });

  it('the stricter bar ratio rejects a radical the default would take', () => {
    const stroke = hand(drawnRadical(0, 0, 100, 80), { seed: 5 });

    assert.ok(recognizeRadical(stroke, OPTIONS));
    assert.equal(recognizeRadical(stroke, { ...OPTIONS, minBarRatio: 1 }), null);
  });

  it('survives junk input', () => {
    assert.equal(recognizeRadical([], OPTIONS), null);
    assert.equal(recognizeRadical([{ x: NaN, y: 1 }, { x: 1, y: Infinity }], OPTIONS), null);
    assert.equal(recognizeRadical(Array.from({ length: 50 }, () => ({ x: 5, y: 5 })), OPTIONS), null);
  });
});

// ---------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------

const length = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

describe('radical geometry', () => {
  it('puts the stem top at the origin and the bar along +x', () => {
    const v = radicalVertices({ height: 100, bar: 150, tick: 40 });

    assert.deepEqual(v.top, { x: 0, y: 0 });
    assert.deepEqual(v.barEnd, { x: 150, y: 0 });
    assert.equal(v.bottom.y, 100);
    assert.ok(v.bottom.x < 0, 'the stem leans right, so its bottom sits left of the top');
    assert.ok(v.tickTop.y > 0 && v.tickTop.y < 100, 'the tick starts between the bar and the bottom');
    assert.ok(v.tickTop.x < v.bottom.x);
    assert.equal(radicalLocalPoints({ height: 100, bar: 150, tick: 40 }).length, 5);
  });

  it('stretching the bar or the depth keeps the tick exactly the same size', () => {
    const base = radicalVertices({ height: 100, bar: 150, tick: 40 });
    const tickOf = (v: typeof base) => ({ tick: length(v.tickTop, v.bottom), serif: length(v.serif, v.tickTop) });

    for (const params of [
      { height: 100, bar: 600, tick: 40 },
      { height: 400, bar: 150, tick: 40 },
      { height: 900, bar: 900, tick: 40 },
    ]) {
      const v = radicalVertices(params);

      assert.ok(Math.abs(tickOf(v).tick - tickOf(base).tick) < 1e-9);
      assert.ok(Math.abs(tickOf(v).serif - tickOf(base).serif) < 1e-9);
      assert.deepEqual(v.top, { x: 0, y: 0 }, 'the anchor never moves');
      assert.equal(v.barEnd.x, params.bar);
      assert.equal(v.bottom.y, params.height);
    }
  });

  it('a deep radical stands up straighter: the lean is capped by the tick', () => {
    const shallow = radicalVertices({ height: 100, bar: 100, tick: 40 });
    const deep = radicalVertices({ height: 1000, bar: 100, tick: 40 });

    assert.ok(Math.abs(deep.bottom.x) <= 40 * RADICAL_PROPORTIONS.maxSlantPerTick + 1e-9);
    assert.ok(Math.abs(deep.bottom.x) / 1000 < Math.abs(shallow.bottom.x) / 100);
  });

  it('normalises degenerate params to a well-formed radical', () => {
    const p = normalizeRadicalParams({ height: 1, bar: -5, tick: 20 });

    assert.ok(p.height >= 20 * RADICAL_PROPORTIONS.minHeightPerTick);
    assert.ok(p.bar >= 20 * RADICAL_PROPORTIONS.minBarPerTick);

    const junk = normalizeRadicalParams({ height: NaN, bar: NaN, tick: NaN });

    assert.ok(Number.isFinite(junk.height) && Number.isFinite(junk.bar) && junk.tick > 0);
  });

  it('places scene points relative to the anchor, and default params are well-formed', () => {
    const scene = radicalScenePoints({ anchor: { x: 10, y: 20 }, params: { height: 100, bar: 150, tick: 40 } });

    assert.deepEqual(scene[3], { x: 10, y: 20 });
    assert.deepEqual(scene[4], { x: 160, y: 20 });

    const d = defaultRadicalParams(80);

    assert.equal(d.height, 80);
    assert.ok(d.bar > d.height && d.tick < d.height);
  });

  it('a clean radical drawn by hand is recognised back to about the same params', () => {
    const params = { height: 120, bar: 200, tick: 45 };
    const stroke = hand(radicalScenePoints({ anchor: { x: 300, y: 300 }, params }), { seed: 21, scale: 120 });
    const result = recognizeRadical(stroke, OPTIONS);

    assert.ok(result);
    assert.ok(Math.abs(result.params.height - 120) < 15);
    assert.ok(Math.abs(result.params.bar - 200) < 25);
  });
});
