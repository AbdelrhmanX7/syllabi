// Mock gradebooks + syllabus extracts for the four demo classes. Everything here is invented — the shapes
// follow the live grade-plan (#573): EAS 101 a weighted B with drops, Calc I a mastery course capped by its
// weakest category (Mastery Checks 70%), plus a points-based lab and a weighted C++ class.
// Shared by `../mock.ts` and the unit tests.
import type { APlan, GradedItem, RemainingItem } from '../types';
import type { RawCourse } from './build-plan';

import { DEFAULT_SCHEME } from './build-plan';

const graded = (rows: [string, string, number, number][]): GradedItem[] =>
  rows.map(([itemId, title, score, possible]) => ({ itemId, title, score, possible }));

const left = (rows: [string, string, number, string | null, boolean?][]): RemainingItem[] =>
  rows.map(([itemId, title, points, dueAt, estimated]) => ({
    // Estimated (not in Canvas) work has no item behind it.
    itemId: estimated ? null : itemId,
    title,
    points,
    dueAt,
    ...(estimated ? { estimated } : {}),
  }));

/* ------------------------------------------------------------------ EAS 101 */

const quiz = (n: number, topic: string) => [`itm_eas_quiz_${n}`, `Quiz ${n} — ${topic}`];

export const GEOL_COURSE: RawCourse = {
  scheme: DEFAULT_SCHEME,
  weighted: true,
  policy: { kind: 'weighted', min: null, categories: [] },
  targetLetter: 'A',
  canvasScore: 87.31,
  groups: [
    {
      id: 'geo_quizzes',
      name: 'Quizzes',
      weight: 15,
      graded: graded(
        (
          [
            [1, 'Earth as a System', 10],
            [2, 'Plate Tectonics Basics', 9],
            [3, 'Rocks and the Rock Cycle', 10],
            [4, 'Minerals', 8],
            [5, 'Igneous Rocks', 10],
            [6, 'Volcanoes', 10],
            [7, 'Weathering', 9],
            [8, 'Sediments', 10],
            [9, 'Sedimentary Rocks', 10],
          ] as [number, string, number][]
        ).map(([n, topic, score]) => [...quiz(n, topic), score, 10] as [string, string, number, number]),
      ),
      remaining: left([
        ['itm_eas_quiz_10', 'Quiz 10 — Metamorphic Rocks', 10, '2026-10-09T06:59:00Z'],
        ['itm_eas_quiz_11', 'Quiz 11 — Geologic Time', 10, '2026-10-16T06:59:00Z'],
        ['itm_eas_quiz_12', 'Quiz 12 — Earthquakes', 10, '2026-10-23T06:59:00Z'],
        ['itm_eas_quiz_13', "Quiz 13 — Earth's Interior", 10, '2026-10-30T06:59:00Z'],
      ]),
    },
    {
      id: 'geo_activities',
      name: 'In-Class Exercises',
      weight: 20,
      dropLowest: 3,
      graded: graded([
        ['itm_eas_ex_1', 'In-Class Exercise 1', 5, 5],
        ['itm_eas_ex_2', 'In-Class Exercise 2', 5, 5],
        ['itm_eas_ex_3', 'In-Class Exercise 3', 0, 5],
        ['itm_eas_ex_4', 'In-Class Exercise 4', 4, 5],
        ['itm_eas_ex_5', 'In-Class Exercise 5', 5, 5],
        ['itm_eas_ex_6', 'In-Class Exercise 6', 5, 5],
        ['itm_eas_ex_7', 'In-Class Exercise 7', 0, 5],
        ['itm_eas_ex_8', 'In-Class Exercise 8', 5, 5],
        ['itm_eas_ex_9', 'In-Class Exercise 9', 3, 5],
      ]),
      remaining: left([
        ['itm_eas_ex_10', 'In-Class Exercise 10', 5, '2026-10-06T18:50:00Z'],
        ['itm_eas_ex_11', 'In-Class Exercise 11', 5, '2026-10-08T18:50:00Z'],
      ]),
    },
    {
      id: 'geo_maps',
      name: 'Reading Checks',
      weight: 20,
      dropLowest: 3,
      graded: graded([
        ['itm_eas_rc_1', 'Reading Check 1', 10, 10],
        ['itm_eas_rc_2', 'Reading Check 2', 9, 10],
        ['itm_eas_rc_3', 'Reading Check 3', 10, 10],
        ['itm_eas_rc_4', 'Reading Check 4', 0, 10],
        ['itm_eas_rc_5', 'Reading Check 5', 8, 10],
        ['itm_eas_rc_6', 'Reading Check 6', 10, 10],
        ['itm_eas_rc_7', 'Reading Check 7', 9, 10],
        ['itm_eas_rc_8', 'Reading Check 8', 6, 10],
        ['itm_eas_rc_9', 'Reading Check 9', 10, 10],
      ]),
      remaining: left([
        ['itm_eas_rc_10', 'Reading Check 10', 10, '2026-10-06T17:30:00Z'],
        ['itm_eas_rc_11', 'Reading Check 11', 10, '2026-10-08T17:30:00Z'],
      ]),
    },
    {
      id: 'geo_exams',
      name: 'Exams',
      weight: 45,
      graded: graded([['itm_eas_midterm_1', 'Midterm 1', 61, 80]]),
      // Midterm 2 and the Final are not on Canvas yet and no exam schedule exists → required.exams is [].
      remaining: [],
    },
  ],
};

