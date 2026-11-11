import type { Question } from '@/lib/api/types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_TALLY,
  filterChipCounts,
  gradeForKey,
  gradeRating,
  gradeResult,
  groupDecks,
  isDue,
  isFlashcard,
  orderSession,
  recallPercent,
  tallyAdd,
  withFlashcardTag,
} from './deck';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const DAY = 86_400_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

const card = (over: Partial<Question> & { id: string }): Question => ({
  classId: 'cs',
  topic: 'Loops',
  subtopic: null,
  difficulty: 2,
  source: { kind: 'manual', itemId: null, pageId: null, lectureId: null, ref: null },
  type: 'free',
  stem: 'Front',
  imageUrl: null,
  answer: 'Back',
  solutionSteps: [],
  tags: ['flashcard'],
  stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
  srs: { dueAt: at(0), stability: 0, difficulty: 5, reps: 0, lapses: 0 },
  createdAt: at(-10 * DAY),
  ...over,
});

const reviewed = (id: string, dueOffset: number, over: Partial<Question> = {}) =>
  card({ id, srs: { dueAt: at(dueOffset), stability: 2, difficulty: 5, reps: 2, lapses: 0 }, ...over });

test('isFlashcard reads the tag case-insensitively', () => {
  assert.equal(isFlashcard({ tags: ['Flashcard'] }), true);
  assert.equal(isFlashcard({ tags: ['copy'] }), false);
  assert.deepEqual(withFlashcardTag(['copy']), ['copy', 'flashcard']);
  assert.deepEqual(withFlashcardTag(['flashcard']), ['flashcard']);
  assert.deepEqual(withFlashcardTag(undefined), ['flashcard']);
});

test('isDue: new cards and past-due reviewed cards', () => {
  assert.equal(isDue(card({ id: 'a' }), NOW), true);
  assert.equal(isDue(reviewed('b', -DAY), NOW), true);
  assert.equal(isDue(reviewed('c', DAY), NOW), false);
});

test('groupDecks groups by class order, then topic, with counts', () => {
  const decks = groupDecks(
    [
      card({ id: '1', classId: 'math', topic: 'Limits' }),
      reviewed('2', DAY, { classId: 'cs', topic: 'Loops' }),
      card({ id: '3', classId: 'cs', topic: 'Arrays' }),
      card({ id: '4', classId: 'cs', topic: 'Loops' }),
      card({ id: '5', classId: 'cs', topic: 'Loops', tags: [] }),
      card({ id: '6', classId: 'cs', topic: '  ' }),
    ],
    ['cs', 'math'],
    NOW,
  );

  assert.deepEqual(
    decks.map((d) => d.classId),
    ['cs', 'math'],
  );
  assert.deepEqual(
    decks[0].topics.map((t) => [t.topic, t.cards.length, t.due]),
    [
      ['Arrays', 1, 1],
      ['General', 1, 1],
      ['Loops', 2, 1],
    ],
  );
  assert.equal(decks[0].count, 4);
  assert.equal(decks[0].due, 3);
});

test('orderSession: overdue first (oldest due), then new; all adds later cards', () => {
  const cards = [
    reviewed('later', 2 * DAY),
    card({ id: 'new-old', createdAt: at(-5 * DAY) }),
    reviewed('due-recent', -DAY),
    card({ id: 'new-recent', createdAt: at(-DAY) }),
    reviewed('due-old', -3 * DAY),
    reviewed('soon', DAY),
  ];

  assert.deepEqual(
    orderSession(cards, { now: NOW }).map((c) => c.id),
    ['due-old', 'due-recent', 'new-old', 'new-recent'],
  );
  assert.deepEqual(
    orderSession(cards, { now: NOW, all: true }).map((c) => c.id),
    ['due-old', 'due-recent', 'new-old', 'new-recent', 'soon', 'later'],
  );
});

test('grade mapping', () => {
  assert.deepEqual(
    (['again', 'hard', 'good', 'easy'] as const).map((g) => [gradeRating(g), gradeResult(g)]),
    [
      [1, 'wrong'],
      [2, 'partial'],
      [3, 'right'],
      [4, 'right'],
    ],
  );
  assert.equal(gradeForKey('3'), 'good');
  assert.equal(gradeForKey('5'), null);
});

test('tally + recall percent', () => {
  let tally = EMPTY_TALLY;

  assert.equal(recallPercent(tally), 0);
  for (const g of ['again', 'good', 'easy', 'hard'] as const) tally = tallyAdd(tally, g);
  assert.deepEqual(tally, { again: 1, hard: 1, good: 1, easy: 1 });
  assert.equal(recallPercent(tally), 50);
});

test('filterChipCounts: All keeps every card, Bookmarked counts the marked ones', () => {
  const cards = [card({ id: 'a', bookmarked: true }), card({ id: 'b' }), card({ id: 'c' })];

  assert.deepEqual(filterChipCounts(cards), { all: 3, bookmarked: 1 });
  assert.deepEqual(filterChipCounts([]), { all: 0, bookmarked: 0 });
});
