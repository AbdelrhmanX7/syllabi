import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWhiteboardDocument } from '../src/defaults';
import { createInsertedSheet, resolvePageLabels } from '../src/inserted-sheets';
import { migrateWhiteboardDocument, migrateWhiteboardPage } from '../src/migrations';
import {
  canvasJsonInkExtent,
  createNotebookSheet,
  isSheetNotebook,
  NOTEBOOK_SHEET_ASPECT,
  splitFreeNotebookIntoSheets,
  toNotebookSheet,
} from '../src/notebook-sheets';
import { normalizePageBookmark } from '../src/page-geometry';

import type { WhiteboardDocument, WhiteboardPage } from '../src/types';

/** A pen stroke the way Fabric 7 serializes it (centre origin, a stroke width, path in object space). */
const stroke = (cx: number, cy: number, w = 120, h = 40, extra: Record<string, unknown> = {}) => ({
  type: 'Path',
  version: '7.4.0',
  originX: 'center',
  originY: 'center',
  left: cx,
  top: cy,
  width: w,
  height: h,
  fill: null,
  stroke: '#1f2937',
  strokeWidth: 3,
  scaleX: 1,
  scaleY: 1,
  angle: 0,
  skewX: 0,
  skewY: 0,
  path: [
    ['M', 0, 0],
    ['Q', 10, 10, w, h],
  ],
  oid: `s${cx}-${cy}`,
  ...extra,
});

const scene = (...objects: unknown[]) => JSON.stringify({ version: '7.4.0', objects });

const freePage = (id: string, canvasJSON: string, extra: Partial<WhiteboardPage> = {}): WhiteboardPage => ({
  id,
  canvasJSON,
  thumbnail: '',
  backgroundType: 'lined',
  viewportOffsetX: 0,
  viewportOffsetY: 120,
  ...extra,
});

test('an empty old page becomes an A4 sheet ruled like a board page', () => {
  const page = freePage('a', '');
  const sheet = toNotebookSheet(page);

  assert.ok(sheet);
  assert.equal(sheet.sheetAspect, NOTEBOOK_SHEET_ASPECT);
  assert.equal(sheet.boardRuled, true);
  assert.equal(sheet.canvasJSON, '');
  assert.equal(sheet.backgroundType, 'lined');
});

test('an old page whose ink fits on A4 keeps every byte of its ink', () => {
  const json = scene(stroke(200, 300), stroke(500, 900));
  const page = freePage('a', json, { canvasWidthPx: 800 });
  const sheet = toNotebookSheet(page);

  assert.ok(sheet);
  assert.equal(sheet.canvasJSON, json);
  assert.equal(sheet.canvasWidthPx, 800);
  assert.equal(sheet.sheetAspect, NOTEBOOK_SHEET_ASPECT);
  assert.equal(sheet.viewportOffsetY, 120);
});

test('an old page written further down becomes one tall page that covers all of its ink', () => {
  const json = scene(stroke(200, 300), stroke(400, 3000, 200, 80));
  const sheet = toNotebookSheet(freePage('a', json, { canvasWidthPx: 800 }));

  assert.ok(sheet);
  assert.equal(sheet.canvasJSON, json);

  const pageHeight = 800 * (sheet.sheetAspect ?? 0);

  // The lowest stroke ends at 3000 + 40 + its stroke width; the page reaches past it.
  assert.ok(pageHeight > 3043, `page height ${pageHeight}`);
  assert.ok(pageHeight < 3200, `page height ${pageHeight}`);
});

test('the box is generous: left/top origin, scale and rotation are all covered', () => {
  const extent = canvasJsonInkExtent(
    scene(
      { type: 'Path', originX: 'left', originY: 'top', left: 10, top: 20, width: 50, height: 50, scaleX: 2, scaleY: 2, stroke: '#000', strokeWidth: 2 },
      { type: 'Rect', originX: 'center', originY: 'center', left: 300, top: 300, width: 100, height: 10, angle: 90 },
    ),
  );

  assert.ok(extent && extent !== 'unreadable');
  assert.ok(extent.minX <= 10 && extent.minY <= 20);
  assert.ok(extent.maxX >= 110 && extent.maxY >= 350, JSON.stringify(extent));
});

