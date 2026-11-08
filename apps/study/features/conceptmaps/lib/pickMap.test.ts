import type { ConceptMapRecord } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapsLinkedToPage, pickMapForPage, weekFromTitle } from './pickMap';

const map = (id: string, patch: Partial<ConceptMapRecord> = {}): ConceptMapRecord => ({
  id,
  classId: 'cls',
  number: null,
  week: null,
  lecture: null,
  dueAt: null,
  promptTerms: [],
  submission: null,
  instructor: null,
  score: null,
  maxScore: 10,
  scoreSource: null,
  canvasScore: null,
  manualScore: null,
  scoreNote: null,
  canvasItemId: null,
  source: 'canvas',
  ...patch,
});

const maps = [
  map('m3', { number: 3, week: 3, lecture: 'Lecture 3 — Minerals', score: 8 }),
  map('m4', { number: 4, week: 4, lecture: 'Lecture 4 — Rocks', score: 9 }),
  map('m5', { number: 5, week: 5, lecture: 'Lecture 5 — Plates' }),
  map('m6', { number: 6, week: 6, lecture: 'Lecture 6 — Volcanoes', score: 7 }),
  map('p1', { source: 'practice', week: 4 }),
];

test('weekFromTitle reads the common spellings', () => {
  assert.equal(weekFromTitle('Week 4 notes'), 4);
  assert.equal(weekFromTitle('GEOL wk 7'), 7);
  assert.equal(weekFromTitle('W05 — plates'), 5);
  assert.equal(weekFromTitle('Lecture notes 5/10'), null);
});

test('a map already linked to the page wins', () => {
  assert.deepEqual(pickMapForPage(maps, { pageId: 'pg', title: 'Week 4', linkedMapIds: ['m3'] }), { map: maps[0], reason: 'linked' });
});

test('then the page week (title or host-given), preferring the assigned map over practice', () => {
  assert.equal(pickMapForPage(maps, { pageId: 'pg', title: 'Week 4 notes' })?.map.id, 'm4');
  assert.equal(pickMapForPage(maps, { pageId: 'pg', title: 'Notes', week: 6 })?.map.id, 'm6');
});

test('then the lecture number', () => {
  const pick = pickMapForPage(maps, { pageId: 'pg', title: 'Lecture 3 notes' });

  assert.equal(pick?.map.id, 'm3');
  assert.equal(pick?.reason, 'lecture');
});

test('otherwise the newest map without a score', () => {
  const pick = pickMapForPage(maps, { pageId: 'pg', title: 'Untitled' });

  assert.equal(pick?.map.id, 'm5');
  assert.equal(pick?.reason, 'unscored');
});

test('all scored: the newest assigned map; nothing at all: null', () => {
  const scored = maps.map((row) => ({ ...row, score: row.score ?? 5 }));

  assert.equal(pickMapForPage(scored, { pageId: 'pg', title: 'Untitled' })?.map.id, 'm6');
  assert.equal(pickMapForPage([], { pageId: 'pg', title: 'Week 4' }), null);
});

test('mapsLinkedToPage trusts the server list when there is one, the device table otherwise', () => {
  const rows = [
    { ...maps[0]!, notesPageIds: ['pg'] },
    { ...maps[1]!, notesPageIds: [] },
    maps[2]!,
  ];
  const device = (id: string) => (id === 'm4' || id === 'm5' ? ['pg'] : []);

  assert.deepEqual(mapsLinkedToPage(rows, 'pg', device), ['m3', 'm5']);
});

test('the lecture-note record goes first: its map, then its week and lecture over the title', () => {
  assert.deepEqual(pickMapForPage(maps, { pageId: 'pg', title: 'Week 6', mapId: 'm3', linkedMapIds: ['m4'] }), { map: maps[0], reason: 'note' });
  assert.equal(pickMapForPage(maps, { pageId: 'pg', title: 'Week 6', week: 4 })?.map.id, 'm4');
  assert.equal(pickMapForPage(maps, { pageId: 'pg', title: 'Lecture 6', lecture: 3 })?.reason, 'lecture');
  assert.equal(pickMapForPage(maps, { pageId: 'pg', title: 'Lecture 6', lecture: 3 })?.map.id, 'm3');
  // An unknown map id (deleted) falls through to the rest of the order.
  assert.equal(pickMapForPage(maps, { pageId: 'pg', title: 'Week 4', mapId: 'gone' })?.map.id, 'm4');
});
