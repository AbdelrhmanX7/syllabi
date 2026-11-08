import type { Diagram } from './diagram';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clearShift, layoutDiagram, moveDiagramNodes, pathThrough, placeInOrder, settleDroppedNode, wrapText } from './diagram';
import { SAMPLE_MAPS } from '../../../../../packages/whiteboard-react/src/components/whiteboard/ai/handConceptMap.fixture';

import { PLATE_TECTONICS_REFERENCE, SEDIMENTARY } from './diagram.fixture';

type Box = { x: number; y: number; w: number; h: number };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function assertClean(diagram: Diagram) {
  const boxes: [string, Box][] = [
    ...diagram.nodes.map((node) => [`node ${node.id}`, node] as [string, Box]),
    ...diagram.edges.flatMap((edge, i) => (edge.labelBox ? [[`label ${i}`, edge.labelBox] as [string, Box]] : [])),
  ];

  for (let i = 0; i < boxes.length; i++) {
    const [name, box] = boxes[i]!;

    assert.ok(box.x >= 0 && box.y >= 0, `${name} starts inside the canvas`);
    assert.ok(box.x + box.w <= diagram.width + 0.01, `${name} ends inside the width`);
    assert.ok(box.y + box.h <= diagram.height + 0.01, `${name} ends inside the height`);
    for (let j = i + 1; j < boxes.length; j++)
      assert.ok(!overlaps(box, boxes[j]![1]), `${name} overlaps ${boxes[j]![0]}`);
  }
}

test('wrapText: greedy by words, long words split, never empty', () => {
  assert.deepEqual(wrapText('Unifying theory of the surface', 12), ['Unifying', 'theory of', 'the surface']);
  assert.deepEqual(wrapText('Lithosphere', 20), ['Lithosphere']);
  assert.deepEqual(wrapText('Supercalifragilistic', 8), ['Superca-', 'lifragi-', 'listic']);
  assert.deepEqual(wrapText('   ', 8), ['']);
});

test('placeInOrder: closest positions that keep the separations', () => {
  assert.deepEqual(placeInOrder([0, 50, 200], [10, 10]), [0, 50, 200]);
  // Two slots wanting the same spot split evenly around it.
  assert.deepEqual(placeInOrder([100, 100], [40]), [80, 120]);
  const placed = placeInOrder([10, 0, 5, 300], [20, 20, 20]);

  for (let i = 1; i < placed.length; i++) assert.ok(placed[i]! - placed[i - 1]! >= 20 - 1e-9);
  assert.equal(placed[3], 300);
});

test('pathThrough: vertical cubic segments', () => {
  assert.equal(
    pathThrough([
      [0, 0],
      [10, 20],
    ]),
    'M0,0 C0,10 10,10 10,20',
  );
  assert.equal(pathThrough([]), '');
});

test('layoutDiagram: the realistic 15-node map has no overlaps and readable text sizes', () => {
  const diagram = layoutDiagram(PLATE_TECTONICS_REFERENCE.nodes, PLATE_TECTONICS_REFERENCE.edges);

  assert.equal(diagram.nodes.length, 15);
  assert.equal(diagram.edges.length, 17);
  assertClean(diagram);
  assert.ok(diagram.options.fontSize >= 13 && diagram.options.labelFontSize >= 13);
  // The backend's normalised bbox is never used for size.
  for (const node of diagram.nodes) assert.ok(node.w >= 96 && node.h >= 30);
  // Every label is shown; long text wraps rather than being clipped.
  for (const edge of diagram.edges) assert.ok(edge.labelBox, `${edge.from}→${edge.to} has a chip`);
  const unifying = diagram.nodes.find((node) => node.id === 'n7')!;

  assert.ok(unifying.lines.length > 1);
  assert.equal(unifying.lines.join(' '), "Unifying theory of how Earth's surface moves and changes");
});

