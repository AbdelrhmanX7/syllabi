import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  backdropNeedsRefresh,
  backdropPaintTransform,
  backdropPatternTile,
  DEFAULT_BACKDROP_BUDGET,
  placeBackdrop,
  planBackdrop,
  resolveBackdropBudget,
  sceneRectIntersectsPlan,
  type BackdropBudget,
} from './overscanBackdrop';

const near = (actual: number, expected: number, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

test('plans a 3x3-viewport area at the budget quality when it fits', () => {
  const plan = planBackdrop(1280, 800, [1, 0, 0, 1, 0, 0]);

  assert.ok(plan);
  assert.equal(plan.overscan, 1);
  near(plan.ratio, 0.4);
  assert.equal(plan.screenLeft, -1280);
  assert.equal(plan.screenTop, -800);
  assert.equal(plan.screenWidth, 3840);
  assert.equal(plan.screenHeight, 2400);
  assert.equal(plan.pixelWidth, 1536);
  assert.equal(plan.pixelHeight, 960);
  assert.ok(plan.pixelWidth * plan.pixelHeight <= DEFAULT_BACKDROP_BUDGET.maxPixels);
});

test('scene rect inverts the viewport transform (zoom + pan)', () => {
  const plan = planBackdrop(1000, 500, [2, 0, 0, 2, 300, -100]);

  assert.ok(plan);
  // screenLeft −1000 → scene (−1000 − 300) / 2.
  near(plan.sceneLeft, -650);
  near(plan.sceneTop, (-500 + 100) / 2);
  near(plan.sceneWidth, 1500);
  near(plan.sceneHeight, 750);
});

test('lowers the ratio before shrinking the overscan to fit the pixel cap', () => {
  const plan = planBackdrop(1920, 1200, [1, 0, 0, 1, 0, 0]);

  assert.ok(plan);
  // 5760×3600 @0.4 = 3.3M px > 2.4M → ratio drops, overscan kept.
  assert.equal(plan.overscan, 1);
  assert.ok(plan.ratio < 0.4 && plan.ratio >= DEFAULT_BACKDROP_BUDGET.minQuality);
  assert.ok(plan.pixelWidth * plan.pixelHeight <= DEFAULT_BACKDROP_BUDGET.maxPixels);
});

test('shrinks the overscan once the ratio hits its floor', () => {
  const tight: BackdropBudget = { ...DEFAULT_BACKDROP_BUDGET, maxPixels: 300_000 };
  const plan = planBackdrop(1920, 1200, [1, 0, 0, 1, 0, 0], tight);

  assert.ok(plan);
  assert.ok(plan.overscan < 1);
  assert.ok(plan.overscan > 0);
  assert.ok(plan.ratio >= tight.minQuality - 1e-9);
  assert.ok(plan.pixelWidth * plan.pixelHeight <= tight.maxPixels);
});

test('falls back to overscan 0 below the floor for an absurd viewport, still capped', () => {
  const tiny: BackdropBudget = { ...DEFAULT_BACKDROP_BUDGET, maxPixels: 10_000 };
  const plan = planBackdrop(4000, 3000, [1, 0, 0, 1, 0, 0], tiny);

  assert.ok(plan);
  assert.equal(plan.overscan, 0);
  assert.ok(plan.ratio < tiny.minQuality);
  assert.ok(plan.pixelWidth * plan.pixelHeight <= tiny.maxPixels);
});

test('respects the max edge for very wide viewports', () => {
  const plan = planBackdrop(8000, 300, [1, 0, 0, 1, 0, 0]);

  assert.ok(plan);
  assert.ok(plan.pixelWidth <= DEFAULT_BACKDROP_BUDGET.maxEdge);
});

test('degenerate viewport → no plan', () => {
  assert.equal(planBackdrop(0, 800, null), null);
  assert.equal(planBackdrop(800, -1, null), null);
});

test('low-memory devices get a smaller budget', () => {
  assert.ok(resolveBackdropBudget(2).maxPixels < resolveBackdropBudget(4).maxPixels);
  assert.ok(resolveBackdropBudget(4).maxPixels < resolveBackdropBudget(8).maxPixels);
  assert.equal(resolveBackdropBudget(undefined), DEFAULT_BACKDROP_BUDGET);
});

test('placement at the planning viewport puts the backdrop exactly over its screen rect', () => {
  const vpt = [1.5, 0, 0, 1.5, 120, -40];
  const plan = planBackdrop(1200, 800, vpt);

  assert.ok(plan);
  const place = placeBackdrop(plan, vpt);

  near(place.x, plan.screenLeft);
  near(place.y, plan.screenTop);
  near(place.scale * plan.pixelWidth, plan.screenWidth, plan.screenWidth * 0.002);
});

test('placement follows a later pan and zoom (scene-anchored)', () => {
  const plan = planBackdrop(1000, 600, [1, 0, 0, 1, 0, 0]);

  assert.ok(plan);
  const later = [2, 0, 0, 2, 50, 70];
  const place = placeBackdrop(plan, later);
  // Scene point (100, 200) → backdrop px → container px must equal later's screen mapping.
  const bx = (100 - plan.sceneLeft) * plan.zoom * plan.ratio;
  const by = (200 - plan.sceneTop) * plan.zoom * plan.ratio;

  near(place.x + place.scale * bx, 2 * 100 + 50);
  near(place.y + place.scale * by, 2 * 200 + 70);
});

test('paint transform maps the overscan corner to the origin', () => {
  const vpt = [2, 0, 0, 2, 10, 20];
  const plan = planBackdrop(400, 300, vpt);

  assert.ok(plan);
  const t = backdropPaintTransform(plan);

  near(t[0] * plan.sceneLeft + t[4], 0);
  near(t[3] * plan.sceneTop + t[5], 0);
});

test('refresh is needed with no plan, after a large pan, or a big zoom change — not after a small pan', () => {
  const vpt = [1, 0, 0, 1, 0, 0];
  const plan = planBackdrop(1000, 600, vpt);

  assert.equal(backdropNeedsRefresh(null, 1000, 600, vpt), true);
  assert.equal(backdropNeedsRefresh(plan, 1000, 600, vpt), false);
  assert.equal(backdropNeedsRefresh(plan, 1000, 600, [1, 0, 0, 1, -300, 100]), false);
  assert.equal(backdropNeedsRefresh(plan, 1000, 600, [1, 0, 0, 1, -800, 0]), true);
  assert.equal(backdropNeedsRefresh(plan, 1000, 600, [2, 0, 0, 2, 0, 0]), true);
  assert.equal(backdropNeedsRefresh(plan, 1000, 600, [0.5, 0, 0, 0.5, 250, 150]), true);
});

test('a pixel-capped plan with small overscan does not demand a refresh at rest', () => {
  const tight: BackdropBudget = { ...DEFAULT_BACKDROP_BUDGET, maxPixels: 300_000 };
  const vpt = [1, 0, 0, 1, 0, 0];
  const plan = planBackdrop(1920, 1200, vpt, tight);

  assert.equal(backdropNeedsRefresh(plan, 1920, 1200, vpt), false);
});

test('ink culling keeps rects that touch the planned scene area', () => {
  const plan = planBackdrop(1000, 600, [1, 0, 0, 1, 0, 0]);

  assert.ok(plan);
  assert.equal(sceneRectIntersectsPlan(plan, { height: 10, left: 1500, top: 0, width: 10 }), true);
  assert.equal(sceneRectIntersectsPlan(plan, { height: 10, left: 2100, top: 0, width: 10 }), false);
  assert.equal(sceneRectIntersectsPlan(plan, { height: 10, left: -1010, top: -610, width: 20 }), true);
});

test('pattern tile: skipped when too dense, aligned to scene origin otherwise', () => {
  const plan = planBackdrop(1000, 600, [1, 0, 0, 1, 37, 11]);

  assert.ok(plan);
  const tile = backdropPatternTile(plan, 30);

  assert.ok(tile);
  near(tile.tilePx * tile.scale, 30 * plan.ratio);
  near(tile.translateX, (37 + 1000) * plan.ratio);
  near(tile.translateY, (11 + 600) * plan.ratio);

  const zoomedOut = planBackdrop(1000, 600, [0.2, 0, 0, 0.2, 0, 0]);

  assert.ok(zoomedOut);
  assert.equal(backdropPatternTile(zoomedOut, 30), null);
});
