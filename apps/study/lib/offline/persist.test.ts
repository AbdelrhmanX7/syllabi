import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QueryClient } from '@tanstack/react-query';

import { createMemoryKv } from './idb-kv';
import {
  buildSnapshot,
  clearPersistedQueries,
  MAX_AGE_MS,
  PERSIST_KEY,
  restoreQueryCache,
  shouldPersistKey,
  type Snapshot,
  snapshotUsable,
  startPersisting,
  EXPIRED_AT,
  expireSignedUrls,
} from './persist';

const ctx = { buster: '1|v|https://api|auto', owner: 'u1' };

test('only allowlisted study queries are saved', () => {
  assert.equal(shouldPersistKey(['study', 'today']), true);
  assert.equal(shouldPersistKey(['study', 'classes', 'current']), true);
  assert.equal(shouldPersistKey(['study', 'items', 'c1', '', '']), true);
  assert.equal(shouldPersistKey(['study', 'questions', 'flashcards']), true);
  assert.equal(shouldPersistKey(['study', 'library', 'list', 'c1']), true);
  assert.equal(shouldPersistKey(['study', 'load', 'questions', null]), true);

  // AI, search, sync status, signed docs, version lists, other namespaces
  assert.equal(shouldPersistKey(['study', 'tutor', 'list', '']), false);
  assert.equal(shouldPersistKey(['study', 'search', 'x']), false);
  assert.equal(shouldPersistKey(['study', 'canvas']), false);
  assert.equal(shouldPersistKey(['study', 'transcript', 'i1']), false);
  assert.equal(shouldPersistKey(['study', 'library', 'doc', 'd1']), false);
  assert.equal(shouldPersistKey(['study', 'page-versions', 'p1']), false);
  assert.equal(shouldPersistKey(['auth', 'me', 'x']), false);
  assert.equal(shouldPersistKey(['share', 'with-me']), false);
  // a per-component useLoad (React id) is not stable across starts
  assert.equal(shouldPersistKey(['study', 'load', ':r1:', null]), false);
});

test('signed links are saved as expired, everything else kept', () => {
  const item = {
    id: 'i1',
    title: 'Week 1.pdf',
    file: { mime: 'application/pdf', size: 10, version: 1, url: 'https://b2/x?sig', expiresAt: '2099-01-01T00:00:00Z' },
    canvasUrl: 'https://canvas/x',
    nested: [{ audio: { url: 'https://b2/a', expiresAt: '2099-01-01T00:00:00Z', mime: 'audio/webm' } }],
    doc: { url: 'https://b2/d', urlExpiresAt: '2099-01-01T00:00:00Z' },
    note: { expiresAt: '2099-01-01T00:00:00Z' },
  };
  const out = expireSignedUrls(item);

  assert.equal(out.file.expiresAt, EXPIRED_AT);
  assert.ok(new Date(out.file.expiresAt).getTime() < Date.now());
  assert.equal(out.file.url, 'https://b2/x?sig');
  assert.equal(out.file.mime, 'application/pdf');
  assert.equal(out.canvasUrl, 'https://canvas/x');
  assert.equal(out.nested[0].audio.expiresAt, EXPIRED_AT);
  assert.equal(out.doc.urlExpiresAt, EXPIRED_AT);
  // an expiry with no link next to it is not a signed link
  assert.equal(out.note.expiresAt, '2099-01-01T00:00:00Z');
  // the original is untouched
  assert.equal(item.file.expiresAt, '2099-01-01T00:00:00Z');
});

test('snapshot keeps only saved kinds and newest first under the byte cap', () => {
  const client = new QueryClient();

  client.setQueryData(['study', 'today'], { a: 1 }, { updatedAt: 1000 });
  client.setQueryData(['study', 'classes', 'current'], [{ id: 'c1' }], { updatedAt: 3000 });
  client.setQueryData(['study', 'tutor', 'list', ''], [{ id: 't' }], { updatedAt: 4000 });
  client.setQueryData(['study', 'items', 'c1', '', ''], ['x'.repeat(2000)], { updatedAt: 2000 });

  const all = JSON.parse(buildSnapshot(client, ctx, 5000)) as Snapshot;

  assert.deepEqual(
    all.state.queries.map((query) => query.queryKey[1]),
    ['classes', 'items', 'today'],
  );
  assert.equal(all.owner, 'u1');

  const capped = JSON.parse(buildSnapshot(client, ctx, 5000, 1500)) as Snapshot;

  // the big items list does not fit; the small ones still do
  assert.deepEqual(
    capped.state.queries.map((query) => query.queryKey[1]),
    ['classes', 'today'],
  );
  client.clear();
});

test('snapshot usable only for the same build/server and not another account', () => {
  const base: Snapshot = { schema: 1, buster: ctx.buster, owner: 'u1', savedAt: 1000, state: { queries: [], mutations: [] } };

  assert.equal(snapshotUsable(base, ctx, 2000), true);
  assert.equal(snapshotUsable({ ...base, buster: 'other' }, ctx, 2000), false);
  assert.equal(snapshotUsable({ ...base, schema: 99 }, ctx, 2000), false);
  assert.equal(snapshotUsable(base, { ...ctx, owner: 'u2' }, 2000), false);
  // a copy saved with no account is never shown to an account, and the reverse
  assert.equal(snapshotUsable({ ...base, owner: null }, ctx, 2000), false);
  assert.equal(snapshotUsable(base, { ...ctx, owner: null }, 2000), false);
  // demo mode (no account on either side) keeps its copy
  assert.equal(snapshotUsable({ ...base, owner: null }, { ...ctx, owner: null }, 2000), true);
  assert.equal(snapshotUsable(base, ctx, 1000 + MAX_AGE_MS + 1), false);
  assert.equal(snapshotUsable(null, ctx, 2000), false);
});

test('round trip: persist, restore into a fresh client, bust on account switch, clear', async () => {
  const kv = createMemoryKv();
  const a = new QueryClient();
  const stop = startPersisting(a, () => ctx, kv, 5);

  a.setQueryData(['study', 'today'], { due: 3 });
  a.setQueryData(['study', 'search', 'q'], ['nope']);
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();

  const b = new QueryClient();

  assert.equal(await restoreQueryCache(b, ctx, kv), true);
  assert.deepEqual(b.getQueryData(['study', 'today']), { due: 3 });
  assert.equal(b.getQueryData(['study', 'search', 'q']), undefined);

  const other = new QueryClient();

  assert.equal(await restoreQueryCache(other, { ...ctx, owner: 'someone-else' }, kv), false);
  assert.equal(other.getQueryData(['study', 'today']), undefined);
  // the unusable copy was deleted
  assert.equal(await kv.get(PERSIST_KEY), undefined);

  await kv.set(PERSIST_KEY, buildSnapshot(b, ctx));
  await clearPersistedQueries(kv);
  assert.equal(await kv.get(PERSIST_KEY), undefined);
  [a, b, other].forEach((client) => client.clear());
});
