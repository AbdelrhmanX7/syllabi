import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyConceptFixes, deriveConceptStyle, parseConceptMapAnalysis, readConceptStyle, withLevels, writeConceptStyle } from './conceptMap';
import { boundaryPoint, hasOverlap, layoutGraph } from './graphLayout';
import {
  finishLasso,
  maskOutsidePolygon,
  placeBeside,
  planRegionRaster,
  pointInPolygon,
  polygonToPixels,
  sceneToScreen,
  screenToScene,
} from './lassoGeometry';
import { graphToMermaid, parseMermaidFlowchart } from './mermaidFlow';
import { correctedVersionBlocks, markableQuestions, parsePageAnalysis, sanitizeBox } from './pageAnalysis';

// ---------------------------------------------------------------------------------------------------
// Lasso geometry + raster crop
// ---------------------------------------------------------------------------------------------------

test('screen ↔ scene round-trip under zoom + pan', () => {
  const vpt = [2, 0, 0, 2, -100, 40];
  const scene = screenToScene({ x: 300, y: 240 }, vpt);

  assert.deepEqual(scene, { x: 200, y: 100 });
  assert.deepEqual(sceneToScreen(scene, vpt), { x: 300, y: 240 });
});

test('finishLasso: tap → null, loop → polygon, diagonal swipe → rect, rect mode → rect', () => {
  assert.equal(finishLasso([{ x: 0, y: 0 }, { x: 3, y: 2 }]), null);

  const circle = Array.from({ length: 40 }, (_, i) => ({
    x: 100 + 50 * Math.cos((i / 40) * Math.PI * 2),
    y: 100 + 50 * Math.sin((i / 40) * Math.PI * 2),
  }));

  assert.equal(finishLasso(circle)?.kind, 'polygon');

  const swipe = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i * 6 }));
  const rect = finishLasso(swipe);

  assert.deepEqual(rect, { kind: 'rect', rect: { left: 0, top: 0, width: 190, height: 114 } });
  assert.equal(finishLasso(circle, { mode: 'rect' })?.kind, 'rect');
});

test('planRegionRaster: ≥1.5× screen resolution, capped at the long edge', () => {
  const small = planRegionRaster({ left: 10, top: 10, width: 200, height: 100 }, { zoom: 1, devicePixelRatio: 1 });

  assert.equal(small.scale, 1.5);
  assert.deepEqual(small.region, { left: 4, top: 4, width: 212, height: 112 });
  assert.equal(small.pixelWidth, 318);

  const retina = planRegionRaster({ left: 0, top: 0, width: 100, height: 100 }, { zoom: 2, devicePixelRatio: 2 });

  assert.equal(retina.scale, 4); // zoom 2 × dpr 2

  const huge = planRegionRaster({ left: 0, top: 0, width: 4000, height: 1000 }, { zoom: 1 });

  assert.ok(Math.max(huge.pixelWidth, huge.pixelHeight) <= 2048);
  assert.ok(Math.max(huge.pixelWidth, huge.pixelHeight) >= 2040);
});

test('mask whitens exactly the pixels outside the lasso', () => {
  const plan = planRegionRaster({ left: 100, top: 100, width: 10, height: 10 }, { zoom: 1, minScreenFactor: 1, paddingScreenPx: 0 });
  const triangle = polygonToPixels(
    [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 100, y: 110 },
    ],
    plan,
  );
  const data = new Uint8ClampedArray(plan.pixelWidth * plan.pixelHeight * 4); // all black, transparent

  maskOutsidePolygon(data, plan.pixelWidth, plan.pixelHeight, triangle);

  const at = (x: number, y: number) => data[(y * plan.pixelWidth + x) * 4];

  assert.equal(at(1, 1), 0, 'inside stays');
  assert.equal(at(9, 9), 255, 'outside is white');
  assert.ok(pointInPolygon({ x: 2, y: 2 }, triangle));
});

test('placeBeside prefers the end (left) side, then right, then below', () => {
  const container = { width: 1000, height: 800 };

  assert.deepEqual(placeBeside({ left: 600, top: 100, width: 100, height: 100 }, { width: 300, height: 200 }, container), { left: 288, top: 100 });
  assert.deepEqual(placeBeside({ left: 50, top: 100, width: 100, height: 100 }, { width: 300, height: 200 }, container), { left: 162, top: 100 });
});

// ---------------------------------------------------------------------------------------------------
// Mermaid subset + layout
// ---------------------------------------------------------------------------------------------------

