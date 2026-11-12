import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });

Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });

test('a graph is one object that carries its spec through save and load, and is rebuilt in place when edited', async () => {
  const { Canvas, util } = await import('fabric');
  const { buildGraphObject, graphSpecOf, replaceGraphObject } = await import('./graphObject');
  const canvas = new Canvas(undefined, { width: 800, height: 600 });
  const graph = buildGraphObject({ mode: 'xy', xMin: -5, xMax: 5, yMin: -5, yMax: 5 }, 0.5);

  graph.set({ left: 100, top: 80 });
  graph.setCoords();
  canvas.add(graph);

  assert.deepEqual(graphSpecOf(graph), { mode: 'xy', xMin: -5, xMax: 5, yMin: -5, yMax: 5 });
  assert.equal(graphSpecOf({}), null);

  // Save → load: still a graph.
  const json = graph.toObject() as Record<string, unknown>;

  assert.ok(json.wbGraph, 'the spec is saved with the object');

  const [revived] = await util.enlivenObjects([json]);

  assert.deepEqual(graphSpecOf(revived), { mode: 'xy', xMin: -5, xMax: 5, yMin: -5, yMax: 5 });

  // Edit: x-axis alone, 0…10 — same corner, same scale, still one object on the canvas.
  const corner = graph.getPointByOrigin('left', 'top');
  const next = replaceGraphObject(canvas as never, graph, { mode: 'x', xMin: 0, xMax: 10, yMin: -5, yMax: 5 });
  const after = next.getPointByOrigin('left', 'top');

  assert.equal(canvas.getObjects().length, 1);
  assert.deepEqual(graphSpecOf(next)?.mode, 'x');
  assert.ok(Math.abs(after.x - corner.x) < 0.01 && Math.abs(after.y - corner.y) < 0.01, 'the graph stays where it was');
  assert.equal(next.scaleX, 0.5);
});
