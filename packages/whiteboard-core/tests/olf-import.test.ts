import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { strToU8, zipSync } from 'fflate';

import {
  bytesToBase64,
  convertOlfDataToWhiteboardDocument,
  convertOlfToWhiteboardDocument,
  convertOlfToWhiteboardResult,
  OLF_FABRIC_JSON_VERSION,
  parseOlfFullMatrix,
  parseOlfMatrix,
  transformOlfPoint,
} from '../src/olf-import';

type FabricCanvasJson = {
  version: string;
  background: string;
  objects: Array<{
    type: string;
    stroke: string;
    strokeWidth: number;
    opacity: number;
    left: number;
    top: number;
    width: number;
    height: number;
    originX: string;
    originY: string;
    path: Array<['M' | 'L', number, number]>;
    globalCompositeOperation?: string;
  }>;
};

/** Build a tiny but representative content.json and zip it into a synthetic `.olf` byte array. */
function makeSyntheticOlf(): Uint8Array {
  const content = {
    olf: {
      width: 1280,
      height: 720,
      pageset: [
        {
          page: {
            // sx=2, sy=2, tx=10, ty=20  → page = (raw - t) / s
            matrix: '2,0,10,0,2,20,0,0,1',
            backgrounds: [{ type: 'color', fill: '#EEEEEE' }],
            elements: [
              {
                stroke: {
                  id: 'a',
                  // (110,220)->(50,100) ; (210,420)->(100,200)
                  points: '110,220 210,420',
                  stroke: '#FF0000',
                  'pen-width': 6,
                  'pen-height': 6,
                  opacity: 1,
                  'is-highlighter': false,
                  matrix: '1,0,0,0,1,0,0,0,1',
                },
              },
              {
                stroke: {
                  id: 'b',
                  // (10,20)->(0,0) ; (30,40)->(10,10)
                  points: '10,20 30,40',
                  stroke: '#FFFF00',
                  'pen-width': 12,
                  opacity: 0.5,
                  'is-highlighter': true,
                },
              },
            ],
          },
        },
        {
          page: {
            // identity matrix → page === raw
            matrix: '1,0,0,0,1,0,0,0,1',
            backgrounds: [{ type: 'color', fill: '#FFFFFF' }],
            elements: [
              {
                stroke: {
                  id: 'c',
                  points: '5,5 15,25',
                  stroke: '#0000FF',
                  'pen-width': 3,
                  opacity: 1,
                },
              },
            ],
          },
        },
      ],
    },
  };

  return zipSync({ 'content.json': strToU8(JSON.stringify(content)) });
}

test('parseOlfMatrix extracts sx/sy/tx/ty from the row-major 9-number string', () => {
  assert.deepEqual(parseOlfMatrix('2,0,10,0,2,20,0,0,1'), { sx: 2, sy: 2, tx: 10, ty: 20 });
});

test('parseOlfMatrix falls back to identity (and guards zero scale) for bad input', () => {
  assert.deepEqual(parseOlfMatrix(undefined), { sx: 1, sy: 1, tx: 0, ty: 0 });
  assert.deepEqual(parseOlfMatrix('0,0,0,0,0,0,0,0,0'), { sx: 1, sy: 1, tx: 0, ty: 0 });
});

test('transformOlfPoint applies page = (raw - t) / s', () => {
  assert.deepEqual(transformOlfPoint(110, 220, { sx: 2, sy: 2, tx: 10, ty: 20 }), { x: 50, y: 100 });
});

