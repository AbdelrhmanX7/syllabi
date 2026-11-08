import type { ConceptMapRecord } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateCriteria,
  applyOverviewFilter,
  averageScore,
  formatScore,
  gradedScores,
  groupByWeek,
  isValidHerScore,
  scoreSourceLabel,
  scoreTone,
  scoreTrend,
} from './score';

const map = (over: Partial<ConceptMapRecord> & { id: string; number: number }): ConceptMapRecord => ({
  classId: 'geo',
  week: 1,
  lecture: 'L',
  dueAt: null,
  promptTerms: ['a', 'b'],
  submission: null,
  instructor: null,
  score: null,
  maxScore: 10,
  scoreSource: null,
  canvasScore: null,
  manualScore: null,
  scoreNote: null,
  canvasItemId: null,
  source: 'import',
  ...over,
});

test('aggregateCriteria sums with one decimal', () => {
  const sum = aggregateCriteria([
    { name: 'a', score: 1.5, max: 2, note: '' },
    { name: 'b', score: 2, max: 2, note: '' },
    { name: 'c', score: 0.1, max: 2, note: '' },
  ]);

  assert.deepEqual(sum, { score: 3.6, max: 6 });
  assert.deepEqual(aggregateCriteria([]), { score: 0, max: 0 });
});

test('scoreTone thresholds', () => {
  assert.equal(scoreTone(null), 'neutral');
  assert.equal(scoreTone(8.5), 'ok');
  assert.equal(scoreTone(7), 'warn');
  assert.equal(scoreTone(6), 'danger');
  assert.equal(scoreTone(17, 20), 'ok');
});

test('formatScore', () => {
  assert.equal(formatScore(null), '— / 10');
  assert.equal(formatScore(8), '8 / 10');
  assert.equal(formatScore(8.5), '8.5 / 10');
});

test('averageScore normalises to /10 and ignores ungraded', () => {
  assert.equal(averageScore([]), null);
  assert.equal(averageScore([{ score: null, maxScore: 10 }]), null);
  assert.equal(
    averageScore([
      { score: 8, maxScore: 10 },
      { score: 18, maxScore: 20 },
      { score: null, maxScore: 10 },
    ]),
    8.5,
  );
});

test('scoreTrend compares later half with earlier half', () => {
  assert.equal(scoreTrend([]), 0);
  assert.equal(scoreTrend([8]), 0);
  assert.equal(scoreTrend([6, 7, 8, 9]), 1);
  assert.equal(scoreTrend([9, 9, 7, 6]), -1);
  assert.equal(scoreTrend([8, 8.1, 8, 8.2]), 0);
  assert.equal(scoreTrend([6, 9, 8]), 1);
});

test('gradedScores: chronological, graded, non-practice only', () => {
  const scores = gradedScores([
    map({ id: 'b', number: 2, score: 9 }),
    map({ id: 'a', number: 1, score: 7 }),
    map({ id: 'p', number: 101, score: 10, source: 'practice' }),
    map({ id: 'c', number: 3, score: null }),
  ]);

  assert.deepEqual(scores, [7, 9]);
});

test('groupByWeek orders weeks and numbers', () => {
  const groups = groupByWeek([
    map({ id: 'c', number: 3, week: 2 }),
    map({ id: 'b', number: 2, week: 1 }),
    map({ id: 'a', number: 1, week: 1 }),
  ]);

  assert.deepEqual(
    groups.map((group) => [group.week, group.maps.map((item) => item.number)]),
    [
      [1, [1, 2]],
      [2, [3]],
    ],
  );
});

test('applyOverviewFilter', () => {
  const maps = [
    map({ id: 'a', number: 1, examReview: true, score: 8 }),
    map({ id: 'b', number: 2, score: null }),
    map({ id: 'p', number: 101, source: 'practice' }),
  ];

  assert.deepEqual(
    applyOverviewFilter(maps, 'all').map((m) => m.id),
    ['a', 'b', 'p'],
  );
  assert.deepEqual(
    applyOverviewFilter(maps, 'exam').map((m) => m.id),
    ['a'],
  );
  assert.deepEqual(
    applyOverviewFilter(maps, 'ungraded').map((m) => m.id),
    ['b'],
  );
  assert.deepEqual(
    applyOverviewFilter(maps, 'practice').map((m) => m.id),
    ['p'],
  );
});

test('isValidHerScore: 0–max in steps of 0.5 (the PATCH contract)', () => {
  assert.equal(isValidHerScore(9.5), true);
  assert.equal(isValidHerScore(0), true);
  assert.equal(isValidHerScore(10), true);
  assert.equal(isValidHerScore(9.25), false);
  assert.equal(isValidHerScore(10.5), false);
  assert.equal(isValidHerScore(-0.5), false);
  assert.equal(isValidHerScore(Number.NaN), false);
});

test('scoreSourceLabel says where her grade came from', () => {
  assert.equal(scoreSourceLabel(map({ id: 'a', number: 1, score: 9.5, scoreSource: 'canvas' })), 'from Canvas');
  assert.equal(scoreSourceLabel(map({ id: 'a', number: 1, score: 8, scoreSource: 'manual' })), 'entered by you');
  assert.equal(scoreSourceLabel(map({ id: 'a', number: 1, score: null, scoreSource: null })), null);
  // Imported scores from before #579 carry no source.
  assert.equal(scoreSourceLabel(map({ id: 'a', number: 1, score: 7, scoreSource: null })), null);
});
