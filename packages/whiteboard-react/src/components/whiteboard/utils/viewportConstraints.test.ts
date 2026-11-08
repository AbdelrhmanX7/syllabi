import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampPanDelta,
  clampViewportTransform,
  clampZoom,
  constraintsForPageRect,
  isSameViewportTransform,
  refitViewportToConstraints,
  resolveFitWidthZoom,
} from './viewportConstraints';

import type { ViewportConstraints } from './viewportConstraints';

// A 1000×1400 page on a 1000×600 canvas: fit-width zoom is 1, the page is taller than the view.
const tallPage: ViewportConstraints = {
  maxZoom: 4,
  minZoom: 1,
  scene: { bottom: 1400, left: 0, right: 1000, top: 0 },
};
const W = 1000;
const H = 600;

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} ≠ ${expected}`);

test('zoom is clamped into [min, max]', () => {
  assert.equal(clampZoom(0.5, tallPage), 1);
  assert.equal(clampZoom(2, tallPage), 2);
  assert.equal(clampZoom(9, tallPage), 4);
});

test('resolveFitWidthZoom is canvas ÷ scene width, 1 when unusable', () => {
  assert.equal(resolveFitWidthZoom(500, 1000), 0.5);
  assert.equal(resolveFitWidthZoom(0, 1000), 1);
  assert.equal(resolveFitWidthZoom(1000, Number.NaN), 1);
});

test('an in-range viewport is returned unchanged', () => {
  const vt = [1, 0, 0, 1, 0, -300];

  assert.ok(isSameViewportTransform(clampViewportTransform(vt, tallPage, W, H), vt));
});

test('zooming out below fit-width is refused: the page keeps filling the width', () => {
  const clamped = clampViewportTransform([0.5, 0, 0, 0.5, 250, 0], tallPage, W, H);

  assert.equal(clamped[0], 1);
  // Horizontally the page exactly fills the canvas, so the only legal offset is 0.
  near(clamped[4], 0);
});

test('a zoom correction keeps the scene point under the canvas centre in place', () => {
  // Zoom 4 with scene (500, 700) under the canvas centre: offsets = 500 - 500·4, 300 - 700·4.
  const vt = [4, 0, 0, 4, -1500, -2500];
  const clamped = clampViewportTransform(vt, { ...tallPage, maxZoom: 2 }, W, H);

  assert.equal(clamped[0], 2);
  // Same scene point under the centre at zoom 2 → offsets 500 - 500·2 = -500, 300 - 700·2 = -1100,
  // both inside the legal ranges ([-1000, 0] and [-2200, 0]) so no pan clamp disturbs them.
  near(clamped[4], -500);
  near(clamped[5], -1100);
});

test('panning past the top or bottom of the page is clamped', () => {
  // Above the top: offsetY would be positive.
  near(clampViewportTransform([1, 0, 0, 1, 0, 120], tallPage, W, H)[5], 0);
  // Below the bottom: 1400 tall page in a 600 view → offsetY floor is 600 - 1400 = -800.
  near(clampViewportTransform([1, 0, 0, 1, 0, -2000], tallPage, W, H)[5], -800);
});

test('panning past the left or right edge is clamped when zoomed in', () => {
  // Zoom 2 → page is 2000 wide on a 1000 canvas: offsetX ∈ [-1000, 0].
  near(clampViewportTransform([2, 0, 0, 2, 50, -100], tallPage, W, H)[4], 0);
  near(clampViewportTransform([2, 0, 0, 2, -1500, -100], tallPage, W, H)[4], -1000);
});

test('a page shorter than the view is centred vertically', () => {
  const shortPage: ViewportConstraints = { maxZoom: 4, minZoom: 1, scene: { bottom: 400, left: 0, right: 1000, top: 0 } };
  const clamped = clampViewportTransform([1, 0, 0, 1, 0, -50], shortPage, W, H);

  near(clamped[5], (H - 400) / 2);
});

test('a scene rect with a negative top (paged frame centring) clamps to its own edges', () => {
  // Page-local frame: a 1000×1400 page centred in a 1000×600 canvas sits at y = -400.
  const framed: ViewportConstraints = { maxZoom: 4, minZoom: 1, scene: { bottom: 1000, left: 0, right: 1000, top: -400 } };

  // Showing the page top means offsetY = +400; anything higher is clamped back.
  near(clampViewportTransform([1, 0, 0, 1, 0, 900], framed, W, H)[5], 400);
  // Bottom: 600 - 1000 = -400.
  near(clampViewportTransform([1, 0, 0, 1, 0, -900], framed, W, H)[5], -400);
});

test('clampPanDelta returns only the part of the pan that stays inside', () => {
  const at = [1, 0, 0, 1, 0, -700];
  const delta = clampPanDelta(at, 30, -500, tallPage, W, H);

  near(delta.dx, 0, 'no horizontal room at fit-width');
  near(delta.dy, -100, 'only 100px of scroll left before the bottom');
});

test('constraintsForPageRect derives fit-width as the floor and the rect as the bounds', () => {
  const constraints = constraintsForPageRect({ canvasWidth: 500, maxZoom: 4, rect: { height: 1400, width: 1000, x: 0, y: -400 } });

  assert.ok(constraints);
  assert.equal(constraints.minZoom, 0.5);
  assert.equal(constraints.maxZoom, 4);
  assert.deepEqual(constraints.scene, { bottom: 1000, left: 0, right: 1000, top: -400 });
  assert.equal(constraintsForPageRect({ canvasWidth: 500, maxZoom: 4, rect: null }), null);
});

// The continuous PDF layout's cage at a given canvas width: the scene is the width the layout was
// entered at (2000 px, full screen on the tablet), the fit zoom is canvas width ÷ that.
const SCENE_WIDTH = 2000;
const cageAt = (canvasWidth: number): ViewportConstraints => {
  const minZoom = resolveFitWidthZoom(canvasWidth, SCENE_WIDTH);

  return { maxZoom: Math.max(4, minZoom), minZoom, scene: { bottom: 40_000, left: 0, right: SCENE_WIDTH, top: 0 } };
};
const HEIGHT = 1100;

test('refitViewportToConstraints: a view at fit re-fits the page to every new width (split screen, rotation)', () => {
  for (const width of [2000, 1350, 1000, 700, 420]) {
    const vt = refitViewportToConstraints([1, 0, 0, 1, 0, -3000], cageAt(2000), cageAt(width), width, HEIGHT);
    const zoom = vt[0];
    const pageRightOnScreen = SCENE_WIDTH * zoom + vt[4];

    assert.ok(Math.abs(zoom - width / SCENE_WIDTH) < 1e-9, `${width}: zoom is the new fit`);
    assert.ok(Math.abs(vt[4]) < 1e-9, `${width}: the page's left edge is on the view's left edge`);
    assert.ok(Math.abs(pageRightOnScreen - width) < 1e-6, `${width}: the page is exactly the view's width, never wider`);
    assert.ok(Math.abs(-vt[5] / zoom - 3000) < 1e-6, `${width}: the reading position (scene row at the top) survives`);
  }
});

