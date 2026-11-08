import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  effectiveStrokeTime,
  isRevealed,
  pageAtTime,
  pageStrokeTimes,
  revealedCount,
  seekTargetMs,
  sortedTimes,
} from '../timeline';

test('effectiveStrokeTime: own t, earliest child for groups, null when untimed', () => {
  assert.equal(effectiveStrokeTime({ type: 'Path', t: 1200 }), 1200);
  assert.equal(effectiveStrokeTime({ type: 'Path' }), null);
  assert.equal(effectiveStrokeTime({ type: 'Group', t: 9000, objects: [{ t: 3000 }, { t: 2000 }, {}] }), 2000);
  assert.equal(effectiveStrokeTime({ type: 'Group', t: 9000, objects: [{}] }), 9000);
  assert.equal(effectiveStrokeTime(null), null);
});

test('pageStrokeTimes reads canvas JSON in object order; bad JSON is empty', () => {
  const json = JSON.stringify({ objects: [{ t: 500 }, {}, { t: 100 }] });

  assert.deepEqual(pageStrokeTimes(json), [500, null, 100]);
  assert.deepEqual(pageStrokeTimes('{oops'), []);
  assert.deepEqual(pageStrokeTimes(''), []);
});

test('reveal: untimed always shown; count is an upper bound', () => {
  const sorted = sortedTimes([500, null, 100, 900]);

  assert.deepEqual(sorted, [100, 500, 900]);
  assert.equal(isRevealed(null, 0), true);
  assert.equal(isRevealed(500, 499), false);
  assert.equal(isRevealed(500, 500), true);
  assert.equal(revealedCount(sorted, 0), 0);
  assert.equal(revealedCount(sorted, 500), 2);
  assert.equal(revealedCount(sorted, 10_000), 3);
});

test('pageAtTime follows the page with the most recent stroke', () => {
  const pages = [[0, 1000, 5000], [2000, 3000], []];

  assert.equal(pageAtTime(pages, -1), 0);
  assert.equal(pageAtTime(pages, 1500), 0);
  assert.equal(pageAtTime(pages, 2500), 1);
  assert.equal(pageAtTime(pages, 4000), 1);
  assert.equal(pageAtTime(pages, 6000), 0);
});

test('seekTargetMs leads in, clamped at 0', () => {
  assert.equal(seekTargetMs(10_000), 8500);
  assert.equal(seekTargetMs(400), 0);
});
