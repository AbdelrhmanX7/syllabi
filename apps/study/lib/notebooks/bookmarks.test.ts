import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Page } from '../api/types';

import { allBookmarks, boardBookmarks, bookmarkHref } from './bookmarks';

const board = (pages: object[]) => JSON.stringify({ id: 'b', pages });

describe('boardBookmarks', () => {
  test('bookmarked pages in order, with the pager label and the trimmed name', () => {
    assert.deepEqual(
      boardBookmarks(
        board([
          { id: 'p1', pdfAssetId: 'a', pdfPageIndex: 0 },
          { id: 's1', sheetAspect: 1.4, bookmark: { at: 0, label: ' proof ' } },
          { id: 'p2', pdfAssetId: 'a', pdfPageIndex: 1, bookmark: { at: 1000 } },
          { id: 'p3', bookmark: { label: 'no time' } },
        ]),
      ),
      [
        { boardPageId: 's1', index: 1, pageLabel: '1a', label: 'proof', at: new Date(0).toISOString() },
        { boardPageId: 'p2', index: 2, pageLabel: '2', label: null, at: new Date(1000).toISOString() },
      ],
    );
  });

  test('anything unreadable has no bookmarks', () => {
    assert.deepEqual(boardBookmarks('{nope'), []);
    assert.deepEqual(boardBookmarks('null'), []);
  });
});

describe('allBookmarks / bookmarkHref', () => {
  test('flattens notebooks in list order and links to the page', () => {
    const mark = { boardPageId: 'x', index: 0, pageLabel: '1', label: null, at: '' };
    const pages = [
      { id: 'n1', classId: 'c1', bookmarks: [mark] },
      { id: 'n2', classId: null },
    ] as unknown as Page[];

    assert.deepEqual(
      allBookmarks(pages).map((entry) => entry.page.id),
      ['n1'],
    );
    assert.equal(bookmarkHref(pages[0], mark), '/notebook/?id=n1&page=x&classId=c1');
  });
});
