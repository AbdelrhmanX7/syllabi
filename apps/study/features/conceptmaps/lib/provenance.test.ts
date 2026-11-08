import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chipText, groupSources, hasProvenance, modelLabel, parseProvenance, parseSources } from './provenance';

test('parseSources keeps prompt order, drops unknown kinds and junk, keeps itemId only when set', () => {
  const sources = parseSources([
    { kind: 'model_answer', title: 'CM 9 answer', itemId: 'i1' },
    { kind: 'notes', title: 'Week 4 notes' },
    { kind: 'bogus', title: 'x' },
    null,
    'textbook',
    { kind: 'textbook', title: '', itemId: '' },
  ]);

  assert.deepEqual(sources, [
    { kind: 'model_answer', title: 'CM 9 answer', itemId: 'i1' },
    { kind: 'notes', title: 'Week 4 notes' },
    { kind: 'textbook', title: 'Textbook' },
  ]);
  assert.deepEqual(parseSources(undefined), []);
});

test('parseProvenance tolerates old payloads without model / sources', () => {
  assert.deepEqual(parseProvenance({ attemptId: 'a1' }), { model: null, sources: [] });
  assert.deepEqual(parseProvenance(null), { model: null, sources: [] });
  assert.equal(hasProvenance(parseProvenance({})), false);
  assert.equal(hasProvenance(parseProvenance({ model: 'deepseek-chat' })), true);
});

test('modelLabel: GPT-6.1 for gpt-6.1-sol, DeepSeek fallback otherwise', () => {
  assert.equal(modelLabel('openrouter/openai/gpt-6.1-sol'), 'GPT-6.1');
  assert.equal(modelLabel('deepseek/deepseek-v4'), 'DeepSeek (fallback)');
  assert.equal(modelLabel(null), null);
  assert.equal(modelLabel(''), null);
});

test('groupSources: one chip per kind in first-seen order with counts', () => {
  const sources = parseSources([
    { kind: 'model_answer', title: 'Answer' },
    { kind: 'notes', title: 'N1' },
    { kind: 'page', title: 'R1', itemId: 'p1' },
    { kind: 'notes', title: 'N2' },
    { kind: 'textbook', title: 'Ch 3' },
    { kind: 'page', title: 'R2' },
    { kind: 'past_maps', title: 'CM 1' },
  ]);
  const groups = groupSources(sources);

  assert.deepEqual(groups.map(chipText), ['Model answer', 'Lecture notes 2', 'Readings 2', 'Textbook 1', 'Past maps 1']);
  assert.deepEqual(
    groups[2]!.items.map((item) => item.itemId ?? null),
    ['p1', null],
  );
});
