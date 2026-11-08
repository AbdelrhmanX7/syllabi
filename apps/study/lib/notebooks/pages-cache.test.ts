import assert from 'node:assert/strict';
import test from 'node:test';

// pages-cache reads `window.localStorage` at call time, so the stand-in below is in place in time.
import { markSyncedVersionDirty, readDirtyPageIds, readSyncedVersion, writeSyncedVersion } from './pages-cache';

const store = new Map<string, string>();

(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
};


test('new ink is remembered as unsent before any upload runs (the app may close first)', () => {
  writeSyncedVersion('p1', 4, false);
  markSyncedVersionDirty('p1');
  assert.deepEqual({ ...readSyncedVersion('p1'), syncedAt: 0 }, { version: 4, syncedAt: 0, dirty: true });
  assert.deepEqual(readDirtyPageIds(), ['p1']);
});

test('a page with no synced record stays without one (the next open takes the server copy)', () => {
  markSyncedVersionDirty('never-synced');
  assert.equal(readSyncedVersion('never-synced'), null);
});

test('a successful upload clears the mark', () => {
  writeSyncedVersion('p1', 5, false);
  assert.equal(readSyncedVersion('p1')?.dirty, false);
});
