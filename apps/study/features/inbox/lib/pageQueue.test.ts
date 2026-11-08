import type { InboxItem } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pageQueue } from './pageQueue';

const item = (id: string, minute: number, extra: Partial<InboxItem> = {}): InboxItem => ({
  id,
  kind: 'image',
  url: `https://b2/${id}.jpg`,
  thumbUrl: null,
  width: 100,
  height: 100,
  bytes: 1,
  note: null,
  createdAt: new Date(Date.UTC(2026, 9, 18, 10, minute)).toISOString(),
  usedAt: null,
  pageId: 'p1',
  ...extra,
});
const ids = (items: InboxItem[]) => items.map((i) => i.id);
const none = new Set<string>();

test('oldest first; the listing and the live store are merged and de-duplicated by id', () => {
  const fetched = [item('c', 5), item('a', 1)];
  const live = [item('d', 9), item('a', 1, { note: 'live copy' }), item('b', 3, { kind: 'pdf' })];
  const queue = pageQueue({ pageId: 'p1', fetched, live, appended: none });

  assert.deepEqual(ids(queue), ['a', 'b', 'c', 'd']);
  assert.equal(queue[0].note, 'live copy');
});

test('same createdAt: stable by id', () => {
  assert.deepEqual(ids(pageQueue({ pageId: 'p1', fetched: [item('y', 2), item('x', 2)], live: [], appended: none })), [
    'x',
    'y',
  ]);
});

test('only this page, only unused, only images and PDFs', () => {
  const live = [
    item('other', 1, { pageId: 'p2' }),
    item('loose', 2, { pageId: null }),
    item('legacy', 3, { pageId: undefined }),
    item('used', 4, { usedAt: '2026-10-18T11:00:00.000Z' }),
    item('weird', 5, { kind: 'video' as InboxItem['kind'] }),
    item('ok', 6),
  ];

  assert.deepEqual(ids(pageQueue({ pageId: 'p1', fetched: [], live, appended: none })), ['ok']);
});

test('the store copy wins: a local usedAt or a move to another page drops a fetched item', () => {
  const fetched = [item('a', 1), item('b', 2), item('c', 3)];
  const live = [item('a', 1, { usedAt: '2026-10-18T11:00:00.000Z' }), item('b', 2, { pageId: 'p2' })];

  assert.deepEqual(ids(pageQueue({ pageId: 'p1', fetched, live, appended: none })), ['c']);
});

test('a re-queue in the store (usedAt cleared) brings back an item the listing never had', () => {
  const live = [item('a', 1, { usedAt: null })];

  assert.deepEqual(ids(pageQueue({ pageId: 'p1', fetched: [], live, appended: none })), ['a']);
});

test('already appended on this board is never offered again', () => {
  const fetched = [item('a', 1), item('b', 2)];
  const live = [item('a', 1, { usedAt: null })];

  assert.deepEqual(ids(pageQueue({ pageId: 'p1', fetched, live, appended: new Set(['a']) })), ['b']);
});
