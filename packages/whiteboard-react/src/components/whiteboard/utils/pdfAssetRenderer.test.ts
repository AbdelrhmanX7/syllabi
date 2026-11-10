import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { PDFDocument } from 'pdf-lib';

import { wbT } from '../../../i18n/strings';

import {
  formatRescuedPdfPagesNotice,
  importPdfFile,
  prefetchPdfAssetPageImage,
  renderPdfAssetPageImageUrl,
} from './pdfAssetRenderer';

import type { PdfImportNativePageRequest, PdfImportNativeRescue } from './pdfAssetRenderer';

/**
 * Regression suite for the production incident: a teacher imported a 45-page PDF, ONE page hit a
 * pdf.js display-layer error («Bounding box is required.» — a malformed transparency group) and the
 * whole import rejected, so the entire upload was lost. A bad page must now cost that page only.
 *
 * pdf.js is stubbed at the module boundary (`./pdfjsStub.fixture.mjs`) and the canvas/FileReader
 * globals are hand-rolled below: jsdom's canvas is a no-op without the native `canvas` package, so
 * a purpose-built stub is both faster and lets the test read back what was DRAWN — which is how a
 * placeholder is told apart from a real render.
 */

const PLACEHOLDER_NOTICE = "Couldn't process this page";
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BEYOND_REPAIR_ERROR = escapeRegExp(wbT('en', 'pdfimport.beyondRepair'));
/** The failed-pages warning line, built from the same dictionary the importer uses. */
const failedPagesWarning = (pages: string, list: string): string => wbT('en', 'pdfimport.failedPages', { list, pages });
const STUB_MODULE_SRC = new URL('./pdfjsStub.fixture.mjs', import.meta.url).href;

interface StubCanvas {
  drawnTexts: string[];
  height: number;
  width: number;
}

interface PdfjsStubState {
  cleanedUpPages: number[];
  createdCanvases: StubCanvas[];
  failingPageNumbers: number[];
  /**
   * What the rescue's blankness probe reads back from a rescued raster. `true` = a page of pure
   * white, i.e. PDFium's short-`/BBox` zero-area-clip case, which must be DISCARDED.
   */
  nativeRasterIsBlank: boolean;
  numPages: number;
  openedDocuments: number;
  pageHeight: number;
  pageWidth: number;
  requestedPages: number[];
  unreadablePageNumbers: number[];
}

function stubState(): PdfjsStubState {
  return (globalThis as unknown as { __pdfjsStubState: PdfjsStubState }).__pdfjsStubState;
}

function resetStubState(overrides: Partial<PdfjsStubState> = {}): PdfjsStubState {
  const state: PdfjsStubState = {
    cleanedUpPages: [],
    createdCanvases: [],
    failingPageNumbers: [],
    nativeRasterIsBlank: false,
    numPages: 5,
    openedDocuments: 0,
    // 600×800 px ≈ 0.75 — deliberately NOT the A4 ratio a placeholder falls back to, so the two are
    // distinguishable by shape alone.
    pageHeight: 800,
    pageWidth: 600,
    requestedPages: [],
    unreadablePageNumbers: [],
    ...overrides,
  };

  (globalThis as unknown as { __pdfjsStubState: PdfjsStubState }).__pdfjsStubState = state;

  return state;
}

/**
 * A canvas that records every `fillText` call and serializes itself into the data URL, so a test can
 * assert that a preview really is the placeholder rather than merely a string.
 */
function createStubCanvas(): unknown {
  const record: StubCanvas = { drawnTexts: [], height: 0, width: 0 };

  stubState().createdCanvases.push(record);

  const serialize = () => JSON.stringify({ drawnTexts: record.drawnTexts, height: record.height, width: record.width });

  const canvas = {
    get height() {
      return record.height;
    },
    set height(next: number) {
      record.height = next;
    },
    get width() {
      return record.width;
    },
    set width(next: number) {
      record.width = next;
    },
    getContext: () => ({
      direction: '',
      drawImage: () => undefined,
      fillStyle: '',
      fillRect: () => undefined,
      fillText: (text: string) => {
        record.drawnTexts.push(String(text));
      },
      font: '',
      // The blankness probe's only read: 255 everywhere = a blank raster, 0 = a painted one.
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(Math.max(1, width * height) * 4).fill(stubState().nativeRasterIsBlank ? 255 : 0),
      }),
      lineWidth: 1,
      strokeRect: () => undefined,
      strokeStyle: '',
      textAlign: '',
      textBaseline: '',
    }),
    toBlob: (callback: (blob: Blob | null) => void, mime: string) => {
      callback(new Blob([serialize()], { type: mime }));
    },
    toDataURL: (mime: string) => `data:${mime};stub,${encodeURIComponent(serialize())}`,
  };

  return canvas;
}

