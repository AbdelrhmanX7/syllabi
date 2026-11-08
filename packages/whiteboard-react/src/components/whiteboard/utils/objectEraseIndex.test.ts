import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BBox } from './spatialHitIndex';
import { createObjectEraseIndex } from './objectEraseIndex';

type Obj = { name: string; box: BBox; half?: number; mark?: boolean; boxReads: number };

const obj = (name: string, x: number, y: number, size = 10, extra: Partial<Obj> = {}): Obj => ({
  box: { minX: x, minY: y, maxX: x + size, maxY: y + size },
  boxReads: 0,
  name,
  ...extra,
});

const makeIndex = () =>
  createObjectEraseIndex<Obj>({
    bboxOf: (o) => {
      o.boxReads += 1;

      return o.box;
    },
    halfStrokeOf: (o) => o.half ?? 0,
    isIndexable: (o) => !o.mark,
  });

const names = (list: Obj[]) => list.map((o) => o.name);

test('the first query builds from the canvas list; candidates come back topmost first', () => {
  const index = makeIndex();
  const a = obj('a', 0, 0);
  const b = obj('b', 5, 5);
  const far = obj('far', 1000, 1000);

  index.sync([a, b, far]);
  assert.deepEqual(names(index.query({ minX: 0, minY: 0, maxX: 20, maxY: 20 })), ['b', 'a']);
  assert.equal(index.rebuildCount(), 1);
});

test('an empty answer is trusted — blank paper costs no fallback to every object', () => {
  const index = makeIndex();
  const objects = [obj('a', 0, 0), obj('b', 100, 100)];

  index.sync(objects);
  assert.deepEqual(index.query({ minX: 500, minY: 500, maxX: 510, maxY: 510 }), []);
});

test('erasing does NOT rebuild: a removal drops just that object', () => {
  const index = makeIndex();
  const objects = Array.from({ length: 2000 }, (_, i) => obj(`s${i}`, (i % 50) * 20, Math.floor(i / 50) * 20));

  index.sync(objects);
  assert.equal(index.rebuildCount(), 1);

  // Erase 100 strokes one at a time, querying between each — the old index rebuilt (2000 box reads) each time.
  for (let i = 0; i < 100; i += 1) {
    const [victim] = objects.splice(0, 1);

    index.noteRemoved(victim);
    index.sync(objects);
    index.query({ minX: 0, minY: 0, maxX: 40, maxY: 40 });
  }

  assert.equal(index.rebuildCount(), 1, 'no rebuild during the erase');
  assert.ok(
    objects.every((o) => o.boxReads === 1),
    'no surviving box was recomputed',
  );
  assert.equal(index.size(), 1900);
  assert.ok(!names(index.query({ minX: 0, minY: 0, maxX: 5, maxY: 5 })).includes('s0'), 'the erased one is gone');
});

test('an added object is boxed lazily at the next sync, and sorts above older ones', () => {
  const index = makeIndex();
  const a = obj('a', 0, 0);
  const objects = [a];

  index.sync(objects);

  const late = obj('late', 2, 2);

  objects.push(late);
  index.noteAdded(late);
  assert.equal(late.boxReads, 0, 'nothing computed on the add event itself');

  index.sync(objects);
  assert.deepEqual(names(index.query({ minX: 0, minY: 0, maxX: 5, maxY: 5 })), ['late', 'a']);
  assert.equal(index.rebuildCount(), 1);
});

test('a modified object is re-boxed where it is now', () => {
  const index = makeIndex();
  const a = obj('a', 0, 0);

  index.sync([a]);
  a.box = { minX: 300, minY: 300, maxX: 310, maxY: 310 };
  index.noteModified(a);
  index.sync([a]);
  assert.deepEqual(index.query({ minX: 0, minY: 0, maxX: 20, maxY: 20 }), []);
  assert.deepEqual(names(index.query({ minX: 295, minY: 295, maxX: 305, maxY: 305 })), ['a']);
});

test('a modified object the canvas does not hold (a multi-selection) forces a rebuild', () => {
  const index = makeIndex();
  const a = obj('a', 0, 0);

  index.sync([a]);
  index.noteModified(obj('selection', 0, 0));
  index.sync([a]);
  assert.equal(index.rebuildCount(), 2);
});

test('a count the events did not explain (a change we never heard of) rebuilds — the consistency net', () => {
  const index = makeIndex();
  const a = obj('a', 0, 0);
  const sneaky = obj('sneaky', 1, 1);

  index.sync([a]);
  index.sync([a, sneaky]);
  assert.equal(index.rebuildCount(), 2);
  assert.deepEqual(names(index.query({ minX: 0, minY: 0, maxX: 5, maxY: 5 })), ['sneaky', 'a']);
});

test('markDirty rebuilds on the next sync (page load, pin flip)', () => {
  const index = makeIndex();
  const a = obj('a', 0, 0);

  index.sync([a]);
  index.markDirty();
  index.sync([a]);
  assert.equal(index.rebuildCount(), 2);
});

test('eraser marks are counted but never candidates', () => {
  const index = makeIndex();
  const objects = [obj('ink', 0, 0), obj('mark', 0, 0, 10, { mark: true })];

  index.sync(objects);
  index.sync(objects);
  assert.equal(index.rebuildCount(), 1, 'the unindexed mark does not trip the count check');
  assert.deepEqual(names(index.query({ minX: 0, minY: 0, maxX: 5, maxY: 5 })), ['ink']);
});

test('maxHalfStroke is the thickest indexed stroke (an upper bound — a removal never lowers it)', () => {
  const index = makeIndex();
  const thick = obj('thick', 0, 0, 10, { half: 12 });
  const objects = [obj('thin', 0, 0, 10, { half: 1 }), thick];

  index.sync(objects);
  assert.equal(index.maxHalfStroke(), 12);
  objects.pop();
  index.noteRemoved(thick);
  index.sync(objects);
  assert.equal(index.maxHalfStroke(), 12, 'over-padding is safe: more candidates, never a missed hit');
});
