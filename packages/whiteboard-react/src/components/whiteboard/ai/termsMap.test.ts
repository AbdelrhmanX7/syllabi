import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  arrowHeadPoints,
  clusterBoxes,
  clusterInk,
  handEllipsePoints,
  parseTermsMap,
  placeBelowFree,
  planTermsMap,
  smoothPath,
} from './termsMap';
import { seededRandom } from './handwritingLayout';

import type { SceneRect } from './types';

const r = (left: number, top: number, width: number, height: number): SceneRect => ({ left, top, width, height });

// --- clustering -------------------------------------------------------------------------------

test('clusterInk: letters of one word join, words a word-space apart join, terms written apart split', () => {
  // «plate tectonics» (two words, 8 apart) on one line; «mantle» far right; «crust» on the next line.
  const strokes = [
    r(0, 0, 18, 20), r(20, 2, 16, 18), r(38, 0, 15, 20), // plate
    r(61, 0, 20, 20), r(83, 1, 30, 19), // tectonics (gap 8 < 0.9 × 20)
    r(300, 0, 20, 20), r(322, 0, 22, 20), // mantle
    r(0, 80, 20, 20), r(24, 80, 20, 20), // crust
    r(26, 74, 3, 3), // a dot just above crust joins it
  ];
  const clusters = clusterInk(strokes, { letterHeight: 20 });

  assert.equal(clusters.length, 3);
  assert.deepEqual(clusters.map((cluster) => cluster.id), ['c1', 'c2', 'c3']);
  assert.deepEqual(clusters[0]!.members.sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.deepEqual(clusters[1]!.members.sort((a, b) => a - b), [5, 6]);
  assert.deepEqual(clusters[2]!.members.sort((a, b) => a - b), [7, 8, 9]);
  assert.deepEqual(clusters[0]!.rect, { left: 0, top: 0, width: 113, height: 20 });
});

test('clusterInk: reading order runs left to right in a row', () => {
  const strokes = [r(0, 0, 20, 20), r(200, 2, 20, 20)];

  assert.deepEqual(clusterInk(strokes, { letterHeight: 20 }).map((cluster) => cluster.members[0]), [0, 1]);
  assert.deepEqual(clusterInk([]), []);
});

test('clusterBoxes: normalised into the captured region', () => {
  const [box] = clusterBoxes([{ id: 'c1', rect: r(50, 25, 100, 50), members: [0] }], r(0, 0, 200, 100));

  assert.deepEqual(box, { id: 'c1', bbox: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
});

// --- parsing ----------------------------------------------------------------------------------

test('parseTermsMap: every cluster lands in exactly one node; unknown/duplicate claims are dropped', () => {
  const result = parseTermsMap(
    {
      terms_map: {
        title: 'Earth',
        direction: 'lr',
        nodes: [
          { id: 'root', text: 'Earth layers', clusterIds: ['c1', 'c2'], level: 0, focus: true },
          { id: 'a', text: 'Crust', clusterIds: ['c3', 'c2', 'c99'], level: 1 },
          { id: 'ghost', text: 'Ghost', clusterIds: ['c1'] },
        ],
        edges: [
          { from: 'root', to: 'a', label: 'includes' },
          { from: 'root', to: 'a', label: 'again' },
          { from: 'a', to: 'a', label: 'self' },
          { from: 'Earth layers', to: 'Ghost', label: 'by text' },
          { from: 'root', to: 'nope' },
        ],
        extra: [{ id: 'm', text: 'Mantle', level: 1 }, { text: '' }],
      },
    },
    ['c1', 'c2', 'c3', 'c4'],
  );

  assert.ok(result);
  assert.equal(result.title, 'Earth');
  assert.equal(result.direction, 'LR');
  assert.deepEqual(result.nodes.map((node) => [node.id, node.clusterIds]), [
    ['root', ['c1', 'c2']],
    ['a', ['c3']],
    ['t_c4', ['c4']], // the cluster the model skipped is still drawn
  ]);
  assert.equal(result.nodes[0]!.focus, true);
  // A node with no ink left becomes an AI-added concept rather than vanishing.
  assert.deepEqual(result.extra.map((item) => item.id), ['ghost', 'm']);
  assert.deepEqual(result.edges, [
    { from: 'root', to: 'a', label: 'includes' },
    { from: 'root', to: 'ghost', label: 'by text' },
  ]);
});

test('parseTermsMap: JSON text, default direction, levels from the edges, garbage → null', () => {
  const result = parseTermsMap(
    'Here: {"nodes":[{"id":"r","text":"A","clusterIds":["c1"]},{"id":"b","text":"B","clusterIds":["c2"]}],"edges":[{"from":"r","to":"b","label":"has"}]}',
    ['c1', 'c2'],
  );

  assert.ok(result);
  assert.equal(result.direction, 'TB');
  assert.deepEqual(result.nodes.map((node) => node.level), [0, 1]);
  assert.equal(parseTermsMap('nope', ['c1']), null);
  assert.equal(parseTermsMap({ nodes: [] }, []), null);
});

// --- hand strokes -----------------------------------------------------------------------------

test('handEllipsePoints: goes round once and overshoots the start; seeded = stable', () => {
  const a = handEllipsePoints(0, 0, 100, 50, seededRandom(7));
  const b = handEllipsePoints(0, 0, 100, 50, seededRandom(7));

  assert.deepEqual(a, b);

  const angles = a.map((p) => Math.atan2(p.y / 50, p.x / 100));
  let swept = 0;

  for (let index = 1; index < angles.length; index += 1) {
    let delta = angles[index]! - angles[index - 1]!;

    if (delta < -Math.PI) delta += Math.PI * 2;
    if (delta > Math.PI) delta -= Math.PI * 2;
    swept += delta;
  }

  assert.ok(swept > Math.PI * 2 + 0.2, `swept ${swept}`);
  // The two ends do not meet exactly.
  assert.ok(Math.hypot(a[0]!.x - a[a.length - 1]!.x, a[0]!.y - a[a.length - 1]!.y) > 1);
  // Radius stays near the ellipse.
  for (const p of a) assert.ok(Math.abs(Math.hypot(p.x / 100, p.y / 50) - 1) < 0.15);
});

test('arrowHeadPoints: both barbs sit behind the tip', () => {
  const [left, tip, right] = arrowHeadPoints({ x: 0, y: 0 }, { x: 0, y: 100 }, 10, seededRandom(1));

  assert.deepEqual(tip, { x: 0, y: 100 });
  assert.ok(left!.y < 100 && right!.y < 100);
  assert.ok(Math.sign(left!.x) !== Math.sign(right!.x));
  assert.match(smoothPath([left!, tip!, right!]), /^M [\d.-]+ [\d.-]+ Q /);
});

// --- the plan ---------------------------------------------------------------------------------

const clusters = new Map<string, SceneRect>([
  ['c1', r(500, 500, 120, 30)],
  ['c2', r(700, 500, 60, 30)],
  ['c3', r(500, 600, 90, 28)],
  ['c4', r(650, 600, 40, 28)],
]);

const sample = () =>
  parseTermsMap(
    {
      direction: 'TB',
      nodes: [
        { id: 'root', text: 'Plate tectonics', clusterIds: ['c2', 'c1'], level: 0 },
        { id: 'a', text: 'Crust', clusterIds: ['c3'], level: 1 },
        { id: 'b', text: 'Mantle', clusterIds: ['c4'], level: 1 },
      ],
      edges: [
        { from: 'root', to: 'a', label: 'moves the' },
        { from: 'root', to: 'b', label: '' },
        { from: 'b', to: 'x', label: 'heated by' },
      ],
      extra: [{ id: 'x', text: 'Core', level: 2 }],
    },
    ['c1', 'c2', 'c3', 'c4'],
  )!;

test('planTermsMap: one ink copy per cluster, an outline per node, dashed only for AI concepts', () => {
  const plan = planTermsMap(sample(), clusters, { letterHeight: 24, seed: 3 });
  const copies = plan.primitives.filter((p) => p.kind === 'ink-copy');
  const outlines = plan.primitives.filter((p) => p.kind === 'outline');

  assert.deepEqual(copies.map((p) => p.kind === 'ink-copy' && p.clusterId).sort(), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(outlines.length, 4);
  assert.deepEqual(outlines.filter((p) => p.kind === 'outline' && p.dashed).map((p) => p.kind === 'outline' && p.nodeId), ['x']);
  assert.equal(plan.primitives.filter((p) => p.kind === 'arrow').length, 3);
  assert.deepEqual(
    plan.primitives
      .filter((p) => p.kind === 'label')
      .map((p) => (p.kind === 'label' ? `${p.role}:${p.text}` : ''))
      .sort(),
    ['extra:Core', 'link:heated by', 'link:moves the'],
  );
});

test("planTermsMap: a node's clusters sit on one line, left to right, inside its ellipse", () => {
  const plan = planTermsMap(sample(), clusters, { letterHeight: 24, seed: 3 });
  const place = (id: string) => {
    const copy = plan.primitives.find((p) => p.kind === 'ink-copy' && p.clusterId === id);

    assert.ok(copy && copy.kind === 'ink-copy');

    const source = clusters.get(id)!;

    return r(source.left + copy.dx, source.top + copy.dy, source.width, source.height);
  };
  const c1 = place('c1');
  const c2 = place('c2');
  const root = plan.nodes.get('root')!;

  assert.ok(c1.left + c1.width < c2.left, 'c1 stays left of c2');
  assert.ok(Math.abs(c1.top + c1.height / 2 - (c2.top + c2.height / 2)) < 0.01, 'same mid-line');

  for (const box of [c1, c2]) {
    for (const [x, y] of [[box.left, box.top + box.height / 2], [box.left + box.width, box.top + box.height / 2]]) {
      assert.ok(((x! - root.cx) / root.rx) ** 2 + ((y! - root.cy) / root.ry) ** 2 < 1, 'ink inside the outline');
    }
  }
});

test('planTermsMap: TB puts children below the root, no node overlaps, all inside the plan, deterministic', () => {
  const plan = planTermsMap(sample(), clusters, { letterHeight: 24, seed: 3 });
  const again = planTermsMap(sample(), clusters, { letterHeight: 24, seed: 3 });

  assert.deepEqual(again.primitives, plan.primitives);

  const nodes = Array.from(plan.nodes.entries());
  const root = plan.nodes.get('root')!;

  assert.ok(plan.nodes.get('a')!.cy > root.cy + root.ry);
  assert.ok(plan.nodes.get('x')!.cy > plan.nodes.get('b')!.cy);

  for (let i = 0; i < nodes.length; i += 1) {
    const [, a] = nodes[i]!;

    assert.ok(a.cx - a.rx >= 0 && a.cy - a.ry >= 0 && a.cx + a.rx <= plan.width && a.cy + a.ry <= plan.height);

    for (let j = i + 1; j < nodes.length; j += 1) {
      const [, b] = nodes[j]!;

      assert.ok(Math.abs(a.cx - b.cx) >= a.rx + b.rx || Math.abs(a.cy - b.cy) >= a.ry + b.ry, `${nodes[i]![0]} overlaps ${nodes[j]![0]}`);
    }
  }

  // Steps: level-0 node before its arrows before level-1 nodes.
  const stepOf = (predicate: (p: (typeof plan.primitives)[number]) => boolean) => plan.primitives.find(predicate)!.step;

  assert.ok(stepOf((p) => p.kind === 'outline' && p.nodeId === 'root') < stepOf((p) => p.kind === 'arrow' && p.from === 'root'));
  assert.ok(stepOf((p) => p.kind === 'arrow' && p.from === 'root') < stepOf((p) => p.kind === 'outline' && p.nodeId === 'a'));
});

test('planTermsMap: a labelled arrow is broken around its phrase', () => {
  const plan = planTermsMap(sample(), clusters, { letterHeight: 24, seed: 3 });
  const arrow = plan.primitives.find((p) => p.kind === 'arrow' && p.to === 'a');

  assert.ok(arrow && arrow.kind === 'arrow');
  assert.equal((arrow.d.match(/M /g) ?? []).length, 2);

  const bare = plan.primitives.find((p) => p.kind === 'arrow' && p.to === 'b');

  assert.ok(bare && bare.kind === 'arrow');
  assert.equal((bare.d.match(/M /g) ?? []).length, 1);
});

// --- placement --------------------------------------------------------------------------------

test('placeBelowFree: under the anchor, pushed past whatever is already there', () => {
  const anchor = r(100, 100, 200, 50);

  assert.deepEqual(placeBelowFree(anchor, { width: 100, height: 80 }, [], 10), { left: 150, top: 160 });

  const below = placeBelowFree(anchor, { width: 100, height: 80 }, [r(0, 170, 400, 40), r(120, 225, 50, 20)], 10);

  assert.equal(below.left, 150);
  assert.ok(below.top >= 245 + 10);
});