/** Mirrors the stub canvas encoding so `readAsDataURL` produces something the test can decode. */
class StubFileReader {
  public error: unknown = null;
  public onerror: (() => void) | null = null;
  public onload: (() => void) | null = null;
  public result: string | null = null;

  public readAsDataURL(blob: Blob): void {
    void blob
      .text()
      .then((text) => {
        this.result = `data:${blob.type};stub,${encodeURIComponent(text)}`;
        this.onload?.();
      })
      .catch((error: unknown) => {
        this.error = error;
        this.onerror?.();
      });
  }
}

/**
 * Decodes instantly and reports the native render's size, so the rescue's blankness probe runs its
 * real code path (decode → downscale → sample) with the stub canvas above standing in for pixels.
 */
class StubImage {
  public naturalHeight = 0;
  public naturalWidth = 0;
  public onerror: (() => void) | null = null;
  public onload: (() => void) | null = null;

  private source = '';

  public get src(): string {
    return this.source;
  }

  public set src(next: string) {
    this.source = next;
    this.naturalWidth = NATIVE_PAGE_WIDTH;
    this.naturalHeight = NATIVE_PAGE_HEIGHT;
    queueMicrotask(() => this.onload?.());
  }
}

function decodePreview(previewImageUrl: string): StubCanvas {
  const marker = ';stub,';
  const payloadIndex = previewImageUrl.indexOf(marker);

  assert.ok(payloadIndex > -1, `preview is not a stub data URL: ${previewImageUrl.slice(0, 64)}`);

  return JSON.parse(decodeURIComponent(previewImageUrl.slice(payloadIndex + marker.length))) as StubCanvas;
}

function isPlaceholderPreview(previewImageUrl: string): boolean {
  return decodePreview(previewImageUrl).drawnTexts.some((text) => text.includes(PLACEHOLDER_NOTICE));
}

/** A real PDF, so the subset path (pdf-lib) genuinely splits instead of falling back to the whole file. */
async function makePdfFile(pageCount: number, name = 'lecture.pdf'): Promise<File> {
  const pdfDocument = await PDFDocument.create();

  for (let index = 0; index < pageCount; index += 1) {
    pdfDocument.addPage([600, 800]).drawText(`Page ${index + 1}`, { size: 24, x: 20, y: 760 });
  }

  const bytes = await pdfDocument.save();

  return new File([bytes as BlobPart], name, { type: 'application/pdf' });
}

before(() => {
  const domGlobals = globalThis as unknown as { FileReader?: unknown; Image?: unknown; document?: unknown };

  domGlobals.document = {
    createElement: (tagName: string) => {
      assert.equal(tagName, 'canvas');

      return createStubCanvas();
    },
  };
  domGlobals.FileReader = StubFileReader;
  domGlobals.Image = StubImage;
});

beforeEach(() => {
  resetStubState();
});

