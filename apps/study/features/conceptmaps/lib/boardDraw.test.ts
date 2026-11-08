import type { KeyValueStore } from '../notes/links';
import type { ReferenceMap } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boardGraphInput,
  clearBoardDraw,
  forgetReferencePage,
  graphSignature,
  mapsDrawnOnPage,
  peekBoardDraw,
  PENDING_DRAW_KEY,
  queueBoardDraw,
  referencePageFor,
  referencePageTitle,
  rememberReferencePage,
} from './boardDraw';
import { PLATE_TECTONICS_REFERENCE } from './diagram.fixture';

function memoryStore(seed: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...seed };

  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const graph: ReferenceMap = { ...PLATE_TECTONICS_REFERENCE, provenance: { kind: 'model' } as unknown as ReferenceMap['provenance'] };

test('a queued draw is read back for its page only, without provenance, until cleared', () => {
  const store = memoryStore();

  assert.equal(queueBoardDraw(store, 'p1', graph, 1000), true);
  const pending = peekBoardDraw(store, 'p1', 2000);

  assert.ok(pending);
  assert.equal(pending.nodes.length, graph.nodes.length);
  assert.equal('provenance' in pending, false);
  assert.equal(peekBoardDraw(store, 'p2', 2000), null);
  // Peek does not consume: a board that unmounts before drawing still finds it next time.
  assert.ok(peekBoardDraw(store, 'p1', 3000));
  clearBoardDraw(store, 'p1');
  assert.equal(peekBoardDraw(store, 'p1', 3000), null);
});

test('stale queued draws expire and are swept on the next queue', () => {
  const store = memoryStore();
  const day = 24 * 60 * 60 * 1000;

  queueBoardDraw(store, 'old', graph, 0);
  assert.equal(peekBoardDraw(store, 'old', day + 1), null);
  queueBoardDraw(store, 'new', graph, day + 1);
  assert.deepEqual(Object.keys(JSON.parse(store.data[PENDING_DRAW_KEY]!)), ['new']);
});

test('corrupt storage reads as nothing; no store never throws', () => {
  const store = memoryStore({ [PENDING_DRAW_KEY]: '{not json' });

  assert.equal(peekBoardDraw(store, 'p1'), null);
  assert.equal(queueBoardDraw(null, 'p1', graph), false);
  assert.equal(peekBoardDraw(null, 'p1'), null);
  assert.equal(referencePageFor(null, 'm1'), null);
});

test('reference pages: per map, reverse lookup by page, forget', () => {
  const store = memoryStore();

  rememberReferencePage(store, 'm1', { pageId: 'p1', signature: graphSignature(graph) });
  rememberReferencePage(store, 'm2', { pageId: 'p9', signature: '' });
  assert.deepEqual(referencePageFor(store, 'm1'), { pageId: 'p1', signature: graphSignature(graph) });
  assert.deepEqual(mapsDrawnOnPage(store, 'p1'), ['m1']);
  forgetReferencePage(store, 'm1');
  assert.equal(referencePageFor(store, 'm1'), null);
});

test('graphSignature: same nodes and links → same; a changed label → different', () => {
  const copy: ReferenceMap = JSON.parse(JSON.stringify(PLATE_TECTONICS_REFERENCE));

  assert.equal(graphSignature(copy), graphSignature(PLATE_TECTONICS_REFERENCE));
  copy.edges[0]!.label = 'suggested';
  assert.notEqual(graphSignature(copy), graphSignature(PLATE_TECTONICS_REFERENCE));
});

test('boardGraphInput: layered 0..1 bbox arrays and labelled end-arrows in the engine wire shape', () => {
  const input = boardGraphInput(PLATE_TECTONICS_REFERENCE) as {
    title: string;
    nodes: Array<{ bbox?: number[]; level?: number }>;
    edges: Array<{ arrow: string; label?: string }>;
  };

  assert.equal(input.title, PLATE_TECTONICS_REFERENCE.title);
  // Boxes are the viewer's layered layout, normalised — not the backend's text-blind grid.
  assert.ok(input.nodes.every((node) => node.bbox?.length === 4 && node.bbox.every((value) => value >= 0 && value <= 1)));
  assert.notDeepEqual(input.nodes[0]!.bbox, [0.1, 0.05, 0.2, 0.1]);
  assert.equal(input.nodes[0]!.level, 0);
  assert.ok(input.edges.every((edge) => edge.arrow === 'end'));
  assert.equal(input.edges[0]!.label, 'proposed');
  assert.equal(referencePageTitle('Plate Tectonics'), 'Plate Tectonics — reference map');
  assert.equal(referencePageTitle('  '), 'Concept map — reference map');
});
