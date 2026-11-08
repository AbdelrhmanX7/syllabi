import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMergeManifestEntry } from './pageRender';

test('PDF page: full-page placement -> points, Y-flip yields y=0', () => {
  const entry = buildMergeManifestEntry({ pdfAssetId: 'asset-1', pdfPageIndex: 3 }, 0, {
    contentHeightCss: 1280,
    contentWidthCss: 960,
    pdfPlacementCss: { height: 1280, left: 0, top: 0, width: 960 },
  });

  // 960*72/96 = 720, 1280*72/96 = 960; pdf fills the page so x/y = 0 after the bottom-left flip.
  assert.deepEqual(entry, {
    heightPt: 960,
    index: 0,
    pdf: { height: 960, width: 720, x: 0, y: 0 },
    pdfAssetId: 'asset-1',
    pdfPageIndex: 3,
    widthPt: 720,
  });
});

test('PDF page: inset placement flips Y to a bottom-left origin', () => {
  const entry = buildMergeManifestEntry({ pdfAssetId: 'asset-2', pdfPageIndex: 0 }, 4, {
    contentHeightCss: 1000,
    contentWidthCss: 1000,
    pdfPlacementCss: { height: 300, left: 100, top: 200, width: 400 },
  });

  // widthPt=heightPt=750; pdf x=75 w=300 h=225; y = 750 - 200*0.75 - 225 = 750 - 150 - 225 = 375.
  assert.deepEqual(entry, {
    heightPt: 750,
    index: 4,
    pdf: { height: 225, width: 300, x: 75, y: 375 },
    pdfAssetId: 'asset-2',
    pdfPageIndex: 0,
    widthPt: 750,
  });
});

test('blank page: omits pdf + pdfAssetId/pdfPageIndex', () => {
  const entry = buildMergeManifestEntry({}, 2, {
    contentHeightCss: 600,
    contentWidthCss: 800,
  });

  assert.deepEqual(entry, { heightPt: 450, index: 2, widthPt: 600 });
  assert.equal(entry.pdf, undefined);
  assert.equal(entry.pdfAssetId, undefined);
  assert.equal(entry.pdfPageIndex, undefined);
});

test('placement without pdfAssetId is treated as blank (backend rejects pdf w/o asset)', () => {
  const entry = buildMergeManifestEntry({ pdfPageIndex: 5 }, 1, {
    contentHeightCss: 1280,
    contentWidthCss: 960,
    pdfPlacementCss: { height: 1280, left: 0, top: 0, width: 960 },
  });

  assert.equal(entry.pdf, undefined);
  assert.equal(entry.pdfAssetId, undefined);
  assert.equal(entry.pdfPageIndex, undefined);
  assert.equal(entry.widthPt, 720);
  assert.equal(entry.heightPt, 960);
});
