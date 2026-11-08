import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getRotatedScreenFitPlacement, getScreenFitPlacement } from './backgroundLayers';
import {
  applySnapshotGeometry,
  captureSnapshotState,
  getFrameScale,
  getPageFrameScale,
  resolveFrozenPdfFit,
  resolvePageExportFrame,
  resolveResetViewport,
  resolveSnapshotGeometry,
  toFrameViewport,
  toPdfPlacementRect,
  toScreenViewport,
} from './snapshotGeometry';

import type { PdfBackgroundFrame } from './snapshotGeometry';
import type { WhiteboardPage } from '../types';

// A4 portrait raster (595×842 pt rendered at some DPI — only the aspect matters) on a 1920×1080 canvas.
const FRAME: PdfBackgroundFrame = {
  pageId: 'page-pdf',
  fitWidth: 1920,
  fitHeight: 1080,
  image: { width: 1190, height: 1684 },
};

function pdfPage(overrides: Partial<WhiteboardPage> = {}): WhiteboardPage {
  return {
    id: 'page-pdf',
    canvasJSON: '{"objects":[]}',
    thumbnail: '',
    backgroundType: 'blank',
    pdfAssetId: 'asset-1',
    pdfPageIndex: 0,
    viewportOffsetX: 0,
    viewportOffsetY: -400,
    viewportZoom: 1.5,
    ...overrides,
  };
}

function blankPage(overrides: Partial<WhiteboardPage> = {}): WhiteboardPage {
  return {
    id: 'page-blank',
    canvasJSON: '{"objects":[]}',
    thumbnail: '',
    backgroundType: 'grid',
    viewportOffsetX: 0,
    viewportOffsetY: 0,
    ...overrides,
  };
}

function recordedPdfPage(overrides: Partial<WhiteboardPage> = {}): WhiteboardPage {
  const geometry = resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage(), pdfFrame: FRAME });

  return applySnapshotGeometry(pdfPage(overrides), geometry);
}

test('toPdfPlacementRect maps the fit placement (left/top) onto the wire rect (x/y) and drops scale', () => {
  const rect = toPdfPlacementRect({ height: 2717, left: 0, scale: 1.6134, top: -818.5, width: 1920 });

  assert.deepEqual(rect, { height: 2717, width: 1920, x: 0, y: -818.5 });
});

test('a PDF page records the FROZEN fit width and the renderer’s own placement — a portrait page starts above the canvas', () => {
  const geometry = resolveSnapshotGeometry({ canvasWidth: 1280, page: pdfPage(), pdfFrame: FRAME });
  const expected = getScreenFitPlacement(FRAME.fitWidth, FRAME.fitHeight, 1190, 1684);

  assert.ok(geometry);
  // The frame the ink lives in is the fit size the page OPENED at, not the live (resized) canvas.
  assert.equal(geometry.canvasWidthPx, 1920);
  assert.deepEqual(geometry.pdfPlacement, {
    height: expected.height,
    width: expected.width,
    x: expected.left,
    y: expected.top,
  });
  assert.ok(typeof geometry.pdfPlacement === 'object');
  assert.equal(geometry.pdfPlacement.x, 0);
  assert.equal(geometry.pdfPlacement.width, 1920);
  assert.ok(geometry.pdfPlacement.y < 0, 'a page taller than the canvas is centred past the top edge');
});

test('the live viewport (pan/zoom) never enters the recorded geometry', () => {
  const panned = resolveSnapshotGeometry({
    canvasWidth: 1920,
    page: pdfPage({ viewportOffsetX: -300, viewportOffsetY: 900, viewportZoom: 2.5 }),
    pdfFrame: FRAME,
  });
  const rested = resolveSnapshotGeometry({
    canvasWidth: 1920,
    page: pdfPage({ viewportOffsetX: 0, viewportOffsetY: 0, viewportZoom: 1 }),
    pdfFrame: FRAME,
  });

  assert.deepEqual(panned, rested);
});

test('a rotated page records the rotated BOUNDING BOX, exactly as the background painter fits it', () => {
  const geometry = resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage({ pdfRotation: 90 }), pdfFrame: FRAME });
  const expected = getRotatedScreenFitPlacement(FRAME.fitWidth, FRAME.fitHeight, 1190, 1684, 90);

  assert.ok(geometry);
  assert.deepEqual(geometry.pdfPlacement, {
    height: expected.height,
    width: expected.width,
    x: expected.left,
    y: expected.top,
  });
  // Turned sideways the A4 page is landscape: still fills the width, but is much shorter than upright
  // (1920 × 1190/1684 ≈ 1357, vs ≈ 2717 upright) — the rect really is the rotated bbox, not the raster.
  const upright = resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage(), pdfFrame: FRAME });

  assert.ok(typeof geometry.pdfPlacement === 'object' && typeof upright?.pdfPlacement === 'object');
  assert.ok(Math.abs(geometry.pdfPlacement.height - (1920 * 1190) / 1684) < 1e-6);
  assert.ok(geometry.pdfPlacement.height < upright.pdfPlacement.height);
});