test('one page whose render rejects costs that page, not the import (whole-file indexing)', async () => {
  resetStubState({ failingPageNumbers: [3], numPages: 5 });

  const progress: number[] = [];
  const result = await importPdfFile(await makePdfFile(5), {
    moduleSrc: STUB_MODULE_SRC,
    onProgress: (next) => progress.push(next),
  });

  assert.equal(result.pages.length, 5);
  assert.equal(result.isSubset, false);
  // Whole-file import → every index is the ORIGINAL page index, the failed page included, so the
  // previews stay aligned with the uploaded asset and the server-merge manifest.
  assert.deepEqual(
    result.pages.map((page) => [page.pageNumber, page.pageIndex]),
    [
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ],
  );

  const failedPage = result.pages[2];

  assert.ok(failedPage);
  assert.equal(isPlaceholderPreview(failedPage.previewImageUrl), true);
  assert.equal(
    result.pages.filter((page) => isPlaceholderPreview(page.previewImageUrl)).length,
    1,
    'only the bad page is a placeholder',
  );

  // The placeholder keeps the real page's aspect ratio (the page object loaded; only rendering failed).
  assert.ok(Math.abs(failedPage.width / failedPage.height - 600 / 800) < 0.01);

  assert.equal(result.summary.warnings.length, 1);
  assert.equal(result.summary.warnings[0], failedPagesWarning('1 page', '3'));

  // Progress still advances past the bad page and finishes.
  assert.deepEqual(progress, [20, 40, 60, 80, 100]);

  // The half-parsed page is still cleaned up — a leaked operator list per bad page would add up
  // across a 45-page import.
  assert.deepEqual(stubState().cleanedUpPages, [1, 2, 3, 4, 5]);
});

test('sizes-only import draws nothing and still gives every page its box', async () => {
  // A page whose RENDER would reject: sizes only never renders, so it is an ordinary page here.
  resetStubState({ failingPageNumbers: [3], numPages: 5 });

  const progress: number[] = [];
  const result = await importPdfFile(await makePdfFile(5), {
    moduleSrc: STUB_MODULE_SRC,
    onProgress: (next) => progress.push(next),
    previews: false,
  });

  assert.deepEqual(
    result.pages.map((page) => [page.pageNumber, page.pageIndex, page.previewImageUrl]),
    [
      [1, 0, ''],
      [2, 1, ''],
      [3, 2, ''],
      [4, 3, ''],
      [5, 4, ''],
    ],
  );
  for (const page of result.pages) assert.ok(Math.abs(page.width / page.height - 600 / 800) < 0.01);
  assert.equal(result.summary.warnings.length, 0);
  assert.deepEqual(progress, [20, 40, 60, 80, 100]);
  assert.deepEqual(stubState().cleanedUpPages, [1, 2, 3, 4, 5]);
});

test('a subset import keeps subset pageIndex for the failed page too', async () => {
  resetStubState({ failingPageNumbers: [3], numPages: 6 });

  const result = await importPdfFile(await makePdfFile(6), { moduleSrc: STUB_MODULE_SRC, pageRange: '2-4' });

  assert.equal(result.isSubset, true);
  assert.equal(result.asset.pageCount, 3);
  // Subset → the index is the page's position INSIDE the uploaded 3-page asset, and the failed page
  // holds its slot rather than shifting the pages after it.
  assert.deepEqual(
    result.pages.map((page) => [page.pageNumber, page.pageIndex]),
    [
      [2, 0],
      [3, 1],
      [4, 2],
    ],
  );

  const failedPage = result.pages[1];

  assert.ok(failedPage);
  assert.equal(isPlaceholderPreview(failedPage.previewImageUrl), true);
  assert.equal(result.summary.warnings[0], failedPagesWarning('1 page', '3'));
});

test('a page whose page dictionary is unreadable falls back to the A4 placeholder shape', async () => {
  resetStubState({ numPages: 3, unreadablePageNumbers: [2] });

  const result = await importPdfFile(await makePdfFile(3), { moduleSrc: STUB_MODULE_SRC });
  const failedPage = result.pages[1];

  assert.equal(result.pages.length, 3);
  assert.ok(failedPage);
  assert.equal(isPlaceholderPreview(failedPage.previewImageUrl), true);
  // `getPage` rejected, so there was no page to measure → A4 portrait (595/842 ≈ 0.7066).
  assert.ok(Math.abs(failedPage.width / failedPage.height - 595 / 842) < 0.01);
  // …and nothing was cleaned up for a page we never received.
  assert.deepEqual(stubState().cleanedUpPages, [1, 3]);
});

test('the placeholder names the page number', async () => {
  resetStubState({ failingPageNumbers: [2], numPages: 3 });

  const result = await importPdfFile(await makePdfFile(3), { moduleSrc: STUB_MODULE_SRC });
  const failedPage = result.pages[1];

  assert.ok(failedPage);

  const drawn = decodePreview(failedPage.previewImageUrl).drawnTexts;

  assert.deepEqual(drawn, [PLACEHOLDER_NOTICE, 'Page 2']);
});