test('layoutDiagram: roots on top, arrows run from the source border to the target border', () => {
  const diagram = layoutDiagram(PLATE_TECTONICS_REFERENCE.nodes, PLATE_TECTONICS_REFERENCE.edges);
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  const wegener = byId.get('n1')!;

  assert.ok(wegener.root);
  assert.equal(wegener.rank, 0);
  assert.ok(byId.get('n13')!.root);
  // Convection is pulled down to sit just above the plates it moves.
  assert.equal(byId.get('n13')!.rank, byId.get('n8')!.rank - 1);
  for (const edge of diagram.edges) {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const [sx, sy] = edge.points[0]!;
    const [ex, ey] = edge.points[edge.points.length - 1]!;

    assert.ok(Math.abs(sy - (from.y + from.h)) < 0.01, `${edge.from} leaves from its bottom`);
    assert.ok(sx > from.x && sx < from.x + from.w);
    assert.ok(Math.abs(ey - to.y) < 0.01, `${edge.to} is entered from its top`);
    assert.ok(ex > to.x && ex < to.x + to.w);
    assert.ok(edge.path.startsWith('M'));
  }
});

test('layoutDiagram: deterministic', () => {
  const a = layoutDiagram(PLATE_TECTONICS_REFERENCE.nodes, PLATE_TECTONICS_REFERENCE.edges);
  const b = layoutDiagram(PLATE_TECTONICS_REFERENCE.nodes, PLATE_TECTONICS_REFERENCE.edges);

  assert.deepEqual(a, b);
});

test('layoutDiagram: a cycle is drawn with the back arrow pointing at its real target', () => {
  const diagram = layoutDiagram(
    [
      { id: 'a', text: 'Evidence' },
      { id: 'b', text: 'Inference' },
      { id: 'c', text: 'Model' },
    ],
    [
      { from: 'a', to: 'b', label: 'is interpreted into' },
      { from: 'b', to: 'c', label: 'builds' },
      { from: 'c', to: 'a', label: 'is checked against' },
    ],
  );
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  const back = diagram.edges.find((edge) => edge.from === 'c')!;
  const [ex, ey] = back.points[back.points.length - 1]!;
  const a = byId.get('a')!;

  assertClean(diagram);
  assert.ok(byId.get('a')!.rank < byId.get('c')!.rank);
  // Ends on the bottom border of «Evidence», above it.
  assert.ok(Math.abs(ey - (a.y + a.h)) < 0.01);
  assert.ok(ex > a.x && ex < a.x + a.w);
});

test('layoutDiagram: unlabelled edges, isolated nodes, empty graph', () => {
  const diagram = layoutDiagram(
    [
      { id: 'a', text: 'Crust' },
      { id: 'b', text: 'Mantle' },
      { id: 'c', text: 'Loose term' },
    ],
    [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'missing', label: 'dropped' },
    ],
  );

  assertClean(diagram);
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0]!.labelBox, null);
  assert.ok(diagram.nodes.find((node) => node.id === 'c')!.rank > 0);

  const empty = layoutDiagram([], []);

  assert.deepEqual([empty.nodes.length, empty.edges.length], [0, 0]);
});

test('layoutDiagram: no edge curve runs through a box it does not connect', () => {
  const diagram = layoutDiagram(PLATE_TECTONICS_REFERENCE.nodes, PLATE_TECTONICS_REFERENCE.edges);

  for (const edge of diagram.edges) {
    const others = diagram.nodes.filter((node) => node.id !== edge.from && node.id !== edge.to);

    for (let i = 0; i + 1 < edge.points.length; i++) {
      const [x0, y0] = edge.points[i]!;
      const [x1, y1] = edge.points[i + 1]!;
      const mid = (y0 + y1) / 2;

      // The same vertical cubic `pathThrough` draws.
      for (let t = 0; t <= 1; t += 0.05) {
        const u = 1 - t;
        const x = u * u * u * x0 + 3 * u * u * t * x0 + 3 * u * t * t * x1 + t * t * t * x1;
        const y = u * u * u * y0 + 3 * u * u * t * mid + 3 * u * t * t * mid + t * t * t * y1;

        for (const node of others)
          assert.ok(
            !(x > node.x && x < node.x + node.w && y > node.y && y < node.y + node.h),
            `${edge.from}→${edge.to} crosses ${node.id}`,
          );
      }
    }
  }
});