test('a PDF page whose frame is not known yet yields null (leave the recorded geometry alone)', () => {
  assert.equal(resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage(), pdfFrame: null }), null);
});

test('a PDF page whose fit is frozen but whose raster is still loading records the width and marks the placement unknown', () => {
  const geometry = resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage(), pdfFrame: { ...FRAME, image: null } });

  assert.deepEqual(geometry, { canvasWidthPx: 1920, pdfPlacement: 'unknown' });
});

test('a frame captured for ANOTHER page is never applied', () => {
  const stale = { ...FRAME, pageId: 'previous-page' };

  assert.equal(resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage(), pdfFrame: stale }), null);
});

test('a frame with a degenerate fit yields null, a degenerate raster marks the placement unknown', () => {
  assert.equal(
    resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage(), pdfFrame: { ...FRAME, fitWidth: 0 } }),
    null,
  );
  assert.deepEqual(
    resolveSnapshotGeometry({
      canvasWidth: 1920,
      page: pdfPage(),
      pdfFrame: { ...FRAME, image: { width: 1190, height: Number.NaN } },
    }),
    { canvasWidthPx: 1920, pdfPlacement: 'unknown' },
  );
});

test('a page without a PDF records the live canvas width and NO placement', () => {
  const geometry = resolveSnapshotGeometry({ canvasWidth: 1366, page: blankPage(), pdfFrame: FRAME });

  assert.deepEqual(geometry, { canvasWidthPx: 1366, pdfPlacement: 'none' });
});

test('a page without a PDF on an unmeasured canvas yields null — never a width of 0', () => {
  assert.equal(resolveSnapshotGeometry({ canvasWidth: 0, page: blankPage(), pdfFrame: null }), null);
  assert.equal(resolveSnapshotGeometry({ canvasWidth: Number.NaN, page: blankPage(), pdfFrame: null }), null);
});

test('an image-backed legacy page (pdfImageUrl, no asset) is a PDF page for geometry purposes', () => {
  const page = pdfPage({ pdfAssetId: undefined, pdfImageUrl: 'blob:page' });
  const geometry = resolveSnapshotGeometry({ canvasWidth: 1920, page, pdfFrame: FRAME });

  assert.ok(geometry && typeof geometry.pdfPlacement === 'object');
});

test('applySnapshotGeometry returns the SAME page object when nothing changed', () => {
  const geometry = resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage(), pdfFrame: FRAME });
  const page = recordedPdfPage();

  assert.equal(applySnapshotGeometry(page, geometry), page);
  assert.equal(applySnapshotGeometry(page, null), page);
});

test('applySnapshotGeometry writes both fields onto a page that had none, leaving everything else intact', () => {
  const page = pdfPage();
  const geometry = resolveSnapshotGeometry({ canvasWidth: 1920, page, pdfFrame: FRAME });
  const next = applySnapshotGeometry(page, geometry);

  assert.notEqual(next, page);
  assert.equal(next.canvasWidthPx, 1920);
  assert.deepEqual(next.pdfPlacement, geometry?.pdfPlacement);
  assert.equal(next.canvasJSON, page.canvasJSON);
  assert.equal(next.viewportZoom, page.viewportZoom);
  assert.equal(next.viewportOffsetY, page.viewportOffsetY);
  // The input is never mutated.
  assert.equal('canvasWidthPx' in page, false);
});

test('applySnapshotGeometry REMOVES a stale placement from a page that no longer has a PDF', () => {
  const page = blankPage({ canvasWidthPx: 1920, pdfPlacement: { height: 1, width: 1, x: 0, y: 0 } });
  const next = applySnapshotGeometry(page, { canvasWidthPx: 1920, pdfPlacement: 'none' });

  assert.equal('pdfPlacement' in next, false);
  assert.equal(next.canvasWidthPx, 1920);
});

