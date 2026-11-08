import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BoardHistoryModel, samePageState } from './boardHistory';

import type { HistoryEntry, PageState } from './boardHistory';

const DOC = 'document';

/** Undo the newest entry and settle it as applied; returns the states it restored. */
function undo(model: BoardHistoryModel, scope = DOC): HistoryEntry | null {
  const entry = model.beginUndo(scope);

  if (entry) model.settleUndo(scope, entry);

  return entry;
}

function redo(model: BoardHistoryModel, scope = DOC): HistoryEntry | null {
  const entry = model.beginRedo(scope);

  if (entry) model.settleRedo(scope, entry);

  return entry;
}

function restored(entry: HistoryEntry | null, direction: 'undo' | 'redo'): Record<string, PageState> {
  assert.ok(entry && entry.kind === 'content');

  return Object.fromEntries(entry.changes.map((change) => [change.pageId, direction === 'undo' ? change.before : change.after]));
}

test('draw A, B, C → undo ×2 → redo ×1 walks one stroke at a time', () => {
  const model = new BoardHistoryModel();

  model.seedPage('p1', []);
  model.commit(DOC, [{ pageId: 'p1', state: ['A'] }]);
  model.commit(DOC, [{ pageId: 'p1', state: ['A', 'B'] }]);
  model.commit(DOC, [{ pageId: 'p1', state: ['A', 'B', 'C'] }]);

  assert.deepEqual(restored(undo(model), 'undo'), { p1: ['A', 'B'] });
  assert.deepEqual(restored(undo(model), 'undo'), { p1: ['A'] });
  assert.deepEqual(model.getCommitted('p1'), ['A']);
  assert.deepEqual(restored(redo(model), 'redo'), { p1: ['A', 'B'] });
  assert.equal(model.canRedo(DOC), true);
  assert.equal(model.canUndo(DOC), true);
});

test('one document stack across pages: page 1, then page 4 → two undos walk back through both', () => {
  const model = new BoardHistoryModel();

  model.seedPage('p1', []);
  model.commit(DOC, [{ pageId: 'p1', state: ['ink-1'] }]);
  // Page 1 scrolled out of the window, page 4 hydrated: the stack is NOT a new one.
  model.seedPage('p4', []);
  model.commit(DOC, [{ pageId: 'p4', state: ['ink-4'] }]);

  assert.deepEqual(restored(undo(model), 'undo'), { p4: [] });
  assert.deepEqual(restored(undo(model), 'undo'), { p1: [] });
  assert.equal(model.canUndo(DOC), false);
});

test('a new action clears redo; an unchanged commit does not', () => {
  const model = new BoardHistoryModel();

  model.seedPage('p1', []);
  model.commit(DOC, [{ pageId: 'p1', state: ['A'] }]);
  model.commit(DOC, [{ pageId: 'p1', state: ['A', 'B'] }]);
  undo(model);
  assert.equal(model.canRedo(DOC), true);

  // Same state again (a checkpoint with nothing new): no entry, redo survives.
  assert.equal(model.commit(DOC, [{ pageId: 'p1', state: ['A'] }]), null);
  assert.equal(model.canRedo(DOC), true);

  model.commit(DOC, [{ pageId: 'p1', state: ['A', 'D'] }]);
  assert.equal(model.canRedo(DOC), false);
  assert.deepEqual(restored(undo(model), 'undo'), { p1: ['A'] });
});

test('an erase swipe committed once is ONE entry, however many objects it took', () => {
  const model = new BoardHistoryModel();
  const ink = Array.from({ length: 40 }, (_, index) => `s${index}`);

  model.seedPage('p1', ink);
  model.commit(DOC, [{ pageId: 'p1', state: ink.filter((_, index) => index % 2 === 0) }]);

  assert.deepEqual(restored(undo(model), 'undo'), { p1: ink });
  assert.equal(model.canUndo(DOC), false);
});

test('a stroke dragged across a page edge is one entry touching both pages', () => {
  const model = new BoardHistoryModel();

  model.seedPage('p1', ['x']);
  model.seedPage('p2', []);

  const entry = model.commit(DOC, [
    { pageId: 'p1', state: [] },
    { pageId: 'p2', state: ['x-moved'] },
  ]);

  assert.equal(entry?.changes.length, 2);
  assert.deepEqual(restored(undo(model), 'undo'), { p1: ['x'], p2: [] });
});

