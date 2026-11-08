import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanSchedule,
  daysLabel,
  daysUntil,
  drillHref,
  examTopics,
  mockExamHref,
  nextExam,
  resolveExam,
  resultPercent,
  resultTrend,
  splitList,
  termStartFor,
  upcomingExams,
  weekStart,
} from './schedule';

const GEOL = [
  { name: 'Exam 1', week: 6, date: '2026-10-01', chapters: ['Ch.1', 'Ch.2'], topics: [] },
  { name: 'Exam 2', week: 11, date: null, chapters: ['Ch.5'], topics: ['Volcanoes'] },
  { name: 'Final', week: 16, date: null, chapters: [], topics: [] },
];

test('termStartFor: class field wins, else the Fall 2026 constant, else null', () => {
  assert.equal(termStartFor({ term: 'Fall 2026' }), '2026-08-24');
  assert.equal(termStartFor({ term: '2026FA' }), '2026-08-24');
  assert.equal(termStartFor({ term: 'Spring 2027' }), null);
  assert.equal(termStartFor({ term: 'Fall 2026', termStart: '2026-08-31T00:00:00Z' }), '2026-08-31');
});

test('weekStart: week N Monday = termStart + (N-1)*7', () => {
  assert.equal(weekStart('2026-08-24', 1), '2026-08-24');
  assert.equal(weekStart('2026-08-24', 11), '2026-11-02');
  assert.equal(weekStart('2026-08-24', 16), '2026-12-07');
});

test('resolveExam: an explicit date is exact; a week is approx; neither is null', () => {
  assert.deepEqual(
    [resolveExam(GEOL[0]!, '2026-08-24').when, resolveExam(GEOL[0]!, '2026-08-24').approx],
    ['2026-10-01', false],
  );
  assert.equal(resolveExam(GEOL[1]!, '2026-08-24').when, '2026-11-02');
  assert.equal(resolveExam(GEOL[1]!, '2026-08-24').approx, true);
  assert.equal(resolveExam(GEOL[1]!, null).when, null);
});

test('daysUntil: approx dates stay "this week" for the rest of their week', () => {
  assert.equal(daysUntil({ when: '2026-11-02', approx: true }, '2026-10-05'), 28);
  assert.equal(daysUntil({ when: '2026-11-02', approx: true }, '2026-11-05'), 0);
  assert.equal(daysUntil({ when: '2026-11-02', approx: true }, '2026-11-09'), -7);
  assert.equal(daysUntil({ when: '2026-09-30', approx: false }, '2026-10-01'), -1);
  assert.equal(daysUntil({ when: null, approx: false }, '2026-10-01'), null);
});

test('nextExam / upcomingExams: past exams drop out, nearest first, undated last', () => {
  const up = upcomingExams(
    [...GEOL, { name: 'Quiz', week: null, date: null, chapters: [], topics: [] }],
    '2026-08-24',
    '2026-10-05',
  );

  assert.deepEqual(
    up.map((e) => e.name),
    ['Exam 2', 'Final', 'Quiz'],
  );
  assert.equal(nextExam(GEOL, '2026-08-24', '2026-10-05')?.name, 'Exam 2');
  assert.equal(nextExam(GEOL, '2026-08-24', '2026-09-01')?.name, 'Exam 1');
  assert.equal(nextExam(GEOL, null, '2026-10-05'), null);
});

test('daysLabel', () => {
  assert.equal(daysLabel(0), 'Today');
  assert.equal(daysLabel(1), 'Tomorrow');
  assert.equal(daysLabel(9), '9 days');
  assert.equal(daysLabel(0, true), 'This week');
  assert.equal(daysLabel(3, true), '~3 days');
  assert.equal(daysLabel(28, true), '~4 wk');
  assert.equal(daysLabel(null), 'Date not set');
});

test('links: mock exam carries each topic; drill opens a review', () => {
  assert.deepEqual(examTopics(GEOL[0]!), ['Ch.1', 'Ch.2']);
  assert.deepEqual(examTopics(GEOL[1]!), ['Volcanoes']);
  assert.equal(
    mockExamHref('c1', ['Plate tectonics, faults', 'Ch.2']),
    '/bank?classId=c1&mock=1&blueprint=class&topics=Plate+tectonics%2C+faults&topics=Ch.2',
  );
  assert.equal(drillHref('c 1'), '/bank?classId=c+1&review=1');
});

test('resultPercent / resultTrend', () => {
  assert.equal(resultPercent({ score: 66, maxScore: 80 }), 82.5);
  assert.equal(resultPercent({ score: 1, maxScore: 0 }), null);
  assert.equal(resultPercent({ score: 1, maxScore: 2, percent: 90 }), 90);
  assert.deepEqual(
    resultTrend([
      { score: 66, maxScore: 80 },
      { score: 45, maxScore: 50 },
      { score: 40, maxScore: 50 },
    ]),
    [null, 7.5, -10],
  );
});

test('splitList / cleanSchedule', () => {
  assert.deepEqual(splitList(' Ch.1, Ch.2\nCh.1 ,, '), ['Ch.1', 'Ch.2']);
  assert.equal(cleanSchedule([{ name: ' ', week: 1, date: null, chapters: [], topics: [] }]), 'Exam 1 needs a name.');
  assert.equal(cleanSchedule([{ name: 'A', week: 61, date: null, chapters: [], topics: [] }]), 'A: week must be 0–60.');
  assert.equal(
    cleanSchedule([{ name: 'A', week: null, date: '10/2', chapters: [], topics: [] }]),
    'A: date must be YYYY-MM-DD.',
  );
  assert.deepEqual(cleanSchedule([{ name: ' A ', week: 3, date: '', chapters: [' x ', ''], topics: [] }]), [
    { name: 'A', week: 3, date: null, chapters: ['x'], topics: [] },
  ]);
});
