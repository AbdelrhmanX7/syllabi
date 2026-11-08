import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWhiteboardDocument } from '../src/defaults';
import { migrateWhiteboardDocument, migrateWhiteboardPage } from '../src/migrations';
import { isSamePdfPlacement, normalizeCanvasWidthPx, normalizePdfPlacement } from '../src/page-geometry';
import { serializeWhiteboardRawData } from '../src/remote/raw-data';
import { WHITEBOARD_SCHEMA_VERSION } from '../src/types';

import type { WhiteboardDocument, WhiteboardPage } from '../src/types';

// A portrait PDF page on a landscape canvas: fill-width fit, centred vertically, so the rect starts
// ABOVE the canvas (negative y). This is the common case, not an edge case — see getScreenFitPlacement.
const PORTRAIT_PLACEMENT = { height: 2715.4, width: 1920, x: 0, y: -817.7 };

function pdfPage(overrides: Partial<WhiteboardPage> = {}): WhiteboardPage {
  return {
    id: 'page-pdf',
    canvasJSON: '{"objects":[]}',
    thumbnail: '',
    backgroundType: 'blank',
    pdfAssetId: 'asset-1',
    pdfPageIndex: 0,
    viewportOffsetX: 0,
    viewportOffsetY: 0,
    canvasWidthPx: 1920,
    pdfPlacement: PORTRAIT_PLACEMENT,
    ...overrides,
  };
}

function documentWith(pages: WhiteboardPage[]): WhiteboardDocument {
  return {
    id: 'doc-1',
    title: 'Board',
    pages,
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 2,
    thumbnail: '',
    viewportZoom: 1,
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  };
}

test('normalizeCanvasWidthPx keeps a finite positive width and rejects everything else', () => {
  assert.equal(normalizeCanvasWidthPx(1920), 1920);
  assert.equal(normalizeCanvasWidthPx(1366.5), 1366.5);
  assert.equal(normalizeCanvasWidthPx(0), undefined);
  assert.equal(normalizeCanvasWidthPx(-1920), undefined);
  assert.equal(normalizeCanvasWidthPx(Number.NaN), undefined);
  assert.equal(normalizeCanvasWidthPx(Number.POSITIVE_INFINITY), undefined);
  assert.equal(normalizeCanvasWidthPx('1920'), undefined);
  assert.equal(normalizeCanvasWidthPx(null), undefined);
  assert.equal(normalizeCanvasWidthPx(undefined), undefined);
});

test('normalizePdfPlacement keeps a well-formed rect, including a negative origin', () => {
  assert.deepEqual(normalizePdfPlacement(PORTRAIT_PLACEMENT), PORTRAIT_PLACEMENT);
  assert.deepEqual(normalizePdfPlacement({ x: -10, y: -20, width: 5, height: 5 }), {
    height: 5,
    width: 5,
    x: -10,
    y: -20,
  });
});

test('normalizePdfPlacement strips unknown keys and copies rather than aliases the input', () => {
  const input = { ...PORTRAIT_PLACEMENT, scale: 2, left: 0 };
  const output = normalizePdfPlacement(input);

  assert.deepEqual(output, PORTRAIT_PLACEMENT);
  assert.notEqual(output, input);
});

test('normalizePdfPlacement rejects a rect with no area, non-finite sides, or the wrong shape', () => {
  assert.equal(normalizePdfPlacement({ x: 0, y: 0, width: 0, height: 0 }), undefined);
  assert.equal(normalizePdfPlacement({ x: 0, y: 0, width: -1920, height: 2715 }), undefined);
  assert.equal(normalizePdfPlacement({ x: 0, y: 0, width: 1920, height: 0 }), undefined);
  assert.equal(normalizePdfPlacement({ x: Number.NaN, y: 0, width: 1920, height: 2715 }), undefined);
  assert.equal(normalizePdfPlacement({ x: 0, y: Number.NEGATIVE_INFINITY, width: 1920, height: 2715 }), undefined);
  assert.equal(normalizePdfPlacement({ x: 0, y: 0, width: 1920 }), undefined);
  assert.equal(normalizePdfPlacement({ left: 0, top: 0, width: 1920, height: 2715 }), undefined);
  assert.equal(normalizePdfPlacement({ x: '0', y: 0, width: 1920, height: 2715 }), undefined);
  assert.equal(normalizePdfPlacement(null), undefined);
  assert.equal(normalizePdfPlacement('rect'), undefined);
  assert.equal(normalizePdfPlacement([0, 0, 1920, 2715]), undefined);
});

test('isSamePdfPlacement compares by value and treats two absences as equal', () => {
  assert.equal(isSamePdfPlacement(PORTRAIT_PLACEMENT, { ...PORTRAIT_PLACEMENT }), true);
  assert.equal(isSamePdfPlacement(PORTRAIT_PLACEMENT, { ...PORTRAIT_PLACEMENT, y: -817.6 }), false);
  assert.equal(isSamePdfPlacement(undefined, undefined), true);
  assert.equal(isSamePdfPlacement(PORTRAIT_PLACEMENT, undefined), false);
  assert.equal(isSamePdfPlacement(undefined, PORTRAIT_PLACEMENT), false);
});