/* ------------------------------------------------------------------ MATH 101 (Calc I) */

const practiceSetsLeft: [string, string, string | null][] = [
  ['itm_calc_ps_8', 'Practice Set 8', '2026-10-03T06:59:00Z'],
  ['itm_calc_ps_9', 'Practice Set 9', '2026-10-06T06:59:00Z'],
  ['itm_calc_ps_10', 'Practice Set 10', '2026-10-08T06:59:00Z'],
  ['itm_calc_ps_11', 'Practice Set 11', '2026-10-10T06:59:00Z'],
  ['itm_calc_ps_12', 'Practice Set 12', '2026-10-13T06:59:00Z'],
  ['itm_calc_ps_13', 'Practice Set 13', '2026-10-15T06:59:00Z'],
  ['itm_calc_ps_14', 'Practice Set 14', '2026-10-17T06:59:00Z'],
  ['itm_calc_ps_15', 'Practice Set 15', '2026-10-22T06:59:00Z'],
];

/** Morning of the final (Monday of the last week): practice sets close, the final mastery check runs. */
export const CALC_FINAL_AT = '2026-12-07T16:00:00Z';

const participation = (n: number, warmUp: number, exit: number, warmDue?: string, exitDue?: string) => [
  [`itm_calc_warmup_${n}`, `Warm-up ${n}`, warmUp, warmDue],
  [`itm_calc_exit_${n}`, `Exit Ticket ${n}`, exit, exitDue],
];

export const CALC_COURSE: RawCourse = {
  scheme: DEFAULT_SCHEME,
  weighted: false,
  // Wire policy: min is a fraction, categories are the policy's group ids.
  policy: {
    kind: 'all_categories_min',
    min: 0.9,
    categories: ['calc_practice', 'calc_assessments', 'calc_engagement'],
  },
  targetLetter: 'A',
  canvasScore: null,
  groups: [
    {
      id: 'calc_practice',
      name: 'Practice Sets',
      weight: 0,
      unit: 'credit',
      // One credit per practice set finished at ≥ 80%: 24 sets on the course calendar.
      estimatedFuture: 9,
      estimateBasis: 'semester_plan:fixed_total',
      graded: graded(
        [1, 2, 3, 4, 5, 6, 7].map((n) => [`itm_calc_ps_${n}`, `Practice Set ${n}`, 1, 1] as [string, string, number, number]),
      ),
      remaining: left(practiceSetsLeft.map(([id, title, due]) => [id, title, 1, due])),
    },
    {
      id: 'calc_assessments',
      name: 'Mastery Checks',
      weight: 0,
      unit: 'question',
      // Points = questions. Mastery Checks 2, 3 and the final (10/20, 11/17, 12/7), 10 questions each.
      estimatedFuture: 30,
      estimateBasis: 'semester_plan:events',
      graded: graded([['itm_calc_mc_1', 'Mastery Check 1', 7, 10]]),
      remaining: [],
    },
    {
      id: 'calc_engagement',
      name: 'Participation',
      weight: 0,
      unit: 'credit',
      // Warm-up + Exit Ticket = 2 credits per remaining Mon/Wed meeting (10 left on the calendar).
      estimatedFuture: 20,
      estimateBasis: 'semester_plan:per_meeting',
      graded: graded(
        [
          participation(1, 1, 1),
          participation(2, 1, 1),
          participation(3, 1, 1),
          participation(4, 0, 0),
          participation(5, 1, 1),
          participation(6, 1, 0),
          participation(7, 1, 1),
        ]
          .flat()
          .map(([id, title, score]) => [id, title, score, 1] as [string, string, number, number]),
      ),
      remaining: left([
        ['itm_calc_warmup_8', 'Warm-up 8', 1, '2026-10-05T17:15:00Z'],
        ['itm_calc_exit_8', 'Exit Ticket 8', 1, '2026-10-05T18:50:00Z'],
        ['itm_calc_warmup_9', 'Warm-up 9', 1, '2026-10-07T17:15:00Z'],
        ['itm_calc_exit_9', 'Exit Ticket 9', 1, '2026-10-07T18:50:00Z'],
        ['itm_calc_warmup_10', 'Warm-up 10', 1, '2026-10-12T17:15:00Z'],
        ['itm_calc_exit_10', 'Exit Ticket 10', 1, '2026-10-12T18:50:00Z'],
        ['itm_calc_warmup_11', 'Warm-up 11', 1, '2026-10-14T17:15:00Z'],
        ['itm_calc_exit_11', 'Exit Ticket 11', 1, '2026-10-14T18:50:00Z'],
        ['itm_calc_warmup_12', 'Warm-up 12', 1, '2026-10-19T17:15:00Z'],
      ]),
    },
  ],
};

