import type { InkStroke } from './ink';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eraseAt, inkBounds, isInkEmpty, planRaster, strokeHits, strokeWidthFor } from './ink';

const stroke = (pts: [number, number][], width = 3): InkStroke => ({
  points: pts.map(([x, y]) => ({ x, y, p: 0.5 })),
  color: '#000',
  width,
});

test('strokeWidthFor follows pressure: 0.5 → base, 0 → half, 1 → 1.5×', () => {
  assert.equal(strokeWidthFor(4, 0.5), 4);
  assert.equal(strokeWidthFor(4, 0), 2);
  assert.equal(strokeWidthFor(4, 1), 6);
  assert.equal(strokeWidthFor(4, 7), 6, 'pressure is clamped to 1');
  assert.equal(strokeWidthFor(0.1, 0), 0.5, 'never thinner than half a pixel');
});

test('inkBounds is null for empty ink and pads around the points + max stroke width', () => {
  assert.equal(inkBounds([]), null);
  assert.equal(inkBounds([stroke([])]), null);
  assert.ok(isInkEmpty([stroke([])]));

  const bounds = inkBounds(
    [
      stroke(
        [
          [10, 20],
          [110, 60],
        ],
        4,
      ),
    ],
    10,
  )!;
  const half = strokeWidthFor(4, 1) / 2; // 3

  assert.deepEqual(bounds, { x: 10 - half - 10, y: 20 - half - 10, w: 100 + half * 2 + 20, h: 40 + half * 2 + 20 });
});

test('planRaster upscales 2× for small ink and caps the long side at maxPx', () => {
  const small = planRaster({ x: 0, y: 0, w: 300, h: 100 }, 1600);

  assert.equal(small.scale, 2);
  assert.deepEqual([small.outW, small.outH], [600, 200]);

  const big = planRaster({ x: 0, y: 0, w: 3200, h: 800 }, 1600);

  assert.equal(big.scale, 0.5);
  assert.deepEqual([big.outW, big.outH], [1600, 400]);

  const tall = planRaster({ x: 0, y: 0, w: 100, h: 4000 }, 1600);

  assert.equal(tall.outH, 1600);
  assert.equal(tall.outW, 40);

  const degenerate = planRaster({ x: 0, y: 0, w: 0, h: 0 }, 1600);

  assert.ok(degenerate.outW >= 1 && degenerate.outH >= 1);
});

test('strokeHits tests distance to segments, not just vertices', () => {
  const line = stroke(
    [
      [0, 0],
      [100, 0],
    ],
    2,
  );

  assert.ok(strokeHits(line, { x: 50, y: 3 }, 2), 'midpoint within radius + half width');
  assert.ok(!strokeHits(line, { x: 50, y: 30 }, 5));
  assert.ok(strokeHits(stroke([[10, 10]], 2), { x: 12, y: 10 }, 1), 'a dot stroke is hit by its own radius');
});

test('eraseAt drops hit strokes and returns the same array when nothing is hit', () => {
  const a = stroke([
    [0, 0],
    [100, 0],
  ]);
  const b = stroke([
    [0, 100],
    [100, 100],
  ]);
  const all = [a, b];

  assert.equal(eraseAt(all, { x: 50, y: 300 }, 8), all, 'identity when nothing hit (lets React skip a redraw)');
  assert.deepEqual(eraseAt(all, { x: 50, y: 2 }, 8), [b]);
  assert.deepEqual(eraseAt(all, { x: 50, y: 50 }, 60), []);
});
