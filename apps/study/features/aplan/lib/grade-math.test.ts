import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGradePlan } from './build-plan';
import {
  applyDrops,
  examPath,
  groupResult,
  letterFor,
  neededUniformPct,
  overallStatus,
  project,
  retryKey,
  roundScore,
  toCalcGroup,
  weightedTotal,
} from './grade-math';
import { aPlanHeadline } from './headline';
import { CALC_COURSE, CPP_COURSE, GEOL_COURSE, LAB_COURSE } from './mock-data';

const close = (actual: number | null | undefined, expected: number, eps = 0.01) =>
  assert.ok(
    actual !== null && actual !== undefined && Math.abs(actual - expected) <= eps,
    `expected ≈${expected}, got ${actual}`,
  );

const GEOL = () => buildGradePlan(GEOL_COURSE);
const CALC = () => buildGradePlan(CALC_COURSE);
const need = (plan: ReturnType<typeof GEOL>, groupId: string) =>
  plan.required?.byGroup.find((row) => row.groupId === groupId)?.neededPct;

/* ------------------------------------------------------------------ drops */

test('applyDrops: drop-lowest keeps the best ratio, not the best percentages one by one', () => {
  // 6/10 (60%) vs 1/2 (50%): dropping the 1/2 keeps 16/20 = 80%; dropping the 6/10 keeps 11/12 ≈ 91.7%.
  const items = [
    { id: 'a', points: 10, score: 10 },
    { id: 'b', points: 10, score: 6 },
    { id: 'c', points: 2, score: 1 },
    { id: 'd', points: 2, score: 2 },
  ];
  const { kept, dropped } = applyDrops(items, 1, 0);

  assert.deepEqual(
    dropped.map((item) => item.id),
    ['b'],
  );
  assert.equal(kept.length, 3);
});

test('applyDrops: never_drop is kept even when it is the lowest; ungraded ignored; one always kept', () => {
  const items = [
    { id: 'a', points: 10, score: 2 },
    { id: 'b', points: 10, score: 9 },
    { id: 'c', points: 10, score: 7 },
    { id: 'd', points: 10, score: null },
  ];
  const { kept, dropped } = applyDrops(items, 1, 0, ['a']);

  assert.deepEqual(kept.map((item) => item.id).sort(), ['a', 'b']);
  assert.deepEqual(
    dropped.map((item) => item.id),
    ['c'],
  );
  assert.equal(applyDrops([{ id: 'x', points: 5, score: 1 }], 3, 0).kept.length, 1);
});

test('applyDrops: drop-highest after drop-lowest', () => {
  const items = [10, 9, 5, 2].map((score, i) => ({ id: `i${i}`, points: 10, score }));

  assert.deepEqual(
    applyDrops(items, 1, 1)
      .kept.map((item) => item.score)
      .sort(),
    [5, 9],
  );
});

/* ------------------------------------------------------------------ EAS 101 (demo: 87.31) */

test('EAS 101: weighted + drop-3 math reproduces 87.31 (B)', () => {
  const plan = GEOL();
  const groups = plan.groups.map((group) => toCalcGroup(plan, group));
  const [quizzes, exercises, readings, exams] = groups.map(groupResult);

  close(quizzes.pct, (86 / 90) * 100);
  close(exercises.pct, (29 / 30) * 100);
  assert.equal(exercises.droppedIds.length, 3);
  assert.equal(readings.earned, 58);
  assert.equal(exams.pct, 76.25);
  assert.equal(roundScore(weightedTotal(groups)!), 87.31);
  assert.deepEqual(plan.current, { score: 87.31, letter: 'B', canvasScore: 87.31, basis: 'canvas' });
  assert.equal(plan.groups[1].dropped?.length, 3);
});

test('EAS 101 required: no category alone gets the A — exams are the path, estimated while unscheduled', () => {
  const plan = GEOL();

  // Each category alone, everything else held: all need well over 100%.
  for (const id of ['geo_quizzes', 'geo_activities', 'geo_maps']) assert.ok(need(plan, id)! > 100, id);
  // Nothing on Canvas in the exam group yet and no schedule → the backend returns no exams.
  assert.equal(need(plan, 'geo_exams'), null);
  assert.deepEqual(plan.required?.exams, []);
  assert.equal(plan.required?.examGroupId, 'geo_exams');
  assert.equal(plan.required?.examScheduleAvailable, false);

  // Client estimate: two more 80-pt exams → ~85.2% average (labelled estimated).
  const path = examPath(plan, ['Midterm 2', 'Final Exam']);

  assert.equal(path.source, 'estimate');
  assert.deepEqual(
    path.exams.map((exam) => [exam.title, exam.estimated, exam.points]),
    [
      ['Midterm 2', true, 80],
      ['Final Exam', true, 80],
    ],
  );
  close(path.neededPct, 85.2, 0.02);
  assert.equal(overallStatus(plan), 'at_risk');
});