/* ------------------------------------------------------------------ EAS 102 lab, CS 101 */

export const LAB_COURSE: RawCourse = {
  scheme: DEFAULT_SCHEME,
  weighted: false,
  policy: { kind: 'weighted', min: null, categories: [] },
  targetLetter: 'A',
  canvasScore: 95.94,
  groups: [
    {
      id: 'lab_labs',
      name: 'Labs',
      weight: 0,
      dropLowest: 1,
      graded: graded([
        ['lab_1', 'Lab 1 — Measurement and Density', 27, 30],
        ['lab_2', 'Lab 2 — Plate Boundaries', 30, 30],
        ['lab_3', 'Lab 3 — Mineral Identification', 29, 30],
        ['lab_4', 'Lab 4 — Rock Identification', 28, 30],
        ['lab_5', 'Lab 5 — Igneous Textures', 30, 30],
      ]),
      remaining: left([['lab_6', 'Lab 6 — Reading Topographic Maps', 30, '2026-10-15T20:00:00Z']]),
    },
    {
      id: 'lab_quizzes',
      name: 'Lab Quizzes',
      weight: 0,
      graded: graded([
        ['lab_q1', 'Lab Quiz 1', 18, 20],
        ['lab_q2', 'Lab Quiz 2', 18.5, 20],
      ]),
      remaining: left([['lab_q3_est', 'Lab Quiz 3', 20, '2026-10-29T20:00:00Z', true]]),
    },
  ],
};

export const CPP_COURSE: RawCourse = {
  scheme: DEFAULT_SCHEME,
  weighted: true,
  policy: { kind: 'weighted', min: null, categories: [] },
  targetLetter: 'A',
  canvasScore: 98.33,
  groups: [
    {
      id: 'cpp_assignments',
      name: 'Assignments',
      weight: 40,
      graded: graded([
        ['cpp_hw1', 'Assignment 1 — Hello, compiler', 20, 20],
        ['cpp_hw2', 'Assignment 2 — Loops and functions', 20, 20],
        ['cpp_hw3', 'Assignment 3 — Vectors and strings', 19, 20],
      ]),
      remaining: left([['cpp_hw4_est', 'Assignment 4 — Your first class', 20, '2026-10-12T06:59:00Z', true]]),
    },
    {
      id: 'cpp_quizzes',
      name: 'Quizzes',
      weight: 20,
      graded: graded([
        ['cpp_q1', 'Quiz 1', 10, 10],
        ['cpp_q2', 'Quiz 2', 10, 10],
        ['cpp_q3', 'Quiz 3', 9.5, 10],
      ]),
      remaining: left([['itm_cs_quiz_4', 'Quiz 4 (extended to Tue 10/6)', 10, '2026-10-07T06:59:00Z', true]]),
    },
    {
      id: 'cpp_tests',
      name: 'Tests',
      weight: 40,
      graded: [],
      // Midterm is published (opens Thu 10/8); the Final is not on Canvas yet.
      remaining: left([['cpp_test1', 'Midterm', 100, '2026-10-10T06:59:00Z']]),
    },
  ],
};

/** Fixture id → course. Demo-seed ids alias the same data so the plain demo seed has a plan too. */
export const COURSES: Record<string, RawCourse> = {
  cls_demo_earth: GEOL_COURSE,
  cls_demo_math: CALC_COURSE,
  cls_demo_lab: LAB_COURSE,
  cls_demo_cs: CPP_COURSE,
  cls_demo_geo: GEOL_COURSE,
  cls_demo_cpp: CPP_COURSE,
};