test('a long failure list collapses instead of overflowing the modal', async () => {
  const failingPageNumbers = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

  resetStubState({ failingPageNumbers, numPages: 20 });

  const result = await importPdfFile(await makePdfFile(20), { moduleSrc: STUB_MODULE_SRC });
  const warning = result.summary.warnings[0] ?? '';

  assert.equal(result.pages.length, 20);
  assert.equal(warning, failedPagesWarning('12 pages', '2, 3, 4, 5, 6, 7, 8, 9 and 4 more'));
});

test('a file where every page fails throws the friendly error instead of a deck of placeholders', async () => {
  resetStubState({ failingPageNumbers: [1, 2, 3], numPages: 3 });

  const file = await makePdfFile(3);

  await assert.rejects(
    () => importPdfFile(file, { moduleSrc: STUB_MODULE_SRC }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(BEYOND_REPAIR_ERROR));
      // The message a teacher reads is the friendly copy, never the raw pdf.js text.
      assert.equal(error.message.includes('Bounding box'), false);

      return true;
    },
  );
});

test('an overwhelming-majority failure also aborts, but a bare majority does not', async () => {
  resetStubState({ failingPageNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9], numPages: 10 });

  const brokenFile = await makePdfFile(10);

  // 9/10 = 0.9 > the 0.8 ratio limit → the file is treated as broken.
  await assert.rejects(
    () => importPdfFile(brokenFile, { moduleSrc: STUB_MODULE_SRC }),
    new RegExp(BEYOND_REPAIR_ERROR),
  );

  resetStubState({ failingPageNumbers: [1, 2, 3, 4], numPages: 5 });

  // 4/5 = exactly 0.8 → not "more than", so the import survives with a warning.
  const survived = await importPdfFile(await makePdfFile(5), { moduleSrc: STUB_MODULE_SRC });

  assert.equal(survived.pages.length, 5);
  assert.equal(survived.summary.warnings.length, 1);
});

test('a small selection where a single page fails is never treated as a broken file', async () => {
  resetStubState({ failingPageNumbers: [2], numPages: 2 });

  // 1/2 = 0.5: over half, but the ratio has a 5-page floor precisely so a tiny selection is not
  // condemned by one bad page. (2/2 failing WOULD abort — that is the all-pages rule.)
  const result = await importPdfFile(await makePdfFile(2), { moduleSrc: STUB_MODULE_SRC });

  assert.equal(result.pages.length, 2);
  assert.equal(result.summary.warnings.length, 1);
});

test('an all-good import is unchanged: no placeholder, no warnings, progress reaches 100', async () => {
  resetStubState({ numPages: 4 });

  const progress: number[] = [];
  const result = await importPdfFile(await makePdfFile(4), {
    moduleSrc: STUB_MODULE_SRC,
    onProgress: (next) => progress.push(next),
  });

  assert.equal(result.pages.length, 4);
  assert.equal(result.isSubset, false);
  assert.deepEqual(result.summary.warnings, []);
  assert.deepEqual(progress, [25, 50, 75, 100]);
  assert.equal(
    result.pages.every((page) => !isPlaceholderPreview(page.previewImageUrl)),
    true,
  );
  assert.deepEqual(
    result.pages.map((page) => [page.pageNumber, page.pageIndex, page.width, page.height]),
    result.pages.map((page) => [page.pageNumber, page.pageNumber - 1, page.width, page.height]),
  );
  assert.deepEqual(stubState().cleanedUpPages, [1, 2, 3, 4]);
});

/**
 * TIER-2 (native/PDFium) rescue double.
 *
 * The real one lives in the desktop shell (`apps/whiteboard/lib/platform/pdf.ts`) and is INJECTED,
 * which is exactly what makes it testable here: the package never imports a Tauri API, so the tests
 * exercise the tier ordering without a native shell. A rescued preview is encoded in the same stub
 * data-URL shape a canvas produces, so `decodePreview`/`isPlaceholderPreview` work on it unchanged.
 */
const NATIVE_PAGE_WIDTH = 1000;
const NATIVE_PAGE_HEIGHT = 500;