test('ink outside the sheet, no recorded width, junk JSON or an endless page: left as it was', () => {
  assert.equal(toNotebookSheet(freePage('a', scene(stroke(-200, 300)), { canvasWidthPx: 800 })), null);
  assert.equal(toNotebookSheet(freePage('a', scene(stroke(1200, 300)), { canvasWidthPx: 800 })), null);
  assert.equal(toNotebookSheet(freePage('a', scene(stroke(300, -400)), { canvasWidthPx: 800 })), null);
  assert.equal(toNotebookSheet(freePage('a', scene(stroke(300, 300)))), null);
  assert.equal(toNotebookSheet(freePage('a', '{not json', { canvasWidthPx: 800 })), null);
  assert.equal(toNotebookSheet(freePage('a', scene(stroke(300, 800 * 25)), { canvasWidthPx: 800 })), null);
});

test('a stroke that only kisses the edge still converts', () => {
  assert.ok(toNotebookSheet(freePage('a', scene(stroke(62, 22)), { canvasWidthPx: 800 })));
  assert.ok(toNotebookSheet(freePage('a', scene(stroke(740, 300)), { canvasWidthPx: 800 })));
});

test('splitting a notebook is all or nothing, and never touches a PDF notebook', () => {
  const ok = freePage('a', scene(stroke(200, 300)), { canvasWidthPx: 800 });
  const bad = freePage('b', scene(stroke(-500, 300)), { canvasWidthPx: 800 });
  const pdf: WhiteboardPage = { ...freePage('p', ''), pdfAssetId: 'asset', pdfPageIndex: 0 };

  assert.equal(splitFreeNotebookIntoSheets([ok, bad]), null);
  assert.equal(splitFreeNotebookIntoSheets([ok, pdf]), null);

  const split = splitFreeNotebookIntoSheets([ok, freePage('c', '')]);

  assert.ok(split);
  assert.equal(split.length, 2);
  assert.ok(isSheetNotebook(split));
  assert.equal(split[0]!.canvasJSON, ok.canvasJSON);
  // The blank page takes the notebook's frame, so its lines match page 1's.
  assert.equal(split[1]!.canvasWidthPx, 800);
  // Already split: the very same array back (nothing to save).
  assert.equal(splitFreeNotebookIntoSheets(split), split);
});

test('a notebook of sheets counts its pages 1, 2, 3', () => {
  assert.deepEqual(resolvePageLabels([createNotebookSheet('lined'), createNotebookSheet('grid'), createNotebookSheet('blank')]), ['1', '2', '3']);
  // Sheets among PDF pages keep their letters.
  assert.deepEqual(
    resolvePageLabels([{ ...freePage('p', ''), pdfAssetId: 'x', pdfPageIndex: 0 }, createInsertedSheet(1.4, 'lined')]),
    ['1', '1a'],
  );
});

test('board ruling and bookmarks survive normalize and migrate; junk is dropped', () => {
  const sheet = { ...createNotebookSheet('lined', 7.1), bookmark: { at: 42, label: ' Chapter 2 ' } };
  const doc: WhiteboardDocument = {
    id: 'd',
    title: 't',
    pages: [sheet, { ...freePage('x', ''), boardRuled: true, bookmark: { at: Number.NaN } as never }],
    currentPageIndex: 0,
    createdAt: 0,
    updatedAt: 0,
    thumbnail: '',
  };
  const normalized = normalizeWhiteboardDocument(doc);

  assert.equal(normalized?.pages[0]?.boardRuled, true);
  assert.deepEqual(normalized?.pages[0]?.bookmark, { at: 42, label: 'Chapter 2' });
  assert.equal('boardRuled' in (normalized?.pages[1] ?? {}), false);
  assert.equal('bookmark' in (normalized?.pages[1] ?? {}), false);

  const migrated = migrateWhiteboardPage(JSON.parse(JSON.stringify(sheet)));

  assert.equal(migrated.boardRuled, true);
  assert.equal(migrated.sheetAspect, NOTEBOOK_SHEET_ASPECT);
  assert.deepEqual(migrated.bookmark, { at: 42, label: 'Chapter 2' });

  const migratedDoc = migrateWhiteboardDocument(JSON.parse(JSON.stringify(doc)));

  assert.deepEqual(migratedDoc.document.pages[0]?.bookmark, { at: 42, label: 'Chapter 2' });
});

test('bookmark labels are trimmed and capped', () => {
  assert.equal(normalizePageBookmark({ at: 1, label: 'x'.repeat(200) })?.label?.length, 60);
  assert.equal(normalizePageBookmark('yes'), undefined);
  assert.equal(normalizePageBookmark(null), undefined);
});