test('an unknown placement keeps the record of THIS frame and drops one from another frame', () => {
  const recorded = recordedPdfPage();

  // Same frame, raster not loaded yet: nothing to change.
  assert.equal(applySnapshotGeometry(recorded, { canvasWidthPx: 1920, pdfPlacement: 'unknown' }), recorded);

  // A record from a 3436 px frame must not survive onto a 1920 px frame.
  const foreign = pdfPage({ canvasWidthPx: 3436, pdfPlacement: { height: 4860, width: 3436, x: 0, y: -1600 } });
  const next = applySnapshotGeometry(foreign, { canvasWidthPx: 1920, pdfPlacement: 'unknown' });

  assert.equal(next.canvasWidthPx, 1920);
  assert.equal('pdfPlacement' in next, false);
});

test('re-snapshotting the same frame is idempotent (no float churn between captures)', () => {
  const first = applySnapshotGeometry(
    pdfPage(),
    resolveSnapshotGeometry({ canvasWidth: 1920, page: pdfPage(), pdfFrame: FRAME }),
  );
  const second = applySnapshotGeometry(first, resolveSnapshotGeometry({ canvasWidth: 1920, page: first, pdfFrame: FRAME }));

  assert.equal(second, first);
});

test('a raster re-rendered at another resolution (sub-pixel aspect drift) does not rewrite the record', () => {
  const recorded = recordedPdfPage();
  // The same page rasterised for a 1096 px window: 1096 × 1684/1190 = 1550.9 rounds to 1551, a
  // slightly different aspect (≈0.5 px of fitted height at 1920 wide).
  const driftedFrame: PdfBackgroundFrame = { ...FRAME, image: { width: 1096, height: 1551 } };
  const drifted = resolveSnapshotGeometry({ canvasWidth: 1096, page: recorded, pdfFrame: driftedFrame });

  assert.ok(drifted && typeof drifted.pdfPlacement === 'object' && typeof recorded.pdfPlacement === 'object');
  assert.notEqual(drifted.pdfPlacement.height, recorded.pdfPlacement.height, 'the drift is real');
  assert.ok(Math.abs(drifted.pdfPlacement.height - recorded.pdfPlacement.height) < 1);
  assert.equal(applySnapshotGeometry(recorded, drifted), recorded);
});

// --- Frozen fit: record vs container -------------------------------------------------------------

test('resolveFrozenPdfFit: no record → the live container, exactly as before', () => {
  assert.deepEqual(resolveFrozenPdfFit({ container: { width: 1096, height: 700 }, record: null }), {
    height: 700,
    width: 1096,
  });
  assert.deepEqual(resolveFrozenPdfFit({ container: { width: 1096, height: 700 }, record: blankPage() }), {
    height: 700,
    width: 1096,
  });
});

test('resolveFrozenPdfFit: a recorded frame wins over the live container, height rebuilt from the placement', () => {
  const recorded = recordedPdfPage(); // frozen at 1920×1080
  const fit = resolveFrozenPdfFit({ container: { width: 1096, height: 700 }, record: recorded });

  assert.ok(fit);
  assert.equal(fit.width, 1920);
  assert.ok(Math.abs(fit.height - 1080) < 1e-6, `fitHeight = 2·y + height must give back 1080, got ${fit.height}`);
});

test('resolveFrozenPdfFit: the recorded frame needs no container at all', () => {
  const fit = resolveFrozenPdfFit({ container: { width: 0, height: 0 }, record: recordedPdfPage() });

  assert.ok(fit);
  assert.equal(fit.width, 1920);
});

test('resolveFrozenPdfFit: a recorded width without a placement takes the height from the live aspect', () => {
  const fit = resolveFrozenPdfFit({
    container: { width: 1096, height: 548 },
    record: { canvasWidthPx: 3436, pdfPlacement: undefined },
  });

  assert.deepEqual(fit, { height: 1718, width: 3436 });
  assert.equal(resolveFrozenPdfFit({ container: { width: 0, height: 0 }, record: { canvasWidthPx: 3436 } }), null);
});

test('resolveFrozenPdfFit: a placement that does not belong to the recorded width is ignored', () => {
  const fit = resolveFrozenPdfFit({
    container: { width: 1096, height: 548 },
    record: { canvasWidthPx: 3436, pdfPlacement: { height: 2715, width: 1920, x: 0, y: -817 } },
  });

  assert.deepEqual(fit, { height: 1718, width: 3436 });
});

test('resolveFrozenPdfFit: junk in the record falls back to the container; nothing at all → null', () => {
  assert.deepEqual(
    resolveFrozenPdfFit({ container: { width: 1096, height: 700 }, record: { canvasWidthPx: 0 } }),
    { height: 700, width: 1096 },
  );
  assert.deepEqual(
    resolveFrozenPdfFit({ container: { width: 1096, height: 700 }, record: { canvasWidthPx: Number.NaN } }),
    { height: 700, width: 1096 },
  );
  assert.equal(resolveFrozenPdfFit({ container: { width: 0, height: 0 }, record: null }), null);
});

