import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  deriveLectures,
  lectureFields,
  lectureLabel,
  lectureNoteTitle,
  lectureOfTitle,
  lectureOnDate,
  metaLabel,
  pickWithSession,
  sessionLecture,
  sessionOfTitle,
  linksToMigrate,
  mergeLectureMetas,
  moduleTopic,
  notesByWeek,
  notesForLecture,
  pageFieldsSupported,
  pickDefaultLecture,
  termWeek,
  weekdayOf,
  weekOfName,
} from './lectures';

const TERM = '2026-08-24';
const MON_WED = [1, 3];

// Shaped like a typical Canvas course (emoji module names, «Lecture N …» items).
const MODULES = [
  { id: 'm0', name: '🔖 Resources', items: [{ id: 'r1', title: '📎 How to use this course' }] },
  {
    id: 'm1',
    name: '🧭 Week 1: Intro to Earth Science',
    items: [
      { id: 'a1', title: '✏️ Lecture 1 Worksheet' },
      { id: 'a2', title: '✏️ Lecture 2 Worksheet' },
    ],
  },
  {
    id: 'm5',
    name: '🗻 Week 5: Magma & Igneous Rocks',
    items: [
      { id: 'v8', title: '▶️ Lecture 8 videos' },
      { id: 'a8', title: '✏️ Lecture 8 Worksheet' },
      { id: 'a7', title: '✏️ Lecture 7 Worksheet' },
    ],
  },
  {
    id: 'm6',
    name: '✅ Week 6: Midterm 1 (Ch. 1–4)',
    items: [{ id: 'q', title: '✔️ Midterm 1 practice quiz' }],
  },
  { id: 'm7', name: '🌋 Week 7: Volcanoes', items: [{ id: 'v10', title: '▶️ Lecture 10 videos' }] },
  { id: 'm14', name: '📈 Week 14: Earthquakes', items: [] },
];

const MAPS = [
  { id: 'map8', week: 5, lecture: 'L8 Igneous Rocks', source: 'canvas' },
  { id: 'map11', week: 7, lecture: 'L11 Volcano Hazards', source: 'canvas' },
  { id: 'practice', week: 7, lecture: 'L12 Practice', source: 'practice' },
];

test('weekOfName / lectureOfTitle / moduleTopic read Canvas names', () => {
  assert.equal(weekOfName('🧭 Week 1: Intro'), 1);
  assert.equal(weekOfName('wk 06'), 6);
  assert.equal(weekOfName('Resources'), null);
  assert.equal(lectureOfTitle('✏️ Lecture 8 Worksheet'), 8);
  assert.equal(lectureOfTitle('Lecture Activity 8'), 8);
  assert.equal(lectureOfTitle('▶️ Lecture 3 videos'), 3);
  assert.equal(lectureOfTitle('L8 Volcanoes'), 8);
  assert.equal(lectureOfTitle('Lab 4: Bank account'), null);
  assert.equal(lectureOfTitle('Practice quiz (lecture review questions)'), null);
  assert.equal(moduleTopic('🌋 Week 7: Volcanoes'), 'Volcanoes');
  assert.equal(moduleTopic('Week 7'), null);
});

test('deriveLectures: numbered lectures by week, map topic wins, week-only rows for bare weeks', () => {
  const lectures = deriveLectures(MODULES, MAPS);

  assert.deepEqual(lectures.map(lectureLabel), [
    'Week 1 · Lecture 1 — Intro to Earth Science',
    'Week 1 · Lecture 2 — Intro to Earth Science',
    'Week 5 · Lecture 7 — Magma & Igneous Rocks',
    'Week 5 · Lecture 8 — Igneous Rocks',
    'Week 6 — Midterm 1 (Ch. 1–4)',
    'Week 7 · Lecture 10 — Volcanoes',
    'Week 7 · Lecture 11 — Volcano Hazards',
    'Week 14 — Earthquakes',
  ]);
  const l8 = lectures.find((row) => row.key === 'L8')!;

  assert.equal(l8.moduleId, 'm5');
  assert.equal(l8.mapId, 'map8');
  assert.deepEqual(l8.itemIds, ['v8', 'a8']);
  // A map-only lecture still lands in its week's module.
  assert.equal(lectures.find((row) => row.key === 'L11')!.moduleId, 'm7');
  assert.equal(lectureNoteTitle(l8), 'Lecture 8 — Igneous Rocks');
});

