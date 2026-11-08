import test from 'node:test';
import assert from 'node:assert/strict';

import {
  excludeImportedPdfPages,
  formatPdfPageRange,
  MAX_PDF_IMPORT_PAGE_COUNT,
  parsePdfPageRange,
  suggestNextPdfPageRange,
} from '../src/pdf-import';

test('parsePdfPageRange expands all pages when the range is empty or all', () => {
  assert.deepEqual(parsePdfPageRange('', 4), [1, 2, 3, 4]);
  assert.deepEqual(parsePdfPageRange('all', 3), [1, 2, 3]);
});

test('parsePdfPageRange resolves mixed page segments and sorts unique values', () => {
  assert.deepEqual(parsePdfPageRange('5, 1-3, 3, 8-7', 10), [1, 2, 3, 5, 7, 8]);
});

test('parsePdfPageRange rejects page selections that exceed the configured cap', () => {
  assert.throws(
    () => parsePdfPageRange(`1-${MAX_PDF_IMPORT_PAGE_COUNT + 1}`, MAX_PDF_IMPORT_PAGE_COUNT + 1),
    /the limit is/,
  );
});

test('formatPdfPageRange condenses consecutive pages into short ranges', () => {
  assert.equal(formatPdfPageRange([1, 2, 3, 5, 6, 9]), '1-3, 5-6, 9');
});

test('excludeImportedPdfPages removes pages that were already imported', () => {
  assert.deepEqual(excludeImportedPdfPages([35, 36, 37, 38, 39], [35, 36, 37]), [38, 39]);
});

test('suggestNextPdfPageRange proposes the next 10 pages after the highest imported page', () => {
  assert.equal(suggestNextPdfPageRange([35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45], 99), '46-55');
});

test('suggestNextPdfPageRange returns an empty string when all pages are already imported', () => {
  assert.equal(suggestNextPdfPageRange([1, 2, 3], 3), '');
});
