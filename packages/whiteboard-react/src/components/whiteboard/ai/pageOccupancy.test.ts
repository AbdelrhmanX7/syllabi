import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOccupancy, contentBlocks, findFreeBox } from './pageOccupancy';

/** A white page with dark rectangles (and optional faint ruling). */
function page(width: number, height: number, dark: Array<[number, number, number, number]>, ruleEvery = 0, paper = 255, ink = 20): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      let v = paper;

      if (ruleEvery && y % ruleEvery === 0) v = 215; // faint ruling
      if (dark.some(([dx, dy, dw, dh]) => x >= dx && x < dx + dw && y >= dy && y < dy + dh)) v = ink;

      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }

  return data;
}

test('printed content is taken, faint ruling is not', () => {
  const grid = buildOccupancy(page(240, 240, [[24, 24, 96, 24]], 20), 240, 240, 12);

  assert.equal(grid.cols, 20);
  assert.equal(grid.cells[2 * 20 + 2], 1, 'the text block');
  assert.equal(grid.cells[10 * 20 + 10], 0, 'a ruled but empty cell');
  assert.ok(grid.fill < 0.1);
});

test('a dark board with light ink reads the same way', () => {
  const grid = buildOccupancy(page(240, 240, [[24, 24, 96, 24]], 0, 18, 240), 240, 240, 12);

  assert.equal(grid.cells[2 * 20 + 2], 1);
  assert.equal(grid.cells[10 * 20 + 10], 0);
});

test('a note wanted on top of text lands in the nearest empty spot, clear of it and of earlier notes', () => {
  const text: [number, number, number, number] = [0, 48, 240, 60];
  const grid = buildOccupancy(page(240, 240, [text]), 240, 240, 12);
  const wanted = { x: 60, y: 60, w: 48, h: 24 };
  const first = findFreeBox(grid, wanted);

  assert.ok(first);
  assert.ok(first.y + first.h <= 48 || first.y >= 108, 'must not overlap the text band');

  const second = findFreeBox(grid, wanted, [first]);

  assert.ok(second);
  assert.ok(second.x + second.w <= first.x || first.x + first.w <= second.x || second.y + second.h <= first.y || first.y + first.h <= second.y, 'two notes never overlap');
});

test('no room (or too far) is null, never a covered spot', () => {
  // Dense print: a dark dot in every cell (the paper is still the most common colour).
  const dots: Array<[number, number, number, number]> = [];

  for (let y = 0; y < 120; y += 12) for (let x = 0; x < 120; x += 12) dots.push([x + 3, y + 3, 4, 4]);

  const full = buildOccupancy(page(120, 120, dots), 120, 120, 12);

  assert.equal(full.fill, 1);

  assert.equal(findFreeBox(full, { x: 10, y: 10, w: 40, h: 20 }), null);

  const grid = buildOccupancy(page(480, 120, [[0, 0, 200, 120]]), 480, 120, 12);

  assert.equal(findFreeBox(grid, { x: 10, y: 10, w: 40, h: 20 }, [], 100), null, 'the only gap is further than the reach');
  assert.ok(findFreeBox(grid, { x: 10, y: 10, w: 40, h: 20 }));
});

test('content regions: columns split apart, a column splits into its paragraphs, boxes hug the content', () => {
  // Left column: two 3-line paragraphs (6 px lines, 6 px apart; 24 px between paragraphs). Right column: one block. A speck.
  const line = (x: number, y: number, w: number): [number, number, number, number] => [x, y, w, 6];
  const left = [line(12, 12, 96), line(12, 24, 96), line(12, 36, 60), line(12, 66, 96), line(12, 78, 96), line(12, 90, 40)];
  const grid = buildOccupancy(page(360, 240, [...left, [180, 12, 120, 60], [330, 220, 3, 3]]), 360, 240, 12);
  const blocks = contentBlocks(grid, { max: 40 });

  assert.equal(blocks.length, 3);

  const [first, right, second] = blocks.sort((a, b) => a.x - b.x || a.y - b.y).length ? [blocks.find((b) => b.x === 12 && b.y < 50)!, blocks.find((b) => b.x >= 180)!, blocks.find((b) => b.x === 12 && b.y > 50)!] : [];

  assert.ok(first && second && right);
  assert.ok(first.y + first.h <= 45 && second.y >= 63, 'the paragraph gap splits the column');
  assert.equal(first.w, 96);
  assert.ok(right.y <= 12 && right.h >= 57);
});

test('content regions: a dense page still fits the cap (lines are grouped)', () => {
  const lines: Array<[number, number, number, number]> = [];

  for (let y = 6; y < 590; y += 12) lines.push([12, y, 200, 6]);

  const grid = buildOccupancy(page(480, 600, lines), 480, 600, 12);
  const blocks = contentBlocks(grid, { max: 10 });

  assert.ok(blocks.length <= 10 && blocks.length >= 8, String(blocks.length));
});