// --- Frame scale + viewport units ------------------------------------------------------------------

test('getFrameScale is live ÷ frame, and 1 whenever either side is unknown', () => {
  assert.ok(Math.abs(getFrameScale(1096, 3436) - 1096 / 3436) < 1e-12);
  assert.equal(getFrameScale(3436, 3436), 1);
  assert.equal(getFrameScale(0, 3436), 1);
  assert.equal(getFrameScale(1096, undefined), 1);
  assert.equal(getFrameScale(1096, Number.NaN), 1);
});

test('getPageFrameScale: 1 for a blank page or a PDF page without a record; live ÷ recorded otherwise', () => {
  assert.equal(getPageFrameScale({ canvasWidth: 1096, canvasHeight: 700, page: blankPage({ canvasWidthPx: 3436 }) }), 1);
  assert.equal(getPageFrameScale({ canvasWidth: 1096, canvasHeight: 700, page: pdfPage() }), 1);

  const scale = getPageFrameScale({ canvasWidth: 1096, canvasHeight: 700, page: pdfPage({ canvasWidthPx: 3436 }) });

  assert.ok(Math.abs(scale - 1096 / 3436) < 1e-12);
});

test('viewport round-trips screen → frame → screen, and is untouched at scale 1', () => {
  const frame = { offsetX: 0, offsetY: -800, zoom: 1 }; // written on the 3436 px device
  const screen = toScreenViewport(frame, 1096 / 3436);

  assert.ok(Math.abs(screen.zoom - 1096 / 3436) < 1e-12);
  assert.ok(Math.abs(screen.offsetY - (-800 * 1096) / 3436) < 1e-9);
  assert.deepEqual(toFrameViewport(screen, 1096 / 3436), frame);

  const untouched = { offsetX: 12.345678901, offsetY: -0.000000001, zoom: 1.7 };

  assert.equal(toScreenViewport(untouched, 1), untouched);
  assert.equal(toFrameViewport(untouched, 1), untouched);
});

test('captureSnapshotState persists the viewport in frame units for a recorded PDF page shown on a narrower window', () => {
  const recorded = pdfPage({ canvasWidthPx: 3436, pdfPlacement: { height: 4860, width: 3436, x: 0, y: -1600 } });
  const frame: PdfBackgroundFrame = {
    pageId: recorded.id,
    fitWidth: 3436,
    fitHeight: 1660,
    image: { width: 1096, height: 1550 },
  };
  const scale = 1096 / 3436;
  const capture = captureSnapshotState({
    canvasWidth: 1096,
    defaultZoom: 1,
    page: recorded,
    pdfFrame: frame,
    viewportTransform: [scale, 0, 0, scale, 0, -255.2],
  });

  // The record stays at the frame the ink was drawn in — never the 1096 px window.
  assert.equal(capture.page.canvasWidthPx, 3436);
  assert.ok(typeof capture.page.pdfPlacement === 'object');
  assert.equal(capture.page.pdfPlacement.width, 3436);
  // A "fills the width" view on the small window is zoom 1 in frame units.
  assert.equal(capture.viewportZoom, 1);
  assert.ok(Math.abs(capture.viewportOffsetY - -255.2 / scale) < 1e-5);
});

test('captureSnapshotState leaves a blank page’s viewport in screen units (scale is exactly 1)', () => {
  const capture = captureSnapshotState({
    canvasWidth: 1096,
    defaultZoom: 1,
    page: blankPage(),
    pdfFrame: null,
    viewportTransform: [1.3, 0, 0, 1.3, 40, -77],
  });

  assert.equal(capture.viewportZoom, 1.3);
  assert.equal(capture.viewportOffsetX, 40);
  assert.equal(capture.viewportOffsetY, -77);
  assert.equal(capture.page.canvasWidthPx, 1096);
});

// --- Reset zoom ------------------------------------------------------------------------------------