/* ------------------------------------------------------------------ syllabus extracts */

export type APlanBody = Omit<APlan, 'gradePlan' | 'generatedAt'>;

const GEOL_PLAN: APlanBody = {
  policy: {
    gradingCategories: [
      { name: 'Quizzes', weight: 15 },
      { name: 'In-Class Exercises', weight: 20 },
      { name: 'Reading Checks', weight: 20 },
      { name: 'Exams', weight: 45 },
    ],
    aRequirement: {
      text: 'A = 90% or higher of the weighted course total.',
      kind: 'weighted',
      min: 90,
      categories: [],
    },
    scale: DEFAULT_SCHEME,
    lateWork: 'Quizzes and reading checks close at the due time. In-class exercises are done in class only.',
    makeupAndRevisions:
      'No make-up exercises; the 3 lowest are dropped to cover absences. Exam make-ups need documentation and must be arranged ahead.',
    drops: 'Lowest 3 In-Class Exercises and lowest 3 Reading Checks are dropped.',
    attendance: 'Attendance is not graded directly, but in-class exercises only count when done in class.',
    exams: [
      {
        name: 'Midterm 2',
        date: '2026-11-05T17:30:00Z',
        week: 'Week 11',
        topics: 'Metamorphic rocks, geologic time, earthquakes',
        format: '40 multiple choice + a labelled diagram, in class, 75 min',
        allowed: 'One handwritten half-page of notes',
      },
      {
        name: 'Final Exam',
        date: '2026-12-15T17:00:00Z',
        week: 'Finals week',
        topics: "Cumulative, weighted toward Earth's interior, mountain building and climate",
        format: 'Multiple choice, in class, 2 hours',
        allowed: 'One handwritten page of notes',
      },
    ],
    extraCredit: 'Up to 1% for the optional field-trip report.',
    instructor: {
      name: 'Prof. Rivera',
      email: 'rivera@example.edu',
      officeHours: 'Tue/Thu 12:00–1:00 PM, Science 210, or by appointment online',
    },
    requiredMaterials: ['Any intro physical geology textbook (free OER edition linked on Canvas)', 'Phone for in-class polls'],
    keyDates: [
      { label: 'Midterm 2', date: '2026-11-05' },
      { label: 'Last day to withdraw', date: '2026-11-13' },
      { label: 'Thanksgiving — no class', date: '2026-11-26' },
      { label: 'Final Exam', date: '2026-12-15' },
    ],
    quotes: [
      {
        field: 'aRequirement',
        text: '“Letter grades follow the standard scale (A 90%+, B 80%+, C 70%+, D 60%+). There is no curve.”',
      },
      {
        field: 'drops',
        text: '“Your three lowest in-class exercises and three lowest reading checks do not count.”',
      },
      {
        field: 'exams',
        text: '“Bring a half page of handwritten notes to the midterms and a full page to the final.”',
      },
    ],
  },
  conflicts: [
    {
      text: 'The syllabus lists the Final at 20% by itself, but Canvas puts every exam in one 45% group. The plan follows Canvas — worth asking Prof. Rivera which is right.',
    },
  ],
  requirements: [
    { text: 'Weighted total ≥ 90%', status: 'at_risk', evidence: 'Now 87.31% — 2.69 points short.' },
    { text: 'Average ≥ 85.2% on Midterm 2 + Final', status: 'on_track', evidence: 'Midterm 1 was 76.3% (61 / 80).' },
    {
      text: 'Keep quizzes, exercises and reading checks where they are',
      status: 'met',
      evidence: 'Quizzes 95.6%, Exercises 96.7%, Reading Checks 96.7% after drops.',
    },
  ],
  risks: [
    {
      text: 'Exams are 45% and Midterm 1 was 76.3%. The other categories are already near the top, so the A is decided on Midterm 2 and the Final.',
      severity: 'high',
      itemIds: ['itm_eas_midterm_1'],
    },
    {
      text: 'All 3 In-Class Exercise drops are used (two 0s and a 3/5). One more miss now lowers the category.',
      severity: 'medium',
      itemIds: ['itm_eas_ex_3', 'itm_eas_ex_7'],
    },
  ],
  thisWeek: [
    {
      text: 'In-Class Exercise 10 — in class Tuesday',
      dueAt: '2026-10-06T18:50:00Z',
      itemId: 'itm_eas_ex_10',
      why: 'No drops left in In-Class Exercises.',
    },
    {
      text: 'Reading Check 10',
      dueAt: '2026-10-06T17:30:00Z',
      itemId: 'itm_eas_rc_10',
      why: 'Keeps Reading Checks above 96%.',
    },
    {
      text: 'Quiz 10 — Metamorphic Rocks',
      dueAt: '2026-10-09T06:59:00Z',
      itemId: 'itm_eas_quiz_10',
      why: 'Quizzes are 15% of the grade.',
    },
    {
      text: 'Start a Midterm 2 notes page from the metamorphic rocks chapter',
      dueAt: null,
      itemId: 'itm_p_midterm-2-review',
      why: 'Midterm 2 needs ~85%; Midterm 1 was 76.3%.',
    },
  ],
  announcements: [
    {
      itemId: 'itm_ann_eas_midterm_scores',
      title: 'Midterm 1 scores are up',
      postedAt: '2026-10-02T21:14:00Z',
      summary: 'Midterm 1 scores are in the gradebook. Optional review session next Thursday before class.',
      actions: [{ text: 'Look over your Midterm 1 and list the topics you missed', dueAt: null }],
      importance: 'high',
      tags: ['grades', 'exam'],
      deadlineChanges: [],
    },
    {
      itemId: 'itm_ann_eas_midterm_room',
      title: 'Midterm 1 reminder',
      postedAt: '2026-09-25T16:02:00Z',
      summary: 'Midterm 1 is in our usual room. Bring a pencil and your notes page.',
      actions: [],
      importance: 'normal',
      tags: ['exam'],
      deadlineChanges: [],
    },
    {
      itemId: 'itm_ann_eas_review',
      title: 'Midterm review sheet posted',
      postedAt: '2026-09-22T18:40:00Z',
      summary: 'A review sheet and a short practice quiz for Midterm 1 are in the Week 5 module.',
      actions: [{ text: 'Reuse the practice-quiz format for Midterm 2', dueAt: null }],
      importance: 'normal',
      tags: ['study guide'],
      deadlineChanges: [],
    },
  ],
  sources: [
    { itemId: 'itm_ann_eas_review', title: 'Midterm review sheet posted (announcement)', kind: 'announcement' },
    { itemId: 'itm_p_midterm-2-review', title: 'Midterm 2 Review', kind: 'syllabus' },
    { itemId: null, title: 'Canvas gradebook', kind: 'canvas' },
  ],
  // Two lectures a week (In-Class Exercise 2N−1 / 2N in each «Week N» module).
  meetings: {
    slots: [
      { day: 2, start: '10:30', end: '11:50' },
      { day: 4, start: '10:30', end: '11:50' },
    ],
    timeZone: 'America/Los_Angeles',
    engagementGroupId: null,
    creditsPerMeeting: null,
  },
};

