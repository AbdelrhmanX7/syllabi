import type { InkStroke } from '@/features/bank/lib/ink';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeNote, encodeNote, noteTooBig, sameNote } from './note';

const stroke = (color: string, pts: [number, number, number][]): InkStroke => ({
  color,
  width: 2.4,
  points: pts.map(([x, y, p]) => ({ x, y, p })),
});

test('encodeNote rounds points, keeps colour tokens and drops empty strokes', () => {
  const note = encodeNote([stroke('blue', [[10.04, 20.06, 0.513]]), stroke('red', []), stroke('#123', [[1, 2, 3]])], 520.4, 260);

  assert.deepEqual(note, {
    w: 520,
    h: 260,
    strokes: [
      { c: 'blue', w: 2.4, pts: [10, 20.1, 0.51] },
      { c: 'ink', w: 2.4, pts: [1, 2, 1] },
    ],
  });
  assert.equal(encodeNote([stroke('ink', [])], 100, 100), null);
});

test('decodeNote round-trips, and shrinks a note written on a wider pad', () => {
  const note = encodeNote([stroke('green', [[100, 50, 0.5], [200, 80, 0.7]])], 400, 200)!;

  assert.deepEqual(decodeNote(note), [stroke('green', [[100, 50, 0.5], [200, 80, 0.7]])]);
  assert.ok(sameNote(note, encodeNote(decodeNote(note), 400, 200)));
  const half = decodeNote(note, 200);

  assert.deepEqual(half[0]!.points[1], { x: 100, y: 40, p: 0.7 });
  assert.equal(half[0]!.width, 1.2);
  // A narrower note keeps its size on a wider pad.
  assert.deepEqual(decodeNote(note, 800)[0]!.points[0], { x: 100, y: 50, p: 0.5 });
  assert.deepEqual(decodeNote(null), []);
});

test('noteTooBig follows the 64 KB server cap', () => {
  const long = (n: number) => stroke('ink', Array.from({ length: n }, (_, i) => [123.4 + i, 456.7, 0.55] as [number, number, number]));

  assert.equal(noteTooBig(encodeNote([long(100)], 500, 500)), false);
  assert.equal(noteTooBig(encodeNote(Array.from({ length: 40 }, () => long(200)), 500, 500)), true);
  assert.equal(noteTooBig(null), false);
});
