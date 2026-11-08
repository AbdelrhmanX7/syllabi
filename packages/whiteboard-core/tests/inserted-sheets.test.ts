import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWhiteboardDocument } from '../src/defaults';
import {
  createInsertedSheet,
  isInsertedSheet,
  pageHasInk,
  resolvePageLabels,
  resolveSheetInsertIndex,
} from '../src/inserted-sheets';
import { migrateWhiteboardPage } from '../src/migrations';
import { insertWhiteboardPageAt } from '../src/page-operations';
import { normalizePaperSpacingMm, PAPER_SPACING_MM_MAX, PAPER_SPACING_MM_MIN } from '../src/page-geometry';

import type { WhiteboardDocument, WhiteboardPage } from '../src/types';

const pdf = (n: number): WhiteboardPage => ({
  id: `p${n}`,
  canvasJSON: '',
  thumbnail: '',
  backgroundType: 'blank',
  pdfAssetId: 'asset',
  pdfPageIndex: n - 1,
  viewportOffsetX: 0,
  viewportOffsetY: 0,
});

const sheet = (id: string, aspect = 1.4): WhiteboardPage => ({ ...createInsertedSheet(aspect, 'lined'), id });

test('isInsertedSheet: only a background-less page with a sane aspect', () => {
  assert.equal(isInsertedSheet(sheet('s')), true);
  assert.equal(isInsertedSheet(pdf(1)), false);
  assert.equal(isInsertedSheet({ ...pdf(1), sheetAspect: 1.4 }), false);
  assert.equal(isInsertedSheet({ ...sheet('s'), sheetAspect: 0 }), false);
  assert.equal(isInsertedSheet({ ...sheet('s'), sheetAspect: Number.NaN }), false);
  assert.equal(isInsertedSheet(undefined), false);
});

test('createInsertedSheet: empty page, the paper asked for, the anchor aspect', () => {
  const page = createInsertedSheet(1.2941, 'lined');

  assert.equal(page.canvasJSON, '');
  assert.equal(page.backgroundType, 'lined');
  assert.equal(page.sheetAspect, 1.2941);
  assert.equal(page.pdfAssetId, undefined);
  assert.equal(createInsertedSheet(Number.NaN, 'blank').sheetAspect, 297 / 210);
});

test('labels: PDF pages keep their own numbers; sheets are «Na», «Nb»', () => {
  assert.deepEqual(resolvePageLabels([pdf(1), pdf(2), pdf(3)]), ['1', '2', '3']);
  assert.deepEqual(resolvePageLabels([pdf(1), sheet('a'), pdf(2), pdf(3), sheet('b'), sheet('c')]), ['1', '1a', '2', '3', '3a', '3b']);
  assert.deepEqual(resolvePageLabels([sheet('a'), pdf(1)]), ['0a', '1']);
  // A page without a PDF counts among the non-sheet pages, exactly as index + 1 did.
  const plain: WhiteboardPage = { ...pdf(9), pdfAssetId: undefined, pdfPageIndex: undefined, id: 'plain' };

  assert.deepEqual(resolvePageLabels([plain, plain, plain]), ['1', '2', '3']);
  // A PDF page shows the PDF's own number even behind a notebook's leading blank page.
  assert.deepEqual(resolvePageLabels([plain, pdf(1), sheet('a'), pdf(2)]), ['1', '1', '1a', '2']);
  // A subset import: the source page number wins over the index into the subset asset.
  assert.deepEqual(resolvePageLabels([{ ...pdf(1), pdfSourcePageNumber: 7 }, sheet('a')]), ['7', '7a']);
});

test('labels: many sheets after one page roll over to two letters', () => {
  const pages = [pdf(1), ...Array.from({ length: 28 }, (_, i) => sheet(`s${i}`))];
  const labels = resolvePageLabels(pages);

  assert.equal(labels[1], '1a');
  assert.equal(labels[26], '1z');
  assert.equal(labels[27], '1aa');
  assert.equal(labels[28], '1ab');
});

test('insert index: after the page, after sheets already following it', () => {
  const pages = [pdf(1), sheet('a'), sheet('b'), pdf(2), pdf(3)];

  assert.equal(resolveSheetInsertIndex(pages, 0), 3);
  assert.equal(resolveSheetInsertIndex(pages, 1), 3);
  assert.equal(resolveSheetInsertIndex(pages, 3), 4);
  assert.equal(resolveSheetInsertIndex(pages, 4), 5);
  // At the end.
  assert.equal(resolveSheetInsertIndex(pages, pages.length - 1), pages.length);
  assert.equal(resolveSheetInsertIndex([], 0), 0);
});

