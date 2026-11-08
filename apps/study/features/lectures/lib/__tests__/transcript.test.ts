import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeSegmentIndex, formatClock, searchSegments } from '../transcript';

const segs = [
  { start: 0, end: 4, text: 'Welcome to calculus' },
  { start: 4, end: 9, text: 'Today: the chain rule' },
  { start: 12, end: 15, text: 'Derivative of the outer function' },
];

test('activeSegmentIndex picks the last started segment, keeps it through gaps', () => {
  assert.equal(activeSegmentIndex(segs, -1), -1);
  assert.equal(activeSegmentIndex(segs, 0), 0);
  assert.equal(activeSegmentIndex(segs, 3.99), 0);
  assert.equal(activeSegmentIndex(segs, 4), 1);
  assert.equal(activeSegmentIndex(segs, 10.5), 1);
  assert.equal(activeSegmentIndex(segs, 99), 2);
  assert.equal(activeSegmentIndex([], 5), -1);
});

test('searchSegments matches all terms case-insensitively', () => {
  assert.deepEqual(searchSegments(segs, 'CHAIN'), [1]);
  assert.deepEqual(searchSegments(segs, 'the function'), [2]);
  assert.deepEqual(searchSegments(segs, '   '), []);
});

test('formatClock', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65.9), '1:05');
  assert.equal(formatClock(3725), '1:02:05');
});
