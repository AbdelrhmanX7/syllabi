import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQuickColorRing,
  dedupeColors,
  parseRecentColors,
  pushRecentColor,
  readRecentColors,
  RECENT_COLORS_CAP,
  RECENT_COLORS_STORAGE_KEY,
  writeRecentColors,
} from './recentColors';

const PALETTE = ['#000000', '#EF4444', '#F97316', '#EAB308', '#22C55E', '#3B82F6'];

test('dedupe is case-insensitive, keeps the first spelling and drops blanks', () => {
  assert.deepEqual(dedupeColors(['#ff0000', '#FF0000', '', '  ', '#00ff00', '#00FF00 ']), ['#ff0000', '#00ff00']);
});

test('push moves a colour to the front (case-insensitive) and caps the list', () => {
  assert.deepEqual(pushRecentColor(['#AAAAAA', '#BBBBBB'], '#bbbbbb'), ['#bbbbbb', '#AAAAAA']);
  const long = Array.from({ length: 20 }, (_, index) => `#0000${index.toString(16).padStart(2, '0')}`);
  const pushed = pushRecentColor(long, '#123456');
  assert.equal(pushed.length, RECENT_COLORS_CAP);
  assert.equal(pushed[0], '#123456');
  assert.deepEqual(pushRecentColor(['#AAAAAA'], ''), ['#AAAAAA']);
});

test('no recents → the default palette, in order', () => {
  assert.deepEqual(buildQuickColorRing([], PALETTE, '#000000'), PALETTE);
});

test('recents come first, then the palette fills the rest without duplicates', () => {
  assert.deepEqual(buildQuickColorRing(['#8B5CF6', '#ef4444'], PALETTE, '#8B5CF6'), [
    '#8B5CF6',
    '#ef4444',
    '#000000',
    '#F97316',
    '#EAB308',
    '#22C55E',
  ]);
});

test('always exactly 6 slots, even with more recents than slots', () => {
  const recents = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777', '#888888'];
  assert.deepEqual(buildQuickColorRing(recents, PALETTE, '#111111'), recents.slice(0, 6));
});

test('the active colour is always on the ring — it replaces the last slot when it did not make the cut', () => {
  const recents = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777'];
  const ring = buildQuickColorRing(recents, PALETTE, '#ABCDEF');
  assert.equal(ring.length, 6);
  assert.deepEqual(ring, ['#111111', '#222222', '#333333', '#444444', '#555555', '#ABCDEF']);
  // already on it (different case) → untouched
  assert.deepEqual(buildQuickColorRing([], PALETTE, '#ef4444'), PALETTE);
});

test('a short pool still includes the active colour', () => {
  assert.deepEqual(buildQuickColorRing([], ['#000000'], '#FFFFFF'), ['#000000', '#FFFFFF']);
});

test('stored list round-trips; malformed values read as empty', () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, v: string) => store.set(key, v) },
  });

  writeRecentColors(['#AAAAAA', '#BBBBBB']);
  assert.equal(store.get(RECENT_COLORS_STORAGE_KEY), '["#AAAAAA","#BBBBBB"]');
  assert.deepEqual(readRecentColors(), ['#AAAAAA', '#BBBBBB']);
  for (const raw of [null, '', 'nope', '{}', '"#fff"']) assert.deepEqual(parseRecentColors(raw), [], String(raw));
  assert.deepEqual(parseRecentColors('["#aaa", 5, null, "#AAA", "#bbb"]'), ['#aaa', '#bbb']);
});

test('blocked storage never throws', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError');
    },
  });

  assert.deepEqual(readRecentColors(), []);
  assert.doesNotThrow(() => writeRecentColors(['#AAAAAA']));
});