test('termWeek / weekdayOf', () => {
  assert.equal(termWeek(TERM, '2026-08-24'), 1);
  assert.equal(termWeek(TERM, '2026-08-30'), 1);
  assert.equal(termWeek(TERM, '2026-09-21'), 5);
  assert.equal(termWeek(TERM, '2026-10-05'), 7);
  assert.equal(weekdayOf('2026-10-05'), 1);
  assert.equal(weekdayOf('2026-10-07'), 3);
  assert.equal(weekdayOf('2026-10-04'), 0);
});

test('lectureOnDate: n-th meeting of the week takes the n-th lecture', () => {
  const lectures = deriveLectures(MODULES, MAPS);

  assert.equal(lectureOnDate(lectures, MON_WED, TERM, '2026-09-21')?.key, 'L7');
  assert.equal(lectureOnDate(lectures, MON_WED, TERM, '2026-09-23')?.key, 'L8');
  assert.equal(lectureOnDate(lectures, MON_WED, TERM, '2026-09-22'), null);
  // A week with one lecture known: the spare meeting keeps it.
  assert.equal(lectureOnDate(deriveLectures(MODULES), MON_WED, TERM, '2026-10-07')?.key, 'L10');
  // A week without numbers: its week row.
  assert.equal(lectureOnDate(lectures, MON_WED, TERM, '2026-09-28')?.key, 'W6');
});

test('pickDefaultLecture: today on a meeting day, else the next meeting, else the latest', () => {
  const lectures = deriveLectures(MODULES, MAPS);
  const pick = (today: string, meetingDays = MON_WED, termStart: string | null = TERM) =>
    pickDefaultLecture(lectures, { meetingDays, termStart, today });

  assert.deepEqual(pick('2026-09-23'), {
    lecture: lectures.find((row) => row.key === 'L8'),
    reason: 'today',
    date: '2026-09-23',
  });
  // Tuesday → Wednesday's lecture.
  assert.equal(pick('2026-09-22')?.lecture.key, 'L8');
  assert.equal(pick('2026-09-22')?.reason, 'next');
  // Friday of week 5 → Monday of week 6 (the exam week row).
  assert.equal(pick('2026-09-25')?.lecture.key, 'W6');
  assert.equal(pick('2026-09-25')?.date, '2026-09-28');
  // Week 9 has no module: no meeting resolves for two weeks → the latest lecture so far.
  assert.equal(pick('2026-10-19')?.lecture.key, 'L11');
  assert.equal(pick('2026-10-19')?.reason, 'last');
  // No meetings known → the latest lecture up to this week.
  assert.equal(pick('2026-09-23', [])?.lecture.key, 'L8');
  // No term start → the first.
  assert.equal(pick('2026-09-23', MON_WED, null)?.reason, 'first');
  assert.equal(pickDefaultLecture([], { meetingDays: MON_WED, termStart: TERM, today: '2026-09-23' }), null);
});

test('notesForLecture / notesByWeek match by device record, then by the title', () => {
  const lectures = deriveLectures(MODULES, MAPS);
  const pages = [
    { id: 'p1', title: 'Lecture 8 — Igneous Rocks', updatedAt: '2026-09-23T10:00:00Z' },
    { id: 'p2', title: 'My scribbles', updatedAt: '2026-09-24T10:00:00Z' },
    { id: 'p3', title: 'Week 6 — Exam 1', updatedAt: '2026-09-28T10:00:00Z' },
    { id: 'p4', title: 'EAS 101 · Sep 21', updatedAt: '2026-09-21T10:00:00Z' },
  ];
  const metas = {
    p2: { classId: 'c', key: 'L8', week: 5, lecture: 8, topic: null, moduleId: 'm5', mapId: null, date: '2026-09-23' },
    p3: {
      classId: 'c',
      key: 'W6',
      week: 6,
      lecture: null,
      topic: null,
      moduleId: 'm6',
      mapId: null,
      date: '2026-09-28',
    },
  };
  const l8 = lectures.find((row) => row.key === 'L8')!;
  const w6 = lectures.find((row) => row.key === 'W6')!;

  assert.deepEqual(
    notesForLecture(pages, metas, l8).map((page) => page.id),
    ['p2', 'p1'],
  );
  assert.deepEqual(
    notesForLecture(pages, metas, w6, '2026-09-28').map((page) => page.id),
    ['p3'],
  );
  assert.deepEqual(notesForLecture(pages, metas, w6, '2026-09-30'), []);
  const byWeek = notesByWeek(pages, metas, lectures);

  assert.deepEqual(
    byWeek.get(5)?.map((page) => page.id),
    ['p1', 'p2'],
  );
  assert.deepEqual(
    byWeek.get(6)?.map((page) => page.id),
    ['p3'],
  );
  assert.equal(
    [...byWeek.values()].flat().some((page) => page.id === 'p4'),
    false,
  );
});

