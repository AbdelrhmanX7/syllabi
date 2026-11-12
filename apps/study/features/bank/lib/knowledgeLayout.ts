// Places a class's knowledge map for the width it is shown in: each main concept with its parts
// wrapped underneath, the groups packed left to right like words on a line. No zoom needed — it is
// laid out at the size it is read. Returns the same `Diagram` the concept-map drawing takes.
// Pure — unit-tested.
import type { ClassKnowledge, KnowledgeConcept } from '@/lib/api/types';
import type { Diagram, DiagramEdge, DiagramNode } from '@/features/conceptmaps/lib/diagram';

import { DIAGRAM_DEFAULTS, pathThrough, wrapMeasured, wrapText } from '@/features/conceptmaps/lib/diagram';

export const WEAK_BELOW = 0.6;
export const STRONG_FROM = 0.8;

export type StrengthLevel = 'weak' | 'middle' | 'strong' | 'untried';

export function strengthLevel(strength: number | null): StrengthLevel {
  if (strength === null) return 'untried';
  if (strength >= STRONG_FROM) return 'strong';

  return strength >= WEAK_BELOW ? 'middle' : 'weak';
}

export const STRENGTH_WORD: Record<StrengthLevel, string> = {
  weak: 'Weak',
  middle: 'Getting there',
  strong: 'Strong',
  untried: 'Not tried yet',
};

/** Weakest first, not tried yet last, then by name. */
export const byWeakest = (a: KnowledgeConcept, b: KnowledgeConcept) =>
  (a.strength ?? 2) - (b.strength ?? 2) || a.label.localeCompare(b.label);

/** What «Practise this» drills: the concept's own topic, or (a part) the topic it belongs to. Null = nothing to drill. */
export function practiseTopic(concept: KnowledgeConcept, all: KnowledgeConcept[]): string | null {
  const parent = concept.parentId ? all.find((c) => c.id === concept.parentId) : undefined;

  if (parent) return parent.label;

  return concept.sources.includes('topic') ? concept.label : null;
}

export const KNOWLEDGE_TEXT = { fontSize: 13, lineHeight: 16, charWidth: 6.9, nodePadX: 10, nodePadY: 10 } as const;
const NODE_MAX = 184;
const NODE_MIN = 44;
/** Room for the ring drawn around a picked concept. */
const PAD = 8;
// Wider than the ring around a picked concept (5px + its stroke), so the ring never touches a neighbour.
const GAP = 12;
const GROUP_GAP = 18;
const PARTS_DROP = 20;

interface Box {
  id: string;
  lines: string[];
  w: number;
  h: number;
  x: number;
  y: number;
}

