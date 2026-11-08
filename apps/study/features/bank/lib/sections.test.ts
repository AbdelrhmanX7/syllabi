import type { ExamQuestion, GradedFrame } from '../api';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { examSections, sectionAt, sectionTallies, withBySection } from './sections';

const q = (id: string, extra: Partial<ExamQuestion> = {}) => ({ id, type: 'mcq', ...extra }) as ExamQuestion;

test('examSections: sections[].questionIds wins, order kept, strays go to Other', () => {
  const groups = examSections({
    questions: [q('a'), q('b'), q('c'), q('d')],
    sections: [
      { name: 'Multiple choice', questionIds: ['b', 'a'] },
      { name: 'Bonus', questionIds: ['c', 'zz'], bonus: true },
    ],
  });

  assert.deepEqual(
    groups?.map((g) => [g.name, g.bonus, g.questions.map((x) => x.id)]),
    [
      ['Multiple choice', false, ['b', 'a']],
      ['Bonus', true, ['c']],
      ['Other', false, ['d']],
    ],
  );
});

test('examSections: consecutive question.section runs; bonus by flag or name', () => {
  const groups = examSections({
    questions: [q('a', { section: 'MC' }), q('b', { section: 'MC' }), q('c', { section: 'Bonus diagram' })],
  });

  assert.deepEqual(
    groups?.map((g) => [g.name, g.bonus, g.questions.length]),
    [
      ['MC', false, 2],
      ['Bonus diagram', true, 1],
    ],
  );
  assert.equal(sectionAt(groups, 'c')?.name, 'Bonus diagram');
});

test('examSections: object section labels from #580', () => {
  const groups = examSections({
    questions: [q('a', { section: { name: 'MC' } }), q('b', { section: { name: 'Bonus', bonus: true } })],
  });

  assert.deepEqual(
    groups?.map((g) => [g.name, g.bonus]),
    [
      ['MC', false],
      ['Bonus', true],
    ],
  );
});

test('examSections: absent or single section → null', () => {
  assert.equal(examSections({ questions: [q('a'), q('b')] }), null);
  assert.equal(examSections({ questions: [q('a', { section: 'MC' }), q('b', { section: 'MC' })] }), null);
  assert.equal(examSections({ questions: [q('a')], sections: [{ name: 'MC' }] }), null);
  assert.equal(sectionAt(null, 'a'), null);
});

test('sectionTallies: ungraded = wrong, partial = half, points weight when all have them', () => {
  const groups = examSections({
    questions: [
      q('a', { section: 'MC', points: 1 }),
      q('b', { section: 'MC', points: 3 }),
      q('c', { section: 'Short' }),
      q('d', { section: 'Short' }),
    ],
  })!;
  const graded = new Map<string, GradedFrame>([
    ['a', { questionId: 'a', result: 'right' }],
    ['b', { questionId: 'b', result: 'partial' }],
    ['c', { questionId: 'c', result: 'right' }],
  ]);
  const [mc, short] = sectionTallies(groups, graded);

  assert.deepEqual([mc!.right, mc!.partial, mc!.wrong, mc!.total], [1, 1, 0, 2]);
  assert.equal(mc!.score, 2.5 / 4);
  assert.deepEqual([short!.right, short!.wrong], [1, 1]);
  assert.equal(short!.score, 0.5);
});

test('withBySection: BE scores win, local counts kept by name, no bySection → local tally', () => {
  const local = [
    { name: 'MC', bonus: false, right: 20, partial: 0, wrong: 5, total: 25, score: 0.8 },
    { name: 'Bonus', bonus: true, right: 1, partial: 0, wrong: 0, total: 1, score: 1 },
  ];
  const merged = withBySection(local, [
    { section: 'MC', score: 76 },
    { section: 'Diagram', score: 50 },
  ])!;

  assert.deepEqual(
    merged.map((t) => [t.name, t.right, t.total, t.score]),
    [
      ['MC', 20, 25, 0.76],
      ['Diagram', 0, 0, 0.5],
    ],
  );
  assert.equal(withBySection(local, undefined), local);
  assert.equal(withBySection(null, []), null);
  assert.equal(withBySection(null, [{ section: 'Bonus round', score: 100 }])![0]!.bonus, true);
});