test('server fields: detection, merge (server wins), one-time migration list', () => {
  const device = {
    old: {
      classId: 'c',
      key: 'L8',
      week: 5,
      lecture: 8,
      topic: 'Igneous',
      moduleId: 'm5',
      mapId: 'map8',
      date: '2026-09-23',
    },
    filed: {
      classId: 'c',
      key: 'L7',
      week: 5,
      lecture: 7,
      topic: 'Magma',
      moduleId: 'm5',
      mapId: null,
      date: '2026-09-21',
    },
  };
  const legacy = [{ id: 'old', title: 'x', updatedAt: '' }];
  const fresh = [
    { id: 'old', title: 'x', updatedAt: '', week: null, moduleId: null, lecture: null },
    {
      id: 'filed',
      title: 'y',
      updatedAt: '',
      week: 6,
      moduleId: 'm6',
      lecture: { number: 9, key: 'L9', date: '2026-09-28' },
    },
    {
      id: 'remote',
      title: 'z',
      updatedAt: '',
      week: 5,
      moduleId: 'm5',
      lecture: { number: 8, key: 'L8', date: '2026-09-23' },
    },
  ];

  assert.equal(pageFieldsSupported([]), null);
  assert.equal(pageFieldsSupported(legacy), false);
  assert.equal(pageFieldsSupported(fresh), true);

  const merged = mergeLectureMetas(fresh, device, 'c');

  assert.equal(merged.old?.key, 'L8');
  // The server moved «filed» to L9: its record wins, the device's L7 topic does not leak in.
  assert.deepEqual(merged.filed, {
    classId: 'c',
    key: 'L9',
    week: 6,
    lecture: 9,
    topic: null,
    moduleId: 'm6',
    mapId: null,
    date: '2026-09-28',
  });
  assert.equal(merged.remote?.lecture, 8);

  assert.deepEqual(
    linksToMigrate(fresh, device).map((row) => row.page.id),
    ['old'],
  );
  assert.deepEqual(linksToMigrate(legacy, device), []);
  assert.deepEqual(lectureFields(device.old), {
    week: 5,
    moduleId: 'm5',
    lecture: { number: 8, key: 'L8', date: '2026-09-23' },
  });
});

// Shaped like a lesson-based math course («Lesson N …» pages) and a lab course («Lab N: …» modules).
const MATH = [
  { id: 'u0', name: 'Mastery Checks and Retakes', items: [{ id: 'na', title: 'Retake sign-up' }] },
  {
    id: 'u3',
    name: 'Unit 3: Using Derivatives',
    items: [
      { id: 'l14', title: 'Lesson 14: Related Rates' },
      { id: 'l14v', title: 'Lesson 14: Related Rates (video 1)' },
      { id: 'l13', title: 'Lesson 13 Implicit Differentiation' },
    ],
  },
];
const LAB = [
  {
    id: 'lab6',
    name: '🗺️ Lab 6: Map Reading I',
    items: [
      { id: 'o6', title: '🌎 Lab 6 Overview' },
      { id: 'q', title: '✔️ Lab Quiz 2 (Lab 3 & 4)' },
    ],
  },
  { id: 'lab7', name: '🗺️ Lab 7: Map Reading II', items: [] },
];

test('sessionOfTitle: lectures, lessons, labs (not «Lab Quiz»)', () => {
  assert.deepEqual(sessionOfTitle('Lesson 14: Related Rates'), { kind: 'Lesson', number: 14 });
  assert.deepEqual(sessionOfTitle('🌎 Lab 6 Overview'), { kind: 'Lab', number: 6 });
  assert.deepEqual(sessionOfTitle('✏️ Lecture 8 Worksheet'), { kind: 'Lecture', number: 8 });
  assert.deepEqual(sessionOfTitle('L8 Volcanoes'), { kind: 'Lecture', number: 8 });
  assert.equal(sessionOfTitle('✔️ Lab Quiz 2 (Lab 3 & 4)')?.number, 3);
  assert.equal(sessionOfTitle('Assessment 1 Revisions'), null);
});

