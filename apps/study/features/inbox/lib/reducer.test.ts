import type { InboxItem } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boardCandidates,
  INBOX_LIMIT,
  inboxReducer,
  initialInboxState,
  latestCreatedAt,
  newArrivals,
  unreadCount,
} from './reducer';

const item = (id: string, minute: number, extra: Partial<InboxItem> = {}): InboxItem => ({
  id,
  kind: 'image',
  url: `https://b2/${id}.jpg`,
  thumbUrl: null,
  width: 100,
  height: 100,
  bytes: 1,
  note: null,
  createdAt: new Date(Date.UTC(2026, 9, 5, 10, minute)).toISOString(),
  ...extra,
});

test('loaded: newest first; arrived: merged and de-duplicated', () => {
  let state = inboxReducer(initialInboxState(), { type: 'loaded', items: [item('a', 1), item('b', 3)] });

  assert.deepEqual(
    state.items.map((i) => i.id),
    ['b', 'a'],
  );
  assert.ok(state.loaded);
  state = inboxReducer(state, { type: 'arrived', items: [item('c', 5), item('b', 3, { note: 'x' })] });
  assert.deepEqual(
    state.items.map((i) => i.id),
    ['c', 'b', 'a'],
  );
  assert.equal(state.items[1].note, 'x');
});

test('arrived with nothing is a no-op (same object)', () => {
  const state = initialInboxState();

  assert.equal(inboxReducer(state, { type: 'arrived', items: [] }), state);
});

test('capped at the backend limit', () => {
  const many = Array.from({ length: INBOX_LIMIT + 7 }, (_, i) => item(`i${i}`, i));
  const state = inboxReducer(initialInboxState(), { type: 'arrived', items: many });

  assert.equal(state.items.length, INBOX_LIMIT);
  assert.equal(state.items[0].id, `i${INBOX_LIMIT + 6}`);
});

test('removed, used; a reload keeps a local usedAt the server has not seen yet', () => {
  let state = inboxReducer(initialInboxState(), { type: 'loaded', items: [item('a', 1), item('b', 2)] });

  state = inboxReducer(state, { type: 'used', id: 'a', usedAt: '2026-10-05T11:00:00.000Z' });
  state = inboxReducer(state, { type: 'removed', id: 'b' });
  assert.deepEqual(
    state.items.map((i) => [i.id, i.usedAt]),
    [['a', '2026-10-05T11:00:00.000Z']],
  );
  state = inboxReducer(state, { type: 'loaded', items: [item('a', 1)] });
  assert.equal(state.items[0].usedAt, '2026-10-05T11:00:00.000Z');
});

test('unread: unused items newer than seenAt; seen only moves forward', () => {
  let state = inboxReducer(initialInboxState(item('x', 2).createdAt), {
    type: 'loaded',
    items: [item('a', 1), item('b', 3), item('c', 4, { usedAt: 'y' })],
  });

  assert.equal(unreadCount(state), 1);
  state = inboxReducer(state, { type: 'seen', at: item('x', 9).createdAt });
  assert.equal(unreadCount(state), 0);
  const back = inboxReducer(state, { type: 'seen', at: item('x', 1).createdAt });

  assert.equal(back, state);
  assert.equal(unreadCount(inboxReducer(initialInboxState(null), { type: 'arrived', items: [item('a', 1)] })), 1);
});

test('reset keeps the seen mark', () => {
  const state = inboxReducer(initialInboxState('2026-01-01T00:00:00.000Z'), { type: 'arrived', items: [item('a', 1)] });
  const reset = inboxReducer(state, { type: 'reset' });

  assert.equal(reset.items.length, 0);
  assert.equal(reset.seenAt, '2026-01-01T00:00:00.000Z');
});

test('newArrivals, latestCreatedAt, boardCandidates', () => {
  assert.deepEqual(
    newArrivals([item('a', 1)], [item('a', 1), item('b', 2)]).map((i) => i.id),
    ['b'],
  );
  assert.equal(latestCreatedAt([item('a', 1), item('b', 7), item('c', 3)]), item('b', 7).createdAt);
  assert.equal(latestCreatedAt([]), null);
  const list = [item('used', 9, { usedAt: 'x' }), item('pdf', 8, { kind: 'pdf' }), item('old', 1), item('new', 5)];

  assert.deepEqual(
    boardCandidates(list).map((i) => i.id),
    ['new', 'old', 'used'],
  );
  assert.deepEqual(
    boardCandidates(list, { pdfs: true }).map((i) => i.id),
    ['pdf', 'new', 'old', 'used'],
  );
});

test('loaded: a server usedAt:null wins over a local usedAt when the item is queued for a page', () => {
  let state = inboxReducer(initialInboxState(), {
    type: 'loaded',
    items: [item('q', 1, { pageId: 'p1' }), item('plain', 2)],
  });

  state = inboxReducer(state, { type: 'used', id: 'q', usedAt: '2026-10-05T11:00:00.000Z' });
  state = inboxReducer(state, { type: 'used', id: 'plain', usedAt: '2026-10-05T11:00:00.000Z' });
  // Claude re-queued `q` (add_inbox_to_page clears usedAt); `plain`'s PATCH has not landed yet.
  state = inboxReducer(state, {
    type: 'loaded',
    items: [item('q', 1, { pageId: 'p1', usedAt: null }), item('plain', 2, { usedAt: null })],
  });
  const byId = Object.fromEntries(state.items.map((i) => [i.id, i.usedAt]));

  assert.equal(byId.q, null);
  assert.equal(byId.plain, '2026-10-05T11:00:00.000Z');
});

test('arrived: a re-queue frame clears a local usedAt, even when it leaves usedAt out', () => {
  let state = inboxReducer(initialInboxState(), {
    type: 'loaded',
    items: [item('a', 1, { pageId: 'p1' }), item('b', 2, { pageId: 'p1' }), item('c', 3)],
  });

  for (const id of ['a', 'b', 'c'])
    state = inboxReducer(state, { type: 'used', id, usedAt: '2026-10-05T11:00:00.000Z' });
  // SSE frames that leave the usedAt key out (the `item` helper never sets it).
  const frameA = item('a', 1, { pageId: 'p1' });
  const frameC = item('c', 3, { note: 'edited' });

  assert.ok(!('usedAt' in frameA) && !('usedAt' in frameC));

  state = inboxReducer(state, {
    type: 'arrived',
    items: [frameA, item('b', 2, { pageId: 'p1', usedAt: null }), frameC],
  });
  const byId = Object.fromEntries(state.items.map((i) => [i.id, i.usedAt]));

  assert.equal(byId.a, null);
  assert.equal(byId.b, null);
  // No pageId: a frame without usedAt says nothing about it — the local mark stays.
  assert.equal(byId.c, '2026-10-05T11:00:00.000Z');
});
