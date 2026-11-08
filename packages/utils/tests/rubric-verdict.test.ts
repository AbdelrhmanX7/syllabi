import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasRubricVerdict, rubricVerdictOf } from '../src/rubric-verdict';

const RUBRIC = ['states the definition', 'gives an example', 'links it to the law'];

test('no breakdown reported is not a verdict — the rubric stays unplaced', () => {
  const verdict = rubricVerdictOf({ rubric: RUBRIC });

  assert.equal(verdict.verdictKnown, false);
  assert.deepEqual(verdict.matched, []);
  assert.deepEqual(verdict.missing, []);
  assert.deepEqual(verdict.unplaced, RUBRIC);
  assert.equal(hasRubricVerdict(verdict), false, 'an unreported verdict must render nothing');
});

test('an EMPTY matched array is a real verdict — the answer earned no point', () => {
  const verdict = rubricVerdictOf({ rubric: RUBRIC, matched: [], missing: RUBRIC });

  assert.equal(verdict.verdictKnown, true);
  assert.deepEqual(verdict.matched, []);
  assert.deepEqual(verdict.missing, RUBRIC);
  assert.equal(hasRubricVerdict(verdict), true);
});

test('points the grader placed in neither list stay visible as unplaced', () => {
  const verdict = rubricVerdictOf({ rubric: RUBRIC, matched: ['states the definition'], missing: ['gives an example'] });

  assert.deepEqual(verdict.matched, ['states the definition']);
  assert.deepEqual(verdict.missing, ['gives an example']);
  assert.deepEqual(verdict.unplaced, ['links it to the law'], 'a dropped point must never vanish');
});

test('blank rows an editing UI left behind are dropped everywhere', () => {
  const verdict = rubricVerdictOf({
    rubric: ['  states the definition  ', '   ', 'gives an example'],
    matched: ['states the definition', ''],
    missing: null,
  });

  assert.deepEqual(verdict.matched, ['states the definition']);
  assert.deepEqual(verdict.unplaced, ['gives an example']);
});

test('a breakdown with no question rubric still reports what the grader said', () => {
  const verdict = rubricVerdictOf({ matched: ['states the definition'], missing: ['gives an example'] });

  assert.equal(verdict.verdictKnown, true);
  assert.deepEqual(verdict.unplaced, []);
  assert.equal(hasRubricVerdict(verdict), true);
});
