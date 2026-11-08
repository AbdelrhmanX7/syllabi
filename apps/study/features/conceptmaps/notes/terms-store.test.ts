import type { KeyValueStore } from './links';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  pendingTerms,
  readLocalTerms,
  TERMS_KEY,
  termsFromReply,
  withLocalTerms,
  writeLocalTerms,
} from './terms-store';

function memoryStore(): KeyValueStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};

  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

test('local terms round trip; empty clears; junk is dropped', () => {
  const store = memoryStore();

  writeLocalTerms(store, 'm10', ['Fault', 'Epicenter']);
  assert.deepEqual(readLocalTerms(store, 'm10'), ['Fault', 'Epicenter']);
  writeLocalTerms(store, 'm10', []);
  assert.deepEqual(readLocalTerms(store, 'm10'), []);
  store.data[TERMS_KEY] = JSON.stringify({ m11: ['Lava', 3, '  ', null], m12: 'x' });
  assert.deepEqual(readLocalTerms(store, 'm11'), ['Lava']);
  assert.deepEqual(readLocalTerms(store, 'm12'), []);
  store.data[TERMS_KEY] = '{oops';
  assert.deepEqual(readLocalTerms(store, 'm11'), []);
});

test('withLocalTerms fills only a map without terms; pendingTerms is the retry list', () => {
  const store = memoryStore();

  writeLocalTerms(store, 'm10', ['Fault']);
  writeLocalTerms(store, 'm5', ['Ignored']);
  const empty = { id: 'm10', promptTerms: [] as string[], lecture: 'L10' };
  const full = { id: 'm5', promptTerms: ['Subduction'] };

  assert.deepEqual(withLocalTerms(empty, store), { ...empty, promptTerms: ['Fault'] });
  assert.equal(withLocalTerms(full, store), full);
  assert.deepEqual(pendingTerms(empty, store), ['Fault']);
  assert.deepEqual(pendingTerms(full, store), []);
  assert.equal(withLocalTerms({ id: 'm99', promptTerms: [] }, null).promptTerms.length, 0);
});

test('termsFromReply: comma line, bullets, numbering, lead-in, «and»', () => {
  assert.deepEqual(termsFromReply('Fault, Epicenter, Seismic wave, Richter scale'), [
    'Fault',
    'Epicenter',
    'Seismic wave',
    'Richter scale',
  ]);
  assert.deepEqual(termsFromReply('Here are the terms on the slide:\n- **Lithosphere**\n- Asthenosphere\n2) Mantle.'), [
    'Lithosphere',
    'Asthenosphere',
    'Mantle',
  ]);
  assert.deepEqual(termsFromReply('Continental drift, Pangaea and Seafloor spreading'), [
    'Continental drift',
    'Pangaea',
    'Seafloor spreading',
  ]);
  assert.deepEqual(termsFromReply(''), []);
});
