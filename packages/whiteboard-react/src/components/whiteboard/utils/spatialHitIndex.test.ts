import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSpatialHitIndex, type BBox } from './spatialHitIndex';

const box = (minX: number, minY: number, maxX: number, maxY: number): BBox => ({
  minX,
  minY,
  maxX,
  maxY,
});

test('queryPoint hits an object containing the point and misses far-away objects', () => {
  const index = createSpatialHitIndex();

  index.insert('near', box(0, 0, 100, 100));
  index.insert('far', box(5000, 5000, 5100, 5100));

  const hits = index.queryPoint(50, 50);

  assert.deepEqual(hits, ['near']);
});

test('queryBBox returns intersecting objects and excludes non-intersecting ones', () => {
  const index = createSpatialHitIndex();

  index.insert('a', box(0, 0, 100, 100));
  index.insert('b', box(90, 90, 200, 200));
  index.insert('c', box(1000, 1000, 1100, 1100));

  const hits = index.queryBBox(box(50, 50, 150, 150));

  assert.deepEqual(new Set(hits), new Set(['a', 'b']));
  assert.ok(!hits.includes('c'));
});

test('queryBBox excludes objects in the same cell that do not actually intersect', () => {
  // cellSize 256: both objects live in cell (0,0) but do not overlap.
  const index = createSpatialHitIndex(256);

  index.insert('left', box(0, 0, 10, 10));
  index.insert('right', box(200, 200, 240, 240));

  const hits = index.queryBBox(box(0, 0, 12, 12));

  assert.deepEqual(hits, ['left']);
});

test('a large object spanning many cells is found from any covered cell', () => {
  const index = createSpatialHitIndex(100);

  // Spans cells (0,0) through (9,9).
  index.insert('big', box(0, 0, 1000, 1000));

  assert.deepEqual(index.queryPoint(10, 10), ['big']);
  assert.deepEqual(index.queryPoint(950, 50), ['big']);
  assert.deepEqual(index.queryPoint(500, 999), ['big']);

  // A point outside its bbox must NOT return it, even though the broad grid
  // might bucket the query nearby.
  assert.deepEqual(index.queryPoint(2000, 2000), []);
  assert.deepEqual(index.queryPoint(-5, -5), []);
});

test('update moves an object: old location no longer matches, new location does', () => {
  const index = createSpatialHitIndex();

  index.insert('mover', box(0, 0, 50, 50));
  assert.deepEqual(index.queryPoint(25, 25), ['mover']);

  index.update('mover', box(1000, 1000, 1050, 1050));

  assert.deepEqual(index.queryPoint(25, 25), []);
  assert.deepEqual(index.queryPoint(1025, 1025), ['mover']);
  assert.equal(index.size(), 1);
});

test('insert of an existing id behaves like update', () => {
  const index = createSpatialHitIndex();

  index.insert('x', box(0, 0, 50, 50));
  index.insert('x', box(500, 500, 550, 550));

  assert.deepEqual(index.queryPoint(25, 25), []);
  assert.deepEqual(index.queryPoint(525, 525), ['x']);
  assert.equal(index.size(), 1);
});

test('remove makes an object unfindable, decrements size, and is a no-op for missing ids', () => {
  const index = createSpatialHitIndex();

  index.insert('a', box(0, 0, 50, 50));
  index.insert('b', box(100, 100, 150, 150));
  assert.equal(index.size(), 2);

  index.remove('a');

  assert.equal(index.size(), 1);
  assert.deepEqual(index.queryPoint(25, 25), []);
  assert.deepEqual(index.queryPoint(125, 125), ['b']);

  // No-op for a missing id.
  index.remove('does-not-exist');
  assert.equal(index.size(), 1);
});

test('two objects in the same cell are both returned when the query overlaps both', () => {
  const index = createSpatialHitIndex(256);

  index.insert('p', box(10, 10, 60, 60));
  index.insert('q', box(40, 40, 90, 90));

  const hits = index.queryBBox(box(45, 45, 55, 55));

  assert.deepEqual(new Set(hits), new Set(['p', 'q']));
});

test('non-finite bbox is safely ignored (no throw, size unaffected)', () => {
  const index = createSpatialHitIndex();

  index.insert('valid', box(0, 0, 50, 50));

  assert.doesNotThrow(() => {
    index.insert('nanBox', box(NaN, 0, 50, 50));
    index.insert('infBox', box(0, 0, Infinity, 50));
    index.update('valid2', box(0, NaN, 50, 50));
  });

  assert.equal(index.size(), 1);
  assert.deepEqual(index.queryPoint(25, 25), ['valid']);

  // Querying with a non-finite bbox returns nothing rather than throwing.
  assert.deepEqual(index.queryBBox(box(NaN, 0, 10, 10)), []);
});

test('updating a previously inserted id to a non-finite bbox removes it', () => {
  const index = createSpatialHitIndex();

  index.insert('temp', box(0, 0, 50, 50));
  assert.equal(index.size(), 1);

  index.update('temp', box(NaN, 0, 50, 50));

  assert.equal(index.size(), 0);
  assert.deepEqual(index.queryPoint(25, 25), []);
});

test('clear() empties the index', () => {
  const index = createSpatialHitIndex();

  index.insert('a', box(0, 0, 50, 50));
  index.insert('b', box(100, 100, 150, 150));
  assert.equal(index.size(), 2);

  index.clear();

  assert.equal(index.size(), 0);
  assert.deepEqual(index.queryPoint(25, 25), []);
  assert.deepEqual(index.queryPoint(125, 125), []);
});