test('isSamePdfPlacement with a tolerance absorbs sub-pixel drift but not a real move', () => {
  const drifted = { ...PORTRAIT_PLACEMENT, height: PORTRAIT_PLACEMENT.height + 0.4, y: PORTRAIT_PLACEMENT.y - 0.2 };

  assert.equal(isSamePdfPlacement(PORTRAIT_PLACEMENT, drifted, 1), true);
  assert.equal(isSamePdfPlacement(PORTRAIT_PLACEMENT, drifted), false);
  assert.equal(isSamePdfPlacement(PORTRAIT_PLACEMENT, { ...PORTRAIT_PLACEMENT, y: -900 }, 1), false);
  assert.equal(isSamePdfPlacement(PORTRAIT_PLACEMENT, undefined, 1), false);
});

test('migrateWhiteboardPage passes recorded geometry through untouched', () => {
  const page = migrateWhiteboardPage(pdfPage());

  assert.equal(page.canvasWidthPx, 1920);
  assert.deepEqual(page.pdfPlacement, PORTRAIT_PLACEMENT);
});

test('migrateWhiteboardPage leaves both fields ABSENT (not zero) on a page that never recorded them', () => {
  const page = migrateWhiteboardPage({ id: 'p', canvasJSON: '', thumbnail: '', backgroundType: 'blank' });

  assert.equal('canvasWidthPx' in page, false);
  assert.equal('pdfPlacement' in page, false);
});

test('migrateWhiteboardPage drops junk geometry instead of carrying it through the spread', () => {
  const page = migrateWhiteboardPage({
    id: 'p',
    canvasJSON: '',
    thumbnail: '',
    backgroundType: 'blank',
    canvasWidthPx: '1920',
    pdfPlacement: { x: 0, y: 0, width: 0, height: 0 },
  });

  assert.equal('canvasWidthPx' in page, false);
  assert.equal('pdfPlacement' in page, false);

  const negative = migrateWhiteboardPage({
    id: 'p',
    canvasJSON: '',
    thumbnail: '',
    backgroundType: 'blank',
    canvasWidthPx: -5,
    pdfPlacement: { x: 0, y: 0, width: 100, height: Number.NaN },
  });

  assert.equal('canvasWidthPx' in negative, false);
  assert.equal('pdfPlacement' in negative, false);
});

test('a current-version document with geometry migrates unchanged', () => {
  const input = documentWith([pdfPage()]);
  const result = migrateWhiteboardDocument(input);

  assert.equal(result.changed, false);
  assert.deepEqual(result.document, input);
});

test('normalizeWhiteboardDocument (the corrupt-record fallback) keeps geometry and drops junk', () => {
  const normalized = normalizeWhiteboardDocument(
    documentWith([
      pdfPage(),
      pdfPage({
        id: 'junk',
        canvasWidthPx: Number.NaN,
        pdfPlacement: { x: 0, y: 0, width: -1, height: 1 },
      }),
    ]),
  );

  assert.ok(normalized);
  assert.equal(normalized.pages[0]?.canvasWidthPx, 1920);
  assert.deepEqual(normalized.pages[0]?.pdfPlacement, PORTRAIT_PLACEMENT);
  assert.equal(normalized.pages[1]?.canvasWidthPx, undefined);
  assert.equal(normalized.pages[1]?.pdfPlacement, undefined);
});

test('geometry reaches the cloud raw-data payload and survives the decode round-trip', () => {
  const wire = serializeWhiteboardRawData(documentWith([pdfPage()]));
  const parsed = JSON.parse(wire) as { pages: Array<Record<string, unknown>> };

  assert.equal(parsed.pages[0]?.canvasWidthPx, 1920);
  assert.deepEqual(parsed.pages[0]?.pdfPlacement, PORTRAIT_PLACEMENT);

  // The decode side is migrateWhiteboardDocument (remote/raw-data.ts ensureDocument).
  const decoded = migrateWhiteboardDocument(JSON.parse(wire)).document;

  assert.equal(decoded.pages[0]?.canvasWidthPx, 1920);
  assert.deepEqual(decoded.pages[0]?.pdfPlacement, PORTRAIT_PLACEMENT);
});

test('a blank page never gains a placement from the wire even when one was written', () => {
  // The renderer refuses to paint a PDF on a page without a PDF/image background, so a stray
  // placement on such a page is meaningless; the normalizers keep the field only where a background
  // exists. canvasWidthPx is legitimate on every page.
  const page = migrateWhiteboardPage({
    id: 'p',
    canvasJSON: '',
    thumbnail: '',
    backgroundType: 'grid',
    canvasWidthPx: 1366,
    pdfPlacement: PORTRAIT_PLACEMENT,
  });

  assert.equal(page.canvasWidthPx, 1366);
  assert.equal('pdfPlacement' in page, false);
});