test('convertOlfToWhiteboardDocument: pages, transformed coords, color, width, highlighter', async () => {
  const olfBytes = makeSyntheticOlf();
  const doc = await convertOlfToWhiteboardDocument(olfBytes, { title: 'Test Import' });

  // Document shape ready to persist.
  assert.equal(doc.title, 'Test Import');
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.currentPageIndex, 0);
  assert.equal(doc.pages.length, 2);

  // --- Page 0 ---
  const page0 = JSON.parse(doc.pages[0]!.canvasJSON) as FabricCanvasJson;

  assert.equal(page0.version, OLF_FABRIC_JSON_VERSION);
  assert.equal(page0.background, '#EEEEEE');
  assert.equal(page0.objects.length, 2);

  // Stroke A — pen, transformed coords + bbox.
  const strokeA = page0.objects[0]!;

  assert.equal(strokeA.type, 'path');
  assert.equal(strokeA.stroke, '#FF0000');
  assert.equal(strokeA.strokeWidth, 6);
  assert.equal(strokeA.opacity, 1);
  assert.equal(strokeA.originX, 'left');
  assert.equal(strokeA.originY, 'top');
  // raw (110,220),(210,420); page-0 content bbox-min is (10,20) (from stroke B) → re-centred to origin.
  assert.deepEqual(strokeA.path, [
    ['M', 100, 200],
    ['L', 200, 400],
  ]);
  // bbox = top-left of the raw points after the page is re-centred to the origin.
  assert.equal(strokeA.left, 100);
  assert.equal(strokeA.top, 200);
  assert.equal(strokeA.width, 100);
  assert.equal(strokeA.height, 200);
  assert.equal(strokeA.globalCompositeOperation, undefined);

  // Stroke B — highlighter → multiply blend, its own opacity/width/color.
  const strokeB = page0.objects[1]!;

  assert.equal(strokeB.stroke, '#FFFF00');
  assert.equal(strokeB.strokeWidth, 12);
  assert.equal(strokeB.opacity, 0.5);
  assert.equal(strokeB.globalCompositeOperation, 'multiply');
  // raw (10,20),(30,40) → (0,0),(20,20) after the page is re-centred (bbox-min subtracted).
  assert.deepEqual(strokeB.path, [
    ['M', 0, 0],
    ['L', 20, 20],
  ]);

  // --- Page 1 ---
  const page1 = JSON.parse(doc.pages[1]!.canvasJSON) as FabricCanvasJson;

  assert.equal(page1.objects.length, 1);
  // raw (5,5),(15,25) → (0,0),(10,20) after re-centre.
  assert.deepEqual(page1.objects[0]!.path, [
    ['M', 0, 0],
    ['L', 10, 20],
  ]);
  assert.equal(page1.objects[0]!.stroke, '#0000FF');
  assert.equal(page1.objects[0]!.strokeWidth, 3);
});

test('convertOlfDataToWhiteboardResult reports accurate stats', () => {
  const data = {
    olf: {
      pageset: [
        {
          page: {
            matrix: '1,0,0,0,1,0,0,0,1',
            elements: [
              { stroke: { points: '0,0 1,1 2,2' } },
              { stroke: { points: '' } }, // empty → skipped
              { text: 'not a stroke' }, // non-stroke → skipped
            ],
          },
        },
      ],
    },
  };

  const { stats } = convertOlfDataToWhiteboardDocument(data);

  assert.equal(stats.pageCount, 1);
  assert.equal(stats.strokeCount, 1);
  assert.equal(stats.pointCount, 3);
  assert.equal(stats.skippedElements, 2);
});

test('single-point stroke becomes a dot (degenerate two-command path)', () => {
  const data = {
    olf: { pageset: [{ page: { matrix: '1,0,0,0,1,0,0,0,1', elements: [{ stroke: { points: '7,9' } }] } }] },
  };

  const page = JSON.parse(convertOlfDataToWhiteboardDocument(data).document.pages[0]!.canvasJSON) as FabricCanvasJson;

  // raw (7,9) is the only point, so the page re-centres it to the origin → a (0,0) dot.
  assert.deepEqual(page.objects[0]!.path, [
    ['M', 0, 0],
    ['L', 0, 0],
  ]);
});