test('refitViewportToConstraints: narrow then wide again returns to fit, never a letterboxed page', () => {
  let vt = refitViewportToConstraints([1, 0, 0, 1, 0, 0], cageAt(2000), cageAt(1350), 1350, HEIGHT);

  assert.ok(Math.abs(vt[0] - 0.675) < 1e-9);
  vt = refitViewportToConstraints(vt, cageAt(1350), cageAt(2000), 2000, HEIGHT);
  assert.ok(Math.abs(vt[0] - 1) < 1e-9, 'back to full width');
  assert.ok(Math.abs(vt[4]) < 1e-9);
});

test('refitViewportToConstraints: a view zoomed in past fit keeps its zoom, pulled back inside', () => {
  const vt = refitViewportToConstraints([2, 0, 0, 2, -2500, -6000], cageAt(2000), cageAt(1000), 1000, HEIGHT);

  assert.equal(vt[0], 2, 'the zoom the user chose is kept');
  assert.ok(vt[4] <= 0 && SCENE_WIDTH * 2 + vt[4] >= 1000, 'no board shows past either page edge');
});

test('refitViewportToConstraints: a zoom below the new fit (window grew) is lifted to the new fit', () => {
  // Zoomed in a little at 1350 (0.8 > fit 0.675), then the window goes full screen (fit 1).
  const vt = refitViewportToConstraints([0.8, 0, 0, 0.8, 0, -800], cageAt(1350), cageAt(2000), 2000, HEIGHT);

  assert.ok(Math.abs(vt[0] - 1) < 1e-9);
  assert.ok(Math.abs(-vt[5] / vt[0] - 1000) < 1e-6, 'same scene row at the top');
});

test('refitViewportToConstraints: no previous cage (first layout) fits', () => {
  const vt = refitViewportToConstraints(undefined, null, cageAt(700), 700, HEIGHT);

  assert.ok(Math.abs(vt[0] - 0.35) < 1e-9);
});
