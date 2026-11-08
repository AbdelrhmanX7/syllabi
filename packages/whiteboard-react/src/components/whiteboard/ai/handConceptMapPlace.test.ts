import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backdropLinesToScene, chooseHandMapPlacement } from './handConceptMapPlace';
import { detectInkLines } from './lassoGeometry';

import type { SceneRect } from './types';

const hits = (a: SceneRect, b: SceneRect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/** A white RGBA page with black bars where its "text" is. */
function page(width: number, height: number, bars: Array<[number, number, number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);

  for (const [x0, y0, x1, y1] of bars)
    for (let y = y0; y < y1; y += 1)
      for (let x = x0; x < x1; x += 1) {
        const o = (y * width + x) * 4;

        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
      }

  return data;
}

test('PDF page: the map goes in the blank part of the page, never on its printed lines', () => {
  // A 200×300 page raster: text in the top third, blank below. Shown at 600×900 scene units.
  const lines = detectInkLines(page(200, 300, [[10, 10, 190, 20], [10, 30, 190, 40], [10, 50, 150, 95]]), 200, 300);
  const backdrop = { left: 100, top: 0, width: 600, height: 900 };
  const occupied = backdropLinesToScene(lines, backdrop);

  assert.ok(occupied.length >= 2);
  const placed = chooseHandMapPlacement({
    sizes: [{ width: 500, height: 400 }],
    occupied,
    backdrop,
    region: { left: 100, right: 700 },
    viewTop: 0,
    margin: 20,
  });
  const rect = { left: placed.left, top: placed.top, width: 500, height: 400 };

  assert.equal(placed.onPage, true);
  assert.ok(occupied.every((line) => !hits(rect, line)), 'clear of the printed lines');
  assert.ok(rect.left >= backdrop.left && rect.left + rect.width <= backdrop.left + backdrop.width, 'on the page');
  assert.ok(rect.top + rect.height <= backdrop.top + backdrop.height, 'on the page');
});

test('PDF page: too full for the big map → a smaller size that fits; no room at all → below the page', () => {
  const backdrop = { left: 0, top: 0, width: 600, height: 900 };
  const occupied = [{ left: 0, top: 0, width: 600, height: 600 }];
  const smaller = chooseHandMapPlacement({
    sizes: [{ width: 550, height: 400 }, { width: 400, height: 250 }],
    occupied,
    backdrop,
    region: { left: 0, right: 600 },
    viewTop: 0,
    margin: 20,
  });

  assert.equal(smaller.index, 1);
  assert.equal(smaller.onPage, true);
  assert.ok(smaller.top >= 600);

  const full = chooseHandMapPlacement({
    sizes: [{ width: 550, height: 400 }],
    occupied: [backdrop],
    backdrop,
    region: { left: 0, right: 600 },
    viewTop: 0,
    margin: 20,
  });

  assert.equal(full.onPage, false);
  assert.ok(full.top >= 900);
});

test('notebook sheet: below everything already written, centred on the sheet; an empty page starts at the view', () => {
  const ink = [
    { left: 50, top: 100, width: 300, height: 40 },
    { left: 400, top: 380, width: 100, height: 60 },
  ];
  const placed = chooseHandMapPlacement({ sizes: [{ width: 400, height: 300 }], occupied: ink, backdrop: null, region: { left: 0, right: 800 }, viewTop: 0, margin: 30 });

  assert.deepEqual(placed, { index: 0, left: 200, top: 470, onPage: false });

  const empty = chooseHandMapPlacement({ sizes: [{ width: 400, height: 300 }], occupied: [], backdrop: null, region: { left: 0, right: 800 }, viewTop: 1000, margin: 30 });

  assert.equal(empty.top, 1030);
});
