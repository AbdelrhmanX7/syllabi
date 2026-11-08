import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';

import type { GlyphBankRemote, GlyphBankRemoteSnapshot } from './store';
import type { GlyphBank, GlyphSample } from './types';

import { bankSampleCount, sampleId } from './merge';
import {
  createIndexedDbGlyphBankLocal,
  createMemoryGlyphBankLocal,
  GlyphBankConflictError,
  glyphBankRemoteFrom,
  GlyphBankStore,
  GlyphBankUnavailableError,
} from './store';
import { EMPTY_GLYPH_BANK } from './types';

const sample = (createdAt: number): GlyphSample => ({
  strokes: [
    [
      [0, 0, 0.5],
      [1, -1, 0.5],
    ],
  ],
  advance: 1,
  entry: [1, 0],
  exit: [0, 0],
  bbox: { x: 0, y: -1, w: 1, h: 1 },
  source: 'sheet',
  createdAt,
});

const ids = (bank: GlyphBank) =>
  Object.values(bank.glyphs)
    .flatMap((entry) => entry.samples.map(sampleId))
    .sort();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An in-memory server: version checked on PUT, a 409 hands back the current copy. */
function fakeServer(initial: GlyphBankRemoteSnapshot | null = null) {
  let current = initial;
  const log: string[] = [];
  /** Runs once right after the next GET answers — another device writing in the gap before our PUT. */
  let afterGet: (() => void) | null = null;
  const remote: GlyphBankRemote = {
    async getGlyphBank() {
      log.push('get');
      const snapshot = current;

      afterGet?.();
      afterGet = null;

      return snapshot;
    },
    async putGlyphBank(bank, version) {
      log.push(`put@${version}`);
      if ((current?.version ?? 0) !== version) throw new GlyphBankConflictError(current);
      current = { bank, version: version + 1 };

      return current;
    },
  };

  return {
    remote,
    log,
    get current() {
      return current;
    },
    /** Another device writes straight to the server. */
    write(bank: GlyphBank) {
      current = { bank, version: (current?.version ?? 0) + 1 };
    },
    raceNextGet(bank: GlyphBank) {
      afterGet = () => {
        current = { bank, version: (current?.version ?? 0) + 1 };
      };
    },
  };
}

test('IndexedDB adapter round-trips a record per user', async () => {
  const local = createIndexedDbGlyphBankLocal(fakeIndexedDB, `t-${Math.random()}`);

  assert.equal(await local.load('u1'), null);
  const bank: GlyphBank = { version: 1, updatedAt: 1, glyphs: { k: { key: 'k', samples: [sample(1)] } } };

  await local.save({ userId: 'u1', bank, synced: null });
  await local.save({ userId: 'u2', bank: EMPTY_GLYPH_BANK, synced: { bank: EMPTY_GLYPH_BANK, version: 4 } });
  assert.deepEqual(await local.load('u1'), { userId: 'u1', bank, synced: null });
  assert.equal((await local.load('u2'))?.synced?.version, 4);
  await local.remove('u1');
  assert.equal(await local.load('u1'), null);
  assert.notEqual(await local.load('u2'), null);
});

test('without a factory the adapter is the in-memory one', async () => {
  const local = createIndexedDbGlyphBankLocal(null);

  await local.save({ userId: 'u', bank: EMPTY_GLYPH_BANK, synced: null });
  assert.equal((await local.load('u'))?.userId, 'u');
});

test('store: accepted samples persist locally and survive a reload', async () => {
  const local = createIndexedDbGlyphBankLocal(fakeIndexedDB, `t-${Math.random()}`);
  const store = new GlyphBankStore({ userId: 'u', local, remote: null });

  await store.load();
  assert.equal(store.getState().status, 'ready');
  await store.addSample('digit:3', sample(1));
  await store.addSample('digit:3', sample(2));
  await store.addSample('ar-dot:1', sample(3));
  assert.equal(bankSampleCount(store.getState().bank), 3);
  assert.equal(store.getState().bank.version, 3);
  store.dispose();

  const again = new GlyphBankStore({ userId: 'u', local, remote: null });

  await again.load();
  assert.equal(bankSampleCount(again.getState().bank), 3);
  assert.equal(again.getState().remote, 'idle');
  // Another user's store starts empty.
  const other = new GlyphBankStore({ userId: 'v', local, remote: null });

  await other.load();
  assert.equal(bankSampleCount(other.getState().bank), 0);
});

test('store: load pulls the server bank and merges it with the device copy', async () => {
  const local = createMemoryGlyphBankLocal();
  const server = fakeServer({
    bank: { version: 2, updatedAt: 2, glyphs: { a: { key: 'a', samples: [sample(1)] } } },
    version: 2,
  });

  await local.save({
    userId: 'u',
    bank: { version: 1, updatedAt: 1, glyphs: { b: { key: 'b', samples: [sample(2)] } } },
    synced: null,
  });
  const store = new GlyphBankStore({ userId: 'u', local, remote: server.remote, pushDebounceMs: 1 });

  await store.load();
  await store.sync();
  assert.equal(store.getState().remote, 'synced');
  assert.deepEqual(Object.keys(store.getState().bank.glyphs).sort(), ['a', 'b']);
  assert.deepEqual(server.log, ['get', 'put@2']);
  assert.equal(server.current?.version, 3);
  assert.deepEqual(ids(server.current!.bank), ids(store.getState().bank));
  assert.equal(store.getState().bank.version, 3);
  // The saved record carries the new base.
  assert.equal((await local.load('u'))?.synced?.version, 3);
  store.dispose();
});

