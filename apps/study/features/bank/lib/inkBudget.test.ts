import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EXAM_INK_TARGET_B64,
  EXAM_TOTAL_B64,
  MIN_SCALE,
  b64Bytes,
  fitTotalBudget,
  quantizeGray,
  shrinkFactor,
} from './inkBudget';

test('b64Bytes converts base64 length to bytes', () => {
  assert.equal(b64Bytes(4), 3);
  assert.equal(b64Bytes(250_000), 187_500);
});

test('shrinkFactor: 1 when under target, √ratio otherwise, clamped to [0.5, 0.9]', () => {
  assert.equal(shrinkFactor(100_000, EXAM_INK_TARGET_B64), 1);
  assert.equal(shrinkFactor(EXAM_INK_TARGET_B64, EXAM_INK_TARGET_B64), 1);
  // 4× too big → √(1/4)·0.95 = 0.475 → clamps up to 0.5
  assert.equal(shrinkFactor(1_000_000, 250_000), 0.5);
  // 1.1× too big → √(1/1.1)·0.95 ≈ 0.906 → clamps down to 0.9
  assert.equal(shrinkFactor(275_000, 250_000), 0.9);
  // 2× too big → √0.5·0.95 ≈ 0.672
  assert.ok(Math.abs(shrinkFactor(500_000, 250_000) - 0.6718) < 0.001);
});

test('fitTotalBudget: 1 when the batch fits, otherwise a uniform √ shrink with a floor', () => {
  assert.equal(fitTotalBudget([200_000, 200_000], EXAM_TOTAL_B64), 1);
  assert.equal(fitTotalBudget([], EXAM_TOTAL_B64), 1);
  // 20 answers × 600 KB = 12 MB > 9 MB → √(0.9·9/12) ≈ 0.822
  const factor = fitTotalBudget(Array(20).fill(600_000), EXAM_TOTAL_B64);

  assert.ok(Math.abs(factor - Math.sqrt((0.9 * 9_000_000) / 12_000_000)) < 1e-9);
  assert.ok(factor < 1 && factor > MIN_SCALE);
  // Absurdly large → floor
  assert.equal(fitTotalBudget([1e9], EXAM_TOTAL_B64), MIN_SCALE);
});

test('quantizeGray: white stays white, ink goes black, mid greys snap to a band, alpha composites onto white', () => {
  const px = [
    255,
    255,
    255,
    255, // white
    0,
    0,
    0,
    255, // black
    120,
    130,
    125,
    255, // mid grey → nearest of 0/85/170/255 → 85 or 170
    200,
    30,
    30,
    255, // red → luminance ≈ 81 → 85
    0,
    0,
    0,
    0, // fully transparent → page → white
  ];

  quantizeGray(px, 4);
  assert.deepEqual(px.slice(0, 4), [255, 255, 255, 255]);
  assert.deepEqual(px.slice(4, 8), [0, 0, 0, 255]);
  assert.ok([85, 170].includes(px[8]!), `mid grey snapped to ${px[8]}`);
  assert.equal(px[9], px[8]);
  assert.equal(px[10], px[8]);
  assert.equal(px[12], 85);
  assert.deepEqual(px.slice(16, 20), [255, 255, 255, 255]);
});

test('quantizeGray with 2 levels is a 1-bit threshold', () => {
  const px = [100, 100, 100, 255, 160, 160, 160, 255];

  quantizeGray(px, 2);
  assert.deepEqual(px, [0, 0, 0, 255, 255, 255, 255, 255]);
});
