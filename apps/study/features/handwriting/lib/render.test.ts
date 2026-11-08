import type { GlyphSample } from '@repo/whiteboard-react';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickPreviewSamples, renderGlyphLine, strokePath } from './render';

const sample = (w: number, createdAt = 1, y = -1, h = 1): GlyphSample => ({
  strokes: [
    [
      [0, 0, 0.5],
      [w / 2, y, 0.5],
      [w, 0, 0.5],
    ],
  ],
  advance: w,
  entry: [w, 0],
  exit: [0, 0],
  bbox: { x: 0, y, w, h },
  source: 'sheet',
  createdAt,
});

test('strokePath: a dot is a zero-length segment, a polyline is quadratic through midpoints', () => {
  const id = (v: number) => v;

  assert.equal(strokePath([], id, id), '');
  assert.equal(strokePath([[3, 4, 1]], id, id), 'M3 4 L3 4');
  assert.equal(
    strokePath(
      [
        [0, 0, 1],
        [2, 2, 1],
        [4, 0, 1],
      ],
      id,
      id,
    ),
    'M0 0 Q2 2 3 1 L4 0',
  );
});

test('renderGlyphLine lays samples left to right with a gap and a shared baseline', () => {
  const line = renderGlyphLine([sample(2), sample(1)], { xHeightPx: 10, gap: 4, pad: 2 });

  // widths 20 + 10, gap 4, pad 2×2 = 38
  assert.equal(line.width, 38);
  assert.equal(line.glyphs.length, 2);
  // First sample at the left: x = 2; second to its right: 2 + 20 + 4 = 26.
  assert.equal(line.glyphs[0].x, 2);
  assert.equal(line.glyphs[1].x, 26);
  // Ascender of 1 x-height above the baseline, 0.4 below (minimum descender room).
  assert.equal(line.baselineY, 12);
  assert.equal(line.height, 18);
  assert.match(line.glyphs[0].paths[0], /^M2 12 /);
});

test('renderGlyphLine gives a descender its room', () => {
  const line = renderGlyphLine([sample(1, 1, -0.5, 1.5)], { xHeightPx: 10, pad: 0 });

  assert.equal(line.baselineY, 10);
  assert.equal(line.height, 20);
});

test('pickPreviewSamples takes the newest sample per key, in key order, up to max', () => {
  const glyphs = {
    a: { samples: [sample(1, 1), sample(1, 9)] },
    b: { samples: [] },
    c: { samples: [sample(2, 3)] },
    d: { samples: [sample(3, 4)] },
  };

  assert.deepEqual(
    pickPreviewSamples(glyphs, ['b', 'a', 'x', 'c', 'd'], 2).map((s) => s.createdAt),
    [9, 3],
  );
  assert.deepEqual(pickPreviewSamples(glyphs, []), []);
});