test('store: a write is pushed after the debounce with the server version', async () => {
  const local = createMemoryGlyphBankLocal();
  const server = fakeServer();
  const store = new GlyphBankStore({ userId: 'u', local, remote: server.remote, pushDebounceMs: 5 });

  await store.load();
  await store.sync();
  // Nothing local, no bank on the server: no PUT to create an empty one.
  assert.deepEqual(server.log, ['get']);
  await store.addSample('k', sample(1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(server.current?.version, 1);
  assert.deepEqual(ids(server.current!.bank), ids(store.getState().bank));
  assert.equal(store.getState().remote, 'synced');
  store.dispose();
});

test('store: a conflict re-fetches, re-merges the samples and retries', async () => {
  const local = createMemoryGlyphBankLocal();
  const server = fakeServer({ bank: EMPTY_GLYPH_BANK, version: 1 });
  const store = new GlyphBankStore({ userId: 'u', local, remote: server.remote, pushDebounceMs: 1 });

  await store.load();
  await store.sync();
  await store.addSample('k', sample(10));
  // Between our pull and our PUT another device adds a sample: the server is at version 2 when we PUT @1.
  server.raceNextGet({ version: 2, updatedAt: 2, glyphs: { k: { key: 'k', samples: [sample(20)] } } });
  await store.flush();
  assert.equal(store.getState().remote, 'synced');
  assert.deepEqual(server.log, ['get', 'get', 'put@1', 'put@2']);
  assert.deepEqual(
    server.current!.bank.glyphs.k.samples.map((s) => s.createdAt),
    [10, 20],
  );
  assert.deepEqual(ids(store.getState().bank), ids(server.current!.bank));
  store.dispose();
});

test('store: a clear deletes on the server too (three-way merge against the synced base)', async () => {
  const local = createMemoryGlyphBankLocal();
  const server = fakeServer({
    bank: { version: 3, updatedAt: 3, glyphs: { k: { key: 'k', samples: [sample(1)] } } },
    version: 3,
  });
  const store = new GlyphBankStore({ userId: 'u', local, remote: server.remote, pushDebounceMs: 1 });

  await store.load();
  await store.sync();
  assert.equal(bankSampleCount(store.getState().bank), 1);
  await store.clear();
  await store.flush();
  assert.equal(bankSampleCount(store.getState().bank), 0);
  assert.equal(bankSampleCount(server.current!.bank), 0);
  assert.equal(server.current!.version, 4);
  store.dispose();
});

test('store: an unavailable route flips to local-only and stops pushing', async () => {
  const local = createMemoryGlyphBankLocal();
  let calls = 0;
  const remote: GlyphBankRemote = {
    async getGlyphBank() {
      calls += 1;
      throw new GlyphBankUnavailableError();
    },
    async putGlyphBank() {
      calls += 1;
      throw new GlyphBankUnavailableError();
    },
  };
  const store = new GlyphBankStore({ userId: 'u', local, remote, pushDebounceMs: 1 });

  await store.load();
  await store.sync();
  assert.equal(store.getState().remote, 'local-only');
  await store.addSample('k', sample(1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  assert.equal(bankSampleCount((await local.load('u'))!.bank), 1);
  store.dispose();
});

test('store: a network failure is reported and retried on the next write', async () => {
  const local = createMemoryGlyphBankLocal();
  let fail = true;
  const server = fakeServer();
  const remote: GlyphBankRemote = {
    getGlyphBank: () => (fail ? Promise.reject(new Error('offline')) : server.remote.getGlyphBank()),
    putGlyphBank: (bank, version) => server.remote.putGlyphBank(bank, version),
  };
  const store = new GlyphBankStore({ userId: 'u', local, remote, pushDebounceMs: 1 });

  await store.load();
  await store.sync();
  assert.equal(store.getState().remote, 'error');
  assert.equal(store.getState().error, 'offline');
  fail = false;
  await store.addSample('k', sample(1));
  await store.flush();
  assert.equal(store.getState().remote, 'synced');
  assert.equal(store.getState().error, null);
  assert.equal(server.current?.version, 1);
  store.dispose();
});

test('store: subscribers see every state change', async () => {
  const store = new GlyphBankStore({ userId: 'u', local: createMemoryGlyphBankLocal() });
  let seen = 0;
  const unsubscribe = store.subscribe(() => {
    seen += 1;
  });

  await store.load();
  await store.addSample('k', sample(1));
  await tick();
  assert.ok(seen >= 2);
  unsubscribe();
  await store.addSample('k', sample(2));
  const after = seen;

  await tick();
  assert.equal(seen, after);
  store.dispose();
});

test('glyphBankRemoteFrom needs both methods', () => {
  assert.equal(glyphBankRemoteFrom(null), null);
  assert.equal(glyphBankRemoteFrom({ getGlyphBank: async () => null }), null);
  const remote = glyphBankRemoteFrom({
    getGlyphBank: async () => null,
    putGlyphBank: async (bank, version) => ({ bank, version: version + 1 }),
  });

  assert.ok(remote);
});
