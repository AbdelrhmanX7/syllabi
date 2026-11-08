import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pdfWhollyOnPage } from './pdfOnPage';

const NAME = 'phone-abc.pdf';
const page = (n: number, extra: Record<string, unknown> = {}) => ({
  pdfAssetId: 'asset-1',
  pdfSourceName: NAME,
  pdfPageIndex: n - 1,
  pdfSourcePageNumber: n,
  ...extra,
});
const whole = new Map([['asset-1', { pageCount: 3, size: 1000 }]]);

test('every page of the whole file is on the note → true', () => {
  assert.equal(
    pdfWhollyOnPage({ pages: [{}, page(1), page(2), page(3)], assets: whole, fileName: NAME, fileSize: 1000 }),
    true,
  );
});

test('a page was deleted → false (the sheet offers it again)', () => {
  assert.equal(pdfWhollyOnPage({ pages: [page(1), page(3)], assets: whole, fileName: NAME, fileSize: 1000 }), false);
});

test('never imported, or another file → false', () => {
  assert.equal(pdfWhollyOnPage({ pages: [{}], assets: whole, fileName: NAME, fileSize: 1000 }), false);
  assert.equal(
    pdfWhollyOnPage({ pages: [page(1), page(2), page(3)], assets: whole, fileName: 'phone-other.pdf', fileSize: 1000 }),
    false,
  );
});

test('only a subset asset (its size is not the file size) → total unknown → false', () => {
  const subset = new Map([['asset-1', { pageCount: 2, size: 400 }]]);

  assert.equal(pdfWhollyOnPage({ pages: [page(1), page(2)], assets: subset, fileName: NAME, fileSize: 1000 }), false);
});

test('asset missing from this device → false', () => {
  assert.equal(
    pdfWhollyOnPage({
      pages: [page(1), page(2), page(3)],
      assets: new Map([['asset-1', null]]),
      fileName: NAME,
      fileSize: 1000,
    }),
    false,
  );
});

test('legacy pages without pdfSourcePageNumber count by pdfPageIndex', () => {
  const legacy = [1, 2, 3].map((n) => page(n, { pdfSourcePageNumber: undefined }));

  assert.equal(pdfWhollyOnPage({ pages: legacy, assets: whole, fileName: NAME, fileSize: 1000 }), true);
});