/** Lays boxes out like words: left to right, a new row when the next one does not fit. */
function flow(boxes: Box[], maxWidth: number, gap: number): { w: number; h: number } {
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;

  for (const box of boxes) {
    if (x > 0 && x + box.w > maxWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    box.x = x;
    box.y = y;
    x += box.w + gap;
    rowH = Math.max(rowH, box.h);
    w = Math.max(w, box.x + box.w);
  }

  return { w, h: y + rowH };
}

/** Where the straight line between two box centres leaves the first box. */
function borderPoint(from: Box, to: Box): [number, number] {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const dx = to.x + to.w / 2 - cx;
  const dy = to.y + to.h / 2 - cy;

  if (dx === 0 && dy === 0) return [cx, cy];
  const scale = Math.min(dx === 0 ? Infinity : from.w / 2 / Math.abs(dx), dy === 0 ? Infinity : from.h / 2 / Math.abs(dy));

  return [cx + dx * scale, cy + dy * scale];
}

const r1 = (value: number) => Math.round(value * 10) / 10;

export function layoutKnowledge(
  knowledge: ClassKnowledge,
  width: number,
  measure?: (text: string) => number,
): Diagram {
  const options = { ...DIAGRAM_DEFAULTS, ...KNOWLEDGE_TEXT, padding: PAD };
  const inner = Math.max(120, Math.floor(width) - PAD * 2);
  const maxNode = Math.min(NODE_MAX, inner);
  const textWidth = (text: string) => (measure ? measure(text) : text.length * KNOWLEDGE_TEXT.charWidth);
  const box = (concept: KnowledgeConcept): Box => {
    const room = maxNode - KNOWLEDGE_TEXT.nodePadX * 2;
    const lines = measure ? wrapMeasured(concept.label, room, measure) : wrapText(concept.label, room / KNOWLEDGE_TEXT.charWidth);
    const widest = Math.max(...lines.map(textWidth));

    return {
      id: concept.id,
      lines,
      w: Math.min(maxNode, Math.max(NODE_MIN, Math.ceil(widest + KNOWLEDGE_TEXT.nodePadX * 2))),
      h: Math.ceil(lines.length * KNOWLEDGE_TEXT.lineHeight + KNOWLEDGE_TEXT.nodePadY * 2),
      x: 0,
      y: 0,
    };
  };

  const ids = new Set(knowledge.concepts.map((c) => c.id));
  const isPart = (c: KnowledgeConcept) => !!c.parentId && c.parentId !== c.id && ids.has(c.parentId);
  const mains = knowledge.concepts.filter((c) => !isPart(c)).sort(byWeakest);
  // A part of a part hangs under the main concept too: the map has two levels.
  const mainOf = (c: KnowledgeConcept): string => {
    let at = c;

    for (let hop = 0; hop < 8 && isPart(at); hop++) at = knowledge.concepts.find((p) => p.id === at.parentId)!;

    return at.id;
  };
  const deep = new Map<string, KnowledgeConcept[]>();

  for (const c of knowledge.concepts.filter(isPart)) {
    const main = mainOf(c);

    deep.set(main, [...(deep.get(main) ?? []), c]);
  }

  // One group per main concept: the concept, and its parts wrapped underneath.
  const groups = mains.map((main) => {
    const head = box(main);
    const parts = [...(deep.get(main.id) ?? [])].sort(byWeakest).map(box);
    const rows = flow(parts, inner, GAP);
    const w = Math.max(head.w, rows.w);

    head.x = parts.length ? Math.max(0, Math.min((rows.w - head.w) / 2, w - head.w)) : 0;
    for (const part of parts) part.y += head.h + PARTS_DROP;

    return { head, parts, x: 0, y: 0, w, h: parts.length ? head.h + PARTS_DROP + rows.h : head.h };
  });

  // Pack the groups like words on a line.
  let x = 0;
  let y = 0;
  let rowH = 0;
  let right = 0;

  for (const group of groups) {
    if (x > 0 && x + group.w > inner) {
      x = 0;
      y += rowH + GROUP_GAP;
      rowH = 0;
    }
    group.x = x;
    group.y = y;
    x += group.w + GROUP_GAP;
    rowH = Math.max(rowH, group.h);
    right = Math.max(right, group.x + group.w);
  }

  const placed = new Map<string, Box>();
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const edge = (from: string, to: string, points: [number, number][], path: string): DiagramEdge => ({
    from,
    to,
    label: null,
    labelLines: [],
    labelBox: null,
    points,
    path,
  });

  for (const group of groups) {
    const put = (b: Box, main: boolean) => {
      const at = { ...b, x: PAD + group.x + b.x, y: PAD + group.y + b.y };

      placed.set(b.id, at);
      nodes.push({ id: b.id, lines: b.lines, rank: main ? 0 : 1, root: main && group.parts.length > 0, x: at.x, y: at.y, w: b.w, h: b.h });

      return at;
    };
    const head = put(group.head, true);

    for (const part of group.parts) {
      const at = put(part, false);
      // Leave the main concept above the part where the two overlap sideways, else at its nearest end.
      const leaveX = Math.max(head.x + 10, Math.min(head.x + head.w - 10, at.x + at.w / 2));
      const points: [number, number][] = [
        [leaveX, head.y + head.h],
        [at.x + at.w / 2, at.y],
      ];

      edges.push(edge(group.head.id, part.id, points, pathThrough(points)));
    }
  }

  const drawn = new Set(edges.map((e) => [e.from, e.to].sort().join('|')));

  for (const link of knowledge.edges) {
    if (link.kind !== 'linked') continue;
    const a = placed.get(link.from);
    const b = placed.get(link.to);
    const key = [link.from, link.to].sort().join('|');

    if (!a || !b || link.from === link.to || drawn.has(key)) continue;
    drawn.add(key);
    const points = [borderPoint(a, b), borderPoint(b, a)];

    edges.push(edge(link.from, link.to, points, `M${r1(points[0]![0])},${r1(points[0]![1])} L${r1(points[1]![0])},${r1(points[1]![1])}`));
  }

  return { width: right + PAD * 2, height: (groups.length ? y + rowH : 0) + PAD * 2, nodes, edges, options };
}