test('mermaid flowchart: shapes, labels, chains, & fan-out, comments', () => {
  const graph = parseMermaidFlowchart(
    'flowchart LR\n%% comment\nA[Start] -->|yes| B{Decide?}\nB -- no --> C((End)) --> D("Quote")\nB & C --- E\nstyle A fill:#f00\nA-->B',
  );

  assert.ok(graph);
  assert.equal(graph.direction, 'ltr');
  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.text, node.shape]),
    [
      ['A', 'Start', 'rect'],
      ['B', 'Decide?', 'diamond'],
      ['C', 'End', 'ellipse'],
      ['D', 'Quote', 'rounded'],
      ['E', 'E', 'rect'],
    ],
  );
  assert.deepEqual(graph.edges[0], { from: 'A', to: 'B', arrow: 'end', label: 'yes' });
  assert.deepEqual(graph.edges[1], { from: 'B', to: 'C', arrow: 'end', label: 'no' });
  assert.deepEqual(graph.edges[2], { from: 'C', to: 'D', arrow: 'end' });
  assert.deepEqual(graph.edges.slice(3, 5), [
    { from: 'B', to: 'E', arrow: 'none' },
    { from: 'C', to: 'E', arrow: 'none' },
  ]);

  const again = parseMermaidFlowchart(graphToMermaid(graph));

  assert.deepEqual(again?.nodes.map((n) => n.text), graph.nodes.map((n) => n.text));
  assert.equal(again?.edges.length, graph.edges.length);
});

const sampleTree = () => {
  const nodes = [
    { id: 'root', width: 160, height: 50, level: 0 },
    ...['a', 'b', 'c'].map((id) => ({ id, width: 120, height: 40 })),
    ...['a1', 'a2', 'a3', 'b1', 'c1', 'c2'].map((id) => ({ id, width: 140, height: 44 })),
  ];
  const edges = [
    { from: 'root', to: 'a' },
    { from: 'root', to: 'b' },
    { from: 'root', to: 'c' },
    { from: 'a', to: 'a1' },
    { from: 'a', to: 'a2' },
    { from: 'a', to: 'a3' },
    { from: 'b', to: 'b1' },
    { from: 'c', to: 'c1' },
    { from: 'c', to: 'c2' },
    { from: 'a3', to: 'b1' }, // a cross-link
  ];

  return { nodes, edges };
};

for (const direction of ['tb', 'ltr', 'rtl', 'radial'] as const) {
  test(`layout ${direction}: every node placed, no overlaps, deterministic`, () => {
    const { nodes, edges } = sampleTree();
    const layout = layoutGraph(nodes, edges, { direction });

    assert.equal(layout.nodes.size, nodes.length);
    assert.equal(hasOverlap(layout), false);
    assert.equal(layout.treeEdges.has('a3\u0000b1'), false, 'cross-link is not a tree edge');
    assert.deepEqual(Array.from(layoutGraph(nodes, edges, { direction }).nodes.values()), Array.from(layout.nodes.values()));

    const root = layout.nodes.get('root')!;
    const child = layout.nodes.get('a')!;

    if (direction === 'tb') assert.ok(child.y > root.y);
    if (direction === 'ltr') assert.ok(child.x > root.x);
    if (direction === 'rtl') assert.ok(child.x < root.x);
    if (direction === 'radial') assert.deepEqual([root.x, root.y], [0, 0]);
  });
}

test('tidy tree centres a parent over its children', () => {
  const layout = layoutGraph(
    [
      { id: 'p', width: 50, height: 20 },
      { id: 'x', width: 50, height: 20 },
      { id: 'y', width: 50, height: 20 },
    ],
    [
      { from: 'p', to: 'x' },
      { from: 'p', to: 'y' },
    ],
    { direction: 'tb' },
  );
  const p = layout.nodes.get('p')!;

  assert.equal(p.x, (layout.nodes.get('x')!.x + layout.nodes.get('y')!.x) / 2);
});

test('boundaryPoint lands on rect / ellipse / diamond outlines', () => {
  const size = { width: 100, height: 40 };

  assert.deepEqual(boundaryPoint({ x: 0, y: 0 }, size, { x: 200, y: 0 }, 'rect'), { x: 50, y: 0 });
  assert.deepEqual(boundaryPoint({ x: 0, y: 0 }, size, { x: 0, y: 100 }, 'ellipse'), { x: 0, y: 20 });
  assert.deepEqual(boundaryPoint({ x: 0, y: 0 }, size, { x: 0, y: -100 }, 'diamond'), { x: 0, y: -20 });
});

// ---------------------------------------------------------------------------------------------------
// Page analysis
// ---------------------------------------------------------------------------------------------------

