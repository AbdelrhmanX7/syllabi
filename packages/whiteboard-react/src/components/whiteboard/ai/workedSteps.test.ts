import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitGlyphs, translatePath } from './workedSteps';

const box = (x: number, y: number, w: number, h: number) => `M ${x} ${y} Q ${x + w} ${y} ${x + w} ${y + h} Q ${x} ${y + h} ${x} ${y} Z`;

test('a written word splits into its letters: shapes that overlap sideways stay together', () => {
  // «o» (outline + hole), «i» (stem + dot above it), «=» (two bars), then a letter on its own.
  const o = `${box(0, 10, 10, 10)} ${box(3, 13, 4, 4)}`;
  const i = `${box(14, 10, 3, 10)} ${box(14, 4, 3, 3)}`;
  const equals = `${box(22, 11, 8, 2)} ${box(22, 16, 8, 2)}`;
  const l = box(34, 2, 3, 18);
  const parts = splitGlyphs([o, i, equals, l].join(' '));

  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map((part) => (part.match(/M/g) ?? []).length), [2, 2, 2, 1]);
  assert.deepEqual(splitGlyphs(''), []);
});

test('moving a traced path moves every point and nothing else', () => {
  assert.equal(translatePath('M 1 2 Q 3.5 4 5 6 Z', 10, -2), 'M 11 0 Q 13.5 2 15 4 Z');
});
