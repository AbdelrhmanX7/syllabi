import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePdfLiveRenderEdge, setPdfQualityMode } from './pdfRenderSizing';

// The PDF page is displayed FIT-TO-WIDTH (getScreenFitPlacement: scale = canvasWidth/imageWidth), and
// the native/pdf.js renderers cap the LONGEST edge. So the raster's WIDTH is `edge × (W / max(W,H))`.
// It must reach the display's device-pixel width or the page is upscaled → soft. In node `window` is
// undefined so devicePixelRatio resolves to 1 — the same dpr=1 as the teacher's device where a portrait
// A4 page measured raster=1625 vs needed=1916 (ratio 0.85, blurry). These tests pin ratio ≥ 1.
const rasterWidth = (edge: number, aspect: number) => (aspect <= 1 ? edge * aspect : edge);
const LIVE_ARGS = { fileSize: 2 * 1024 * 1024, totalPages: 10, zoom: 1 } as const;

test('portrait A4 page covers the fit-to-width display (regression: was 0.85 on-device)', () => {
  setPdfQualityMode('max');
  const containerWidth = 1916; // the teacher's measured container width, dpr=1
  const aspect = 1625 / 2304; // the teacher's exact measured page aspect (~0.705)
  const edge = resolvePdfLiveRenderEdge({ ...LIVE_ARGS, containerWidth, pageAspectRatio: aspect });

  assert.ok(
    rasterWidth(edge, aspect) >= containerWidth,
    `raster width ${Math.round(rasterWidth(edge, aspect))} must cover display ${containerWidth}`,
  );
});

test('portrait coverage holds even before the aspect is known (first render defaults to A4)', () => {
  setPdfQualityMode('high');
  const containerWidth = 1920;
  // Unknown aspect (first render). A real A4/Letter portrait page must still be covered.
  const edge = resolvePdfLiveRenderEdge({ ...LIVE_ARGS, containerWidth });

  for (const aspect of [0.7071, 0.773]) {
    assert.ok(
      rasterWidth(edge, aspect) >= containerWidth * 0.99,
      `mode=high default-aspect: raster ${Math.round(rasterWidth(edge, aspect))} vs ${containerWidth}`,
    );
  }
});

test('landscape and square pages are covered too', () => {
  setPdfQualityMode('max');
  const containerWidth = 1600;

  for (const aspect of [1.0, 1.333, 1.777]) {
    const edge = resolvePdfLiveRenderEdge({ ...LIVE_ARGS, containerWidth, pageAspectRatio: aspect });

    assert.ok(
      rasterWidth(edge, aspect) >= containerWidth,
      `aspect ${aspect}: raster ${Math.round(rasterWidth(edge, aspect))} vs ${containerWidth}`,
    );
  }
});

test('never exceeds the 4096 hard cap (memory safety)', () => {
  setPdfQualityMode('max');
  // A huge display + very tall page would demand more than the cap; the request must clamp, not blow up.
  const edge = resolvePdfLiveRenderEdge({ ...LIVE_ARGS, containerWidth: 3840, pageAspectRatio: 0.5, zoom: 3 });

  assert.ok(edge <= 4096, `edge ${edge} must clamp to the 4096 ceiling`);
});