test('handles ~12k strokes efficiently', async () => {
  const STROKE_COUNT = 12_000;
  const elements = Array.from({ length: STROKE_COUNT }, (_, index) => ({
    stroke: {
      points: `${index},${index} ${index + 1},${index + 1} ${index + 2},${index + 2}`,
      stroke: '#123456',
      'pen-width': 4,
    },
  }));

  const olfBytes = zipSync({
    'content.json': strToU8(
      JSON.stringify({ olf: { pageset: [{ page: { matrix: '1,0,0,0,1,0,0,0,1', elements } }] } }),
    ),
  });

  const startedAt = Date.now();
  const { document, stats } = await convertOlfToWhiteboardResult(olfBytes);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(stats.strokeCount, STROKE_COUNT);
  assert.equal(stats.pointCount, STROKE_COUNT * 3);

  const page = JSON.parse(document.pages[0]!.canvasJSON) as FabricCanvasJson;

  assert.equal(page.objects.length, STROKE_COUNT);
  // Generous ceiling — purely a guard against accidental quadratic blowups, not a perf benchmark.
  assert.ok(elapsedMs < 5_000, `conversion of ${STROKE_COUNT} strokes took ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------------------------------
// Image / PDF-background import (PDF-derived OLFs paste each page as rasters, not strokes).
// ---------------------------------------------------------------------------------------------------

type FabricImageJson = {
  type: string;
  src: string;
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  opacity: number;
};

/** Deterministic pseudo-image bytes (the converter never validates PNG structure, only embeds bytes). */
function makeImageBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * seed + 7) & 0xff;
  }

  return bytes;
}

function base64Reference(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

test('parseOlfFullMatrix keeps the full affine (a,b,c,d,e,f) from the row-major string', () => {
  // row-major [m0,m1,m2, m3,m4,m5, ...] → a=m0,b=m3,c=m1,d=m4,e=m2,f=m5
  assert.deepEqual(parseOlfFullMatrix('2,0,300,0,3,400,0,0,1'), { a: 2, b: 0, c: 0, d: 3, e: 300, f: 400 });
  assert.deepEqual(parseOlfFullMatrix(undefined), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
});

test('bytesToBase64 matches the reference encoder across 0/1/2-mod-3 lengths', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 255, 256, 1000, 16_384, 16_385]) {
    const bytes = makeImageBytes(31, length);

    assert.equal(bytesToBase64(bytes), base64Reference(bytes), `length ${length}`);
  }
});

test('image element covering the viewport becomes pdfImageUrl; smaller ones become image objects', async () => {
  const bgBytes = makeImageBytes(13, 4_096);
  const overlayBytes = makeImageBytes(29, 512);
  const jpegBytes = makeImageBytes(41, 300);

  const content = {
    olf: {
      width: 1000,
      height: 1000,
      pageset: [
        {
          page: {
            matrix: '1,0,0,0,1,0,0,0,1',
            backgrounds: [{ background: { type: 'color', fill: '#ABCDEF' } }],
            elements: [
              // Full-page raster (100% of the 1000x1000 viewport) → the page background (pdfImageUrl).
              {
                image: {
                  x: 0,
                  y: 0,
                  width: 1000,
                  height: 1000,
                  'mime-type': 'image/png',
                  source: 'images/bg.png',
                  matrix: '1,0,0,0,1,0,0,0,1',
                },
              },
              // Small overlay (2% of the viewport) with a real per-element scale+translate matrix.
              {
                image: {
                  x: 0,
                  y: 0,
                  width: 100,
                  height: 50,
                  source: 'images/overlay.png',
                  matrix: '2,0,300,0,3,400,0,0,1',
                },
              },
              // JPEG overlay — mime inferred from the extension when no mime-type field is present.
              {
                image: { x: 0, y: 0, width: 80, height: 80, source: 'images/photo.jpg', matrix: '1,0,10,0,1,20,0,0,1' },
              },
              // References an asset that is NOT in the archive → skipped gracefully, import continues.
              { image: { x: 0, y: 0, width: 40, height: 40, source: 'images/missing.png', matrix: '1,0,0,0,1,0,0,0,1' } },
            ],
          },
        },
      ],
    },
  };

  const olfBytes = zipSync({
    'content.json': strToU8(JSON.stringify(content)),
    'images/bg.png': bgBytes,
    'images/overlay.png': overlayBytes,
    'images/photo.jpg': jpegBytes,
  });

  const { document, stats } = await convertOlfToWhiteboardResult(olfBytes, {
    title: 'Board',
    sourceName: 'lesson.olf',
  });

  assert.equal(document.pages.length, 1);

  const page = document.pages[0]!;

  // The full-page raster is the page background, carried as a data URL through the pdfImageUrl path.
  assert.equal(page.pdfImageUrl, `data:image/png;base64,${base64Reference(bgBytes)}`);
  assert.equal(page.pdfSourceName, 'lesson.olf');

  const canvas = JSON.parse(page.canvasJSON) as { background?: string; objects: FabricImageJson[] };

  // A backdrop page must NOT carry a Fabric background: Fabric paints it ABOVE the separate backdrop
  // canvas, so an opaque color would hide the slide entirely (previews render pdfImageUrl directly and
  // were never covered — the "preview shows the PDF but the page renders blank" bug).
  assert.equal(canvas.background, undefined);

  // Two overlay image objects (png + jpg); the full-page raster is NOT duplicated as an object, and the
  // missing asset produced no object.
  const images = canvas.objects.filter((object) => object.type === 'image');

  assert.equal(images.length, 2);

  const png = images.find((object) => object.src.startsWith('data:image/png'))!;

  assert.equal(png.src, `data:image/png;base64,${base64Reference(overlayBytes)}`);
  // matrix 2,0,300,0,3,400 → left=tx=300, top=ty=400, scaleX=2, scaleY=3, box = element width/height.
  assert.equal(png.left, 300);
  assert.equal(png.top, 400);
  assert.equal(png.width, 100);
  assert.equal(png.height, 50);
  assert.equal(png.scaleX, 2);
  assert.equal(png.scaleY, 3);
  assert.equal(png.angle, 0);

  // JPEG mime inferred from the `.jpg` extension (no mime-type field on that element).
  const jpg = images.find((object) => object.src.startsWith('data:image/jpeg'))!;

  assert.equal(jpg.src, `data:image/jpeg;base64,${base64Reference(jpegBytes)}`);

  assert.equal(stats.importedBackgrounds, 1);
  assert.equal(stats.importedImages, 2);
  assert.equal(stats.skippedElements, 1); // the missing asset
  assert.equal(stats.strokeCount, 0);
});

test('a type:"image" page background (no full-page element) becomes the pdfImageUrl', async () => {
  const screenshotBytes = makeImageBytes(7, 2_048);

  const content = {
    olf: {
      width: 1280,
      height: 720,
      pageset: [
        {
          page: {
            matrix: '1,0,0,0,1,0,0,0,1',
            backgrounds: [
              { background: { type: 'color', fill: '#FFFFFF' } },
              { background: { type: 'image', 'image-source': 'images/bk-image.png' } },
            ],
            elements: [],
          },
        },
      ],
    },
  };

  const olfBytes = zipSync({
    'content.json': strToU8(JSON.stringify(content)),
    'images/bk-image.png': screenshotBytes,
  });

  const { document, stats } = await convertOlfToWhiteboardResult(olfBytes);
  const page = document.pages[0]!;

  assert.equal(page.pdfImageUrl, `data:image/png;base64,${base64Reference(screenshotBytes)}`);
  assert.equal(stats.importedBackgrounds, 1);
  assert.equal(stats.importedImages, 0);
});

test('pages without any image assets still import strokes and set no pdfImageUrl', () => {
  const data = {
    olf: { pageset: [{ page: { matrix: '1,0,0,0,1,0,0,0,1', elements: [{ stroke: { points: '5,5 15,25' } }] } }] },
  };

  const { document, stats } = convertOlfDataToWhiteboardDocument(data);
  const page = document.pages[0]!;

  assert.equal(page.pdfImageUrl, undefined);
  assert.equal(stats.importedBackgrounds, 0);
  assert.equal(stats.importedImages, 0);
  assert.equal(stats.strokeCount, 1);
});

// Real ViewSonic PDF-derived export (22 pages, 46 image elements, 0 strokes). Kept OUT of the committed
// tree for size; skipped when absent so CI stays green. Copy a real `.olf` here to exercise it locally.
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/sample-pdf.olf', import.meta.url));

test('real PDF-derived OLF: every page gets a pdfImageUrl data URL', { skip: !existsSync(FIXTURE_PATH) }, async () => {
  const bytes = readFileSync(FIXTURE_PATH);
  const { document, stats } = await convertOlfToWhiteboardResult(bytes, { sourceName: 'sample-pdf.olf' });

  assert.equal(document.pages.length, 22);
  assert.equal(stats.pageCount, 22);

  for (let index = 0; index < document.pages.length; index += 1) {
    const url = document.pages[index]!.pdfImageUrl;

    assert.ok(url, `page ${index} has a pdfImageUrl`);
    assert.ok(url!.startsWith('data:image/'), `page ${index} pdfImageUrl is a data URL`);
    assert.ok(url!.length > 1000, `page ${index} pdfImageUrl is a real raster (len ${url!.length})`);
    assert.equal(document.pages[index]!.pdfSourceName, 'sample-pdf.olf');
  }

  // Every image element is accounted for as a background, an overlay, or a genuine skip (none skipped here).
  assert.ok(stats.importedBackgrounds >= 22, `importedBackgrounds ${stats.importedBackgrounds} >= page count`);
  assert.ok(stats.importedImages > 0, 'in-page overlays imported as image objects');
  assert.equal(stats.skippedElements, 0);
});
