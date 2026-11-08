import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SmoothPoint } from './strokeSmoothing';

import { findLiftHookTrim, StrokeSmoother } from './strokeSmoothing';

/** Deterministic noise in [-amplitude, amplitude] (mulberry32), so the tests never flake. */
function noise(seed: number) {
  let state = seed >>> 0;

  return (amplitude: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * amplitude;
  };
}

function smoothAll(points: readonly SmoothPoint[], zoom = 1): SmoothPoint[] {
  const smoother = new StrokeSmoother();

  return points.map((point) => smoother.next(point.x, point.y, zoom));
}

/** RMS distance from the horizontal line y = 0. */
function rmsOffLine(points: readonly SmoothPoint[]): number {
  return Math.sqrt(points.reduce((sum, point) => sum + point.y * point.y, 0) / points.length);
}

/** Sum of absolute turning (radians) along a polyline — a wobbly line turns a lot, a clean one barely. */
function totalTurning(points: readonly SmoothPoint[]): number {
  let total = 0;

  for (let i = 2; i < points.length; i += 1) {
    const a = Math.atan2(points[i - 1].y - points[i - 2].y, points[i - 1].x - points[i - 2].x);
    const b = Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x);
    let delta = b - a;

    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    total += Math.abs(delta);
  }

  return total;
}

describe('StrokeSmoother', () => {
  it('removes most of the wobble from a slow, noisy line (a stroke end / the base of a "2")', () => {
    const jitter = noise(7);
    const raw = Array.from({ length: 120 }, (_, i) => ({ x: i * 0.5 + jitter(0.4), y: jitter(0.6) }));
    const smoothed = smoothAll(raw);

    // Skip the first samples while the filter settles from the pen-down point.
    assert.ok(rmsOffLine(smoothed.slice(10)) < rmsOffLine(raw.slice(10)) * 0.75);
    assert.ok(totalTurning(smoothed) < totalTurning(raw) * 0.5);
  });

  it('barely lags a fast stroke (latency stays around a screen pixel)', () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({ x: i * 8, y: 0 }));
    const smoothed = smoothAll(raw);
    const tip = smoothed[smoothed.length - 1];

    assert.ok(raw[raw.length - 1].x - tip.x < 2, `lag ${raw[raw.length - 1].x - tip.x}px`);
  });

  it('keeps a sharp intentional corner (the apex of an "N") within about a pixel', () => {
    // Up 40px then straight down-right, 1.5px per sample — a handwriting-speed corner.
    const raw: SmoothPoint[] = [];

    for (let i = 0; i <= 27; i += 1) raw.push({ x: 0, y: -i * 1.5 });
    for (let i = 1; i <= 27; i += 1) raw.push({ x: i * 0.75, y: -40.5 + i * 1.3 });

    const smoothed = smoothAll(raw);
    const apexY = Math.min(...smoothed.map((point) => point.y));

    assert.ok(apexY < -40.5 + 2, `apex rounded to ${apexY}`);
  });

  it('passes the first sample through untouched and repeats it for a tap (dot)', () => {
    const smoother = new StrokeSmoother();

    assert.deepEqual(smoother.next(12, 34), { x: 12, y: 34 });
    assert.deepEqual(smoother.next(12, 34), { x: 12, y: 34 });
  });

  it('starts fresh after reset — no pull toward the previous stroke', () => {
    const smoother = new StrokeSmoother();

    smoother.next(0, 0);
    smoother.next(10, 0);
    smoother.reset();

    assert.deepEqual(smoother.next(500, 500), { x: 500, y: 500 });
  });

  it('tunes in screen px: the same on-screen stroke is smoothed the same at every zoom', () => {
    const jitter = noise(3);
    const screen = Array.from({ length: 80 }, (_, i) => ({ x: i * 0.7 + jitter(0.3), y: jitter(0.5) }));
    const zoom = 2.5;
    const atOne = smoothAll(screen, 1);
    const atZoom = smoothAll(
      screen.map((point) => ({ x: point.x / zoom, y: point.y / zoom })),
      zoom,
    );

    for (let i = 0; i < atOne.length; i += 1) {
      assert.ok(Math.abs(atOne[i].x - atZoom[i].x * zoom) < 1e-9);
      assert.ok(Math.abs(atOne[i].y - atZoom[i].y * zoom) < 1e-9);
    }
  });
});

describe('findLiftHookTrim', () => {
  const straight = (count: number, step = 1.5) => Array.from({ length: count }, (_, i) => ({ x: i * step, y: 0 }));

  it('cuts a short lift-off hook that doubles back (the end of a ")")', () => {
    const points = [...straight(30), { x: 43, y: 1.5 }, { x: 42, y: 3 }];
    const [start, end] = findLiftHookTrim(points);

    assert.equal(start, 0);
    assert.equal(end, 29);
  });

  it('keeps the short first leg of a checkmark (no start trim)', () => {
    const points: SmoothPoint[] = [];

    for (let i = 0; i <= 3; i += 1) points.push({ x: i, y: i });
    for (let i = 1; i <= 20; i += 1) points.push({ x: 3 + i * 1.2, y: 3 - i * 1.8 });

    assert.deepEqual(findLiftHookTrim(points), [0, points.length - 1]);
  });

  it('keeps a deliberate flick longer than the hook bound (the tail of a "u")', () => {
    const tail = Array.from({ length: 8 }, (_, i) => ({ x: 43.5, y: -(i + 1) * 1.5 }));
    const points = [...straight(30), ...tail];

    assert.deepEqual(findLiftHookTrim(points), [0, points.length - 1]);
  });

  it('keeps a tight but smooth curve (the bottom of a "3")', () => {
    // Half circle of radius 12px, 1.2px steps.
    const points = Array.from({ length: 32 }, (_, i) => {
      const angle = (i / 31) * Math.PI;

      return { x: 12 * Math.cos(angle), y: 12 * Math.sin(angle) };
    });

    assert.deepEqual(findLiftHookTrim(points), [0, points.length - 1]);
  });

  it('never touches a dot, the dot of an "i", or a short dash', () => {
    assert.deepEqual(findLiftHookTrim([{ x: 1, y: 1 }, { x: 1, y: 1 }]), [0, 1]);
    assert.deepEqual(
      findLiftHookTrim([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.2 },
        { x: 1, y: 0 },
        { x: 0.6, y: -0.3 },
        { x: 0.2, y: 0.1 },
      ]),
      [0, 4],
    );

    const dash = [...straight(8), { x: 10, y: 2 }, { x: 9, y: 3 }];

    assert.deepEqual(findLiftHookTrim(dash), [0, dash.length - 1]);
  });

  it('measures the hook in screen px, so zooming in does not let a bigger hook through or cut more', () => {
    const zoom = 4;
    const points = [...straight(30), { x: 43, y: 1.5 }, { x: 42, y: 3 }].map((point) => ({
      x: point.x / zoom,
      y: point.y / zoom,
    }));

    assert.deepEqual(findLiftHookTrim(points, zoom), [0, 29]);
  });
});