interface NativeRescueStub {
  ensureCalls: Array<{ assetId: string; blobSize: number }>;
  rescue: PdfImportNativeRescue;
  renderCalls: PdfImportNativePageRequest[];
}

function nativeRescuePreviewText(pageNumber: number): string {
  return `native page ${pageNumber}`;
}

function createNativeRescueStub({
  available = true,
  ensure = true,
  render = 'ok',
}: { available?: boolean; ensure?: boolean; render?: 'null' | 'ok' | 'throw' } = {}): NativeRescueStub {
  const ensureCalls: NativeRescueStub['ensureCalls'] = [];
  const renderCalls: PdfImportNativePageRequest[] = [];

  return {
    ensureCalls,
    renderCalls,
    rescue: {
      ensureSourceCached: async ({ assetId, blob }) => {
        ensureCalls.push({ assetId, blobSize: blob.size });

        return ensure;
      },
      isAvailable: () => available,
      renderPage: async (request) => {
        renderCalls.push(request);

        if (render === 'throw') {
          throw new Error('stub: the native renderer exploded.');
        }

        if (render === 'null') {
          return null;
        }

        const payload = JSON.stringify({
          drawnTexts: [nativeRescuePreviewText(request.pageNumber)],
          height: NATIVE_PAGE_HEIGHT,
          width: NATIVE_PAGE_WIDTH,
        });

        return {
          height: NATIVE_PAGE_HEIGHT,
          previewImageUrl: `data:image/jpeg;stub,${encodeURIComponent(payload)}`,
          width: NATIVE_PAGE_WIDTH,
        };
      },
    },
  };
}

function isNativeRescuePreview(previewImageUrl: string, pageNumber: number): boolean {
  return decodePreview(previewImageUrl).drawnTexts.includes(nativeRescuePreviewText(pageNumber));
}

test('a page pdf.js drops is RESCUED by the native renderer, not replaced by a placeholder', async () => {
  resetStubState({ failingPageNumbers: [3], numPages: 5 });

  const native = createNativeRescueStub();
  const result = await importPdfFile(await makePdfFile(5), {
    moduleSrc: STUB_MODULE_SRC,
    nativeRescue: native.rescue,
  });

  assert.equal(result.pages.length, 5);
  assert.deepEqual(
    result.pages.map((page) => [page.pageNumber, page.pageIndex]),
    [
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ],
  );

  const rescuedPage = result.pages[2];

  assert.ok(rescuedPage);
  assert.equal(isNativeRescuePreview(rescuedPage.previewImageUrl, 3), true);
  assert.equal(isPlaceholderPreview(rescuedPage.previewImageUrl), false);
  // The NATIVE render's own pixel box is what lands on the page — the importer positions the new
  // board page from it, so a placeholder-shaped guess would misplace the page.
  assert.equal(rescuedPage.width, NATIVE_PAGE_WIDTH);
  assert.equal(rescuedPage.height, NATIVE_PAGE_HEIGHT);

  // A rescued page is NOT a failure: the failure copy must not appear anywhere.
  assert.deepEqual(result.summary.warnings, []);
  assert.deepEqual(result.summary.rescuedPageNumbers, [3]);
  assert.equal(
    result.pages.some((page) => isPlaceholderPreview(page.previewImageUrl)),
    false,
  );

  // The rescue asked for the page by its index in the SOURCE file, at the same box/quality the good
  // path renders into, and (whole-file import) under the asset's OWN id — so the board's first
  // native render of that asset is a cache hit rather than a fresh stream.
  assert.equal(native.renderCalls.length, 1);
  assert.deepEqual(
    native.renderCalls.map((call) => [call.pageNumber, call.sourcePageIndex]),
    [[3, 2]],
  );
  assert.equal(native.renderCalls[0]?.assetId, result.asset.id);
  assert.ok((native.renderCalls[0]?.targetLongestEdge ?? 0) > 0);
  assert.ok((native.renderCalls[0]?.quality ?? 0) > 0);
  assert.equal(native.ensureCalls.length, 1);
});

