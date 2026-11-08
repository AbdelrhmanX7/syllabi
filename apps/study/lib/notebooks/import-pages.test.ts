import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImageNotebookDocument,
  DEFAULT_IMPORT_TITLE,
  importKindOf,
  importProgressLabel,
  notebookTitleForImages,
  notebookTitleFromFileName,
  planImport,
  topAlignedViewportOffsetY,
} from './import-pages';

test('notebookTitleFromFileName strips only the last extension', () => {
  assert.equal(notebookTitleFromFileName('Lecture 3 – vectors.pdf'), 'Lecture 3 – vectors');
  assert.equal(notebookTitleFromFileName('notes.v2.PDF'), 'notes.v2');
  assert.equal(notebookTitleFromFileName('Screenshot_20261107_101500.jpg'), 'Screenshot 20261107 101500');
  assert.equal(notebookTitleFromFileName('/storage/emulated/0/Notes/Chem  week 4.png'), 'Chem week 4');
  assert.equal(notebookTitleFromFileName('No extension'), 'No extension');
});

test('notebookTitleFromFileName falls back when nothing is left', () => {
  assert.equal(notebookTitleFromFileName('.pdf'), DEFAULT_IMPORT_TITLE);
  assert.equal(notebookTitleFromFileName(''), DEFAULT_IMPORT_TITLE);
  assert.equal(notebookTitleFromFileName(undefined), DEFAULT_IMPORT_TITLE);
  assert.equal(notebookTitleFromFileName(`${'a'.repeat(300)}.pdf`).length, 200);
});

test('notebookTitleForImages names after the first image plus the rest', () => {
  assert.equal(notebookTitleForImages([]), DEFAULT_IMPORT_TITLE);
  assert.equal(notebookTitleForImages(['page1.png']), 'page1');
  assert.equal(notebookTitleForImages(['page1.png', 'page2.png', 'page3.png']), 'page1 +2');
});

test('importKindOf reads the mime, then the extension', () => {
  assert.equal(importKindOf({ name: 'x', type: 'application/pdf' }), 'pdf');
  assert.equal(importKindOf({ name: 'x.pdf', type: '' }), 'pdf');
  assert.equal(importKindOf({ name: 'x', mime: 'image/jpeg' }), 'image');
  assert.equal(importKindOf({ name: 'x.HEIC', type: '' }), 'image');
  assert.equal(importKindOf({ name: 'x.docx', type: 'application/msword' }), 'other');
});

test('planImport: one PDF, or only images; anything else is an error', () => {
  const pdf = { name: 'a.pdf', type: 'application/pdf' };
  const img = (n: number) => ({ name: `${n}.png`, type: 'image/png' });

  assert.deepEqual(planImport([pdf]), { kind: 'pdf', file: pdf });
  assert.deepEqual(planImport([img(1), img(2)]), { kind: 'images', files: [img(1), img(2)] });
  assert.equal(planImport([]).kind, 'error');
  assert.equal(planImport([pdf, pdf]).kind, 'error');
  assert.equal(planImport([pdf, img(1)]).kind, 'error');
  assert.equal(planImport([{ name: 'a.txt', type: 'text/plain' }]).kind, 'error');
});

test('topAlignedViewportOffsetY: a page taller than the board opens at its top', () => {
  // A4 portrait on an 800×1280 tablet: fitted height 800·√2 ≈ 1131 < 1280 → fits, no offset.
  assert.equal(topAlignedViewportOffsetY(595, 842, 800, 1280), 0);
  // Same page in landscape (1280×800): fitted height 1811, centred → top at -505.5.
  assert.ok(Math.abs(topAlignedViewportOffsetY(595, 842, 1280, 800) - (1280 * (842 / 595) - 800) / 2) < 1e-9);
  // A tall phone screenshot (1080×2400) on the portrait tablet.
  assert.ok(Math.abs(topAlignedViewportOffsetY(1080, 2400, 800, 1280) - (800 * (2400 / 1080) - 1280) / 2) < 1e-9);
  // Degenerate sizes never produce NaN.
  assert.equal(topAlignedViewportOffsetY(0, 100, 800, 1280), 0);
  assert.equal(topAlignedViewportOffsetY(100, 100, 0, 0), 0);
});

test('buildImageNotebookDocument: one background page per image, fitted to the board', () => {
  let n = 0;
  const doc = buildImageNotebookDocument({
    pageId: 'draft',
    title: 'Chem',
    images: [
      { dataUrl: 'data:image/png;base64,AAA', width: 1080, height: 2400, name: 'a.png' },
      { dataUrl: 'data:image/jpeg;base64,BBB', width: 1600, height: 1000, name: 'b.jpg' },
    ],
    canvas: { width: 800, height: 1280 },
    newId: () => `p${++n}`,
    now: 42,
    schemaVersion: 7,
  });

  assert.equal(doc.id, 'draft');
  assert.equal(doc.title, 'Chem');
  assert.equal(doc.schemaVersion, 7);
  assert.equal(doc.createdAt, 42);
  assert.equal(doc.currentPageIndex, 0);
  assert.deepEqual(
    doc.pages.map((page) => [page.id, page.pdfImageUrl, page.pdfSourceName, page.thumbnail, page.pdfAssetId]),
    [
      ['p1', 'data:image/png;base64,AAA', 'a.png', '', undefined],
      ['p2', 'data:image/jpeg;base64,BBB', 'b.jpg', '', undefined],
    ],
  );
  assert.ok((doc.pages[0].viewportOffsetY ?? 0) > 0);
  assert.equal(doc.pages[1].viewportOffsetY, 0);
});

test('importProgressLabel', () => {
  assert.equal(importProgressLabel('rendering', 0.426), 'Rendering pages 43%');
  assert.equal(importProgressLabel('rendering', 3), 'Rendering pages 100%');
  assert.equal(importProgressLabel('images', 0, 3), 'Preparing image 1 of 3…');
  assert.equal(importProgressLabel('saving'), 'Saving notebook…');
});
