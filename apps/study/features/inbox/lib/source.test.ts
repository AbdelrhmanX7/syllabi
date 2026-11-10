import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSaved, usableDropLink } from './dropLink';
import { inboxSource, sourcesPresent } from './source';

test('known sources map to themselves', () => {
  for (const source of ['phone', 'claude', 'codex', 'shared', 'upload', 'other'])
    assert.equal(inboxSource({ source }), source);
  assert.equal(inboxSource({ source: ' Claude ' }), 'claude');
});

test('missing or unknown source is Other', () => {
  assert.equal(inboxSource({}), 'other');
  assert.equal(inboxSource({ source: null }), 'other');
  assert.equal(inboxSource({ source: '' }), 'other');
  assert.equal(inboxSource({ source: 'zapier' }), 'other');
});

test('free-text sources from another server are recognised', () => {
  assert.equal(inboxSource({ source: 'Claude Desktop' }), 'claude');
  assert.equal(inboxSource({ source: 'openai-codex' }), 'codex');
  assert.equal(inboxSource({ source: 'drop_token' }), 'phone');
  assert.equal(inboxSource({ source: 'share-target' }), 'shared');
});

test('sourcesPresent keeps the fixed order', () => {
  assert.deepEqual(sourcesPresent([{ source: 'claude' }, {}, { source: 'phone' }, { source: 'claude' }]), [
    'phone',
    'claude',
    'other',
  ]);
});

test('drop link: parse and scope', () => {
  const saved = parseSaved(
    JSON.stringify({ scope: 'mock', id: 't1', label: 'Board code', token: 'sk_drop_x', savedAt: 1000 }),
  );

  assert.ok(saved);
  // A list fetched before the code was made does not know it yet.
  assert.equal(usableDropLink(saved, 'mock', ['t2'], 500), saved);
  assert.equal(parseSaved('nope'), null);
  assert.equal(parseSaved(JSON.stringify({ scope: 'mock', id: 't1' })), null);
  assert.equal(usableDropLink(saved, 'https://api.example', null), null);
  assert.equal(usableDropLink(saved, 'mock', null), saved);
  assert.equal(usableDropLink(saved, 'mock', ['t1', 't2']), saved);
  assert.equal(usableDropLink(saved, 'mock', ['t2']), null);
});
