import assert from 'node:assert/strict';
import test from 'node:test';

import { sampleShapeOutline, shapeOutlineLength } from './shapeSampling';

import type { Vec } from './shapeRecognition';

const gaps = (points: Vec[]) =>
  points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
const near = (a: Vec, b: Vec, eps = 1e-9) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

test('an open line is sampled end to end at the spacing, both endpoints exact', () => {
  const geometry = { type: 'poly' as const, closed: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
  const samples = sampleShapeOutline(geometry, { spacing: 10 });

  assert.equal(shapeOutlineLength(geometry), 100);
  assert.equal(samples.length, 11);
  assert.deepEqual(samples[0], { x: 0, y: 0 });
  assert.deepEqual(samples[samples.length - 1], { x: 100, y: 0 });
  assert.ok(gaps(samples).every((gap) => Math.abs(gap - 10) < 1e-9), 'uneven spacing');
});

test('a closed polygon keeps every corner as a sample and comes back to its first point', () => {
  const corners = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
  const geometry = { type: 'poly' as const, closed: true, points: corners };
  const samples = sampleShapeOutline(geometry, { spacing: 7 });

  assert.equal(shapeOutlineLength(geometry), 200);

  for (const corner of corners) {
    assert.ok(samples.some((sample) => near(sample, corner)), `corner ${corner.x},${corner.y} was not sampled`);
  }

  assert.ok(near(samples[0], corners[0]));
  assert.ok(near(samples[samples.length - 1], corners[0]), 'a closed outline must end where it began');
  // A corner is never skipped: no gap longer than the spacing, none shorter than half of it.
  assert.ok(gaps(samples).every((gap) => gap <= 7 + 1e-9 && gap >= 3.5 - 1e-9), `gaps ${gaps(samples).join(',')}`);
});

test('an ellipse is sampled around its rotated outline and closes the loop', () => {
  const geometry = { type: 'ellipse' as const, cx: 100, cy: 50, rx: 40, ry: 20, angle: Math.PI / 6 };
  const length = shapeOutlineLength(geometry);
  const samples = sampleShapeOutline(geometry, { spacing: 4 });

  // Ramanujan for 40/20: ~193.8
  assert.ok(Math.abs(length - 193.77) < 0.1, `perimeter ${length}`);
  assert.ok(near(samples[0], samples[samples.length - 1]), 'the ellipse outline must close');
  assert.ok(samples.length >= length / 4, 'too few samples for the spacing');

  // Every sample lies on the ellipse: undo the rotation and test the implicit equation.
  for (const sample of samples) {
    const dx = sample.x - geometry.cx;
    const dy = sample.y - geometry.cy;
    const localX = dx * Math.cos(-geometry.angle) - dy * Math.sin(-geometry.angle);
    const localY = dx * Math.sin(-geometry.angle) + dy * Math.cos(-geometry.angle);
    const value = (localX / geometry.rx) ** 2 + (localY / geometry.ry) ** 2;

    assert.ok(Math.abs(value - 1) < 1e-9, `sample off the ellipse: ${value}`);
  }
});

test('maxPoints widens the spacing instead of exceeding the cap; degenerate shapes do not throw', () => {
  const geometry = { type: 'poly' as const, closed: true, points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 }] };
  const samples = sampleShapeOutline(geometry, { spacing: 2, maxPoints: 400 });

  // 4 edges, each rounded up to whole steps, plus the closing point: a handful over the cap at most.
  assert.ok(samples.length <= 400 + 5, `${samples.length} samples`);
  assert.ok(samples.length >= 300);

  assert.deepEqual(sampleShapeOutline({ type: 'poly', closed: false, points: [] }, { spacing: 2 }), []);
  assert.deepEqual(sampleShapeOutline({ type: 'poly', closed: false, points: [{ x: 3, y: 4 }] }, { spacing: 2 }), [{ x: 3, y: 4 }]);
  assert.ok(sampleShapeOutline({ type: 'ellipse', cx: 0, cy: 0, rx: 0, ry: 0, angle: 0 }, { spacing: 2 }).length >= 12);
});