test('deriveLectures: MATH lessons and EAS 102 labs become sessions with their own titles', () => {
  const math = deriveLectures(MATH);

  assert.deepEqual(
    math.map((row) => [row.key, lectureNoteTitle(row)]),
    [
      ['LS13', 'Lesson 13 — Implicit Differentiation'],
      ['LS14', 'Lesson 14 — Related Rates'],
    ],
  );
  assert.deepEqual(math.find((row) => row.key === 'LS14')?.itemIds, ['l14', 'l14v']);
  // Concept maps of another class never add «Lecture N» rows to a lesson-numbered class.
  assert.deepEqual(
    deriveLectures(MATH, MAPS).map((row) => row.key),
    ['LS13', 'LS14'],
  );
  const lab = deriveLectures(LAB);

  assert.deepEqual(
    lab.map((row) => [row.key, lectureNoteTitle(row)]),
    [
      ['LB3', 'Lab 3'],
      ['LB6', 'Lab 6 — Map Reading I'],
      ['LB7', 'Lab 7 — Map Reading II'],
    ],
  );
});

test('sessionLecture + pickWithSession: a dated note whenever no lecture fits', () => {
  const session = sessionLecture('MATH 101', TERM, '2026-10-05');

  assert.equal(session.key, '2026-10-05');
  assert.equal(lectureNoteTitle(session), 'MATH 101 — Week 7 · Mon Oct 5');
  assert.equal(session.week, 7);
  assert.equal(session.lecture, null);
  assert.equal(sessionLecture('MATH 101', null, '2026-10-05').title, 'MATH 101 — Mon Oct 5');

  const opts = { meetingDays: MON_WED, termStart: TERM, today: '2026-10-05' };

  // MATH on a Monday: lessons have no week → today's dated note.
  assert.deepEqual(pickWithSession(deriveLectures(MATH), opts, session), {
    lecture: session,
    reason: 'today',
    date: '2026-10-05',
  });
  // EAS 101 on a Monday keeps its numbered lecture.
  assert.equal(
    pickWithSession(deriveLectures(MODULES, MAPS), { ...opts, today: '2026-09-21' }, session).lecture.key,
    'L7',
  );
  // Not a meeting day and nothing dated → the dated note, not «Lesson 13».
  assert.equal(
    pickWithSession(deriveLectures(MATH), { ...opts, today: '2026-10-06' }, session).lecture.key,
    '2026-10-05',
  );
  assert.equal(pickWithSession([], { ...opts, meetingDays: [] }, session).lecture, session);
});

test('session notes match by date; title fallback reads lessons / labs', () => {
  const session = sessionLecture('MATH 101', TERM, '2026-10-05');
  const pages = [
    { id: 's1', title: 'MATH 101 — Week 7 · Mon Oct 5', updatedAt: '2026-10-05T10:00:00Z' },
    { id: 's2', title: 'Lesson 14 — Rates', updatedAt: '2026-10-05T10:00:00Z' },
  ];
  const metas = {
    s1: {
      classId: 'c',
      key: '2026-10-05',
      week: 7,
      lecture: null,
      topic: null,
      moduleId: null,
      mapId: null,
      date: '2026-10-05',
    },
  };

  assert.deepEqual(
    notesForLecture(pages, metas, session, '2026-10-05').map((page) => page.id),
    ['s1'],
  );
  assert.deepEqual(
    notesForLecture(pages, metas, deriveLectures(MATH).find((row) => row.key === 'LS14')!).map((page) => page.id),
    ['s2'],
  );
  assert.equal(metaLabel(metas.s1), 'Oct 5');
  assert.equal(metaLabel({ key: 'LS14', lecture: 14, week: null, date: '' }), 'Lesson 14');
  assert.equal(metaLabel({ key: 'L8', lecture: 8, week: 5, date: '' }), 'Lecture 8');
});

test('lectureFields drops values the backend would 400 on', () => {
  const body = lectureFields({ week: 0, moduleId: null, lecture: 500, key: 'L'.repeat(100), date: '2026-10-05' });

  assert.equal(body.week, null);
  assert.equal(body.lecture.number, null);
  assert.equal(body.lecture.key.length, 80);
  assert.equal(lectureFields({ week: 30, moduleId: null, lecture: 1, key: 'L1', date: '2026-10-05' }).week, 30);
});