test('insert then delete leaves every other page byte-identical and in order', () => {
  const ink = '{"version":"7","objects":[{"type":"Path","left":10,"top":800}]}';
  const pages = [pdf(1), { ...pdf(2), canvasJSON: ink, canvasWidthPx: 1000 }, pdf(3)];
  const before = JSON.stringify(pages);
  const insertAt = resolveSheetInsertIndex(pages, 0);
  const { insertedIndex, pages: inserted } = insertWhiteboardPageAt(pages, sheet('new'), insertAt);

  assert.equal(insertedIndex, 1);
  assert.deepEqual(resolvePageLabels(inserted), ['1', '1a', '2', '3']);
  // Page 2's ink is untouched: ink is page-local, insertion only moves where the page is stacked.
  assert.equal(inserted[2]!.canvasJSON, ink);
  assert.equal(inserted[2]!.id, 'p2');

  const deleted = inserted.filter((page) => page.id !== 'new');

  assert.equal(JSON.stringify(deleted), before);
});

test('persistence: sheetAspect survives normalize + migrate; old pages stay byte-identical', () => {
  const doc = {
    id: 'd',
    title: 't',
    pages: [pdf(1), sheet('s', 1.5), pdf(2)],
    currentPageIndex: 0,
    createdAt: 1,
    updatedAt: 1,
    thumbnail: '',
  } as WhiteboardDocument;
  const normalized = normalizeWhiteboardDocument(doc);

  assert.equal(normalized.pages[1]!.sheetAspect, 1.5);
  assert.equal(JSON.parse(JSON.stringify(normalized)).pages[0].sheetAspect, undefined);
  assert.equal('sheetAspect' in JSON.parse(JSON.stringify(normalized.pages[0])), false);
  assert.equal(migrateWhiteboardPage(JSON.parse(JSON.stringify(sheet('s', 1.5)))).sheetAspect, 1.5);
  // Junk or a PDF page carrying the key: dropped.
  assert.equal(migrateWhiteboardPage({ ...sheet('s'), sheetAspect: -1 }).sheetAspect, undefined);
  assert.equal('sheetAspect' in migrateWhiteboardPage({ ...pdf(1), sheetAspect: 1.4 }), false);
  assert.equal('sheetAspect' in migrateWhiteboardPage(pdf(1)), false);
});

test('pageHasInk', () => {
  assert.equal(pageHasInk({ canvasJSON: '' }), false);
  assert.equal(pageHasInk({ canvasJSON: '{"version":"7","objects":[]}' }), false);
  assert.equal(pageHasInk({ canvasJSON: '{"objects":[{"type":"Path"}]}' }), true);
});

test('paper spacing: validated, rounded, kept through normalize + migrate; absent stays absent', () => {
  assert.equal(normalizePaperSpacingMm(7.1), 7.1);
  assert.equal(normalizePaperSpacingMm(7.149), 7.1);
  assert.equal(normalizePaperSpacingMm(PAPER_SPACING_MM_MIN), 3);
  assert.equal(normalizePaperSpacingMm(PAPER_SPACING_MM_MAX), 15);
  assert.equal(normalizePaperSpacingMm(2.9), undefined);
  assert.equal(normalizePaperSpacingMm('7'), undefined);
  assert.equal(normalizePaperSpacingMm(Number.NaN), undefined);

  assert.equal(migrateWhiteboardPage({ ...pdf(1), paperSpacingMm: 6 }).paperSpacingMm, 6);
  assert.equal('paperSpacingMm' in migrateWhiteboardPage({ ...pdf(1), paperSpacingMm: 99 }), false);
  assert.equal('paperSpacingMm' in migrateWhiteboardPage(pdf(1)), false);

  const doc = { id: 'd', title: 't', pages: [{ ...pdf(1), paperSpacingMm: 8.7 }, pdf(2)], currentPageIndex: 0, createdAt: 1, updatedAt: 1, thumbnail: '' } as WhiteboardDocument;
  const json = JSON.parse(JSON.stringify(normalizeWhiteboardDocument(doc)));

  assert.equal(json.pages[0].paperSpacingMm, 8.7);
  assert.equal('paperSpacingMm' in json.pages[1], false);
});

test('createInsertedSheet takes a spacing only when it is valid', () => {
  assert.equal(createInsertedSheet(1.4, 'lined', 7.1).paperSpacingMm, 7.1);
  assert.equal('paperSpacingMm' in createInsertedSheet(1.4, 'lined'), false);
  assert.equal('paperSpacingMm' in createInsertedSheet(1.4, 'lined', 50), false);
});