test('a rescued page in a SUBSET import keeps its subset pageIndex and renders the SOURCE page', async () => {
  resetStubState({ failingPageNumbers: [3], numPages: 6 });

  const native = createNativeRescueStub();
  const result = await importPdfFile(await makePdfFile(6), {
    moduleSrc: STUB_MODULE_SRC,
    nativeRescue: native.rescue,
    pageRange: '2-4',
  });

  assert.equal(result.isSubset, true);
  assert.deepEqual(
    result.pages.map((page) => [page.pageNumber, page.pageIndex]),
    [
      [2, 0],
      [3, 1],
      [4, 2],
    ],
  );

  const rescuedPage = result.pages[1];

  assert.ok(rescuedPage);
  assert.equal(isNativeRescuePreview(rescuedPage.previewImageUrl, 3), true);
  assert.deepEqual(result.summary.warnings, []);
  assert.deepEqual(result.summary.rescuedPageNumbers, [3]);

  // The native side parses the ORIGINAL file, so the page it is asked for is `pageNumber - 1` (2),
  // never the subset index (1) this preview carries.
  assert.deepEqual(
    native.renderCalls.map((call) => [call.pageNumber, call.sourcePageIndex]),
    [[3, 2]],
  );
  // …and the SOURCE bytes are cached under a sibling id: the produced asset is a different, freshly
  // built 3-page PDF, so sharing one id would render the wrong page at every index.
  assert.notEqual(native.renderCalls[0]?.assetId, result.asset.id);
  assert.equal(native.renderCalls[0]?.assetId, `${result.asset.id}-src`);
  assert.deepEqual(
    native.ensureCalls.map((call) => call.assetId),
    [`${result.asset.id}-src`],
  );
});

test('the source bytes are pushed to the native cache ONCE for an import, however many pages fail', async () => {
  resetStubState({ failingPageNumbers: [2, 3, 5], numPages: 8 });

  const native = createNativeRescueStub();
  const result = await importPdfFile(await makePdfFile(8), {
    moduleSrc: STUB_MODULE_SRC,
    nativeRescue: native.rescue,
  });

  assert.equal(result.pages.length, 8);
  assert.deepEqual(result.summary.rescuedPageNumbers, [2, 3, 5]);
  assert.deepEqual(result.summary.warnings, []);
  // Three rescues, ONE byte push: re-streaming a (possibly 86 MB) file per bad page is exactly what
  // the memo inside `importPdfFile` exists to prevent.
  assert.equal(native.renderCalls.length, 3);
  assert.equal(native.ensureCalls.length, 1);
  assert.ok((native.ensureCalls[0]?.blobSize ?? 0) > 0);
});

test('when the native rescue also fails, the placeholder + failure warning are exactly as before', async () => {
  resetStubState({ failingPageNumbers: [3], numPages: 5 });

  const native = createNativeRescueStub({ render: 'null' });
  const result = await importPdfFile(await makePdfFile(5), {
    moduleSrc: STUB_MODULE_SRC,
    nativeRescue: native.rescue,
  });
  const failedPage = result.pages[2];

  assert.equal(result.pages.length, 5);
  assert.ok(failedPage);
  assert.equal(isPlaceholderPreview(failedPage.previewImageUrl), true);
  // The placeholder still carries the real page's aspect ratio, not the native render's.
  assert.ok(Math.abs(failedPage.width / failedPage.height - 600 / 800) < 0.01);
  assert.equal(result.summary.warnings.length, 1);
  assert.equal(result.summary.warnings[0], failedPagesWarning('1 page', '3'));
  assert.deepEqual(result.summary.rescuedPageNumbers, []);
  assert.equal(native.renderCalls.length, 1);
});

