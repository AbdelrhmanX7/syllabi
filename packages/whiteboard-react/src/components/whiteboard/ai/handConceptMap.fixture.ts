// Test support for the hand-drawn concept map: sample maps that used to collide (wide fans of long
// phrases, chains with skip and back links, many-word labels, isolated nodes, a self-loop) and one checker
// for every way a drawn plan can overlap itself. Shared by the engine's tests and the study app's.
import type { HandConceptPlan } from './handConceptMap';
import type { TermsPrimitive } from './termsMap';
import type { ConceptMap } from './types';

/** Points along an SVG path of M / L / Q segments (`smoothPath`). */
export function samplePath(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const tokens = d.match(/[MLQ]|-?\d+(?:\.\d+)?/g) ?? [];
  let pen: [number, number] = [0, 0];

  for (let i = 0; i < tokens.length; ) {
    const op = tokens[i++]!;
    const num = () => Number(tokens[i++]);

    if (op === 'M') pen = [num(), num()];
    else if (op === 'L') {
      const to: [number, number] = [num(), num()];

      for (let t = 0; t <= 1; t += 0.05) out.push([pen[0] + (to[0] - pen[0]) * t, pen[1] + (to[1] - pen[1]) * t]);
      pen = to;
    } else if (op === 'Q') {
      const c: [number, number] = [num(), num()];
      const to: [number, number] = [num(), num()];

      for (let t = 0; t <= 1; t += 0.05) {
        const u = 1 - t;

        out.push([u * u * pen[0] + 2 * u * t * c[0] + t * t * to[0], u * u * pen[1] + 2 * u * t * c[1] + t * t * to[1]]);
      }
      pen = to;
    }
  }

  return out;
}

type Rect = { left: number; top: number; width: number; height: number };
type Label = Extract<TermsPrimitive, { kind: 'label' }>;
type Arrow = Extract<TermsPrimitive, { kind: 'arrow' }>;

const hits = (a: Rect, b: Rect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const inside = (x: number, y: number, r: Rect) => x > r.left && x < r.left + r.width && y > r.top && y < r.top + r.height;

/** Every way a drawn map can collide with itself; [] = clean. */
export function planProblems(plan: HandConceptPlan): string[] {
  const problems: string[] = [];
  const nodes = Array.from(plan.nodes.entries()).map(([id, n]) => ({
    id,
    n,
    rect: { left: n.cx - n.rx, top: n.cy - n.ry, width: n.rx * 2, height: n.ry * 2 },
  }));
  const labels = plan.primitives.filter((p): p is Label => p.kind === 'label');
  const links = labels.filter((p) => p.role === 'link');
  const arrows = plan.primitives.filter((p): p is Arrow => p.kind === 'arrow');

  for (let i = 0; i < nodes.length; i += 1)
    for (let j = i + 1; j < nodes.length; j += 1) if (hits(nodes[i]!.rect, nodes[j]!.rect)) problems.push(`node ${nodes[i]!.id} on node ${nodes[j]!.id}`);
  for (const label of labels) {
    const own = label.role === 'node' ? nodes.find((node) => node.id === label.nodeId) : undefined;

    if (label.role === 'node' && !own) problems.push(`"${label.text}" has no node`);
    for (const node of nodes) if (node !== own && hits(label.box, node.rect)) problems.push(`${label.role} "${label.text}" on node ${node.id}`);
  }
  for (const a of links) for (const b of links) if (a !== b && a.edge !== b.edge && hits(a.box, b.box)) problems.push(`"${a.text}" on "${b.text}"`);
  for (const arrow of arrows) {
    const points = samplePath(`${arrow.d} ${arrow.head}`);

    for (const node of nodes) {
      if (node.id === arrow.from || node.id === arrow.to) continue;
      if (points.some(([x, y]) => ((x - node.n.cx) / node.n.rx) ** 2 + ((y - node.n.cy) / node.n.ry) ** 2 < 1))
        problems.push(`arrow ${arrow.from}->${arrow.to} through node ${node.id}`);
    }
    for (const label of labels)
      if (label.role !== 'node' && points.some(([x, y]) => inside(x, y, label.box))) problems.push(`arrow ${arrow.from}->${arrow.to} through "${label.text}"`);
  }

  return problems;
}

const LONG = 'the very long linking phrase that keeps on going and going';

export const SAMPLE_MAPS: Record<string, ConceptMap> = {
  star: {
    title: 'Photosynthesis — a very long title that is wider than some of the maps',
    nodes: [
      { id: 'r', text: 'Photosynthesis in green plants', level: 0 },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, text: i % 2 ? 'Chlorophyll pigment absorbing red and blue light strongly' : `Leaf ${i}` })),
    ],
    edges: Array.from({ length: 9 }, (_, i) => ({ from: 'r', to: `c${i}`, label: i % 3 ? LONG : 'needs', arrow: 'end' as const })),
  },
  chain: {
    nodes: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, text: `Stage ${i} of the extremely long process name here` })),
    edges: [
      ...Array.from({ length: 5 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, label: LONG })),
      { from: 'n0', to: 'n5', label: 'skips straight to' },
      { from: 'n4', to: 'n1', label: 'feeds back into', arrow: 'both' as const },
    ],
  },
  photosynthesis: {
    title: 'Photosynthesis',
    nodes: [
      { id: 'a', text: 'Photosynthesis in green plants' },
      { id: 'b', text: 'Chlorophyll' },
      { id: 'c', text: 'Carbon dioxide, water and sunlight' },
      { id: 'd', text: 'Glucose' },
    ],
    edges: [
      { from: 'a', to: 'b', label: 'needs a pigment' },
      { from: 'a', to: 'c', label: 'uses' },
      { from: 'a', to: 'd', label: 'makes sugar' },
      { from: 'c', to: 'd', label: 'turn into' },
      { from: 'b', to: 'd', label: 'helps form' },
    ],
  },
  lonely: {
    nodes: [
      { id: 'x', text: 'Pneumonoultramicroscopicsilicovolcanoconiosis is a word' },
      { id: 'y', text: 'Isolated' },
      { id: 'z', text: 'Also isolated but with a much longer name than the other one' },
    ],
    edges: [{ from: 'x', to: 'x', label: 'self' }],
  },
};
