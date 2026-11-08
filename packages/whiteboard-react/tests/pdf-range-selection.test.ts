import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPdfRangeSelection,
  getPdfRangeSelectionInputError,
  parsePdfRangeSelection,
} from '../src/components/whiteboard/utils/pdfRangeSelection';

test('parsePdfRangeSelection resolves all-page selection', () => {
  assert.deepEqual(parsePdfRangeSelection('all'), {
    endPage: '',
    mode: 'all',
    startPage: '',
  });
});

test('parsePdfRangeSelection resolves presets into start and end inputs', () => {
  assert.deepEqual(parsePdfRangeSelection('7'), {
    endPage: '7',
    mode: 'range',
    startPage: '7',
  });
  assert.deepEqual(parsePdfRangeSelection('46-55'), {
    endPage: '55',
    mode: 'range',
    startPage: '46',
  });
});

test('buildPdfRangeSelection returns a PDF range string only when both inputs are valid', () => {
  assert.equal(
    buildPdfRangeSelection({
      endPage: '55',
      mode: 'range',
      startPage: '46',
    }),
    '46-55',
  );
  assert.equal(
    buildPdfRangeSelection({
      endPage: '12',
      mode: 'range',
      startPage: '12',
    }),
    '12',
  );
  assert.equal(
    buildPdfRangeSelection({
      endPage: '',
      mode: 'range',
      startPage: '46',
    }),
    null,
  );
});

test('getPdfRangeSelectionInputError guides incomplete or invalid range input', () => {
  assert.equal(
    getPdfRangeSelectionInputError({
      endPage: '',
      mode: 'range',
      startPage: '46',
    }),
    'Enter both a start and an end page.',
  );
  assert.equal(
    getPdfRangeSelectionInputError({
      endPage: '0',
      mode: 'range',
      startPage: '1',
    }),
    'Page numbers start at 1.',
  );
  assert.equal(
    getPdfRangeSelectionInputError({
      endPage: '55',
      mode: 'range',
      startPage: '46',
    }),
    '',
  );
});
