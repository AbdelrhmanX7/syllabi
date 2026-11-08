import assert from 'node:assert/strict';
import { test } from 'node:test';

import { borderLuminance, contrastOnWhite, normalizeInk, strokeWidthEstimate, thickenInk, visionScale } from './visionPrep';

const canvasOf = (width: number, height: number, [r, g, b, a]: number[]) => {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let o = 0; o < data.length; o += 4) {
    data[o] = r!;
    data[o + 1] = g!;
    data[o + 2] = b!;
    data[o + 3] = a!;
  }

  return data;
};
const paint = (data: Uint8ClampedArray, width: number, x0: number, x1: number, y0: number, y1: number, rgba: number[]) => {
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) data.set(rgba, (y * width + x) * 4);
};
const at = (data: Uint8ClampedArray, width: number, x: number, y: number) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

test('transparent background → white paper, black ink stays black (no black-on-black)', () => {
  const data = canvasOf(20, 10, [0, 0, 0, 0]); // fully transparent, like a bare ink layer

  paint(data, 20, 5, 14, 4, 5, [0, 0, 0, 255]);
  normalizeInk(data, 20, 10);

  assert.deepEqual(at(data, 20, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(at(data, 20, 8, 4), [0, 0, 0, 255]);
});

test('a yellow nib is darkened to ≥ 4.5:1 on white and keeps its hue', () => {
  const data = canvasOf(20, 10, [255, 255, 255, 255]);

  paint(data, 20, 5, 14, 4, 5, [253, 224, 71, 255]); // #ffc93c
  assert.ok(contrastOnWhite(253, 224, 71) < 1.5);
  normalizeInk(data, 20, 10);

  const [r, g, b] = at(data, 20, 8, 4);

  assert.ok(contrastOnWhite(r!, g!, b!) >= 4.5, `contrast ${contrastOnWhite(r!, g!, b!)}`);
  assert.ok(r! > b! && g! > b!, 'still yellow-ish (brown), not grey');
});

test('a dark board (white chalk on black) is inverted to dark ink on white', () => {
  const data = canvasOf(20, 10, [20, 24, 30, 255]);

  paint(data, 20, 5, 14, 4, 5, [245, 245, 245, 255]);

  assert.ok(borderLuminance(data, 20, 10) < 0.05);
  assert.deepEqual(normalizeInk(data, 20, 10), { inverted: true });

  const paper = at(data, 20, 0, 0);
  const ink = at(data, 20, 8, 4);

  assert.ok(paper[0]! > 200, 'board became light');
  assert.ok(contrastOnWhite(ink[0]!, ink[1]!, ink[2]!) >= 4.5, 'chalk became dark ink');
});

test('stroke width estimate, thickening a hairline, and the vision scale bounds', () => {
  const data = canvasOf(30, 30, [255, 255, 255, 255]);

  paint(data, 30, 15, 15, 2, 27, [0, 0, 0, 255]); // a 1-px vertical hairline
  assert.equal(strokeWidthEstimate(data, 30, 30), 1);
  assert.equal(strokeWidthEstimate(thickenInk(data, 30, 30), 30, 30), 3);

  assert.equal(visionScale({ width: 400, height: 100 }, 10), 4, 'tiny writing → 40 px lines');
  assert.equal(visionScale({ width: 1000, height: 300 }, 10), 1.6, 'capped at a 1600 px long edge');
  assert.equal(visionScale({ width: 200, height: 100 }, 80), 2.56, 'raised to a 512 px long edge');
});

test('faint grey grid lines are left alone, not promoted to ink', () => {
  const data = canvasOf(20, 10, [255, 255, 255, 255]);

  paint(data, 20, 0, 19, 5, 5, [226, 232, 240, 255]); // a grid line
  normalizeInk(data, 20, 10);

  assert.deepEqual(at(data, 20, 3, 5), [226, 232, 240, 255]);
});
