import type { Question } from '@/lib/api/types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EMPTY_FILTERS, applyFilters, matchesSearch, mergeQuestions, sourcesOf, topicsOf } from './filters';

const NOW = Date.parse('2026-10-04T12:00:00Z');

const q = (over: Partial<Question> & { id: string }): Question => ({
  classId: 'calc',
  topic: 'Limits',
  subtopic: null,
  difficulty: 2,
  source: { kind: 'manual', itemId: null, pageId: null, lectureId: null, ref: null },
  type: 'free',
  stem: 'Find $\\lim_{x\\to 0} \\frac{\\sin x}{x}$',
  imageUrl: null,
  answer: '1',
  solutionSteps: [],
  tags: [],
  stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
  srs: { dueAt: new Date(NOW + 86_400_000).toISOString(), stability: 1, difficulty: 5, reps: 0, lapses: 0 },
  createdAt: new Date(NOW).toISOString(),
  ...over,
});

const set: Question[] = [
  q({ id: 'a' }),
  q({
    id: 'b',
    topic: 'Derivatives',
    stats: { attempts: 2, correct: 1, lastResult: 'wrong', mastery: 0.3 },
    srs: { dueAt: new Date(NOW - 1000).toISOString(), stability: 1, difficulty: 5, reps: 2, lapses: 1 },
  }),
  q({
    id: 'c',
    classId: 'geo',
    topic: 'Minerals',
    source: { kind: 'canvas_quiz', itemId: 'i1', pageId: null, lectureId: null, ref: null },
    stem: 'Which mineral scratches glass?',
    choices: ['Quartz', 'Talc'],
    type: 'mcq',
    stats: { attempts: 1, correct: 1, lastResult: 'right', mastery: 0.8 },
  }),
  q({
    id: 'd',
    classId: 'cpp',
    topic: 'Classes',
    source: { kind: 'lecture', itemId: null, pageId: null, lectureId: 'l1', ref: null },
    stem: '```cpp\nclass A { virtual void f(); };\n```\nWhat is `f`?',
    tags: ['virtual'],
  }),
];

test('applyFilters by class / topic / source / due / result', () => {
  assert.deepEqual(
    applyFilters(set, { ...EMPTY_FILTERS, classId: 'calc' }, NOW).map((x) => x.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    applyFilters(set, { ...EMPTY_FILTERS, topic: 'Minerals' }, NOW).map((x) => x.id),
    ['c'],
  );
  assert.deepEqual(
    applyFilters(set, { ...EMPTY_FILTERS, source: 'lecture' }, NOW).map((x) => x.id),
    ['d'],
  );
  assert.deepEqual(
    applyFilters(set, { ...EMPTY_FILTERS, dueOnly: true }, NOW).map((x) => x.id),
    ['b'],
  );
  assert.deepEqual(
    applyFilters(set, { ...EMPTY_FILTERS, result: 'wrong' }, NOW).map((x) => x.id),
    ['b'],
  );
  assert.deepEqual(
    applyFilters(set, { ...EMPTY_FILTERS, result: 'unseen' }, NOW).map((x) => x.id),
    ['a', 'd'],
  );
  assert.deepEqual(applyFilters(set, { ...EMPTY_FILTERS, classId: 'calc', result: 'right' }, NOW), []);
});

test('search looks at stem, topic, choices and tags, case-insensitively', () => {
  assert.ok(matchesSearch(set[2]!, 'quartz'));
  assert.ok(matchesSearch(set[3]!, 'VIRTUAL'));
  assert.ok(matchesSearch(set[0]!, 'limits'));
  assert.ok(!matchesSearch(set[0]!, 'quartz'));
  assert.deepEqual(
    applyFilters(set, { ...EMPTY_FILTERS, q: '  sin x ' }, NOW).map((x) => x.id),
    ['a', 'b'],
  );
});

test('topicsOf orders by count then name; sourcesOf is distinct + sorted', () => {
  assert.deepEqual(topicsOf([...set, q({ id: 'e', topic: 'Minerals' })]), [
    { topic: 'Minerals', count: 2 },
    { topic: 'Classes', count: 1 },
    { topic: 'Derivatives', count: 1 },
    { topic: 'Limits', count: 1 },
  ]);
  assert.deepEqual(sourcesOf(set), ['canvas_quiz', 'lecture', 'manual']);
});

test('mergeQuestions replaces by id and prepends new ones', () => {
  const updated = q({ id: 'b', topic: 'Changed' });
  const fresh = q({ id: 'z' });
  const merged = mergeQuestions(set, [updated, fresh]);

  assert.deepEqual(
    merged.map((x) => x.id),
    ['z', 'a', 'b', 'c', 'd'],
  );
  assert.equal(merged.find((x) => x.id === 'b')?.topic, 'Changed');
});
