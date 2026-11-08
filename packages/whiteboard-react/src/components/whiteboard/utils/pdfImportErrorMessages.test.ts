import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PDF_IMPORT_FILE_SIZE, MAX_PDF_IMPORT_PAGE_COUNT } from '@repo/whiteboard-core';

import { PDF_STRINGS } from '../../../i18n/dict/pdf';
import { userFacingError, wbT } from '../../../i18n/strings';

import { describePdfImportError, readPdfImportErrorMessage } from './pdfImportErrorMessages';
import { selectNewPdfImportWarnings } from './pdfImportNotices';

/**
 * A teacher on a tablet hit `Bounding box is required.` — a raw pdf.js string — on a red line in the
 * import modal. These pin the rule that raw engine text never reaches the modal as the message.
 */

const VARS = { max: MAX_PDF_IMPORT_PAGE_COUNT, mb: Math.round(MAX_PDF_IMPORT_FILE_SIZE / (1024 * 1024)) };

const ENGINE_MESSAGES = [
  'Bounding box is required.',
  'PasswordException: No password given',
  'InvalidPDFException: Invalid PDF structure',
  'The PDF file is corrupt',
  'Array buffer allocation failed',
  'Out of memory',
  'Failed to fetch dynamically imported module: /pdf.worker.min.mjs',
  'NetworkError when attempting to fetch resource.',
  'Setting up fake worker failed',
  'PDF subset would be empty.',
  'TypeError: Cannot read properties of undefined (reading "width")',
  'Some brand new failure nobody has seen yet',
  '',
];

test('the pdf.js bounding-box error becomes friendly copy with a next step', () => {
  const copy = describePdfImportError(new Error('Bounding box is required.'));

  assert.equal(copy.kind, 'unreadable-format');
  assert.equal(copy.title, wbT('en', 'pdferr.unreadableFormat.title'));
  assert.equal(copy.message, wbT('en', 'pdferr.unreadableFormat.message', VARS));
  assert.equal(copy.hint, wbT('en', 'pdferr.unreadableFormat.hint', VARS));
  assert.ok(copy.hint.length > 0);
  // The engine string is kept for diagnosis, just demoted out of the message.
  assert.equal(copy.detail, 'Bounding box is required.');
});

test('every engine string maps to a titled message, never the raw engine text', () => {
  for (const message of ENGINE_MESSAGES) {
    const copy = describePdfImportError(new Error(message));

    assert.ok(copy.title.length > 0, `no title for: ${message}`);
    assert.ok(copy.message.length > 0, `no message for: ${message}`);
    assert.notEqual(copy.kind, 'user-facing', `engine text passed through for: ${message}`);
    assert.notEqual(copy.message, message);
    if (message) assert.ok(!copy.message.includes(message), `engine text leaked into the message for: ${message}`);
  }
});

test('a password-protected file is named as such', () => {
  const copy = describePdfImportError(new Error('PasswordException: No password given'));

  assert.equal(copy.kind, 'password-protected');
  assert.equal(copy.title, wbT('en', 'pdferr.passwordProtected.title'));
});

test('a corrupt file and an unreadable page are told apart', () => {
  assert.equal(describePdfImportError(new Error('InvalidPDFException')).kind, 'corrupt-file');
  assert.equal(describePdfImportError(new Error('FormatError: bad XRef entry')).kind, 'unreadable-format');
});

test('memory and canvas failures suggest a smaller range', () => {
  const oom = describePdfImportError(new Error('Array buffer allocation failed'));
  const canvas = describePdfImportError(new Error('Could not create a drawing surface to process the PDF pages'));

  assert.equal(oom.kind, 'out-of-memory');
  assert.equal(canvas.kind, 'out-of-memory');
  assert.equal(oom.hint, wbT('en', 'pdferr.outOfMemory.hint', VARS));
});

test('a worker that never loaded reads as a connection problem, not a broken file', () => {
  const copy = describePdfImportError(new Error('Failed to fetch dynamically imported module: /pdf.worker.min.mjs'));

  assert.equal(copy.kind, 'network');
  assert.equal(copy.hint, wbT('en', 'pdferr.network.hint', VARS));
});

test('the size and page-count guards keep their own limits and gain a next step', () => {
  const tooBig = describePdfImportError(new Error('File size exceeds the allowed limit (500 MB)'));
  const tooMany = describePdfImportError(new Error('Selected page count (900) exceeds the allowed limit (500 pages).'));

  assert.equal(tooBig.kind, 'file-too-large');
  assert.equal(tooMany.kind, 'too-many-pages');
  assert.match(tooMany.message, new RegExp(String(MAX_PDF_IMPORT_PAGE_COUNT)));
  assert.ok(tooMany.hint.length > 0);
});

test('a message written for the teacher passes through untouched, with no invented hint', () => {
  const copy = describePdfImportError(userFacingError('Could not convert the PowerPoint file to PDF.'));

  assert.equal(copy.kind, 'user-facing');
  assert.equal(copy.message, 'Could not convert the PowerPoint file to PDF.');
  assert.equal(copy.hint, '');
  assert.equal(copy.detail, null);
});

test('an unknown failure still says what happened and what to try', () => {
  const copy = describePdfImportError(new Error('Some brand new failure nobody has seen yet'));

  assert.equal(copy.kind, 'unknown');
  assert.equal(copy.title, wbT('en', 'pdferr.unknown.title'));
  assert.equal(copy.detail, 'Some brand new failure nobody has seen yet');
});

test('a thrown non-Error does not dead-end the teacher', () => {
  for (const thrown of [null, undefined, 42, { code: 'nope' }]) {
    const copy = describePdfImportError(thrown);

    assert.equal(copy.kind, 'unknown');
    assert.equal(copy.message, wbT('en', 'pdferr.unknown.message', VARS));
  }

  assert.equal(describePdfImportError('Bounding box is required.').kind, 'unreadable-format');
  assert.equal(readPdfImportErrorMessage({ message: '  boom  ' }), 'boom');
  assert.equal(readPdfImportErrorMessage(undefined), '');
});

test('only the warnings an import ADDED are surfaced after a partial success', () => {
  const before = ['Device memory is limited, so PDF pages will render at a lower resolution.'];
  const after = [...before, 'Could not process page 12; it was added blank.', 'Could not process page 12; it was added blank.'];

  assert.deepEqual(selectNewPdfImportWarnings(before, after), ['Could not process page 12; it was added blank.']);
  assert.deepEqual(selectNewPdfImportWarnings(before, before), []);
  assert.deepEqual(selectNewPdfImportWarnings(undefined, undefined), []);
});

test('the board copy is never re-read as an engine failure', () => {
  const guards = new Set(['pdfimport.fileTooLarge', 'pdfimport.tooManyPages']);

  for (const [key, text] of Object.entries(PDF_STRINGS)) {
    // pdferr.* is this mapper's own output, never thrown; guards keep their tailored hint.
    if (guards.has(key) || key.startsWith('pdferr.') || /\{\w+\}/.test(text) || text.trim().length < 12) continue;
    const copy = describePdfImportError(userFacingError(text));

    assert.equal(copy.kind, 'user-facing', `${key} was reclassified as ${copy.kind}`);
    assert.equal(copy.message, text);
  }

  assert.equal(describePdfImportError(new Error(wbT('en', 'pdfimport.beyondRepair'))).kind, 'user-facing');
});
