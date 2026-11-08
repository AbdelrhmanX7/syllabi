import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pagedSheet, pageLength, scrollSheetAt, scrollSheetOf, toPageBox, toPagePoint, toSceneBox, toScenePoint } from './penCoords';

const page = { left: 100, top: 2000, width: 800, height: 1100 };

test('page point ↔ scene point round-trips through the sheet, zoom-free', () => {
  const scene = toScenePoint({ x: 0.25, y: 0.5 }, page);

  assert.deepEqual(scene, { x: 300, y: 2550 });
  assert.deepEqual(toPagePoint(scene, page), { x: 0.25, y: 0.5 });
});

test('coordinates outside the sheet are clamped to it', () => {
  assert.deepEqual(toScenePoint({ x: -0.5, y: 1.7 }, page), { x: 100, y: 3100 });
  assert.deepEqual(toPagePoint({ x: 0, y: 99999 }, page), { x: 0, y: 1 });
});

test('page box ↔ scene box, clipped to the sheet', () => {
  const rect = toSceneBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.1 }, page);

  assert.deepEqual(rect, { left: 180, top: 2220, width: 400, height: 110 });
  assert.deepEqual(toPageBox(rect, page), { x: 0.1, y: 0.2, w: 0.5, h: 0.1 });
  // A box running off the right edge is cut at the edge.
  const clipped = toSceneBox({ x: 0.8, y: 0, w: 0.5, h: 0.1 }, page);

  assert.deepEqual(
    { left: clipped.left, top: clipped.top, width: Math.round(clipped.width), height: Math.round(clipped.height) },
    { left: 740, top: 2000, width: 160, height: 110 },
  );
  assert.deepEqual(toPageBox({ left: 740, top: 2000, width: 400, height: 110 }, page), { x: 0.8, y: 0, w: 0.2, h: 0.1 });
});

test('sizes are fractions of the page HEIGHT', () => {
  assert.equal(pageLength(0.02, page), 22);
  assert.equal(pageLength(-1, page), 0);
});

test('a degenerate sheet never divides by zero', () => {
  const flat = { left: 0, top: 0, width: 0, height: 0 };

  assert.deepEqual(toPagePoint({ x: 5, y: 5 }, flat), { x: 1, y: 1 });
  assert.ok(Number.isFinite(toScenePoint({ x: 0.5, y: 0.5 }, flat).x));
});

test('continuous scroll layout: the sheet under a scene y, pages stacked at x = 0', () => {
  const layout = {
    width: 900,
    entries: [
      { top: 0, height: 1200 },
      { top: 1230, height: 1200 },
      { top: 2460, height: 600 },
    ],
  };

  assert.deepEqual(scrollSheetAt(layout, -50), { left: 0, top: 0, width: 900, height: 1200 });
  assert.deepEqual(scrollSheetAt(layout, 1500), { left: 0, top: 1230, width: 900, height: 1200 });
  // The gap below a page belongs to that page.
  assert.deepEqual(scrollSheetAt(layout, 1215), { left: 0, top: 0, width: 900, height: 1200 });
  assert.deepEqual(scrollSheetAt(layout, 99999), { left: 0, top: 2460, width: 900, height: 600 });
  assert.deepEqual(scrollSheetOf(layout, 1), { left: 0, top: 1230, width: 900, height: 1200 });
  assert.equal(scrollSheetOf(layout, 7), null);
  assert.equal(scrollSheetAt({ width: 900, entries: [] }, 10), null);
});

test('paged layout: the export bounds are the sheet (a copy)', () => {
  const sheet = pagedSheet(page);

  assert.deepEqual(sheet, page);
  assert.notEqual(sheet, page);
});
