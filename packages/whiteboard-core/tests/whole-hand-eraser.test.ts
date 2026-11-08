import test from 'node:test';
import assert from 'node:assert/strict';

import { computeWholeHandEraserCircle } from '../src/whole-hand-eraser';

const OPTS = { minSize: 80, fingerPadding: 30, maxSize: 600 };

test('no contacts → null', () => {
  assert.equal(computeWholeHandEraserCircle([], OPTS), null);
});

test('single contact → centred on it, floored to minSize', () => {
  const c = computeWholeHandEraserCircle([{ x: 100, y: 200 }], OPTS);

  assert.ok(c);
  assert.equal(c!.x, 100);
  assert.equal(c!.y, 200);
  // 2*0 + 2*30 = 60 < minSize 80 → floored.
  assert.equal(c!.size, 80);
});

test('centroid is the average of the contacts', () => {
  const c = computeWholeHandEraserCircle(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ],
    OPTS,
  );

  assert.ok(c);
  assert.equal(c!.x, 50);
  assert.equal(c!.y, 50);
});

test('circle COVERS all contacts (radius >= max distance from centroid)', () => {
  const contacts = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 100, y: 160 },
    { x: 40, y: 90 },
    { x: 170, y: 120 },
  ];
  const c = computeWholeHandEraserCircle(contacts, OPTS)!;
  const radius = c.size / 2;

  for (const p of contacts) {
    const d = Math.hypot(p.x - c.x, p.y - c.y);

    assert.ok(radius >= d - 1e-9, `contact at ${d.toFixed(1)}px must be within radius ${radius.toFixed(1)}px`);
  }
});

test('spreading the fingers grows the eraser; pinching shrinks it', () => {
  const tight = computeWholeHandEraserCircle(
    [
      { x: 90, y: 100 },
      { x: 110, y: 100 },
    ],
    OPTS,
  )!;
  const wide = computeWholeHandEraserCircle(
    [
      { x: 0, y: 100 },
      { x: 400, y: 100 },
    ],
    OPTS,
  )!;

  assert.ok(wide.size > tight.size, `wide ${wide.size} should exceed tight ${tight.size}`);
  // wide span = 400 across → 2*200 + 2*30 = 460.
  assert.equal(wide.size, 460);
  // tight span = 20 across → 2*10 + 60 = 80 == minSize floor.
  assert.equal(tight.size, 80);
});

test('huge spread is capped at maxSize', () => {
  const c = computeWholeHandEraserCircle(
    [
      { x: 0, y: 0 },
      { x: 5000, y: 0 },
    ],
    OPTS,
  )!;

  assert.equal(c.size, 600);
});
