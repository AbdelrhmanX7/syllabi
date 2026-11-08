import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAutoNoteTitle, pdfNoteTitle, retitleForPdf } from './note-title';

test('pdfNoteTitle drops the extension and any folder', () => {
  assert.equal(pdfNoteTitle('Chapter 4.pdf'), 'Chapter 4');
  assert.equal(pdfNoteTitle('a/b\\Slides.week3.PDF'), 'Slides.week3');
  assert.equal(pdfNoteTitle('deck.pptx'), 'deck');
  assert.equal(pdfNoteTitle('.pdf'), null);
  assert.equal(pdfNoteTitle(null), null);
});

test('isAutoNoteTitle recognises generated names only', () => {
  assert.ok(isAutoNoteTitle('MATH-192-1396 — Week 8 · Sun Oct 18'));
  assert.ok(isAutoNoteTitle('MATH 101 — Mon Oct 5'));
  assert.ok(isAutoNoteTitle('Lecture 8 — Igneous Rocks'));
  assert.ok(isAutoNoteTitle('Week 8'));
  assert.ok(isAutoNoteTitle('Notebook'));
  assert.ok(isAutoNoteTitle(''));
  assert.ok(!isAutoNoteTitle('My calculus cheatsheet'));
  assert.ok(!isAutoNoteTitle('Midterm review'));
});

test('retitleForPdf renames the default but never a typed name', () => {
  assert.equal(retitleForPdf('MATH-192-1396 — Week 8 · Sun Oct 18', 'Limits.pdf'), 'Limits');
  assert.equal(retitleForPdf('My own name', 'Limits.pdf'), null);
  assert.equal(retitleForPdf('Limits', 'Limits.pdf'), null);
  assert.equal(retitleForPdf('Notebook', '.pdf'), null);
});
