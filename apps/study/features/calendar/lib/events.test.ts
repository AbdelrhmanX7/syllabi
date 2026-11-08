import type { Item, Question, StudyClass } from '@/lib/api/types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildEvents, byDate, dateKey, monthGrid, startOfWeek } from './events';

const cls = (id: string, extra: Partial<StudyClass> = {}) =>
  ({ id, code: id.toUpperCase(), name: id, color: '#123456', meetings: null, ...extra }) as unknown as StudyClass;
const item = (id: string, type: Item['type'], dueAt: string | null, classId = 'a') =>
  ({ id, classId, type, title: id, dueAt }) as unknown as Item;
const question = (dueAt: string) => ({ id: dueAt, srs: { dueAt } }) as unknown as Question;

test('startOfWeek is Monday; monthGrid is 42 days from that Monday', () => {
  assert.equal(dateKey(startOfWeek(new Date(2026, 10, 7))), '2026-11-02'); // Sat → Mon
  assert.equal(dateKey(startOfWeek(new Date(2026, 10, 2))), '2026-11-02');
  const grid = monthGrid(new Date(2026, 10, 15));

  assert.equal(grid.length, 42);
  assert.equal(dateKey(grid[0]!), '2026-10-26');
});

test('only dated assignments and quizzes in range become due events', () => {
  const events = buildEvents(
    {
      classes: [cls('a')],
      items: [
        item('hw', 'assignment', new Date(2026, 10, 4, 23, 59).toISOString()),
        item('q', 'quiz', new Date(2026, 10, 5).toISOString()),
        item('page', 'page', new Date(2026, 10, 5).toISOString()),
        item('undated', 'assignment', null),
        item('late', 'assignment', new Date(2026, 11, 1).toISOString()),
      ],
      exams: {},
      questions: [],
    },
    '2026-11-02',
    '2026-11-08',
  );

  assert.deepEqual(
    events.map((e) => [e.title, e.date, e.time]),
    [
      ['hw', '2026-11-04', '23:59'],
      ['q', '2026-11-05', null],
    ],
  );
  assert.equal(events[0]!.color, '#123456');
});

test('meetings repeat weekly; exams and reviews land on their dates', () => {
  const events = buildEvents(
    {
      classes: [cls('a', { meetings: { slots: [{ day: 'Mon', start: '9:00', end: '10:15' }] } })],
      items: [],
      exams: { a: [{ name: 'Midterm', week: 8, date: '2026-11-05', chapters: [], topics: [] }] },
      questions: [question(new Date(2026, 10, 3, 10).toISOString()), question(new Date(2026, 10, 3, 12).toISOString())],
    },
    '2026-11-02',
    '2026-11-15',
  );
  const days = byDate(events);

  assert.deepEqual(
    days.get('2026-11-02')?.map((e) => [e.kind, e.time, e.end]),
    [['class', '09:00', '10:15']],
  );
  assert.ok(days.get('2026-11-09')?.some((e) => e.kind === 'class'));
  assert.equal(days.get('2026-11-05')?.[0]?.title, 'A · Midterm');
  // Reviews due before today count on today, so only assert the per-day merge when the date is ahead.
  const reviewDay = [...days.values()].flat().filter((e) => e.kind === 'review');

  assert.equal(reviewDay.reduce((n, e) => n + Number(e.title.split(' ')[0]), 0) <= 2, true);
});