const CALC_PLAN: APlanBody = {
  policy: {
    gradingCategories: [
      { name: 'Practice Sets', weight: null },
      { name: 'Mastery Checks', weight: null },
      { name: 'Participation', weight: null },
    ],
    aRequirement: {
      text: 'An A needs at least 90% of the semester total in every category — Practice Sets, Mastery Checks and Participation.',
      kind: 'all_categories_min',
      min: 90,
      categories: ['Practice Sets', 'Mastery Checks', 'Participation'],
    },
    scale: DEFAULT_SCHEME,
    lateWork:
      'Practice: one credit per online practice set finished at ≥ 80%, no late penalty — all sets close the morning of the final. Warm-ups and Exit Tickets are earned in class only.',
    makeupAndRevisions:
      'Mastery Checks are graded per question: Mastered or Not Yet. Retake up to 3 questions a week in office hours — Mon 1–2, Tue 11–12, Thu 3:30–4:30, Fri 10–11 in MS 214 — after signing up at least 24 h ahead. A Not Yet with a small slip can be fixed with a written correction within 3 days. The final cannot be retaken.',
    drops: 'No drops — the bar is 90% of the semester total in each category.',
    attendance:
      'Participation = Warm-up + Exit Ticket, 2 credits per Mon/Wed meeting (not on mastery-check days or holidays); you must be there to earn them.',
    exams: [
      {
        name: 'Mastery Check 2',
        date: '2026-10-21T06:59:59Z',
        week: 'Week 9',
        topics: 'Limits, continuity and the definition of the derivative',
        format: 'In class, paper, graded per question; retakes allowed',
        allowed: 'Scientific calculator (no graphing / CAS)',
      },
      {
        name: 'Final mastery check',
        date: CALC_FINAL_AT,
        week: 'Monday of the last week',
        topics: 'Cumulative',
        format: 'In class, paper — no retakes',
        allowed: 'Scientific calculator',
      },
    ],
    extraCredit: 'None.',
    instructor: {
      name: 'Prof. Chen',
      email: 'chen@example.edu',
      officeHours: 'Mon 1–2, Tue 11–12, Thu 3:30–4:30, Fri 10–11 in MS 214 (none Fri 10/9 — professional development day)',
    },
    requiredMaterials: ['Online homework account (link on Canvas)', 'Guided notes packet'],
    keyDates: [
      { label: 'Professional development day — no office hours', date: '2026-10-09' },
      { label: 'Mastery Check 2', date: '2026-10-20' },
      { label: 'Last day to withdraw', date: '2026-11-13' },
      { label: 'Final mastery check; practice closes that morning', date: '2026-12-07' },
    ],
    quotes: [
      {
        field: 'aRequirement',
        text: '“An A requires 90% or more of the available credit in each of the three categories, not on average.”',
      },
      {
        field: 'makeupAndRevisions',
        text: '“You can retake up to three questions per week. Sign up on the retake sheet at least a day before the office hour you want.”',
      },
      {
        field: 'lateWork',
        text: '“Each practice set finished at 80% or better earns one credit. Late is fine — every set stays open until the final.”',
      },
    ],
  },
  conflicts: [],
  requirements: [
    { text: 'Practice Sets ≥ 90% of 24', status: 'on_track', evidence: '7 / 7 so far; 2 credits to spare.' },
    {
      text: 'Mastery Checks ≥ 90% of ~40 questions',
      status: 'at_risk',
      evidence: 'Mastery Check 1: 7 / 10 Mastered; 3 questions still Not Yet. Best case today 92.5%.',
    },
    {
      text: 'Participation ≥ 90% of ~43 credits',
      status: 'at_risk',
      evidence: '11 / 14 so far — 1 miss left. Best case 93.02%.',
    },
  ],
  risks: [
    {
      text: 'Participation: only 1 miss left for the rest of the semester (Warm-up 4, Exit Ticket 4 and Exit Ticket 6 already missed). Be in every Mon/Wed class.',
      severity: 'high',
      itemIds: ['itm_calc_warmup_4', 'itm_calc_exit_4', 'itm_calc_exit_6'],
    },
    {
      text: 'Mastery Checks: 3 questions on Mastery Check 1 are still Not Yet and only 1 more miss fits. Each retake that lands gives a miss back.',
      severity: 'high',
      itemIds: ['itm_calc_mc_1', 'itm_calc_retake_form'],
    },
  ],
  thisWeek: [
    {
      text: 'Sign up to retake the 3 Mastery Check 1 questions still Not Yet',
      dueAt: '2026-10-05T18:00:00Z',
      itemId: 'itm_calc_retake_form',
      why: 'Up to 3 a week; sign up at least 24 h before the office hour.',
    },
    {
      text: 'Be in class Mon + Wed for the Warm-up and Exit Ticket',
      dueAt: '2026-10-07T18:50:00Z',
      itemId: 'itm_calc_exit_9',
      why: 'Only 1 Participation miss left for the semester.',
    },
    {
      text: 'Practice Set 11 at ≥ 80%',
      dueAt: '2026-10-10T06:59:00Z',
      itemId: 'itm_calc_ps_11',
      why: 'Each set is a credit; no late penalty, but do not let them pile up.',
    },
  ],
  announcements: [
    {
      itemId: 'itm_ann_calc_no_oh_friday',
      title: 'No office hours this Friday',
      postedAt: '2026-10-04T17:30:00Z',
      summary: 'Friday is a professional development day, so there are no office hours. Retakes move to Mon/Tue/Thu.',
      actions: [{ text: 'Book a Mon/Tue/Thu retake slot instead of Friday', dueAt: '2026-10-07T18:00:00Z' }],
      importance: 'high',
      tags: ['office hours', 'schedule'],
      deadlineChanges: [],
    },
    {
      itemId: 'itm_ann_calc_corrections',
      title: 'Mastery Check 1 corrections due Thursday',
      postedAt: '2026-09-30T15:00:00Z',
      summary: 'Written corrections for Mastery Check 1 are due Thursday at 11:59 PM.',
      actions: [{ text: 'Turn in Mastery Check 1 corrections', dueAt: '2026-10-02T06:59:59Z' }],
      importance: 'high',
      tags: ['assessment', 'revision'],
      deadlineChanges: [],
    },
    {
      itemId: 'itm_ann_calc_mc1_back',
      title: 'Mastery Check 1 returned',
      postedAt: '2026-09-26T20:10:00Z',
      summary: 'Mastery Check 1 is marked. Read the feedback, then plan which questions to retake.',
      actions: [{ text: 'Read the feedback on Mastery Check 1', dueAt: null }],
      importance: 'normal',
      tags: ['grades', 'assessment'],
      deadlineChanges: [],
    },
    {
      itemId: 'itm_ann_calc_prep',
      title: 'Before Monday: derivative rules',
      postedAt: '2026-10-03T14:00:00Z',
      summary: 'Watch the two short videos on the power rule and fill in the guided notes before Monday.',
      actions: [{ text: 'Power-rule videos + guided notes', dueAt: '2026-10-05T17:00:00Z' }],
      importance: 'normal',
      tags: ['prep'],
      deadlineChanges: [],
    },
  ],
  sources: [
    { itemId: 'itm_ann_calc_mc1_back', title: 'Mastery Check 1 returned', kind: 'announcement' },
    { itemId: 'itm_calc_mc1_key', title: 'Mastery Check 1 practice problems (key).pdf', kind: 'syllabus' },
    { itemId: null, title: 'Canvas gradebook', kind: 'canvas' },
    { itemId: null, title: 'MATH 101 syllabus', kind: 'syllabus' },
  ],
  recovery: {
    newAttempts: {
      perWeek: 3,
      formLeadHours: 24,
      formItemId: 'itm_calc_retake_form',
      slots: [
        { day: 1, start: '13:00', end: '14:00', place: 'MS 214' },
        { day: 2, start: '11:00', end: '12:00', place: 'MS 214' },
        { day: 4, start: '15:30', end: '16:30', place: 'MS 214' },
        { day: 5, start: '10:00', end: '11:00', place: 'MS 214' },
      ],
      closedDates: ['2026-10-09'],
      notYetSuccessful: 3,
    },
    // Canvas has no per-question marks, so no correction deadline is known.
    revisions: [],
    rules: [
      'Retake up to 3 questions a week, as many tries per question as you need.',
      'Sign up on the retake sheet at least 24 h before the office hour you will use.',
      'A Not Yet with a small slip can be fixed with a written correction within 3 days.',
      'The final mastery check (Monday of the last week) cannot be retaken.',
    ],
  },
  meetings: {
    slots: [
      { day: 1, start: '10:00', end: '11:50' },
      { day: 3, start: '10:00', end: '11:50' },
    ],
    timeZone: 'America/Los_Angeles',
    engagementGroupId: 'calc_engagement',
    creditsPerMeeting: 2,
  },
};