test('layoutDiagram: no overlaps on the stress maps (long phrases, wide fans, skip and back links, a self-loop)', () => {
  for (const [name, map] of Object.entries(SAMPLE_MAPS)) {
    const nodes = map.nodes.map((node) => ({ id: node.id, text: node.text }));

    assert.doesNotThrow(() => assertClean(layoutDiagram(nodes, map.edges)), name);
  }
});

test('layoutDiagram: a real text measure sizes the boxes — wide glyphs get wide boxes, still no overlaps', () => {
  // «W» is twice an average glyph: the char estimate would undersize this box and the text would spill.
  const measure = (text: string, kind: 'node' | 'label') => Array.from(text).reduce((sum, ch) => sum + (ch === 'W' ? 15 : 7.6), 0) * (kind === 'label' ? 0.9 : 1);
  const nodes = [
    { id: 'a', text: 'WWWW WWWW WWWW' },
    { id: 'b', text: 'small' },
    { id: 'c', text: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW' },
  ];
  const edges = [
    { from: 'a', to: 'b', label: 'WWWW WWWW WWWW WWWW' },
    { from: 'a', to: 'c', label: 'to' },
  ];
  const diagram = layoutDiagram(nodes, edges, { measure });

  assertClean(diagram);
  for (const node of diagram.nodes)
    for (const line of node.lines) assert.ok(measure(line, 'node') + diagram.options.nodePadX * 2 <= node.w + 1, `"${line}" fits its box`);
  for (const edge of diagram.edges)
    for (const line of edge.labelLines) assert.ok(measure(line, 'label') + diagram.options.labelPadX * 2 <= edge.labelBox!.w + 1, `"${line}" fits its chip`);
});

test('dragging a node: its links follow (border to border), its phrases slide off every box, nothing else moves', () => {
  const diagram = layoutDiagram(PLATE_TECTONICS_REFERENCE.nodes, PLATE_TECTONICS_REFERENCE.edges);
  const n6 = diagram.nodes.find((node) => node.id === 'n6')!;
  const shown = moveDiagramNodes(diagram, { n6: { dx: 300, dy: 120 } });
  const moved = shown.nodes.find((node) => node.id === 'n6')!;

  assert.deepEqual([moved.x, moved.y], [n6.x + 300, n6.y + 120]);
  for (const edge of shown.edges) {
    if (edge.from !== 'n6' && edge.to !== 'n6') {
      assert.deepEqual(edge, diagram.edges.find((other) => other.from === edge.from && other.to === edge.to), 'untouched link kept');
      continue;
    }
    const end = edge.from === 'n6' ? edge.points[0]! : edge.points[edge.points.length - 1]!;
    const onBorder =
      (Math.abs(end[0] - moved.x) < 0.01 || Math.abs(end[0] - (moved.x + moved.w)) < 0.01 || Math.abs(end[1] - moved.y) < 0.01 || Math.abs(end[1] - (moved.y + moved.h)) < 0.01) &&
      end[0] >= moved.x - 0.01 && end[0] <= moved.x + moved.w + 0.01 && end[1] >= moved.y - 0.01 && end[1] <= moved.y + moved.h + 0.01;

    assert.ok(onBorder, `${edge.from}→${edge.to} meets n6's border`);
    if (edge.labelBox) for (const node of shown.nodes) assert.ok(!overlaps(edge.labelBox, node), `${edge.label} clear of ${node.id}`);
  }
  assert.ok(shown.width >= moved.x + moved.w && shown.height >= moved.y + moved.h, 'the drawing grows to hold it');
});

test('dropping a node on another: it is nudged clear; nothing to clear → unchanged', () => {
  const diagram = layoutDiagram(PLATE_TECTONICS_REFERENCE.nodes, PLATE_TECTONICS_REFERENCE.edges);
  const a = diagram.nodes.find((node) => node.id === 'n3')!;
  const b = diagram.nodes.find((node) => node.id === 'n9')!;
  const dropped = { n3: { dx: b.x - a.x + 5, dy: b.y - a.y + 5 } };
  const settled = settleDroppedNode(diagram, dropped, 'n3');
  const shown = moveDiagramNodes(diagram, settled);
  const placed = shown.nodes.find((node) => node.id === 'n3')!;

  for (const node of shown.nodes) if (node.id !== 'n3') assert.ok(!overlaps(placed, node), `n3 clear of ${node.id}`);
  const far = { n3: { dx: 0, dy: diagram.height + 200 } };

  assert.equal(settleDroppedNode(diagram, far, 'n3'), far);
  assert.equal(moveDiagramNodes(diagram, {}), diagram);
});

test('clearShift: the nearest free spot, never off the top-left edge', () => {
  assert.deepEqual(clearShift({ x: 10, y: 10, w: 20, h: 20 }, [{ x: 100, y: 100, w: 10, h: 10 }], 4), { dx: 0, dy: 0 });
  const shift = clearShift({ x: 0, y: 0, w: 20, h: 20 }, [{ x: 0, y: 0, w: 30, h: 30 }], 2, 8);

  assert.ok(shift.dx >= 0 && shift.dy >= 0 && (shift.dx >= 32 || shift.dy >= 32));
});

type Seg = { x1: number; y1: number; x2: number; y2: number; edge: number; from: string };

/** Axis-aligned runs of every edge's course (a diagonal has none: it cannot lie along another line). */
function runsOf(diagram: Diagram): Seg[] {
  return diagram.edges.flatMap((edge, index) =>
    edge.points.slice(1).map((q, i) => {
      const p = edge.points[i]!;

      return { x1: Math.min(p[0], q[0]), y1: Math.min(p[1], q[1]), x2: Math.max(p[0], q[0]), y2: Math.max(p[1], q[1]), edge: index, from: edge.from };
    }),
  );
}

test('layoutDiagram: two parents never share a stretch of line (no bus), and no box or phrase touches another', () => {
  const maps = [SEDIMENTARY, PLATE_TECTONICS_REFERENCE, ...Object.values(SAMPLE_MAPS)];

  for (const map of maps) {
    const diagram = layoutDiagram(
      map.nodes.map((node) => ({ id: node.id, text: node.text })),
      map.edges,
    );
    const all = runsOf(diagram);
    // Every stretch is level or plumb: two slants side by side read as one bus.
    const segs = all.filter((seg) => seg.x2 - seg.x1 <= 0.5 || seg.y2 - seg.y1 <= 0.5);

    assert.equal(segs.length, all.length, 'every course is made of level and plumb runs');

    assertClean(diagram);
    // Phrases and boxes keep a hand's width apart, not just "not overlapping".
    const boxes: Box[] = [...diagram.nodes, ...diagram.edges.flatMap((edge) => (edge.labelBox ? [edge.labelBox] : []))];

    boxes.forEach((a, i) =>
      boxes.slice(i + 1).forEach((b) => assert.ok(!overlaps({ x: a.x - 3, y: a.y - 3, w: a.w + 6, h: a.h + 6 }, b), 'boxes keep a gap')),
    );
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i]!;
        const b = segs[j]!;

        if (a.from === b.from) continue;
        const horizontal = a.y2 - a.y1 < 0.5 && b.y2 - b.y1 < 0.5 && Math.abs(a.y1 - b.y1) < 0.5;
        const vertical = a.x2 - a.x1 < 0.5 && b.x2 - b.x1 < 0.5 && Math.abs(a.x1 - b.x1) < 0.5;
        const shared = horizontal ? Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) : vertical ? Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) : 0;

        assert.ok(shared <= 0.5, `edges ${a.edge} and ${b.edge} (different parents) run along the same line`);
      }
  }
});

test('layoutDiagram: the sedimentary map keeps each link on its own channel and no link crosses a box it does not join', () => {
  const diagram = layoutDiagram(SEDIMENTARY.nodes, SEDIMENTARY.edges);

  for (const edge of diagram.edges)
    for (const node of diagram.nodes) {
      if (node.id === edge.from || node.id === edge.to) continue;
      edge.points.slice(1).forEach((q, i) => {
        const p = edge.points[i]!;
        const seg = { x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(p[0] - q[0]), h: Math.abs(p[1] - q[1]) };

        assert.ok(!overlaps({ ...seg, w: seg.w + 0.01, h: seg.h + 0.01 }, node), `${edge.from}→${edge.to} runs through ${node.id}`);
      });
    }
});