test('sanitizeBox: object / array / percent / per-mille; rejects garbage', () => {
  assert.deepEqual(sanitizeBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.deepEqual(sanitizeBox([10, 20, 30, 10]), { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.deepEqual(sanitizeBox({ left: 100, top: 200, width: 300, height: 100 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
  assert.equal(sanitizeBox({ x: 0.9, y: 0.1, w: 0.5, h: 0.1 }), undefined, 'falls off the page');
  assert.equal(sanitizeBox({ x: 0.1, y: 0.1, w: 0, h: 0.1 }), undefined, 'degenerate');
  assert.equal(sanitizeBox('0.1,0.1'), undefined);
});

test('parsePageAnalysis from a prose-wrapped answer, odd verdicts coerced', () => {
  const analysis = parsePageAnalysis(
    'Sure, here is the analysis:\n```json\n{"pageType":"questions","questions":[' +
      '{"n":1,"text":"2+2","bbox":[5,10,40,6],"givenAnswer":"5","givenAnswerBbox":{"x":0.5,"y":0.1,"w":0.1,"h":0.05},"correctAnswer":"4","verdict":"wrong","reason":"wrong sum"},' +
      '{"n":"2","text":"3×3","correctAnswer":"9","verdict":"correct"},' +
      '{"n":3,"text":"Explain","verdict":"no_answer"},' +
      '{"garbage":true}' +
      ']}\n```',
  );

  assert.ok(analysis);
  assert.equal(analysis.pageType, 'questions');
  assert.equal(analysis.questions.length, 3);
  assert.equal(analysis.questions[0]?.verdict, 'wrong');
  assert.deepEqual(analysis.questions[0]?.bbox, { x: 0.05, y: 0.1, w: 0.4, h: 0.06 });
  assert.equal(markableQuestions(analysis).length, 1);

  const corrected = correctedVersionBlocks(analysis);

  assert.equal(corrected[0]?.type, 'heading');
  assert.deepEqual(corrected[1], {
    type: 'question',
    stem: '1) 2+2',
    answer: '4',
    explanation: 'The written answer «5» is wrong: wrong sum',
  });
});

// ---------------------------------------------------------------------------------------------------
// Concept maps
// ---------------------------------------------------------------------------------------------------

test('concept map analysis: nodes by id or text, fixes validated, applied to a copy', () => {
  const analysis = parseConceptMapAnalysis({
    map: {
      title: 'Climate',
      direction: 'radial',
      nodes: [
        { id: 'n1', text: 'Climate', shape: 'ellipse', color: 'blue', level: 0 },
        { id: 'n2', text: 'Temperature', shape: 'rect' },
        { id: 'n3', text: 'Rainfal', shape: 'rect' },
      ],
      edges: [
        { from: 'n1', to: 'Temperature', label: 'includes' },
        { from: 'n1', to: 'n3' },
        { from: 'n1', to: 'missing' },
      ],
      style: { edgeColor: '#000000', strokeWidth: '3' },
    },
    suggestions: [
      { kind: 'spelling', message: "Rainfall is spelt with two l's", fix: { op: 'rename_node', id: 'n3', text: 'Rainfall' } },
      { kind: 'missing_concept', message: 'Wind is missing', fix: { op: 'add_node', text: 'Wind', parent: 'n1' } },
      { kind: 'link', message: 'A link to a node that does not exist', fix: { op: 'add_edge', from: 'n1', to: 'zzz' } },
    ],
  });

  assert.ok(analysis);
  assert.equal(analysis.map.edges.length, 2, 'the edge to an unknown node is dropped');
  assert.equal(analysis.map.edges[0]?.to, 'n2', 'text reference resolved to id');
  assert.equal(analysis.suggestions.length, 3);
  assert.equal(analysis.suggestions[2]?.fix, undefined, 'an invalid fix is dropped, the message kept');

  const fixed = applyConceptFixes(
    analysis.map,
    analysis.suggestions.map((s) => s.fix).filter((fix): fix is NonNullable<typeof fix> => Boolean(fix)),
  );

  assert.equal(fixed.nodes.find((n) => n.id === 'n3')?.text, 'Rainfall');
  assert.equal(fixed.nodes.length, 4);
  assert.equal(analysis.map.nodes.length, 3, 'original untouched');

  const style = deriveConceptStyle(analysis.map, { strokeWidth: 9 });

  assert.equal(style.direction, 'radial');
  assert.equal(style.edgeColor, '#000000');
  assert.equal(style.strokeWidth, 3);
  assert.deepEqual(style.nodeColors, ['#2563eb']);
});

test('withLevels derives levels from edges', () => {
  const map = withLevels({ nodes: [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }, { id: 'c', text: 'c' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });

  assert.deepEqual(map.nodes.map((n) => n.level), [0, 1, 2]);
});

test('concept style persists per board with a device default', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

  assert.equal(readConceptStyle('b1', storage), null);
  writeConceptStyle('b1', { ...deriveConceptStyle({ nodes: [], edges: [] }), direction: 'rtl' }, storage);
  assert.equal(readConceptStyle('b1', storage)?.direction, 'rtl');
  assert.equal(readConceptStyle('other-board', storage)?.direction, 'rtl', 'falls back to the device style');
});

test('findFreeSpot: centre when empty, steps around content, null when full', async () => {
  const { findFreeSpot } = await import('./lassoGeometry');
  const view = { left: 0, top: 0, width: 1000, height: 800 };

  assert.deepEqual(findFreeSpot(view, { width: 200, height: 100 }, [], { minTop: 70 }), { left: 400, top: 70 });
  // Something in the middle-top: the right column is free.
  assert.deepEqual(findFreeSpot(view, { width: 200, height: 100 }, [{ left: 300, top: 0, width: 400, height: 400 }], { minTop: 70 }), {
    left: 792,
    top: 70,
  });
  assert.equal(findFreeSpot(view, { width: 200, height: 100 }, [{ left: 0, top: 0, width: 1000, height: 800 }]), null);
});

test('contentPixelBounds crops to the ink; dominantInkColors ranks the teacher colours', async () => {
  const { contentPixelBounds } = await import('./lassoGeometry');
  const { dominantInkColors } = await import('./conceptMap');
  const width = 40;
  const height = 20;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x: number, y: number, [r, g, b]: number[]) => {
    const o = (y * width + x) * 4;

    data[o] = r!;
    data[o + 1] = g!;
    data[o + 2] = b!;
  };

  for (let x = 10; x < 30; x += 1) for (let y = 5; y < 8; y += 1) paint(x, y, [29, 78, 216]); // blue: 60 px
  for (let x = 10; x < 20; x += 1) paint(x, 12, [185, 28, 28]); // red: 10 px

  assert.deepEqual(contentPixelBounds(data, width, height, { padding: 0, stride: 1 }), { x: 10, y: 5, width: 20, height: 8 });
  assert.equal(contentPixelBounds(new Uint8ClampedArray(16).fill(255), 2, 2), null);

  const colors = dominantInkColors(data, { stride: 1 });

  assert.equal(colors[0], '#1d4ed8');
  assert.equal(colors[1], '#b91c1c');
});

test('mermaid: quoted labels from the teacher endpoint (brackets/parens inside quotes)', () => {
  const graph = parseMermaidFlowchart('flowchart TD\n  A["Force (F)"] -->|"if [a] is constant"| B["Acceleration [a]"]\n  B --> C{"Is F = ma?"}\n  C -- "yes" --> D(("Done"))');

  assert.deepEqual(
    graph?.nodes.map((n) => [n.id, n.text, n.shape]),
    [
      ['A', 'Force (F)', 'rect'],
      ['B', 'Acceleration [a]', 'rect'],
      ['C', 'Is F = ma?', 'diamond'],
      ['D', 'Done', 'ellipse'],
    ],
  );
  assert.equal(graph?.edges[0]?.label, 'if [a] is constant');
  assert.equal(graph?.edges[2]?.label, 'yes');
});

test('noticeSpot keeps the notice off the inserted content', async () => {
  const { noticeSpot } = await import('./lassoGeometry');
  const insets = { top: 120, bottom: 0 };

  // Content right under the toolbar → the notice goes to the bottom.
  assert.deepEqual(noticeSpot(800, insets, { left: 100, top: 136, width: 500, height: 300 }), { bottom: 12 });
  // Content reaching the bottom → under the top chrome instead.
  assert.deepEqual(noticeSpot(800, insets, { left: 100, top: 400, width: 500, height: 390 }), { top: 132 });
  // A bottom-docked toolbar pushes the bottom strip above it.
  assert.deepEqual(noticeSpot(800, { top: 0, bottom: 70 }, null), { bottom: 82 });
  // Covering the whole view: the smaller overlap wins (both full → bottom).
  assert.deepEqual(noticeSpot(800, insets, { left: 0, top: 0, width: 900, height: 800 }), { bottom: 12 });
});

test('teacher concept-map shape: {graph, fixes} → map + applicable suggestions; direction enum mapped', () => {
  const analysis = parseConceptMapAnalysis({
    graph: {
      title: 'Climate of Egypt',
      direction: 'RL',
      nodes: [
        { id: 'n1', text: 'Climate of Egypt', bbox: [0.4, 0.05, 0.2, 0.08], shape: 'ellipse', color: '#1d4ed8', level: 0 },
        { id: 'n2', text: 'Rainfal', bbox: [0.1, 0.4, 0.2, 0.08], shape: 'ellipse', level: 1 },
        { id: 'n3', text: 'Temperature', bbox: [0.7, 0.4, 0.2, 0.08], shape: 'rect', level: 1 },
      ],
      edges: [
        { from: 'n1', to: 'n2', arrow: 'end' },
        { from: 'n1', to: 'n3', label: 'includes', arrow: 'end' },
      ],
      style: { nodeColors: ['#1d4ed8'], edgeColor: '#b91c1c', strokeWidth: 3, font: 'handwriting' },
    },
    fixes: [
      { type: 'spelling', target: 'n2', suggestion: 'Rainfall', reason: 'double l' },
      { type: 'missing_concept', target: 'n1', suggestion: 'Wind', reason: 'a key element' },
      { type: 'link', target: 'n2->n3', suggestion: 'is affected by', reason: 'the relation' },
      { type: 'link', target: 'n1->n3', suggestion: 'is one of its elements', reason: 'a more precise link' },
      { type: 'fact', target: 'n3', suggestion: 'Egypt is hot in summer and mild in winter along the northern coast', reason: 'overgeneralised' },
    ],
  });

  assert.ok(analysis);
  assert.equal(analysis.map.direction, 'rtl');
  assert.deepEqual(analysis.map.nodes.map((n) => n.shape), ['ellipse', 'ellipse', 'rect'], 'shape per node kept');
  assert.deepEqual(
    analysis.suggestions.map((s) => [s.kind, s.fix?.op ?? null]),
    [
      ['spelling', 'rename_node'],
      ['missing_concept', 'add_node'],
      ['link', 'add_edge'],
      ['link', 'relabel_edge'],
      ['fact', null], // a long sentence of advice is not applied as a node label
    ],
  );
  assert.equal(analysis.suggestions[0]?.message, 'Rainfall — double l');
  assert.deepEqual(analysis.suggestions[1]?.fix, { op: 'add_node', id: 'new_2', text: 'Wind', parent: 'n1' });
});

test('layoutFromBoxes places server boxes in the frame; overlapping or missing boxes → null (self-layout)', async () => {
  const { layoutFromBoxes } = await import('./graphLayout');
  const nodes = [
    { id: 'a', width: 100, height: 40, bbox: { x: 0.4, y: 0.0, w: 0.2, h: 0.1 } },
    { id: 'b', width: 100, height: 40, bbox: { x: 0.0, y: 0.5, w: 0.2, h: 0.1 } },
  ];
  const layout = layoutFromBoxes(nodes, [{ from: 'a', to: 'b' }], { width: 1000, height: 600 });

  assert.deepEqual([layout?.nodes.get('a')?.x, layout?.nodes.get('a')?.y], [500, 30]);
  assert.ok(layout?.treeEdges.has('a\u0000b'));
  assert.equal(layoutFromBoxes([...nodes, { id: 'c', width: 100, height: 40 }], [], { width: 1000, height: 600 }), null);
  assert.equal(
    layoutFromBoxes([nodes[0]!, { id: 'd', width: 100, height: 40, bbox: { x: 0.41, y: 0.0, w: 0.2, h: 0.1 } }], [], { width: 1000, height: 600 }),
    null,
    'collision → self-layout',
  );
});

test('spelling fix when the server already corrected the label: the copy starts from the drawn text; checked:false kept', () => {
  const analysis = parseConceptMapAnalysis({
    checked: false,
    graph: {
      direction: 'TB',
      nodes: [
        { id: 'n1', text: 'Rocks', level: 0 },
        { id: 'n2', text: 'Granite', level: 1 },
      ],
      edges: [{ from: 'n1', to: 'n2', arrow: 'end' }],
    },
    fixes: [{ type: 'spelling', target: 'n2', suggestion: 'Granite', reason: 'written on the board as «Granit»' }],
  });

  assert.ok(analysis);
  assert.equal(analysis.checked, false);
  assert.equal(analysis.map.nodes[1]?.text, 'Granit', 'unaccepted copy = what the teacher drew');
  assert.equal(analysis.suggestions[0]?.message, 'Granite — written on the board as «Granit»', 'reason always shown');
  assert.deepEqual(analysis.suggestions[0]?.fix, { op: 'rename_node', id: 'n2', text: 'Granite' });

  const fixed = applyConceptFixes(analysis.map, [analysis.suggestions[0]!.fix!]);

  assert.equal(fixed.nodes[1]?.text, 'Granite', 'accepting replaces the drawn label');
});
