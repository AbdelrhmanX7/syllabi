import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EraserCapsule } from './eraserGeometry';
import { distancePointToSegment } from './eraserGeometry';
import { capsulesBBox, collectSweepHits, sweepCapsules } from './objectEraseSweep';

test('a frame of samples becomes the chain of capsules the ring swept, from the previous sample', () => {
  const capsules = sweepCapsules({ x: 0, y: 0 }, [{ x: 10, y: 0 }, { x: 20, y: 0 }], 3);

  assert.deepEqual(capsules, [
    { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, r: 3 },
    { a: { x: 10, y: 0 }, b: { x: 20, y: 0 }, r: 3 },
  ]);
});

test('the first sample of a drag is a dot, not a sweep from the last drag', () => {
  assert.deepEqual(sweepCapsules(null, [{ x: 5, y: 5 }], 2), [{ a: { x: 5, y: 5 }, b: { x: 5, y: 5 }, r: 2 }]);
  assert.deepEqual(sweepCapsules(null, [], 2), []);
});

test('the query box is the union of every capsule, padded', () => {
  const capsules = sweepCapsules(null, [{ x: 0, y: 0 }, { x: 100, y: -50 }], 5);

  assert.deepEqual(capsulesBBox(capsules, 1), { minX: -6, minY: -56, maxX: 106, maxY: 6 });
  assert.equal(capsulesBBox([]), null);
});

type Dot = { name: string; x: number; y: number };

const dotHits = (dot: Dot, capsule: EraserCapsule) => distancePointToSegment(dot, capsule.a, capsule.b) <= capsule.r;

test('every object any capsule of the frame touches is hit, once, in candidate order', () => {
  const capsules = sweepCapsules({ x: 0, y: 0 }, [{ x: 50, y: 0 }, { x: 50, y: 50 }], 2);
  const candidates: Dot[] = [
    { name: 'on-second-leg', x: 51, y: 30 },
    { name: 'off', x: 25, y: 25 },
    { name: 'on-first-leg', x: 20, y: 1 },
    { name: 'on-the-corner', x: 50, y: 0 },
  ];

  assert.deepEqual(
    collectSweepHits(candidates, capsules, dotHits).map((d) => d.name),
    ['on-second-leg', 'on-first-leg', 'on-the-corner'],
  );
});

test('a capsule whose box cannot reach a candidate is not even tested against it', () => {
  const capsules = sweepCapsules({ x: 0, y: 0 }, [{ x: 10, y: 0 }, { x: 500, y: 0 }], 2);
  let tests = 0;
  const hits = collectSweepHits(
    [{ name: 'near-start', x: 5, y: 0 }],
    capsules,
    (dot, capsule) => {
      tests += 1;

      return dotHits(dot, capsule);
    },
    (dot) => ({ minX: dot.x, minY: dot.y, maxX: dot.x, maxY: dot.y }),
  );

  assert.equal(hits.length, 1);
  assert.equal(tests, 1, 'the hit on the first capsule ends the search for that object');

  tests = 0;
  collectSweepHits(
    [{ name: 'far-below', x: 250, y: 300 }],
    capsules,
    (dot, capsule) => {
      tests += 1;

      return dotHits(dot, capsule);
    },
    (dot) => ({ minX: dot.x, minY: dot.y, maxX: dot.x, maxY: dot.y }),
  );
  assert.equal(tests, 0, 'no exact test for a box no capsule reaches');
});
