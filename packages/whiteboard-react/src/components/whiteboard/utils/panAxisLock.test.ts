import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPanAxisLock, decidePanAxis, filterPanDelta, PAN_AXIS_DECIDE_PX } from './panAxisLock';

/** Feed a straight drag of (dx, dy) in `steps` equal frames; return the total applied. */
function drag(dx: number, dy: number, steps = 40) {
  const lock = createPanAxisLock();
  let x = 0;
  let y = 0;

  for (let step = 0; step < steps; step += 1) {
    const out = filterPanDelta(lock, dx / steps, dy / steps);

    x += out.dx;
    y += out.dy;
  }

  return { axis: lock.axis, x, y };
}

test('decidePanAxis: mostly vertical / mostly horizontal / diagonal', () => {
  assert.equal(decidePanAxis(1.5, 10), 'y');
  assert.equal(decidePanAxis(-6, 10), 'y');
  assert.equal(decidePanAxis(10, -2), 'x');
  assert.equal(decidePanAxis(10, 10), 'free');
  assert.equal(decidePanAxis(7, 10), 'free');
});

test('a slightly diagonal scroll (dy=400, dx=60) moves only vertically, none of y is lost', () => {
  const result = drag(60, 400);

  assert.equal(result.axis, 'y');
  assert.equal(result.x, 0);
  assert.ok(Math.abs(result.y - 400) < 1e-9);
});

test('a horizontal swipe locks to x', () => {
  const result = drag(-300, 40);

  assert.equal(result.axis, 'x');
  assert.equal(result.y, 0);
  assert.ok(Math.abs(result.x + 300) < 1e-9);
});

test('a true diagonal stays free', () => {
  const result = drag(200, 220);

  assert.equal(result.axis, 'free');
  assert.ok(Math.abs(result.x - 200) < 1e-9);
  assert.ok(Math.abs(result.y - 220) < 1e-9);
});

test('nothing moves until the axis is decided, then the held travel is released on that axis', () => {
  const lock = createPanAxisLock();

  assert.deepEqual(filterPanDelta(lock, 1, 3), { dx: 0, dy: 0 });
  assert.deepEqual(filterPanDelta(lock, 0.5, 3), { dx: 0, dy: 0 });
  assert.equal(lock.axis, null);

  const released = filterPanDelta(lock, 0.5, PAN_AXIS_DECIDE_PX);

  assert.equal(lock.axis, 'y');
  assert.deepEqual(released, { dx: 0, dy: 6 + PAN_AXIS_DECIDE_PX });
});

test('once locked vertical, a later sideways turn (or a fling with x velocity) never moves x', () => {
  const lock = createPanAxisLock();

  filterPanDelta(lock, 0, 20);
  assert.equal(lock.axis, 'y');
  assert.deepEqual(filterPanDelta(lock, 80, 5), { dx: 0, dy: 5 });
  assert.deepEqual(filterPanDelta(lock, -30, 0), { dx: 0, dy: 0 });
});