test('an all-WHITE native raster is discarded as a failure, never shown as a silent blank page', async () => {
  // MEASURED 2026-09-12 (both libpdfium.so and the shipped pdfium.dll): a SHORT `/BBox` array makes
  // PDFium pad with zeros → zero-area clip → a render that reports SUCCESS and returns a megapixel
  // of pure white. pdf.js already threw on this page, so that is a zero-area clip far more often
  // than a genuinely empty page — the teacher gets the honest notice instead of a blank sheet.
  resetStubState({ failingPageNumbers: [3], nativeRasterIsBlank: true, numPages: 5 });

  const native = createNativeRescueStub();
  const result = await importPdfFile(await makePdfFile(5), {
    moduleSrc: STUB_MODULE_SRC,
    nativeRescue: native.rescue,
  });
  const blankPage = result.pages[3 - 1];

  assert.equal(result.pages.length, 5);
  assert.ok(blankPage);
  assert.equal(native.renderCalls.length, 1, 'the native renderer did run');
  assert.equal(isNativeRescuePreview(blankPage.previewImageUrl, 3), false, 'the white raster was discarded');
  assert.equal(isPlaceholderPreview(blankPage.previewImageUrl), true);
  assert.deepEqual(result.summary.rescuedPageNumbers, []);
  assert.equal(result.summary.warnings.length, 1);
  assert.equal(result.summary.warnings[0], failedPagesWarning('1 page', '3'));

  // …and a raster WITH content on the same page is still a rescue (the floor is not a blanket veto).
  resetStubState({ failingPageNumbers: [3], nativeRasterIsBlank: false, numPages: 5 });

  const painted = await importPdfFile(await makePdfFile(5), {
    moduleSrc: STUB_MODULE_SRC,
    nativeRescue: createNativeRescueStub().rescue,
  });

  assert.deepEqual(painted.summary.rescuedPageNumbers, [3]);
  assert.deepEqual(painted.summary.warnings, []);
});

test('a native rescue that throws, is unavailable, or cannot cache the bytes degrades to the placeholder', async () => {
  for (const native of [
    createNativeRescueStub({ render: 'throw' }),
    createNativeRescueStub({ available: false }),
    createNativeRescueStub({ ensure: false }),
  ]) {
    resetStubState({ failingPageNumbers: [2], numPages: 3 });

    const result = await importPdfFile(await makePdfFile(3), {
      moduleSrc: STUB_MODULE_SRC,
      nativeRescue: native.rescue,
    });
    const failedPage = result.pages[1];

    assert.ok(failedPage);
    assert.equal(isPlaceholderPreview(failedPage.previewImageUrl), true);
    assert.equal(result.summary.warnings.length, 1);
    assert.deepEqual(result.summary.rescuedPageNumbers, []);
  }

  // An unavailable runtime is never asked to read the (multi-MB) blob at all.
  const unavailable = createNativeRescueStub({ available: false });

  resetStubState({ failingPageNumbers: [2], numPages: 3 });
  await importPdfFile(await makePdfFile(3), { moduleSrc: STUB_MODULE_SRC, nativeRescue: unavailable.rescue });
  assert.deepEqual(unavailable.ensureCalls, []);
  assert.deepEqual(unavailable.renderCalls, []);

  // A failed byte push is not retried per page either — one push attempt, no render attempt.
  const cannotCache = createNativeRescueStub({ ensure: false });

  resetStubState({ failingPageNumbers: [1, 2], numPages: 4 });
  await importPdfFile(await makePdfFile(4), { moduleSrc: STUB_MODULE_SRC, nativeRescue: cannotCache.rescue });
  assert.equal(cannotCache.ensureCalls.length, 1);
  assert.deepEqual(cannotCache.renderCalls, []);
});

test('a web consumer (no native rescue injected) keeps the pdf.js → placeholder behaviour', async () => {
  resetStubState({ failingPageNumbers: [2], numPages: 4 });

  // Exactly the call apps/studio, apps/teacher and the web build make: no `nativeRescue` at all.
  const result = await importPdfFile(await makePdfFile(4), { moduleSrc: STUB_MODULE_SRC });
  const failedPage = result.pages[1];

  assert.ok(failedPage);
  assert.equal(isPlaceholderPreview(failedPage.previewImageUrl), true);
  assert.equal(result.summary.warnings.length, 1);
  assert.equal(result.summary.warnings[0], failedPagesWarning('1 page', '2'));
  assert.deepEqual(result.summary.rescuedPageNumbers, []);
});