const LAB_PLAN: APlanBody = {
  policy: {
    gradingCategories: [
      { name: 'Labs', weight: null },
      { name: 'Lab Quizzes', weight: null },
    ],
    aRequirement: { text: 'A = 90% of total points.', kind: 'weighted', min: 90, categories: [] },
    scale: DEFAULT_SCHEME,
    lateWork: 'Labs are finished and handed in during the lab session.',
    makeupAndRevisions: 'One missed lab is dropped. No lab make-ups.',
    drops: 'Lowest lab dropped.',
    attendance: 'Required — labs are done in the room.',
    exams: [
      {
        name: 'Lab Quiz 3',
        date: '2026-10-29T20:00:00Z',
        week: 'Week 10',
        topics: 'Map reading, rock identification',
        format: 'Practical stations',
        allowed: 'Hand lens, no notes',
      },
    ],
    extraCredit: 'None.',
    instructor: { name: 'Prof. Rivera', email: 'rivera@example.edu', officeHours: 'Tue/Thu 12:00–1:00 PM, Science 210' },
    requiredMaterials: ['Lab manual', 'Hand lens', 'Protractor + ruler'],
    keyDates: [{ label: 'Lab Quiz 3', date: '2026-10-29' }],
    quotes: [{ field: 'aRequirement', text: '“Your grade is total points earned out of total points possible.”' }],
  },
  conflicts: [],
  requirements: [{ text: 'Total points ≥ 90%', status: 'on_track', evidence: 'Now 95.9%.' }],
  risks: [],
  thisWeek: [
    {
      text: 'Read the Lab 6 handout before lab',
      dueAt: '2026-10-15T20:00:00Z',
      itemId: 'itm_ann_lab_6',
      why: 'Lab 6 is graded in the room.',
    },
  ],
  announcements: [
    {
      itemId: 'itm_ann_lab_6',
      title: 'Lab 6 — bring a ruler',
      postedAt: '2026-09-30T19:00:00Z',
      summary: 'Lab 6 is map reading: bring a protractor and a ruler.',
      actions: [{ text: 'Bring protractor + ruler', dueAt: '2026-10-15T20:00:00Z' }],
      importance: 'normal',
      tags: ['materials'],
      deadlineChanges: [],
    },
  ],
  sources: [{ itemId: null, title: 'Canvas gradebook', kind: 'canvas' }],
};

