import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assignLevels, layoutConceptGraph } from './layout';

const nodes = [
  { id: 'a', text: 'Convection' },
  { id: 'b', text: 'Seafloor spreading' },
  { id: 'c', text: 'Subduction' },
  { id: 'd', text: 'Transform fault' },
  { id: 'e', text: 'Hot spot' },
];
const edges = [
  { from: 'a', to: 'b', label: 'drives' },
  { from: 'a', to: 'c', label: 'drives' },
  { from: 'b', to: 'd' },
  { from: 'd', to: 'a', label: 'cycle' },
];

test('assignLevels: BFS from roots, islands under everything, explicit levels kept', () => {
  const levels = assignLevels(nodes, edges);

  assert.equal(levels.get('a'), 0);
  assert.equal(levels.get('b'), 1);
  assert.equal(levels.get('c'), 1);
  assert.equal(levels.get('d'), 2);
  assert.equal(levels.get('e'), 3);

  const explicit = assignLevels(
    [
      { id: 'x', text: 'X', level: 4 },
      { id: 'y', text: 'Y' },
    ],
    [{ from: 'y', to: 'x' }],
  );

  assert.equal(explicit.get('x'), 4);
  assert.equal(explicit.get('y'), 0);
});

test('assignLevels: a pure cycle still gets a root', () => {
  const levels = assignLevels(
    [
      { id: 'p', text: 'P' },
      { id: 'q', text: 'Q' },
    ],
    [
      { from: 'p', to: 'q' },
      { from: 'q', to: 'p' },
    ],
  );

  assert.equal(levels.get('p'), 0);
  assert.equal(levels.get('q'), 1);
});

test('layoutConceptGraph: rows stack, siblings never overlap, edges anchor on box edges', () => {
  const layout = layoutConceptGraph(nodes, edges);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const a = byId.get('a')!;
  const b = byId.get('b')!;
  const c = byId.get('c')!;

  assert.ok(b.y > a.y && c.y === b.y);
  assert.ok(b.x + b.w <= c.x || c.x + c.w <= b.x, 'siblings do not overlap');
  assert.ok(layout.nodes.every((node) => node.x >= 0 && node.x + node.w <= layout.width));
  assert.ok(layout.nodes.every((node) => node.y >= 0 && node.y + node.h <= layout.height));

  const down = layout.edges.find((edge) => edge.from === 'a' && edge.to === 'b')!;

  assert.equal(down.y1, a.y + a.h);
  assert.equal(down.y2, b.y);
  assert.equal(down.label, 'drives');

  const up = layout.edges.find((edge) => edge.from === 'd' && edge.to === 'a')!;

  assert.equal(up.y1, byId.get('d')!.y);
  assert.equal(up.y2, a.y + a.h);

  const unlabeled = layout.edges.find((edge) => edge.from === 'b' && edge.to === 'd')!;

  assert.equal(unlabeled.label, null);
});

test('layoutConceptGraph: long labels are capped, short ones get the minimum width', () => {
  const layout = layoutConceptGraph(
    [
      { id: 'l', text: 'A very long definition that goes on and on and on forever' },
      { id: 's', text: 'Hi' },
    ],
    [],
  );
  const long = layout.nodes.find((node) => node.id === 'l')!;
  const short = layout.nodes.find((node) => node.id === 's')!;

  assert.equal(long.w, 220);
  assert.equal(short.w, 96);
});

test('layoutConceptGraph: empty graph is a tiny empty canvas', () => {
  const layout = layoutConceptGraph([], []);

  assert.deepEqual(layout.nodes, []);
  assert.deepEqual(layout.edges, []);
  assert.ok(layout.width > 0 && layout.height > 0);
});

test('layoutConceptGraph keeps the backend boxes (shifted to the padding) and clips arrows to them', () => {
  const layout = layoutConceptGraph(
    [
      { id: 'a', text: 'Magma', bbox: [100, 50, 100, 40] },
      { id: 'b', text: 'Igneous rock', bbox: [100, 250, 100, 40] },
    ],
    [{ from: 'a', to: 'b', label: 'cools into' }],
    { padding: 10 },
  );

  assert.deepEqual(
    layout.nodes.map((node) => [node.x, node.y, node.w, node.h]),
    [
      [10, 10, 100, 40],
      [10, 210, 100, 40],
    ],
  );
  assert.equal(layout.width, 120);
  assert.equal(layout.height, 260);
  const [edge] = layout.edges;

  // Straight down: leaves the bottom of «Magma», enters the top of «Igneous rock».
  assert.deepEqual([edge?.x1, edge?.y1, edge?.x2, edge?.y2], [60, 50, 60, 210]);
  assert.equal(edge?.label, 'cools into');
});

test('layoutConceptGraph scales the live backend\'s fractional boxes to a readable drawing', () => {
  const layout = layoutConceptGraph(
    [
      { id: 'a', text: 'Origin and Evolution of Magma', bbox: [0.4, 0.05, 0.2, 0.1] },
      { id: 'b', text: 'Decompression melting', bbox: [0.1, 0.65, 0.1125, 0.1] },
    ],
    [{ from: 'a', to: 'b', label: 'includes' }],
    { padding: 10 },
  );

  assert.deepEqual(
    layout.nodes.map((node) => [node.x, node.y, node.w, node.h].map(Math.round)),
    [
      [430, 10, 280, 64],
      [10, 394, 158, 64],
    ],
  );
  assert.ok(layout.width > 700 && layout.height > 450);
});

test('layoutConceptGraph falls back to layers when any node has no box', () => {
  const layout = layoutConceptGraph(
    [
      { id: 'a', text: 'A', bbox: [0, 0, 50, 20] },
      { id: 'b', text: 'B' },
    ],
    [{ from: 'a', to: 'b' }],
  );

  assert.ok(layout.nodes[1]!.y > layout.nodes[0]!.y);
  assert.equal(layout.nodes[0]!.h, 44);
});