test('reload with the same content keeps the stack; different content clears the stacks that mention it', () => {
  const model = new BoardHistoryModel();

  model.seedPage('p1', []);
  model.seedPage('p2', []);
  model.commit('p1', [{ pageId: 'p1', state: ['A'] }]);
  model.commit('p2', [{ pageId: 'p2', state: ['B'] }]);

  // Autosave round trip / page coming back into view: same strings, new array.
  assert.equal(model.seedPage('p1', ['A'].slice()), false);
  assert.equal(model.canUndo('p1'), true);

  // Changed elsewhere: p1's stack is gone, p2's is untouched.
  assert.equal(model.seedPage('p1', ['A', 'remote']), true);
  assert.equal(model.canUndo('p1'), false);
  assert.equal(model.canUndo('p2'), true);
  assert.deepEqual(model.getCommitted('p1'), ['A', 'remote']);
});

test('a page first seen by a commit is its baseline, not an undo step', () => {
  const model = new BoardHistoryModel();

  assert.equal(model.commit(DOC, [{ pageId: 'p9', state: ['old'] }]), null);
  assert.equal(model.canUndo(DOC), false);
  model.commit(DOC, [{ pageId: 'p9', state: ['old', 'new'] }]);
  assert.deepEqual(restored(undo(model), 'undo'), { p9: ['old'] });
});

test('sheet insert/delete entries round-trip and interleave with ink', () => {
  const model = new BoardHistoryModel<{ id: string }>();
  const sheet = { id: 'sheet' };

  model.recordPageList(DOC, 'insert-page', sheet, 'sheet', 2);
  model.seedPage('sheet', []);
  model.commit(DOC, [{ pageId: 'sheet', state: ['note'] }]);

  const inkUndo = model.beginUndo(DOC);

  assert.equal(inkUndo?.kind, 'content');
  model.settleUndo(DOC, inkUndo!);

  const insertUndo = model.beginUndo(DOC);

  assert.equal(insertUndo?.kind, 'insert-page');
  assert.equal(insertUndo?.kind === 'insert-page' && insertUndo.index, 2);
  model.settleUndo(DOC, insertUndo!);
  assert.equal(model.hasCommitted('sheet'), false);

  assert.equal(model.beginRedo(DOC)?.kind, 'insert-page');
});

test('a step that could not be applied goes back where it was', () => {
  const model = new BoardHistoryModel();

  model.seedPage('p1', []);
  model.commit(DOC, [{ pageId: 'p1', state: ['A'] }]);

  const entry = model.beginUndo(DOC)!;

  model.cancelUndo(DOC, entry);
  assert.equal(model.canUndo(DOC), true);
  assert.equal(model.canRedo(DOC), false);
  assert.deepEqual(model.getCommitted('p1'), ['A']);
});

test('memory ceiling counts only the strings an entry adds, and the newest entry always stays', () => {
  const big = 'x'.repeat(1000);
  const model = new BoardHistoryModel({ maxBytes: 2500 });
  let state: string[] = [];

  model.seedPage('p1', state);

  for (let index = 0; index < 10; index += 1) {
    state = [...state, `${big}${index}`];
    model.commit(DOC, [{ pageId: 'p1', state }]);
  }

  // ~1000 per entry (the shared prefix is free) → two entries fit 2500.
  let undone = 0;

  while (undo(model)) undone += 1;

  assert.equal(undone, 2);

  const tiny = new BoardHistoryModel({ maxBytes: 10 });

  tiny.seedPage('p1', []);
  tiny.commit(DOC, [{ pageId: 'p1', state: [big] }]);
  assert.equal(tiny.canUndo(DOC), true);
});

test('samePageState compares element-wise', () => {
  assert.equal(samePageState(['a', 'b'], ['a', 'b']), true);
  assert.equal(samePageState(['a', 'b'], ['b', 'a']), false);
  assert.equal(samePageState(['a'], undefined), false);
});

test('a reload that rewrites the same objects with coordinate noise keeps the stack, re-keyed', () => {
  const model = new BoardHistoryModel();
  const live = (width: number) => JSON.stringify({ type: 'Path', width, path: [['M', 0, 0], ['L', 60, 10]] });

  model.seedPage('p1', [live(10)]);
  model.commit('p1', [{ pageId: 'p1', state: [live(10), live(60.008)] }]);

  // Leaving and reopening the page: Fabric re-derives the box from the rounded points.
  assert.equal(model.seedPage('p1', [live(10), live(60)]), false);
  assert.equal(model.canUndo('p1'), true);

  const entry = model.beginUndo('p1');

  assert.ok(entry?.kind === 'content');
  // The recorded "after" now names the reloaded object, so a restore keeps the live instances.
  assert.deepEqual(entry.changes[0]?.after, [live(10), live(60)]);
  assert.deepEqual(entry.changes[0]?.before, [live(10)]);

  // A real difference is still a reset.
  model.cancelUndo('p1', entry);
  assert.equal(model.seedPage('p1', [live(10), live(75)]), true);
  assert.equal(model.canUndo('p1'), false);
});