const CPP_PLAN: APlanBody = {
  policy: {
    gradingCategories: [
      { name: 'Assignments', weight: 40 },
      { name: 'Quizzes', weight: 20 },
      { name: 'Tests', weight: 40 },
    ],
    aRequirement: { text: 'A = 90% of the weighted total.', kind: 'weighted', min: 90, categories: [] },
    scale: DEFAULT_SCHEME,
    lateWork: 'Three free late days for assignments over the term; after that, late work is not accepted.',
    makeupAndRevisions: 'No test make-ups. Quiz answers open after the due date.',
    drops: 'None.',
    attendance: 'Online course — no attendance grade.',
    exams: [
      {
        name: 'Midterm',
        date: '2026-10-10T06:59:00Z',
        week: 'Week 7',
        topics: 'Functions, vectors, strings and a first class (Modules 1–6)',
        format: 'Online on Canvas, opens Thu 10/8, due Fri 10/9',
        allowed: 'Open book, no AI tools',
      },
    ],
    extraCredit: 'None.',
    instructor: { name: 'Prof. Nguyen', email: 'nguyen@example.edu', officeHours: 'Online, Wed 6–7 PM' },
    requiredMaterials: ['A C++ compiler (g++, clang or Visual Studio)', 'Any intro C++ textbook'],
    keyDates: [{ label: 'Midterm window', date: '2026-10-08' }],
    quotes: [{ field: 'exams', text: '“The midterm opens on Canvas Thursday morning and closes Friday at 11:59 PM.”' }],
  },
  conflicts: [],
  requirements: [
    { text: 'Weighted total ≥ 90%', status: 'on_track', evidence: 'Now 98.33% before any test.' },
    { text: 'Midterm ≥ ~78% keeps the A', status: 'on_track', evidence: 'Tests are 40% and nothing is graded yet.' },
  ],
  risks: [
    { text: 'Tests are 40% and none is graded yet — the 98.33% is not locked in.', severity: 'low', itemIds: [] },
  ],
  thisWeek: [
    {
      text: 'Quiz 4 (extended to Tue 10/6)',
      dueAt: '2026-10-07T06:59:00Z',
      itemId: 'itm_cs_quiz_4',
      why: 'Quizzes are 20%.',
    },
    {
      text: 'Work through the midterm review list',
      dueAt: '2026-10-08T07:00:00Z',
      itemId: 'itm_ann_cs_midterm',
      why: 'The midterm opens Thursday.',
    },
  ],
  announcements: [
    {
      itemId: 'itm_ann_cs_midterm',
      title: 'Midterm review list',
      postedAt: '2026-10-01T16:00:00Z',
      summary: 'What the midterm covers — opens Thu 10/8, due Fri 10/9.',
      actions: [{ text: 'Take the midterm', dueAt: '2026-10-10T06:59:00Z' }],
      importance: 'high',
      tags: ['test', 'study guide'],
      deadlineChanges: [],
    },
    {
      itemId: 'itm_cs_quiz_4',
      title: 'Quiz 4 extended',
      postedAt: '2026-10-03T22:00:00Z',
      summary: 'Quiz 4 now closes Tuesday 10/6.',
      actions: [{ text: 'Finish Quiz 4', dueAt: '2026-10-07T06:59:00Z' }],
      importance: 'normal',
      tags: ['deadline-change'],
      deadlineChanges: [
        {
          itemTitle: 'Quiz 4',
          newDueAt: '2026-10-07T06:59:00Z',
          matchedItemId: 'itm_cs_quiz_4',
          confidence: 0.92,
          outcome: 'applied',
        },
      ],
    },
  ],
  sources: [{ itemId: 'itm_ann_cs_midterm', title: 'Midterm review list', kind: 'announcement' }],
};

export const CALC_PLAN_RECOVERY = CALC_PLAN.recovery!;

export const PLANS: Record<string, APlanBody> = {
  cls_demo_earth: GEOL_PLAN,
  cls_demo_math: CALC_PLAN,
  cls_demo_lab: LAB_PLAN,
  cls_demo_cs: CPP_PLAN,
  cls_demo_geo: GEOL_PLAN,
  cls_demo_cpp: CPP_PLAN,
};
