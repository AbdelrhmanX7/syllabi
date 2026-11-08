import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendWhiteboardPages,
  insertWhiteboardPageAt,
  insertWhiteboardPageRelative,
  reorderWhiteboardPages,
} from '../src/page-operations';

import type { WhiteboardPage } from '../src/types';

function createPage(id: string): WhiteboardPage {
  return {
    id,
    canvasJSON: '',
    thumbnail: '',
    backgroundType: 'blank',
    viewportOffsetX: 0,
    viewportOffsetY: 0,
  };
}

test('insertWhiteboardPageAt clamps the index and inserts the page at the expected position', () => {
  const pageA = createPage('a');
  const pageB = createPage('b');
  const pageC = createPage('c');
  const insertedPage = createPage('x');

  const result = insertWhiteboardPageAt([pageA, pageB, pageC], insertedPage, 10);

  assert.equal(result.insertedIndex, 3);
  assert.deepEqual(
    result.pages.map((page) => page.id),
    ['a', 'b', 'c', 'x'],
  );
});

test('insertWhiteboardPageRelative inserts before and after the requested page', () => {
  const pages = [createPage('a'), createPage('b'), createPage('c')];

  const beforeResult = insertWhiteboardPageRelative(pages, createPage('before'), 1, 'before');
  const afterResult = insertWhiteboardPageRelative(pages, createPage('after'), 1, 'after');

  assert.deepEqual(
    beforeResult.pages.map((page) => page.id),
    ['a', 'before', 'b', 'c'],
  );
  assert.equal(beforeResult.insertedIndex, 1);
  assert.deepEqual(
    afterResult.pages.map((page) => page.id),
    ['a', 'b', 'after', 'c'],
  );
  assert.equal(afterResult.insertedIndex, 2);
});

test('appendWhiteboardPages returns the first inserted index for imported PDF pages', () => {
  const existingPages = [createPage('a'), createPage('b')];
  const importedPages = [createPage('pdf-1'), createPage('pdf-2')];
  const result = appendWhiteboardPages(existingPages, importedPages);

  assert.equal(result.firstInsertedIndex, 2);
  assert.deepEqual(
    result.pages.map((page) => page.id),
    ['a', 'b', 'pdf-1', 'pdf-2'],
  );
});

test('reorderWhiteboardPages moves the requested page without mutating invalid inputs', () => {
  const pages = [createPage('a'), createPage('b'), createPage('c'), createPage('d')];

  const moved = reorderWhiteboardPages(pages, 1, 3);
  const untouched = reorderWhiteboardPages(pages, -1, 2);

  assert.deepEqual(
    moved.map((page) => page.id),
    ['a', 'c', 'd', 'b'],
  );
  assert.equal(untouched, pages);
});
