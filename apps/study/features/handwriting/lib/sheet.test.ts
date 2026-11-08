import type { GlyphBank, GlyphSample, SheetCell } from '@repo/whiteboard-react';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EMPTY_GLYPH_BANK } from '@repo/whiteboard-react';

import {
  cellPromptKey,
  cellSampleCount,
  cellsOnPage,
  cellTails,
  nextPageWithMissing,
  pageCount,
  pageOfCell,
  sheetProgress,
} from './sheet';

const cells: SheetCell[] = [
  { key: 'a.isol', label: 'a', prompt: '', form: 'isol', dir: 'ltr', group: 'skel:a' },
  { key: 'a.init', label: 'a', prompt: '', form: 'init', dir: 'ltr', group: 'skel:a' },
  { key: 'a.medi', label: 'a', prompt: '', form: 'medi', dir: 'ltr', group: 'skel:a' },
  { key: 'a.fina', label: 'a', prompt: '', form: 'fina', dir: 'ltr', group: 'skel:a' },
  { key: 'ar-dot:2', label: '·', prompt: '', form: 'isol', dir: 'ltr', group: 'dots' },
  { key: 'digit:3', label: '3', prompt: '', form: 'isol', dir: 'ltr', group: 'digits' },
  { key: 'lat:a', label: 'a', prompt: '', form: 'isol', dir: 'ltr', group: 'latin' },
];

const sample = (createdAt: number): GlyphSample => ({
  strokes: [[[0, 0, 0.5]]],
  advance: 1,
  entry: [1, 0],
  exit: [0, 0],
  bbox: { x: 0, y: -1, w: 1, h: 1 },
  source: 'sheet',
  createdAt,
});

const bankWith = (...keys: string[]): GlyphBank => ({
  ...EMPTY_GLYPH_BANK,
  glyphs: Object.fromEntries(keys.map((key) => [key, { key, samples: [sample(1), sample(2)] }])),
});

test('pages of three', () => {
  assert.equal(pageCount(cells, 3), 3);
  assert.deepEqual(
    cellsOnPage(1, cells, 3).map((cell) => cell.key),
    ['a.fina', 'ar-dot:2', 'digit:3'],
  );
  assert.deepEqual(
    cellsOnPage(9, cells, 3).map((cell) => cell.key),
    ['lat:a'],
  );
  assert.equal(pageOfCell('digit:3', cells, 3), 1);
  assert.equal(pageOfCell('nope', cells, 3), 0);
  assert.equal(pageCount([], 3), 1);
});

test('sheetProgress counts covered cells and lists the missing ones in order', () => {
  const progress = sheetProgress(bankWith('a.init', 'digit:3', 'unknown-key'), cells);

  assert.equal(progress.total, 7);
  assert.equal(progress.done, 2);
  assert.equal(progress.percent, 29);
  assert.deepEqual(progress.missing, ['a.isol', 'a.medi', 'a.fina', 'ar-dot:2', 'lat:a']);
  assert.equal(sheetProgress(EMPTY_GLYPH_BANK, []).percent, 0);
});

test('cellSampleCount caps at the bank maximum', () => {
  const bank = bankWith('a.init');

  assert.equal(cellSampleCount(bank, 'a.init'), 2);
  assert.equal(cellSampleCount(bank, 'a.isol'), 0);
});

test('nextPageWithMissing looks ahead, then wraps, then gives up', () => {
  const progress = sheetProgress(bankWith('a.isol', 'a.init', 'a.medi', 'ar-dot:2', 'digit:3'), cells);

  // Missing: a.fina (page 1), lat:a (page 2).
  assert.equal(nextPageWithMissing(progress, 0, cells, 3), 1);
  assert.equal(nextPageWithMissing(progress, 1, cells, 3), 2);
  assert.equal(nextPageWithMissing(progress, 2, cells, 3), 1);
  assert.equal(nextPageWithMissing(sheetProgress(bankWith(...cells.map((c) => c.key)), cells), 0, cells, 3), null);
});

test('prompt keys and join tails follow the form', () => {
  assert.deepEqual(cells.map(cellPromptKey), [
    'promptIsol',
    'promptInit',
    'promptMedi',
    'promptFina',
    'promptDots',
    'promptDigit',
    'promptLatin',
  ]);
  assert.deepEqual(cellTails(cells[0]), { right: false, left: false });
  assert.deepEqual(cellTails(cells[1]), { right: false, left: true });
  assert.deepEqual(cellTails(cells[2]), { right: true, left: true });
  assert.deepEqual(cellTails(cells[3]), { right: true, left: false });
  assert.deepEqual(cellTails(cells[5]), { right: false, left: false });
});
