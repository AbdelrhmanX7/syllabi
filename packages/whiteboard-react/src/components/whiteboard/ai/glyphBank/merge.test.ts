import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GlyphBank, GlyphSample } from './types';

import {
  addSampleToBank,
  bankCoveredKeys,
  bankSampleCount,
  clearedBank,
  mergeGlyphBanks,
  removeGlyphFromBank,
  sameBankContent,
  sampleId,
} from './merge';
import { EMPTY_GLYPH_BANK } from './types';

const sample = (createdAt: number, x = 0): GlyphSample => ({
  strokes: [
    [
      [x, 0, 0.5],
      [x + 1, -1, 0.5],
    ],
  ],
  advance: 1,
  entry: [1, 0],
  exit: [0, 0],
  bbox: { x: 0, y: -1, w: 1, h: 1 },
  source: 'sheet',
  createdAt,
});

const bankOf = (version: number, entries: Array<[string, GlyphSample[]]>): GlyphBank => ({
  version,
  updatedAt: version,
  glyphs: Object.fromEntries(entries.map(([key, samples]) => [key, { key, samples }])),
});

test('sampleId is stable across a JSON round trip and differs per sample', () => {
  const a = sample(10);
  const b = sample(10, 2);

  assert.equal(sampleId(a), sampleId(JSON.parse(JSON.stringify(a)) as GlyphSample));
  assert.notEqual(sampleId(a), sampleId(b));
});

test('addSampleToBank bumps the version, keeps samples ordered and caps them at three', () => {
  let bank = EMPTY_GLYPH_BANK;

  for (const t of [30, 10, 20, 40]) bank = addSampleToBank(bank, 'digit:3', sample(t), { now: 100 });

  assert.equal(bank.version, 4);
  assert.equal(bank.updatedAt, 100);
  assert.deepEqual(
    bank.glyphs['digit:3'].samples.map((s) => s.createdAt),
    [20, 30, 40],
  );
  assert.equal(bankSampleCount(bank), 3);
  assert.deepEqual(Array.from(bankCoveredKeys(bank)), ['digit:3']);
});

test('removeGlyphFromBank drops the key; clearedBank is empty one version on', () => {
  const bank = addSampleToBank(EMPTY_GLYPH_BANK, 'ar-dot:1', sample(1));
  const removed = removeGlyphFromBank(bank, 'ar-dot:1', 5);

  assert.equal(removed.version, 2);
  assert.deepEqual(removed.glyphs, {});
  assert.equal(removeGlyphFromBank(removed, 'nope'), removed);
  const cleared = clearedBank(bankOf(7, [['a', [sample(1)]]]), 9);

  assert.deepEqual(cleared, { version: 8, updatedAt: 9, glyphs: {} });
});

test('mergeGlyphBanks without a base is a union, deduped by sample id', () => {
  const shared = sample(1);
  const local = bankOf(3, [
    ['lat:a', [shared, sample(2)]],
    ['digit:3', [sample(5)]],
  ]);
  const remote = bankOf(4, [
    ['lat:a', [shared, sample(3)]],
    ['ar-dot:1', [sample(6)]],
  ]);
  const merged = mergeGlyphBanks(local, remote);

  assert.deepEqual(Object.keys(merged.glyphs).sort(), ['ar-dot:1', 'digit:3', 'lat:a']);
  assert.deepEqual(
    merged.glyphs['lat:a'].samples.map((s) => s.createdAt),
    [1, 2, 3],
  );
  // Differs from the remote → one past the higher version.
  assert.equal(merged.version, 5);
  assert.equal(sameBankContent(merged, remote), false);
});

test('mergeGlyphBanks with a base keeps local deletions and remote additions', () => {
  const kept = sample(1);
  const deletedHere = sample(2);
  const addedThere = sample(3);
  const addedHere = sample(4);
  const base = bankOf(2, [['k', [kept, deletedHere]]]);
  const local = bankOf(3, [['k', [kept, addedHere]]]);
  const remote = bankOf(3, [['k', [kept, deletedHere, addedThere]]]);
  const merged = mergeGlyphBanks(local, remote, base);

  assert.deepEqual(
    merged.glyphs.k.samples.map((s) => s.createdAt),
    [1, 3, 4],
  );
});

test('mergeGlyphBanks: a local clear against a base wins over the server copy', () => {
  const base = bankOf(2, [['k', [sample(1), sample(2)]]]);
  const local = clearedBank(base, 50);
  const merged = mergeGlyphBanks(local, base, base);

  assert.deepEqual(merged.glyphs, {});
  assert.equal(merged.version, 4);
});

test('mergeGlyphBanks: identical content keeps the server version', () => {
  const remote = bankOf(9, [['k', [sample(1)]]]);
  const local = bankOf(2, [['k', [sample(1)]]]);
  const merged = mergeGlyphBanks(local, remote);

  assert.equal(merged.version, 9);
  assert.equal(sameBankContent(merged, remote), true);
});

test('mergeGlyphBanks caps a glyph at the three newest samples', () => {
  const local = bankOf(1, [['k', [sample(1), sample(2), sample(3)]]]);
  const remote = bankOf(1, [['k', [sample(4), sample(5)]]]);

  assert.deepEqual(
    mergeGlyphBanks(local, remote).glyphs.k.samples.map((s) => s.createdAt),
    [3, 4, 5],
  );
});
