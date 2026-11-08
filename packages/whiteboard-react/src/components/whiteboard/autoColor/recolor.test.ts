import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_INK_PALETTE, detectCorrection, isRecolorable, mixColor, parseColor, planRecolor, resolvePalette, sameColor } from './recolor';

import type { InkAutoMarker, RecolorTarget } from './recolor';

const palette = resolvePalette(undefined);
const ink = (over: Partial<RecolorTarget> = {}): RecolorTarget => ({
  id: 'a',
  color: '#000000',
  marker: null,
  defaultInk: true,
  createdColor: '#000000',
  ...over,
});

test('colour helpers: notations, mixing', () => {
  assert.ok(sameColor('#000', 'rgb(0, 0, 0)'));
  assert.ok(sameColor('black', '#000000'));
  assert.ok(!sameColor('#000000', '#0f766e'));
  assert.deepEqual(parseColor('#0f766e80'), { r: 15, g: 118, b: 110, a: 128 / 255 });
  assert.equal(mixColor('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixColor('#000000', '#0f766e', 1), '#0f766e');
});

test('only default ink that still has its committed colour is recolourable', () => {
  assert.ok(isRecolorable(ink()));
  assert.ok(!isRecolorable(ink({ defaultInk: false })), 'a hand-picked pen colour');
  assert.ok(!isRecolorable(ink({ color: '#ff0000' })), 'recoloured by hand after writing');
  assert.ok(!isRecolorable(ink({ createdColor: null })), 'not written this session');
});

test('plan: default ink takes the class colour and a marker with the original ink', () => {
  const [change] = planRecolor([ink()], 'term', palette, 'g1', 1000);

  assert.equal(change.to, DEFAULT_INK_PALETTE.term);
  assert.deepEqual(change.marker, { c: 'term', k: DEFAULT_INK_PALETTE.term, o: '#000000', g: 'g1', at: 1000 });
  assert.deepEqual(planRecolor([ink()], 'definition', palette, 'g1', 1000), [], 'definition keeps the ink');
  assert.deepEqual(planRecolor([ink({ defaultInk: false, color: '#2563eb', createdColor: '#2563eb' })], 'term', palette, 'g', 0), []);
});

test('re-classification moves an auto-coloured word, or returns it to its ink; a manual recolour is left alone', () => {
  const marker: InkAutoMarker = { c: 'term', k: DEFAULT_INK_PALETTE.term!, o: '#000000', g: 'g1', at: 0 };
  const coloured = ink({ color: DEFAULT_INK_PALETTE.term!, marker });

  assert.equal(planRecolor([coloured], 'heading', palette, 'g1', 5)[0].to, DEFAULT_INK_PALETTE.heading);
  const back = planRecolor([coloured], 'plain', palette, 'g1', 5)[0];

  assert.equal(back.to, '#000000');
  assert.equal(back.marker, null);
  assert.deepEqual(planRecolor([coloured], 'term', palette, 'g1', 5), [], 'unchanged class → no change');
  assert.deepEqual(planRecolor([ink({ color: '#ff0000', marker })], 'heading', palette, 'g1', 5), [], 'student recoloured it');
});

test('palette overrides: null leaves a class uncoloured', () => {
  const custom = resolvePalette({ term: null, definition: '#123456' });

  assert.deepEqual(planRecolor([ink()], 'term', custom, 'g', 0), []);
  assert.equal(planRecolor([ink()], 'definition', custom, 'g', 0)[0].to, '#123456');
});

test('corrections: to another class colour, back to the ink (plain), or a free colour (manual)', () => {
  const marker: InkAutoMarker = { c: 'term', k: DEFAULT_INK_PALETTE.term!, o: '#000000', g: 'g1', at: 100 };

  assert.equal(detectCorrection(marker, DEFAULT_INK_PALETTE.term!, palette, 200), null);
  assert.deepEqual(detectCorrection(marker, DEFAULT_INK_PALETTE.formula!, palette, 400), { from: 'term', to: 'formula', afterMs: 300 });
  assert.equal(detectCorrection(marker, '#000', palette, 400)?.to, 'plain');
  assert.equal(detectCorrection(marker, '#ff00ff', palette, 400)?.to, 'manual');
  assert.equal(detectCorrection(null, '#ff00ff', palette, 400), null);
});