test('GEOL what-if: 90% on the estimated exams → A, 85% → B; a 0 on a remaining exercise is re-dropped', () => {
  const plan = GEOL();
  const estimated = examPath(plan, ['Midterm 2', 'Final Exam']);

  assert.equal(estimated.exams.length, 2);
  // project() on a plan carrying the estimated exams (as the what-if panel does).
  const examPlan = {
    ...plan,
    groups: plan.groups.map((group) =>
      group.id === 'geo_exams'
        ? {
            ...group,
            remaining: estimated.exams.map((exam) => ({
              itemId: null,
              title: exam.title,
              points: exam.points!,
              dueAt: null,
              estimated: true,
            })),
          }
        : group,
    ),
  };

  assert.equal(project(examPlan, { groups: { geo_exams: 90 } }).letter, 'A');
  assert.equal(project(examPlan, { groups: { geo_exams: 85 } }).letter, 'B');
  // Exercise 10 = 0: the 3 drops are spent, so the 0 is dropped and the 3/5 comes back → 32/35, plus
  // Exercise 11 projected at the current 29/30.
  const missed = project(plan, { items: { itm_eas_ex_10: 0 } });

  close(missed.groups.find((group) => group.id === 'geo_activities')!.pct, ((32 + (5 * 29) / 30) / 40) * 100);
});

/* ------------------------------------------------------------------ Calc I (mastery, semester totals) */

test('Calc I: categories over the semester total', () => {
  const plan = CALC();
  const byName = Object.fromEntries((plan.categories ?? []).map((row) => [row.name, row]));
  const practice = byName['Practice Sets'];
  const mastery = byName['Mastery Checks'];
  const participation = byName.Participation;

  assert.deepEqual(
    [practice.earned, practice.possible, practice.total, practice.maxMissesAllowed, practice.status],
    [7, 7, 24, 2, 'on_track'],
  );
  assert.deepEqual(
    [mastery.earned, mastery.possible, mastery.total, mastery.maxPct, mastery.maxMissesAllowed],
    [7, 10, 40, 92.5, 1],
  );
  assert.equal(mastery.status, 'at_risk');
  assert.equal(mastery.notYetSuccessful, 3);
  assert.equal(mastery.pendingRevisions, null);
  assert.equal(mastery.questionDetail, 'totals_only');
  assert.deepEqual(
    [
      participation.earned,
      participation.possible,
      participation.total,
      participation.maxPct,
      participation.maxMissesAllowed,
    ],
    [11, 14, 43, 93.02, 1],
  );
  assert.equal(participation.status, 'at_risk');
  assert.ok(participation.estimated);

  assert.deepEqual(plan.current, {
    score: null,
    letter: 'C',
    canvasScore: null,
    basis: 'lowest_category',
    lowestCategoryPct: 70,
  });
  assert.equal(plan.target.min, 90);
  assert.equal(plan.required, null);
  assert.equal(overallStatus(plan), 'at_risk');
});

test('Calc I what-if over the semester total: perfect from here → A; one Participation miss fits, two do not', () => {
  const plan = CALC();
  const perfect = { calc_practice: 100, calc_assessments: 100, calc_engagement: 100 };

  // Retakes that land count back: 37 + 3 → 40/40.
  assert.ok(project(plan, { groups: perfect }).meetsTarget);
  // Retakes never land: Mastery Checks 37/40 = 92.5% — still fine.
  close(
    project(plan, { groups: perfect, items: { [retryKey('calc_assessments')]: 0 } }).groups.find(
      (group) => group.id === 'calc_assessments',
    )!.pct,
    92.5,
  );
  // Participation: 1 more miss → 39/43 = 90.7% ✓; 2 more → 38/43 = 88.4% ✗ (B).
  const one = project(plan, { groups: perfect, items: { itm_calc_warmup_8: 0 } });
  const two = project(plan, { groups: perfect, items: { itm_calc_warmup_8: 0, itm_calc_exit_8: 0 } });

  assert.ok(one.meetsTarget);
  assert.equal(two.meetsTarget, false);
  assert.equal(two.letter, 'B');
});

test('headline: GEOL leads with the estimated exam path; Calc explains the weakest category', () => {
  const geol = aPlanHeadline(GEOL(), ['Midterm 2', 'Final Exam']);
  const calc = aPlanHeadline(CALC());

  assert.equal(geol.tone, 'warn');
  assert.equal(geol.text, 'Average 85.2% on Midterm 2 and Final Exam for the A (estimated — exam schedule pending).');
  assert.equal(calc.tone, 'warn');
  assert.equal(
    calc.text,
    'Every category needs 90% of the semester total — Mastery Checks 1 question to spare, Participation 1 credit to spare.',
  );
  assert.equal(calc.detail, 'Your grade is limited by your weakest category — Mastery Checks at 70%.');
});

/* ------------------------------------------------------------------ the other two */

test('Lab and C++ land where Canvas says', () => {
  const lab = buildGradePlan(LAB_COURSE);
  const cpp = buildGradePlan(CPP_COURSE);

  assert.equal(lab.current.score, 95.94);
  assert.equal(lab.current.letter, 'A');
  assert.equal(cpp.current.score, 98.33);
  assert.equal(cpp.current.letter, 'A');
  assert.equal(overallStatus(cpp), 'on_track');
  const test1 = neededUniformPct(cpp, ['cpp_tests']);

  assert.ok(test1 !== null && test1 > 70 && test1 < 80, `Test need ${test1}`);
});

test('letterFor: rounds half-up to 2 dp like Canvas before comparing', () => {
  const scheme = [
    { name: 'A', min: 90 },
    { name: 'B', min: 80 },
    { name: 'F', min: 0 },
  ];

  assert.equal(letterFor(89.996, scheme), 'A');
  assert.equal(letterFor(89.49, scheme), 'B');
  assert.equal(letterFor(null, scheme), null);
  assert.equal(letterFor(-3, scheme), 'F');
});