test('a file pdf.js cannot read AT ALL still imports when the native renderer can read it', async () => {
  resetStubState({ failingPageNumbers: [1, 2, 3], numPages: 3 });

  const native = createNativeRescueStub();
  // Without tier 2 this is the "beyond repair" abort (every selected page failed). A rescue makes
  // every page real, so there is nothing left to abort over — which is the whole owner ask: the app
  // fixes the pages instead of refusing the file.
  const result = await importPdfFile(await makePdfFile(3), {
    moduleSrc: STUB_MODULE_SRC,
    nativeRescue: native.rescue,
  });

  assert.equal(result.pages.length, 3);
  assert.deepEqual(result.summary.rescuedPageNumbers, [1, 2, 3]);
  assert.deepEqual(result.summary.warnings, []);
  assert.equal(
    result.pages.every((page, index) => isNativeRescuePreview(page.previewImageUrl, index + 1)),
    true,
  );
});

test('the rescued-pages notice is calm and never reuses the failure copy', async () => {
  const rescued = (pages: string, list: string): string => wbT('en', 'pdfimport.rescuedPages', { list, pages });

  assert.equal(formatRescuedPdfPagesNotice([3]), rescued('1 page', '3'));
  assert.equal(formatRescuedPdfPagesNotice([2, 3]), rescued('2 pages', '2, 3'));

  const longNotice = formatRescuedPdfPagesNotice([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  assert.equal(longNotice, rescued('10 pages', '1, 2, 3, 4, 5, 6, 7, 8 and 2 more'));

  for (const notice of [formatRescuedPdfPagesNotice([3]), longNotice]) {
    assert.equal(notice.includes("couldn't"), false);
  }
});

test('a board page that fails to rasterize shows a placeholder and is NOT cached', async () => {
  resetStubState({ failingPageNumbers: [1], numPages: 2 });

  const asset = {
    blob: new Blob(['stub'], { type: 'application/pdf' }),
    createdAt: Date.now(),
    fileName: 'board.pdf',
    fingerprint: 'stub-fingerprint',
    id: `asset-live-${Date.now()}`,
    mimeType: 'application/pdf',
    pageCount: 2,
    size: 1024,
  };
  const renderArgs = {
    asset,
    containerHeight: 1080,
    containerWidth: 1920,
    moduleSrc: STUB_MODULE_SRC,
    pageIndex: 0,
    zoom: 1,
  };

  const firstUrl = await renderPdfAssetPageImageUrl(renderArgs);

  assert.equal(typeof firstUrl, 'string');
  assert.ok(firstUrl.length > 0);

  const placeholderCanvas = stubState().createdCanvases.at(-1);

  assert.ok(placeholderCanvas);
  assert.equal(
    placeholderCanvas.drawnTexts.some((text) => text.includes(PLACEHOLDER_NOTICE)),
    true,
  );

  // Not caching the failure is deliberate: a transient failure (worker restart, OOM at a deep zoom)
  // would otherwise poison this page for the whole session. The second call must retry the render.
  await renderPdfAssetPageImageUrl(renderArgs);
  assert.deepEqual(stubState().requestedPages, [1, 1]);

  // A page that renders fine still caches — the second call does not touch pdf.js again.
  const goodArgs = { ...renderArgs, pageIndex: 1 };

  await renderPdfAssetPageImageUrl(goodArgs);
  await renderPdfAssetPageImageUrl(goodArgs);
  assert.deepEqual(stubState().requestedPages, [1, 1, 2]);
});

test('prefetching a broken page resolves quietly and caches nothing', async () => {
  resetStubState({ failingPageNumbers: [1], numPages: 1 });

  const asset = {
    blob: new Blob(['stub'], { type: 'application/pdf' }),
    createdAt: Date.now(),
    fileName: 'prefetch.pdf',
    fingerprint: 'stub-fingerprint',
    id: `asset-prefetch-${Date.now()}`,
    mimeType: 'application/pdf',
    pageCount: 1,
    size: 1024,
  };

  await prefetchPdfAssetPageImage({
    asset,
    containerHeight: 1080,
    containerWidth: 1920,
    moduleSrc: STUB_MODULE_SRC,
    pageIndex: 0,
    zoom: 1,
  });

  // A prefetch has no viewer, so it asks the renderer to reject rather than mint a placeholder
  // object URL nobody would paint or revoke.
  assert.equal(
    stubState().createdCanvases.every((canvas) => !canvas.drawnTexts.some((text) => text.includes(PLACEHOLDER_NOTICE))),
    true,
  );
});
