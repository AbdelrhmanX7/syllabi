import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applySceneTransformToPoint,
  buildPdfScrollLayout,
  DEFAULT_PDF_PAGE_ASPECT,
  findPdfScrollPageAt,
  invertSceneTransform,
  markRevivedFromJson,
  pageToSceneTransform,
  pdfScrollLayoutKey,
  pdfScrollPagePaintTransform,
  pdfScrollRegionPaintArgs,
  pdfScrollViewportForPage,
  resolvePdfPageAspect,
  resolvePdfScrollCurrentPage,
  resolvePdfScrollPageFrame,
  resolvePdfScrollVisibleRange,
  REVIVED_FROM_JSON_MARKER,
  samePdfScrollPageSequence,
  SHEET_RULE_LINES_PER_WIDTH,
  sheetRuleLineYs,
  sheetRulePitch,
  transformCanvasObjectJson,
  visibleSceneBand,
} from './pdfScrollLayout';

import type { WhiteboardPage } from '../types';

const page = (id: string, extra: Partial<WhiteboardPage> = {}): WhiteboardPage => ({
  backgroundType: 'blank',
  canvasJSON: '',
  id,
  pdfAssetId: 'asset',
  pdfPageIndex: 0,
  thumbnail: '',
  ...extra,
});

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} ≠ ${expected}`);

// Three pages, 1000 wide, aspect 1.5 → 1500 tall each, 24px gaps: tops at 0, 1524, 3048.
const threePages = buildPdfScrollLayout([page('a'), page('b'), page('c')], { aspectOf: () => 1.5, gap: 24, width: 1000 });

test('pages stack top-to-bottom with one gap between neighbours', () => {
  assert.deepEqual(
    threePages.entries.map((entry) => [entry.pageId, entry.top, entry.height]),
    [
      ['a', 0, 1500],
      ['b', 1524, 1500],
      ['c', 3048, 1500],
    ],
  );
  assert.equal(threePages.totalHeight, 4548);
  assert.equal(buildPdfScrollLayout([], { aspectOf: () => 1, width: 1000 }).totalHeight, 0);
});

test('aspect: recorded placement wins, then the rotated raster, then A4', () => {
  near(resolvePdfPageAspect(page('a', { canvasWidthPx: 800, pdfPlacement: { height: 1200, width: 800, x: 0, y: -100 } })), 1.5);
  // A placement recorded against another width describes another frame → ignored.
  near(resolvePdfPageAspect(page('a', { canvasWidthPx: 800, pdfPlacement: { height: 1200, width: 900, x: 0, y: 0 } })), DEFAULT_PDF_PAGE_ASPECT);
  near(resolvePdfPageAspect(page('a'), { height: 2000, width: 1000 }), 2);
  // Rotated 90°: the bounding box flips.
  near(resolvePdfPageAspect(page('a', { pdfRotation: 90 }), { height: 2000, width: 1000 }), 0.5);
  near(resolvePdfPageAspect(page('a')), DEFAULT_PDF_PAGE_ASPECT);
});

test('findPdfScrollPageAt: binary search with gaps belonging to the page above', () => {
  assert.equal(findPdfScrollPageAt(threePages, -50), 0);
  assert.equal(findPdfScrollPageAt(threePages, 0), 0);
  assert.equal(findPdfScrollPageAt(threePages, 1499), 0);
  assert.equal(findPdfScrollPageAt(threePages, 1510), 0);
  assert.equal(findPdfScrollPageAt(threePages, 1524), 1);
  assert.equal(findPdfScrollPageAt(threePages, 3048), 2);
  assert.equal(findPdfScrollPageAt(threePages, 99999), 2);
  assert.equal(findPdfScrollPageAt(buildPdfScrollLayout([], { aspectOf: () => 1, width: 1 }), 0), -1);
});

test('visible range: only pages that intersect the (overscanned) viewport', () => {
  // 600px view at zoom 1 scrolled to y=1400: shows 1400..2000 → a (ends 1500) and b (from 1524).
  assert.deepEqual(resolvePdfScrollVisibleRange(threePages, { offsetY: -1400, zoom: 1 }, 600), { end: 1, start: 0 });
  // Scrolled into the gap: 1505..2105 → only b.
  assert.deepEqual(resolvePdfScrollVisibleRange(threePages, { offsetY: -1505, zoom: 1 }, 600), { end: 1, start: 1 });
  // Ending just above c's top: 2440..3040 → only b.
  assert.deepEqual(resolvePdfScrollVisibleRange(threePages, { offsetY: -2440, zoom: 1 }, 600), { end: 1, start: 1 });
  // One viewport of overscan on each side pulls a and c in.
  assert.deepEqual(resolvePdfScrollVisibleRange(threePages, { offsetY: -2000, zoom: 1 }, 600, 600), { end: 2, start: 0 });
  // Zoom halves what a screen px covers: at zoom 2 the same 600px view spans 300 scene px
  // (offsetY -2000 → scene 1000..1300, all inside a).
  assert.deepEqual(resolvePdfScrollVisibleRange(threePages, { offsetY: -2000, zoom: 2 }, 600), { end: 0, start: 0 });
});

test('current page follows the view centre and jumps to the next page inside the gap', () => {
  assert.equal(resolvePdfScrollCurrentPage(threePages, { offsetY: 0, zoom: 1 }, 600), 0);
  // Centre at 1250 → a; centre at 1510 (gap) → b; centre at 1600 → b.
  assert.equal(resolvePdfScrollCurrentPage(threePages, { offsetY: -950, zoom: 1 }, 600), 0);
  assert.equal(resolvePdfScrollCurrentPage(threePages, { offsetY: -1210, zoom: 1 }, 600), 1);
  assert.equal(resolvePdfScrollCurrentPage(threePages, { offsetY: -1300, zoom: 1 }, 600), 1);
});

test('pdfScrollViewportForPage puts the page top at the canvas top', () => {
  assert.deepEqual(pdfScrollViewportForPage(threePages, 1, 1), { offsetX: 0, offsetY: -1524, zoom: 1 });
  assert.deepEqual(pdfScrollViewportForPage(threePages, 2, 0.5), { offsetX: 0, offsetY: -1524, zoom: 0.5 });
  assert.deepEqual(pdfScrollViewportForPage(threePages, 99, 1), { offsetX: 0, offsetY: -3048, zoom: 1 });
});

test('page frame: a recorded page keeps its record, an unrecorded one is framed like the paged layout', () => {
  const recorded = resolvePdfScrollPageFrame(
    page('a', { canvasWidthPx: 800, pdfPlacement: { height: 1200, width: 800, x: 0, y: -300 } }),
    { aspect: 1.5 },
    threePages,
    { height: 600, width: 1000 },
  );

  assert.equal(recorded.recorded, true);
  assert.equal(recorded.frameWidth, 800);
  assert.equal(recorded.frameHeight, 600);

  const fresh = resolvePdfScrollPageFrame(page('a'), { aspect: 1.5 }, threePages, { height: 600, width: 1000 });

  assert.equal(fresh.recorded, false);
  assert.equal(fresh.frameWidth, 1000);
  assert.equal(fresh.frameHeight, 600);
  // 1500 tall page centred in a 600 frame sits at y = -450, exactly what getScreenFitPlacement gives.
  assert.deepEqual(fresh.placement, { height: 1500, width: 1000, x: 0, y: -450 });

  const blank = resolvePdfScrollPageFrame(page('z', { pdfAssetId: undefined }), { aspect: 1.5 }, threePages, { height: 600, width: 1000 });

  assert.equal(blank.placement.y, 0, 'a page without a PDF is framed from its top');
});

test('page↔scene transform maps the page-local PDF rect onto the scene rect and inverts exactly', () => {
  const frame = { frameWidth: 500, placement: { height: 750, width: 500, x: 0, y: -75 } };
  const entry = threePages.entries[1]!;
  const toScene = pageToSceneTransform(frame, entry, threePages);

  // Written at 500 wide, shown at 1000 → scale 2; the rect's top-left (0, -75) lands on (0, 1524).
  assert.equal(toScene.scale, 2);
  assert.deepEqual(applySceneTransformToPoint(toScene, { x: 0, y: -75 }), { x: 0, y: 1524 });
  assert.deepEqual(applySceneTransformToPoint(toScene, { x: 500, y: 675 }), { x: 1000, y: 3024 });

  const back = invertSceneTransform(toScene);
  const roundTrip = applySceneTransformToPoint(back, applySceneTransformToPoint(toScene, { x: 123.4, y: 56.7 }));

  near(roundTrip.x, 123.4);
  near(roundTrip.y, 56.7);
});

test('transformCanvasObjectJson moves left/top and scales scaleX/scaleY only when needed', () => {
  const stroke = { left: 10, path: [['M', 0, 0]], scaleX: 1, scaleY: 1, top: 20, type: 'Path' };
  const shifted = transformCanvasObjectJson(stroke, { dx: 0, dy: 1524, scale: 1 });

  assert.equal(shifted.left, 10);
  assert.equal(shifted.top, 1544);
  assert.equal(shifted.scaleX, 1);
  assert.strictEqual(shifted.path, stroke.path, 'geometry arrays are shared, not copied');
  assert.equal(stroke.top, 20, 'input untouched');

  const scaled = transformCanvasObjectJson({ left: 10, top: 20, type: 'Path' }, { dx: 5, dy: -7, scale: 2 });

  assert.equal(scaled.left, 25);
  assert.equal(scaled.top, 33);
  assert.equal((scaled as { scaleX?: number }).scaleX, 2);
  assert.equal((scaled as { scaleY?: number }).scaleY, 2);
});

test('paint transform folds the page→scene map into the live viewport', () => {
  const vt = pdfScrollPagePaintTransform([2, 0, 0, 2, -100, -3000], { dx: 0, dy: 1524 + 150, scale: 1 });

  assert.deepEqual(vt, [2, 0, 0, 2, -100, -3000 + 2 * 1674]);
});

test('region paint args put a later page\'s raster under the ink of the same scene rect', () => {
  // A lasso on page 2 (scene y ≥ 1524), rendered at 3 px per scene unit — the AI capture.
  const region = { height: 300, left: 400, top: 2000, width: 500 };
  const args = pdfScrollRegionPaintArgs(region, 3);

  assert.equal(args.width, 1500);
  assert.equal(args.height, 900);
  assert.equal(args.pixelRatio, 1);

  // The band the painter walks is exactly the region (not the live viewport, not page 1).
  const band = visibleSceneBand({ offsetY: args.viewportTransform[5]!, zoom: args.viewportTransform[0]! }, args.height);

  near(band.top, 2000);
  near(band.bottom, 2300);

  // A page-local PDF point → scene (how ink is hydrated) → output pixel: the same pixel
  // toCanvasElement(scale, { left, top }) puts that scene point's ink at.
  const frame = { frameWidth: 500, placement: { height: 750, width: 500, x: 0, y: -75 } };
  const toScene = pageToSceneTransform(frame, threePages.entries[1]!, threePages);
  const local = { x: 250, y: 300 };
  const scene = applySceneTransformToPoint(toScene, local);
  const [a, , , d, e, f] = pdfScrollPagePaintTransform(args.viewportTransform, toScene);

  near(a! * local.x + e!, (scene.x - region.left) * 3);
  near(d! * local.y + f!, (scene.y - region.top) * 3);
});

test('layout keys and page-sequence comparison', () => {
  const taller = buildPdfScrollLayout([page('a'), page('b'), page('c')], { aspectOf: (_p, i) => (i === 0 ? 2 : 1.5), gap: 24, width: 1000 });
  const reordered = buildPdfScrollLayout([page('b'), page('a'), page('c')], { aspectOf: () => 1.5, gap: 24, width: 1000 });

  assert.notEqual(pdfScrollLayoutKey(threePages), pdfScrollLayoutKey(taller));
  assert.equal(samePdfScrollPageSequence(threePages, taller), true, 'same pages, different heights → shift in place');
  assert.equal(samePdfScrollPageSequence(threePages, reordered), false);
});

test('host custom props (the lecture stroke clock `t`) survive the frame transform untouched', () => {
  const stamped = { left: 10, t: 48210, top: 20, type: 'Path' };
  const moved = transformCanvasObjectJson(stamped, { dx: 0, dy: 1524, scale: 1 });

  assert.equal((moved as { t?: number }).t, 48210);
});

test('markRevivedFromJson stamps the loadFromJSON-reviver marker on every hydrated object', () => {
  const objects = [{ type: 'Path' }, { type: 'Path', t: 5 }];

  markRevivedFromJson(objects);

  for (const object of objects) {
    assert.equal((object as Record<string, unknown>)[REVIVED_FROM_JSON_MARKER], true);
  }

  assert.equal((objects[1] as { t?: number }).t, 5, 'an existing stamp is kept');
});

test('inserted sheet: sized by its own aspect, ahead of the A4 guess', () => {
  const sheet = page('s', { pdfAssetId: undefined, sheetAspect: 1.25 });

  near(resolvePdfPageAspect(sheet), 1.25);
  // A recorded PDF placement still wins (a PDF page never carries sheetAspect, but the order is fixed).
  near(resolvePdfPageAspect(page('a', { canvasWidthPx: 800, pdfPlacement: { height: 1200, width: 800, x: 0, y: 0 }, sheetAspect: 3 })), 1.5);
  near(resolvePdfPageAspect(page('s', { pdfAssetId: undefined })), DEFAULT_PDF_PAGE_ASPECT);
});

test('inserting a sheet only restacks later pages; their ink stays on their own page', () => {
  const aspects: Record<string, number> = { a: 1.5, b: 1.5, s: 1.5, c: 1.5 };
  const before = buildPdfScrollLayout([page('a'), page('b'), page('c')], { aspectOf: (p) => aspects[p.id]!, gap: 24, width: 1000 });
  const after = buildPdfScrollLayout([page('a'), page('s', { pdfAssetId: undefined, sheetAspect: 1.5 }), page('b'), page('c')], {
    aspectOf: (p) => aspects[p.id]!,
    gap: 24,
    width: 1000,
  });

  // Same width, same gap; the sheet takes the slot after «a», «b» moves down one page + one gap.
  assert.deepEqual(after.entries.map((entry) => entry.pageId), ['a', 's', 'b', 'c']);
  assert.equal(after.entries[1]!.top, 1524);
  assert.equal(after.entries[2]!.top, before.entries[1]!.top + 1524);
  assert.equal(samePdfScrollPageSequence(before, after), false);

  // Ink stored page-local on «b» (a PDF page recorded at frame width 1000, rect centred at y=-200).
  const pageB = page('b', { canvasWidthPx: 1000, pdfPlacement: { height: 1500, width: 1000, x: 0, y: -200 } });
  const stroke = { left: 300, top: 400, type: 'Path' };
  const frameB = resolvePdfScrollPageFrame(pageB, after.entries[2]!, after, { height: 1100, width: 1000 });
  const toScene = pageToSceneTransform(frameB, after.entries[2]!, after);
  const inScene = transformCanvasObjectJson(stroke, toScene);

  // Lands inside «b»'s sheet in the new layout (not on the sheet that took «b»'s old slot)…
  assert.equal(findPdfScrollPageAt(after, inScene.top), 2);
  near(inScene.top, after.entries[2]!.top + 600);
  // …and round-trips back to the identical page-local coordinates.
  const back = transformCanvasObjectJson(inScene, invertSceneTransform(toScene));

  near(back.left, 300);
  near(back.top, 400);
});

test('inserted sheet frame: from the top of the page; another device scales it uniformly', () => {
  const sheet = page('s', { pdfAssetId: undefined, sheetAspect: 1.5, canvasWidthPx: 1000 });
  const layout = buildPdfScrollLayout([page('a'), sheet], { aspectOf: () => 1.5, gap: 24, width: 500 });
  const frame = resolvePdfScrollPageFrame(sheet, layout.entries[1]!, layout, { height: 700, width: 500 });

  assert.equal(frame.recorded, false);
  assert.equal(frame.frameWidth, 1000);
  assert.deepEqual(frame.placement, { height: 1500, width: 1000, x: 0, y: 0 });

  const transform = pageToSceneTransform(frame, layout.entries[1]!, layout);

  near(transform.scale, 0.5);
  const point = applySceneTransformToPoint(transform, { x: 1000, y: 1500 });

  near(point.x, 500);
  near(point.y, layout.entries[1]!.top + 750);
});

test('sheet ruling: width-relative pitch, header band, clipped to the band and the sheet', () => {
  const entry = { height: 1400, top: 1000 };
  const pitch = sheetRulePitch(1000);
  const all = sheetRuleLineYs(entry, 1000, -Infinity, Infinity);

  near(pitch, 1000 / SHEET_RULE_LINES_PER_WIDTH);
  near(all[0]!, 1000 + 2 * pitch);
  assert.ok(all[all.length - 1]! <= 2400 - pitch / 2);
  all.slice(1).forEach((y, i) => near(y - all[i]!, pitch));

  const band = sheetRuleLineYs(entry, 1000, 1510, 1700);

  assert.ok(band.length > 0 && band.every((y) => y >= 1510 && y <= 1700));
  assert.deepEqual(band, all.filter((y) => y >= 1510 && y <= 1700));
  assert.deepEqual(sheetRuleLineYs(entry, 1000, 0, 900), []);
});