test('resolveResetViewport: a tall PDF page resets to "fills the width, top of the page at the top of the view"', () => {
  const recorded = pdfPage({ canvasWidthPx: 3436, pdfPlacement: { height: 1932.75, width: 3436, x: 0, y: -335.875 } });
  const frame: PdfBackgroundFrame = {
    pageId: recorded.id,
    fitWidth: 3436,
    fitHeight: 1261,
    image: { width: 1600, height: 900 },
  };
  const scale = 1096 / 3436;
  const reset = resolveResetViewport({ canvasWidth: 1096, page: recorded, pdfFrame: frame });

  assert.ok(Math.abs(reset.zoom - scale) < 1e-12);
  assert.equal(reset.offsetX, 0);
  // −y × scale: the raster's top edge lands on screen y = 0 instead of 107 px above the window.
  assert.ok(Math.abs(reset.offsetY - 335.875 * scale) < 1e-9);

  // On the device the page was written on the same rule gives the import-time opening position.
  const wide = resolveResetViewport({ canvasWidth: 3436, page: recorded, pdfFrame: frame });

  assert.equal(wide.zoom, 1);
  assert.ok(Math.abs(wide.offsetY - 335.875) < 1e-9);
});

test('resolveResetViewport: a page shorter than its frame (positive y) stays centred; blank pages and unknown frames reset to identity', () => {
  const short = pdfPage({ canvasWidthPx: 1920 });
  const frame: PdfBackgroundFrame = { pageId: short.id, fitWidth: 1920, fitHeight: 1080, image: { width: 1600, height: 400 } };

  assert.deepEqual(resolveResetViewport({ canvasWidth: 1920, page: short, pdfFrame: frame }), {
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
  });
  assert.deepEqual(resolveResetViewport({ canvasWidth: 1920, page: blankPage(), pdfFrame: null }), {
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
  });
  assert.deepEqual(resolveResetViewport({ canvasWidth: 1920, page: pdfPage(), pdfFrame: null }), {
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
  });
});

test('resolveResetViewport: while the raster is still loading, the recorded placement decides the top-align', () => {
  const recorded = pdfPage({ canvasWidthPx: 3436, pdfPlacement: { height: 1932.75, width: 3436, x: 0, y: -335.875 } });
  const loading: PdfBackgroundFrame = { pageId: recorded.id, fitWidth: 3436, fitHeight: 1261, image: null };
  const reset = resolveResetViewport({ canvasWidth: 3436, page: recorded, pdfFrame: loading });

  assert.equal(reset.zoom, 1);
  assert.ok(Math.abs(reset.offsetY - 335.875) < 1e-9);
});

test('resolvePageExportFrame: an export composes against the RECORDED frame, not a taller live canvas (the shifted-ink bug)', () => {
  // Written on a 1920×900 board (the frozen frame); exported later with the window at 1920×1080.
  const image = { width: 1190, height: 1684 };
  const frame = { width: 1920, height: 900 };
  const recorded = toPdfPlacementRect(getScreenFitPlacement(frame.width, frame.height, image.width, image.height));
  const page = pdfPage({ canvasWidthPx: frame.width, pdfPlacement: recorded });
  const live = { width: 1920, height: 1080 };
  const exportFrame = resolvePageExportFrame({ live, page, pinned: null });

  assert.equal(exportFrame.width, frame.width);
  assert.ok(Math.abs(exportFrame.height - frame.height) < 1e-6);

  // Fitting against that frame reproduces the recorded placement — the page lands under the ink.
  const composed = toPdfPlacementRect(
    getScreenFitPlacement(exportFrame.width, exportFrame.height, image.width, image.height),
  );

  assert.ok(Math.abs(composed.y - recorded.y) < 1e-6);
  assert.ok(Math.abs(composed.height - recorded.height) < 1e-6);

  // Whereas the live canvas would have drawn the page (1080 − 900) / 2 = 90 px lower, i.e. the ink 90 px too high.
  const drifted = getScreenFitPlacement(live.width, live.height, image.width, image.height);

  assert.ok(Math.abs(drifted.top - composed.y - 90) < 1e-6);
});

test('resolvePageExportFrame: the painter’s pinned frame wins for its own page, another page’s pin is ignored, and no record means the live canvas as before', () => {
  const live = { width: 1920, height: 1080 };
  // Recorded frame height = 2·y + height = 900.
  const recorded = pdfPage({ canvasWidthPx: 1920, pdfPlacement: { height: 2700, width: 1920, x: 0, y: -900 } });
  const pinned: PdfBackgroundFrame = { pageId: recorded.id, fitWidth: 1600, fitHeight: 750, image: null };

  assert.deepEqual(resolvePageExportFrame({ live, page: recorded, pinned }), { height: 750, width: 1600 });
  assert.deepEqual(resolvePageExportFrame({ live, page: recorded, pinned: { ...pinned, pageId: 'other' } }), {
    height: 900,
    width: 1920,
  });
  assert.deepEqual(resolvePageExportFrame({ live, page: pdfPage(), pinned: null }), live);
  assert.deepEqual(resolvePageExportFrame({ live, page: pdfPage(), pinned: { ...pinned, pageId: 'other' } }), live);
});
