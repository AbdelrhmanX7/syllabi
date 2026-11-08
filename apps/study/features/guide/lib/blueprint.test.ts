import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blueprintQuestionCount, cleanBlueprint, sectionTypeLabel } from './blueprint';

const GEOL = [
  { section: 'Multiple choice', type: 'mcq' as const, count: 25 },
  { section: 'Matching', type: 'matching' as const, count: 1, preferImage: true },
  { section: 'Fill in the blank', type: 'fill_blank' as const, count: 5 },
  { section: 'Short answer', type: 'free' as const, count: 4, from: 'concept_map' as const },
  { section: 'Diagram to complete', type: 'label_image' as const, count: 1, optional: true },
  { section: 'Bonus', type: 'any' as const, count: 1, bonus: true },
];

test('cleanBlueprint: the default geology blueprint passes untouched', () => {
  assert.deepEqual(cleanBlueprint(110, GEOL), { minutes: 110, sections: GEOL });
  assert.equal(blueprintQuestionCount({ sections: GEOL }), 36);
});

test('cleanBlueprint: mirrors the BE rules', () => {
  assert.match(cleanBlueprint(0, GEOL) as string, /Minutes/);
  assert.match(cleanBlueprint(null, []) as string, /at least one/);
  assert.match(cleanBlueprint(null, [{ section: ' ', type: 'mcq', count: 1 }]) as string, /needs a name/);
  assert.match(
    cleanBlueprint(null, [
      { section: 'MC', type: 'mcq', count: 1 },
      { section: 'mc', type: 'mcq', count: 1 },
    ]) as string,
    /twice/,
  );
  assert.match(cleanBlueprint(null, [{ section: 'MC', type: 'mcq', count: 0 }]) as string, /count/);
  assert.match(
    cleanBlueprint(null, [
      { section: 'A', type: 'mcq', count: 30 },
      { section: 'B', type: 'mcq', count: 30 },
    ]) as string,
    /add up to 60/,
  );
  assert.deepEqual(cleanBlueprint(null, [{ section: ' MC ', type: 'mcq', count: 3, bonus: false, points: 2 }]), {
    minutes: null,
    sections: [{ section: 'MC', type: 'mcq', count: 3, points: 2 }],
  });
  assert.equal(sectionTypeLabel('fill_blank'), 'Fill in the blank');
});
