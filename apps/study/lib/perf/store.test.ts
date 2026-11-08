import type { PerfEvent } from './types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryPerfStore, PerfRingIndex, utf8Length } from './store';

const nav = (t: number, r = '/x'): PerfEvent => ({ k: 'nav', t, r });

test('ring evicts the oldest past the event cap and counts the drops', async () => {
  const store = new MemoryPerfStore({ maxEvents: 3, maxBytes: 1_000_000 });

  await store.append([nav(1), nav(2), nav(3), nav(4), nav(5)]);
  const left = (await store.all()).map((entry) => JSON.parse(entry.json).t);

  assert.deepEqual(left, [3, 4, 5]);
  assert.equal(store.stats().dropped, 2);
  assert.equal(store.takeDropped(), 2);
  assert.equal(store.stats().dropped, 0);
});

test('ring evicts by bytes too, but never its last event', async () => {
  const one = utf8Length(JSON.stringify(nav(1)));
  const store = new MemoryPerfStore({ maxEvents: 100, maxBytes: one * 2 });

  await store.append([nav(1), nav(2), nav(3)]);
  assert.equal(store.stats().count, 2);
  assert.ok(store.stats().bytes <= one * 2);

  const tiny = new MemoryPerfStore({ maxEvents: 100, maxBytes: 1 });

  await tiny.append([nav(9)]);
  assert.equal(tiny.stats().count, 1);
});

test('peek takes the oldest that fit, at least one, and remove deletes exactly those', async () => {
  const store = new MemoryPerfStore();

  await store.append([nav(1), nav(2), nav(3)]);
  const size = utf8Length(JSON.stringify(nav(1)));
  const head = await store.peek(size * 2);

  assert.deepEqual(
    head.map((entry) => JSON.parse(entry.json).t),
    [1, 2],
  );
  assert.equal((await store.peek(1)).length, 1);
  await store.remove(head.map((entry) => entry.id));
  assert.deepEqual(
    (await store.all()).map((entry) => JSON.parse(entry.json).t),
    [3],
  );
});

test('index load seeds ids so new ones never collide', () => {
  const index = new PerfRingIndex({ maxEvents: 10, maxBytes: 1000 });

  index.load([
    { id: 4, bytes: 10 },
    { id: 7, bytes: 10 },
  ]);
  assert.equal(index.add(5).id, 8);
  assert.equal(index.bytes, 25);
});

test('utf8Length counts accented Latin as 2 bytes and astral as 4', () => {
  assert.equal(utf8Length('ab'), 2);
  assert.equal(utf8Length('éèü'), 6);
  assert.equal(utf8Length('😀'), 4);
});
