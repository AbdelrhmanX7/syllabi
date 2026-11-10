import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseWhiteboardDocumentFile, prepareImportedDocument } from './whiteboardFile';

const validDoc = {
  id: 'orig-id',
  title: 'My Board',
  pages: [
    { id: 'p1', canvasJSON: '{"objects":[]}', thumbnail: 'data:x', backgroundType: 'grid' },
    { id: 'p2', canvasJSON: '{"objects":[]}', thumbnail: '', backgroundType: 'weird' },
  ],
  currentPageIndex: 5,
  createdAt: 111,
  updatedAt: 222,
  thumbnail: 'data:doc',
};

test('rejects non-JSON text', () => {
  const r = parseWhiteboardDocumentFile('not json {');

  assert.equal(r.ok, false);
});

test('rejects a JSON value that is not an object', () => {
  assert.equal(parseWhiteboardDocumentFile('42').ok, false);
  assert.equal(parseWhiteboardDocumentFile('null').ok, false);
});

test('rejects a document with no pages', () => {
  assert.equal(parseWhiteboardDocumentFile(JSON.stringify({ pages: [] })).ok, false);
  assert.equal(parseWhiteboardDocumentFile(JSON.stringify({ title: 'x' })).ok, false);
});

test('rejects a document with an invalid page', () => {
  const bad = { pages: [{ id: 'p1' /* missing canvasJSON */ }] };

  assert.equal(parseWhiteboardDocumentFile(JSON.stringify(bad)).ok, false);
});

test('parses a valid document and normalizes loose fields', () => {
  const r = parseWhiteboardDocumentFile(JSON.stringify(validDoc));

  assert.equal(r.ok, true);
  if (!r.ok) return;

  // currentPageIndex clamped to [0, pages.length-1]
  assert.equal(r.document.currentPageIndex, 1);
  // unknown backgroundType normalized to 'blank'
  assert.equal(r.document.pages[1].backgroundType, 'blank');
  assert.equal(r.document.pages[0].backgroundType, 'grid');
  assert.equal(r.document.pages.length, 2);
  assert.equal(r.document.title, 'My Board');
});

test('defaults a blank title', () => {
  const r = parseWhiteboardDocumentFile(JSON.stringify({ ...validDoc, title: '   ' }));

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.document.title.length > 0);
});

test('prepareImportedDocument assigns a fresh id + timestamps and clamps index', () => {
  const r = parseWhiteboardDocumentFile(JSON.stringify(validDoc));

  assert.equal(r.ok, true);
  if (!r.ok) return;

  const prepared = prepareImportedDocument(r.document, { id: 'new-id', now: 999 });

  assert.equal(prepared.id, 'new-id');
  assert.equal(prepared.createdAt, 999);
  assert.equal(prepared.updatedAt, 999);
  assert.equal(prepared.currentPageIndex, 1);
  assert.notEqual(prepared.id, 'orig-id');
});

test('carries recorded capture geometry through the .kawb.json whitelist, validated', () => {
  const placement = { height: 2715.4, width: 1920, x: 0, y: -817.7 };
  const doc = {
    ...validDoc,
    pages: [
      // PDF page with a good record: both fields survive, the negative y included.
      { id: 'p1', canvasJSON: '{}', thumbnail: '', backgroundType: 'blank', pdfAssetId: 'a', canvasWidthPx: 1920, pdfPlacement: placement },
      // Junk record: dropped, never repaired to 0.
      { id: 'p2', canvasJSON: '{}', thumbnail: '', backgroundType: 'blank', pdfAssetId: 'a', canvasWidthPx: 0, pdfPlacement: { x: 0, y: 0, width: 0, height: 0 } },
      // Blank page: a width is legitimate, a placement is not (nothing to place).
      { id: 'p3', canvasJSON: '{}', thumbnail: '', backgroundType: 'grid', canvasWidthPx: 1366, pdfPlacement: placement },
    ],
  };
  const r = parseWhiteboardDocumentFile(JSON.stringify(doc));

  assert.equal(r.ok, true);
  if (!r.ok) return;

  const [p1, p2, p3] = r.document.pages;

  assert.equal(p1?.canvasWidthPx, 1920);
  assert.deepEqual(p1?.pdfPlacement, placement);
  assert.equal('canvasWidthPx' in (p2 ?? {}), false);
  assert.equal('pdfPlacement' in (p2 ?? {}), false);
  assert.equal(p3?.canvasWidthPx, 1366);
  assert.equal('pdfPlacement' in (p3 ?? {}), false);
});

test('carries bookmarks, sheet shape, board ruling and paper spacing through the whitelist', () => {
  const doc = {
    ...validDoc,
    pages: [
      {
        id: 'p1',
        canvasJSON: '{}',
        thumbnail: '',
        backgroundType: 'lined',
        canvasWidthPx: 900,
        sheetAspect: 2.5,
        boardRuled: true,
        paperSpacingMm: 7.1,
        bookmark: { at: 123, label: '  Exam formulas  ' },
      },
      // Junk: a bookmark without a time, board ruling without a sheet, a sheet shape on a PDF page.
      { id: 'p2', canvasJSON: '{}', thumbnail: '', backgroundType: 'blank', pdfAssetId: 'a', sheetAspect: 1.4, boardRuled: true, bookmark: { label: 'x' } },
      { id: 'p3', canvasJSON: '{}', thumbnail: '', backgroundType: 'blank', bookmark: { at: 5, label: '   ' } },
    ],
  };
  const r = parseWhiteboardDocumentFile(JSON.stringify(doc));

  assert.equal(r.ok, true);
  if (!r.ok) return;

  const [p1, p2, p3] = r.document.pages;

  assert.equal(p1?.sheetAspect, 2.5);
  assert.equal(p1?.boardRuled, true);
  assert.equal(p1?.paperSpacingMm, 7.1);
  assert.deepEqual(p1?.bookmark, { at: 123, label: 'Exam formulas' });
  assert.equal('sheetAspect' in (p2 ?? {}), false);
  assert.equal('boardRuled' in (p2 ?? {}), false);
  assert.equal('bookmark' in (p2 ?? {}), false);
  assert.deepEqual(p3?.bookmark, { at: 5 });
});
