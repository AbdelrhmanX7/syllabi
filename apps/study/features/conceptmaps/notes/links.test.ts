import type { KeyValueStore, NoteLink } from './links';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addLink, LINKS_KEY, linkKey, pageIdsOf, readLinks, removeLink, resolveLinks, writeLinks } from './links';

function memoryStore(seed: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...seed };

  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const pageA: NoteLink = { kind: 'page', pageId: 'p1', title: 'Lecture 4 notes' };
const pageB: NoteLink = { kind: 'page', pageId: 'p2', title: 'Slides', libraryId: 'lib9' };
const typed: NoteLink = { kind: 'library', libraryId: 'lib3', title: 'Week 4 summary' };

test('read/write round trip per map; empty list deletes the entry', () => {
  const store = memoryStore();

  assert.equal(writeLinks(store, 'm1', [pageA, typed]), true);
  writeLinks(store, 'm2', [pageB]);
  assert.deepEqual(readLinks(store, 'm1'), [pageA, typed]);
  assert.deepEqual(readLinks(store, 'm2'), [pageB]);
  writeLinks(store, 'm1', []);
  assert.deepEqual(readLinks(store, 'm1'), []);
  assert.equal('m1' in JSON.parse(store.data[LINKS_KEY]!), false);
});

test('corrupt or foreign storage reads as empty, malformed rows are dropped', () => {
  assert.deepEqual(readLinks(memoryStore({ [LINKS_KEY]: '{not json' }), 'm1'), []);
  assert.deepEqual(readLinks(memoryStore({ [LINKS_KEY]: '[1,2]' }), 'm1'), []);
  const store = memoryStore({
    [LINKS_KEY]: JSON.stringify({ m1: [pageA, { kind: 'page', title: 'no id' }, { kind: 'x' }, null] }),
  });

  assert.deepEqual(readLinks(store, 'm1'), [pageA]);
  assert.deepEqual(readLinks(null, 'm1'), []);
});

test('a store that throws never throws out of write', () => {
  const store: KeyValueStore = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceeded');
    },
  };

  assert.equal(writeLinks(store, 'm1', [pageA]), false);
  assert.equal(writeLinks(null, 'm1', [pageA]), false);
});

test('addLink dedupes by kind+id and refreshes the title in place', () => {
  const once = addLink(addLink([], pageA), typed);
  const again = addLink(once, { ...pageA, title: 'Renamed' });

  assert.equal(again.length, 2);
  assert.equal(again[0]!.title, 'Renamed');
  assert.deepEqual(removeLink(again, linkKey(typed)), [{ ...pageA, title: 'Renamed' }]);
  assert.deepEqual(pageIdsOf([pageA, typed, pageB]), ['p1', 'p2']);
});

test('resolveLinks: no backend field → device links', () => {
  const resolved = resolveLinks({}, [pageA, typed]);

  assert.equal(resolved.source, 'device');
  assert.deepEqual(resolved.links, [pageA, typed]);
  assert.deepEqual(resolved.toMigrate, []);
});

test('resolveLinks: backend field wins, device rows give titles, device-only pages migrate once', () => {
  const resolved = resolveLinks({ notesPageIds: ['p2', 'p7'] }, [pageA, pageB, typed]);

  assert.equal(resolved.source, 'server');
  assert.deepEqual(
    resolved.links.map((row) => linkKey(row)),
    ['page:p2', 'page:p7', 'page:p1', 'library:lib3'],
  );
  assert.equal(resolved.links[0]!.title, 'Slides');
  assert.equal(resolved.links[1]!.title, 'Lecture notes');
  assert.deepEqual(resolved.toMigrate, ['p1']);
});

test('resolveLinks: an empty backend list still means server mode', () => {
  const resolved = resolveLinks({ notesPageIds: [] }, []);

  assert.equal(resolved.source, 'server');
  assert.deepEqual(resolved.links, []);
});
