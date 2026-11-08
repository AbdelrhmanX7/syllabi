import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { smoothStroke } from './smoothStroke';

import type { Vec } from './shapeRecognition';

function rng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 2 ** 32 - 0.5;
  };
}

/** A wavy S-curve (no recognisable shape) with hand jitter, plus a resting tail at the end. */
function shakyCurve(jitter: number, seed = 7): Vec[] {
  const r = rng(seed);
  const points: Vec[] = [];

  for (let i = 0; i <= 200; i += 1) {
    const t = i / 200;

    points.push({ x: t * 400 + r() * jitter, y: Math.sin(t * Math.PI * 2) * 80 + r() * jitter });
  }
  const end = points[points.length - 1];

  for (let i = 0; i < 20; i += 1) points.push({ x: end.x + r() * 3, y: end.y + r() * 3 });

  return points;
}

/** Sum of absolute turning angles — the "wobble" of a polyline. */
function totalTurn(points: readonly Vec[]): number {
  let turn = 0;

  for (let i = 2; i < points.length; i += 1) {
    const a = Math.atan2(points[i - 1].y - points[i - 2].y, points[i - 1].x - points[i - 2].x);
    const b = Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x);
    let d = b - a;

    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turn += Math.abs(d);
  }

  return turn;
}

describe('smoothStroke', () => {
  it('takes the shake out of a freehand curve and keeps its shape', () => {
    const raw = shakyCurve(6);
    const smooth = smoothStroke(raw, 1);

    assert.ok(smooth);
    assert.equal(smooth.closed, false);
    // The clean curve turns ~2×(its two bends); the shaky one turns many times that.
    assert.ok(totalTurn(smooth.points) < totalTurn(raw) / 4, `turn ${totalTurn(smooth.points)} vs ${totalTurn(raw)}`);
    // Still the same curve: every smoothed point sits near the true sine.
    for (const p of smooth.points) {
      assert.ok(Math.abs(p.y - Math.sin((p.x / 400) * Math.PI * 2) * 80) < 12, `off-curve point ${p.x},${p.y}`);
    }
  });

  it('pins the start and drops the resting tail', () => {
    const raw = shakyCurve(4);
    const smooth = smoothStroke(raw, 1)!;

    assert.deepEqual(smooth.points[0], raw[0]);
    const last = smooth.points[smooth.points.length - 1];

    assert.ok(Math.hypot(last.x - 400, last.y) < 8);
  });

  it('closes a stroke that ends where it began', () => {
    const r = rng(3);
    const blob: Vec[] = [];

    for (let i = 0; i <= 120; i += 1) {
      const a = (i / 120) * Math.PI * 2;
      const radius = 100 + 25 * Math.sin(3 * a);

      blob.push({ x: Math.cos(a) * radius + r() * 5, y: Math.sin(a) * radius + r() * 5 });
    }

    assert.equal(smoothStroke(blob, 1)?.closed, true);
  });

  it('leaves letters and dots alone', () => {
    const letter: Vec[] = Array.from({ length: 30 }, (_, i) => ({ x: i, y: Math.sin(i) * 8 }));

    assert.equal(smoothStroke(letter, 1), null);
    // The same ink zoomed in 4× is big on screen, so it is a shape-sized stroke there.
    assert.ok(smoothStroke(letter, 4));
  });
});
