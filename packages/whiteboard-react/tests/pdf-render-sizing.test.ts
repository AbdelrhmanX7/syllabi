import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PDF_RENDER_EDGE,
  getPdfImportBaseRenderScale,
  resolvePdfLiveRenderEdge,
  resolvePdfPreviewJpegQuality,
  resolvePdfRenderProfile,
  resolvePdfImportRenderScale,
} from '../src/components/whiteboard/utils/pdfRenderSizing';

test('getPdfImportBaseRenderScale lowers the scale for medium and large PDFs', () => {
  assert.equal(getPdfImportBaseRenderScale(10), 1.5);
  assert.equal(getPdfImportBaseRenderScale(40), 1.2);
  assert.equal(getPdfImportBaseRenderScale(160), 0.95);
});

test('resolvePdfImportRenderScale keeps standard A4 pages within the selected scale', () => {
  assert.equal(resolvePdfImportRenderScale(160, 595, 842), 0.95);
  assert.equal(resolvePdfImportRenderScale(40, 595, 842), 1.2);
});

test('resolvePdfImportRenderScale caps oversized pages to the max render edge', () => {
  const scale = resolvePdfImportRenderScale(5, 1500, 2200);
  const renderedLongestEdge = Math.max(1500, 2200) * scale;

  assert.ok(scale < 1.5);
  assert.equal(Math.round(renderedLongestEdge), MAX_PDF_RENDER_EDGE);
});

test('resolvePdfRenderProfile lowers preview quality for very large PDFs', () => {
  const profile = resolvePdfRenderProfile({
    fileSize: 320 * 1024 * 1024,
    totalPages: 320,
  });

  assert.equal(profile.previewMaxEdge, 192);
  assert.equal(profile.previewJpegQuality, 0.42);
});

test('resolvePdfLiveRenderEdge respects the live render cap for large documents', () => {
  assert.equal(
    resolvePdfLiveRenderEdge({
      containerHeight: 900,
      containerWidth: 1400,
      fileSize: 300 * 1024 * 1024,
      totalPages: 350,
      zoom: 2.1,
    }),
    1280,
  );
});

test('resolvePdfPreviewJpegQuality keeps smaller files at a higher preview quality', () => {
  assert.equal(
    resolvePdfPreviewJpegQuality({
      fileSize: 20 * 1024 * 1024,
      totalPages: 24,
    }),
    0.52,
  );
});
