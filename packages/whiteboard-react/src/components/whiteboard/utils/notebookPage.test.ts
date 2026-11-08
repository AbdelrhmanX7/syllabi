import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  captureNotebookView,
  fitNotebookViewport,
  NOTEBOOK_PAGE_MAX_WIDTH_PX,
  NOTEBOOK_PAGE_ROOM_AHEAD,
  notebookViewBottom,
  notebookViewStorageKey,
  parseNotebookView,
  refitNotebookViewport,
  resolveNotebookFrameWidth,
  resolveNotebookLayout,
  restoreNotebookViewport,
  shouldGrowNotebookPage,
  unionInkBounds,
} from './notebookPage';
import { clampPanDelta, clampViewportTransform } from './viewportConstraints';

const near = (actual: number, expected: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} ≉ ${expected}`);

test('frame width: the recorded frame wins; else the pane, capped', () => {
  assert.equal(resolveNotebookFrameWidth(1400, 800), 1400);
  assert.equal(resolveNotebookFrameWidth(undefined, 800), 800);
  assert.equal(resolveNotebookFrameWidth(undefined, 2000), NOTEBOOK_PAGE_MAX_WIDTH_PX);
  assert.equal(resolveNotebookFrameWidth(undefined, 0), null);
  assert.equal(resolveNotebookFrameWidth(Number.NaN, 700), 700);
});

test('a page as wide as the pane fits at zoom 1 and cannot pan sideways', () => {
  const layout = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 800, frameWidth: 800, ink: null, maxZoom: 4 });

  assert.ok(layout);
  near(layout.constraints.minZoom, 1);
  assert.equal(layout.pageLeft, 0);
  assert.equal(layout.pageRight, 800);

  // A diagonal finger at the fit zoom: x stays 0, y scrolls (the page is one screen + room to grow).
  const vt = [1, 0, 0, 1, 0, 0];
  const delta = clampPanDelta(vt, 60, -400, layout.constraints, 800, 900);

  assert.equal(delta.dx, 0);
});

test('a wide pane shows the capped page centred, x locked at the fit zoom', () => {
  const layout = resolveNotebookLayout({
    canvasHeight: 1250,
    canvasWidth: 2000,
    frameWidth: NOTEBOOK_PAGE_MAX_WIDTH_PX,
    ink: { bottom: 3000, left: 20, right: 900, top: 10 },
    maxZoom: 4,
  });

  assert.ok(layout);
  near(layout.constraints.minZoom, 1);

  const vt = clampViewportTransform([1, 0, 0, 1, 0, -500], layout.constraints, 2000, 1250);

  near(vt[4], (2000 - NOTEBOOK_PAGE_MAX_WIDTH_PX) / 2, 'centred');

  for (const dx of [60, -60, 500]) {
    assert.equal(clampPanDelta(vt, dx, -400, layout.constraints, 2000, 1250).dx, 0);
  }
});

test('zoomed in past fit, horizontal pan is clamped to the page edges', () => {
  const layout = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 800, frameWidth: 800, ink: null, maxZoom: 4 });

  assert.ok(layout);

  // Zoom 2: the page is 1600 px on screen, so x may range over [800 − 1600, 0] = [−800, 0].
  const vt = [2, 0, 0, 2, -100, 0];

  assert.equal(clampPanDelta(vt, 60, 0, layout.constraints, 800, 900).dx, 60);
  assert.equal(clampPanDelta(vt, 500, 0, layout.constraints, 800, 900).dx, 100);
  assert.equal(clampPanDelta(vt, -2000, 0, layout.constraints, 800, 900).dx, -700);
});

test('zoom-out is capped at the fit zoom', () => {
  const layout = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 600, frameWidth: 1000, ink: null, maxZoom: 4 });

  assert.ok(layout);
  near(layout.constraints.minZoom, 0.6);
  near(clampViewportTransform([0.3, 0, 0, 0.3, 0, 0], layout.constraints, 600, 900)[0], 0.6);
});

test('the same page on a narrower device is the same sheet scaled (width-relative)', () => {
  const ink = { bottom: 400, left: 100, right: 700, top: 50 };
  const wide = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 1000, frameWidth: 1000, ink, maxZoom: 4 });
  const narrow = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 500, frameWidth: 1000, ink, maxZoom: 4 });

  assert.ok(wide && narrow);

  const vtWide = fitNotebookViewport([1, 0, 0, 1, 0, 0], wide.constraints, 1000, 900);
  const vtNarrow = fitNotebookViewport([1, 0, 0, 1, 0, 0], narrow.constraints, 500, 900);
  // A stroke at scene x = 700 sits at 70% of the visible width on both.
  const relative = (vt: number[], width: number) => (700 * vt[0] + vt[4]) / width;

  near(relative(vtWide, 1000), 0.7);
  near(relative(vtNarrow, 500), 0.7);
});

test('old ink outside the frame widens the page instead of hiding it', () => {
  const layout = resolveNotebookLayout({
    canvasHeight: 900,
    canvasWidth: 1200,
    frameWidth: 1000,
    ink: { bottom: 500, left: -150, right: 1400, top: -40 },
    maxZoom: 4,
  });

  assert.ok(layout);
  assert.equal(layout.pageLeft, -150);
  assert.equal(layout.pageRight, 1400);
  assert.equal(layout.constraints.scene.top, -40);
  near(layout.constraints.minZoom, 1200 / 1550);

  // At the fit zoom both ends are on screen.
  const vt = fitNotebookViewport([1, 0, 0, 1, 0, 0], layout.constraints, 1200, 900);

  near(-150 * vt[0] + vt[4], 0);
  near(1400 * vt[0] + vt[4], 1200);
});

test('endless paper: a blank page already scrolls; ink and the furthest view each keep room ahead', () => {
  const empty = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 800, frameWidth: 800, ink: null, maxZoom: 4 });
  const long = resolveNotebookLayout({
    canvasHeight: 900,
    canvasWidth: 800,
    frameWidth: 800,
    ink: { bottom: 5000, left: 0, right: 700, top: 0 },
    maxZoom: 4,
  });

  assert.ok(empty && long);
  // A blank page: one screen plus room ahead, so it can scroll down at all.
  assert.equal(empty.constraints.scene.bottom, 900 * (1 + NOTEBOOK_PAGE_ROOM_AHEAD));
  assert.ok(clampPanDelta([1, 0, 0, 1, 0, 0], 0, -400, empty.constraints, 800, 900).dy < 0, 'blank page scrolls');
  near(long.constraints.scene.bottom, 5000 + 900 * NOTEBOOK_PAGE_ROOM_AHEAD);

  // The view scrolled past the ink: the page keeps room below the view, not just below the ink.
  const viewed = resolveNotebookLayout({
    canvasHeight: 900,
    canvasWidth: 800,
    frameWidth: 800,
    ink: { bottom: 500, left: 0, right: 700, top: 0 },
    maxZoom: 4,
    viewedBottom: 8000,
  });

  assert.ok(viewed);
  near(viewed.constraints.scene.bottom, 8000 + 900 * NOTEBOOK_PAGE_ROOM_AHEAD);
  // Junk high-water marks are ignored.
  const junk = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 800, frameWidth: 800, ink: null, maxZoom: 4, viewedBottom: Number.NaN });

  assert.equal(junk?.constraints.scene.bottom, empty.constraints.scene.bottom);
});

test('endless paper: scrolling to the bottom repeatedly keeps growing the page, never under the view', () => {
  const height = 900;
  let viewedBottom: number | null = null;
  let vt: number[] = [1, 0, 0, 1, 0, 0];
  let layout = resolveNotebookLayout({ canvasHeight: height, canvasWidth: 800, frameWidth: 800, ink: null, maxZoom: 4 });

  assert.ok(layout);

  for (let step = 0; step < 40; step += 1) {
    // Fling down as far as the cage allows.
    const { dy } = clampPanDelta(vt, 0, -5000, layout!.constraints, 800, height);

    vt = [vt[0], 0, 0, vt[3], vt[4], vt[5] + dy];
    const viewBottom = notebookViewBottom(vt, height);

    assert.ok(viewBottom <= layout!.constraints.scene.bottom + 1e-6, 'view inside the page');
    viewedBottom = Math.max(viewedBottom ?? viewBottom, viewBottom);

    if (shouldGrowNotebookPage(layout!.constraints, viewBottom, height)) {
      const next = resolveNotebookLayout({ canvasHeight: height, canvasWidth: 800, frameWidth: 800, ink: null, maxZoom: 4, viewedBottom });

      assert.ok(next && next.constraints.scene.bottom > layout!.constraints.scene.bottom, 'grows, never shrinks');
      // The grown cage never moves the view.
      assert.deepEqual(clampViewportTransform(vt, next!.constraints, 800, height), vt);
      layout = next;
    }

    // Scroll back up a little now and then: the page keeps its length.
    if (step % 7 === 6) vt = [vt[0], 0, 0, vt[3], vt[4], vt[5] + 1200];
  }

  assert.ok(notebookViewBottom(vt, height) > 900 * 40, 'scrolled far down a blank page');
});

test('notebookViewBottom / shouldGrowNotebookPage', () => {
  near(notebookViewBottom([2, 0, 0, 2, 0, -1000], 900), 950);
  near(notebookViewBottom(undefined, 900), 900);

  const constraints = { maxZoom: 4, minZoom: 1, scene: { bottom: 3000, left: 0, right: 800, top: 0 } };

  assert.equal(shouldGrowNotebookPage(constraints, 1000, 900), false);
  assert.equal(shouldGrowNotebookPage(constraints, 1700, 900), true);
  assert.equal(shouldGrowNotebookPage(constraints, Number.NaN, 900), false);
});

test('refit: a view at the fit zoom follows a resize; a zoomed-in view keeps its zoom', () => {
  const ink = { bottom: 3000, left: 0, right: 900, top: 0 };
  const before = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 1000, frameWidth: 1000, ink, maxZoom: 4 });
  const after = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 600, frameWidth: 1000, ink, maxZoom: 4 });

  assert.ok(before && after);

  // At fit, scrolled so scene y = 300 is at the top.
  const atFit = refitNotebookViewport([1, 0, 0, 1, 0, -300], before.constraints, after.constraints, 600, 900);

  near(atFit[0], 0.6);
  near(-atFit[5] / atFit[0], 300, 'reading row kept');
  near(atFit[4], 0);

  const zoomed = refitNotebookViewport([2, 0, 0, 2, -50, -300], before.constraints, after.constraints, 600, 900);

  near(zoomed[0], 2);
});

test('view memory: a zoomed, scrolled view round-trips through storage', () => {
  const layout = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 800, frameWidth: 800, ink: null, maxZoom: 4, viewedBottom: 4000 });

  assert.ok(layout);

  const vt = [2, 0, 0, 2, -300, -5000];
  const view = captureNotebookView(vt, layout.constraints);

  assert.deepEqual(view, { left: 150, top: 2500, zoomRatio: 2 });

  const parsed = parseNotebookView(JSON.stringify(view));

  assert.ok(parsed);
  assert.deepEqual(restoreNotebookViewport(parsed, layout.constraints, 800, 900), vt);
  assert.equal(notebookViewStorageKey('b1', 'p1'), 'wb-notebook-view:b1:p1');
});

test('view memory: the zoom is fit-relative, kept in range, and the view pulled inside the page', () => {
  // Left at fit width on a 1000 px pane; reopened on a 500 px pane → fit width there too.
  const wide = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 1000, frameWidth: 1000, ink: null, maxZoom: 4 });
  const narrow = resolveNotebookLayout({ canvasHeight: 900, canvasWidth: 500, frameWidth: 1000, ink: null, maxZoom: 4 });

  assert.ok(wide && narrow);

  const view = captureNotebookView([1, 0, 0, 1, 0, -400], wide.constraints);

  assert.ok(view);

  const vt = restoreNotebookViewport(view, narrow.constraints, 500, 900);

  near(vt[0], 0.5);
  near(-vt[5] / vt[0], 400, 'same reading row');

  // An out-of-range zoom is clamped; a view far below the page is pulled back inside.
  near(restoreNotebookViewport({ left: 0, top: 0, zoomRatio: 50 }, narrow.constraints, 500, 900)[0], 4);
  const far = restoreNotebookViewport({ left: 0, top: 99999, zoomRatio: 1 }, narrow.constraints, 500, 900);

  assert.ok(notebookViewBottom(far, 900) <= narrow.constraints.scene.bottom + 1e-6);
});

test('view memory: malformed stored values are ignored', () => {
  for (const raw of [null, '', 'nope', '{}', '{"zoomRatio":0,"left":0,"top":0}', '{"zoomRatio":1,"left":"x","top":0}', 42]) {
    assert.equal(parseNotebookView(raw), null, String(raw));
  }

  assert.equal(captureNotebookView([Number.NaN, 0, 0, 1, 0, 0], { maxZoom: 4, minZoom: 1, scene: { bottom: 1, left: 0, right: 1, top: 0 } }), null);
});

test('unionInkBounds', () => {
  assert.equal(unionInkBounds([]), null);
  assert.deepEqual(
    unionInkBounds([
      { height: 10, left: 5, top: 5, width: 10 },
      { height: 100, left: -20, top: 50, width: 30 },
      { height: Number.NaN, left: 0, top: 0, width: 1 },
    ]),
    { bottom: 150, left: -20, right: 15, top: 5 },
  );
});
