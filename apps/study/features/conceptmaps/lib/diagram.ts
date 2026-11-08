// Layered (Sugiyama-style) layout for drawing the AI reference concept map as a readable node-link
// diagram: cycles broken, longest-path ranks, an extra layer between ranks that holds each edge's
// label (so labels never sit on a box or on each other), dummy points for long edges, barycenter
// ordering sweeps, then x positions pulled toward neighbours under a no-overlap constraint.
// Deterministic and pure — unit-tested. The backend's `bbox` is ignored on purpose: it is a
// normalised 0..1 grid (whiteboard `layoutGraph`) that knows nothing about text length.
// The layout engine itself is the board's (`@repo/whiteboard-react/concept-layout`), shared with the
// hand-drawn map; this file sizes the typeset boxes and phrase chips it is fed.
import type { ReferenceEdge, ReferenceNode } from '../types';

import { layeredLayout, placeInOrder } from '@repo/whiteboard-react/concept-layout';

export interface DiagramOptions {
  fontSize?: number;
  lineHeight?: number;
  /** Average glyph advance at `fontSize`, for wrapping and box widths. */
  charWidth?: number;
  nodeMaxWidth?: number;
  nodeMinWidth?: number;
  nodePadX?: number;
  nodePadY?: number;
  labelFontSize?: number;
  labelLineHeight?: number;
  labelCharWidth?: number;
  labelMaxWidth?: number;
  labelPadX?: number;
  labelPadY?: number;
  /** Vertical gap between consecutive layers (node layer ↔ label layer). */
  layerGap?: number;
  nodeGap?: number;
  padding?: number;
}

export interface DiagramNode {
  id: string;
  lines: string[];
  rank: number;
  /** A root: nothing points at it, it points at something. */
  root: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string | null;
  labelLines: string[];
  /** Label chip, centred on the edge's path. */
  labelBox: { x: number; y: number; w: number; h: number } | null;
  /** From the `from` box border to the `to` box border, through the dummy points. */
  points: [number, number][];
  /** SVG path data (vertical cubic segments through `points`). */
  path: string;
}

export interface Diagram {
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  options: Required<DiagramOptions>;
}

export const DIAGRAM_DEFAULTS: Required<DiagramOptions> = {
  fontSize: 15,
  lineHeight: 19,
  charWidth: 7.6,
  nodeMaxWidth: 210,
  nodeMinWidth: 96,
  nodePadX: 14,
  nodePadY: 10,
  labelFontSize: 14,
  labelLineHeight: 17,
  labelCharWidth: 6.9,
  labelMaxWidth: 150,
  labelPadX: 7,
  labelPadY: 3,
  layerGap: 22,
  nodeGap: 22,
  padding: 20,
};

/** Greedy word wrap to `maxChars` per line; a word longer than a line is split. */
export function wrapText(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (let word of words) {
    while (word.length > limit) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, limit - 1) + '-');
      word = word.slice(limit - 1);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  return lines.length ? lines : [''];
}

/**
 * Greedy word wrap by measured width: lines no wider than `maxWidth`; a word wider than a line is
 * split (with a hyphen). `measure` = the rendered width of a string.
 */
export function wrapMeasured(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (let word of words) {
    while (measure(word) > maxWidth && Array.from(word).length > 1) {
      if (line) {
        lines.push(line);
        line = '';
      }
      const chars = Array.from(word);
      let cut = 1;

      while (cut < chars.length - 1 && measure(chars.slice(0, cut + 1).join('') + '-') <= maxWidth) cut++;
      lines.push(chars.slice(0, cut).join('') + '-');
      word = chars.slice(cut).join('');
    }
    if (!line) line = word;
    else if (measure(`${line} ${word}`) <= maxWidth) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  return lines.length ? lines : [''];
}

export { placeInOrder };

/** The rendered width of a node's / a phrase's text (the real font, e.g. a canvas `measureText`). */
export type TextMeasure = (text: string, kind: 'node' | 'label') => number;

/**
 * Units here are board units. For drawings that must match a real size or a map scale (1:N), see
 * `apps/study/docs/RULER.md`: 1 mm of paper = 96/25.4 ≈ 3.7795 board units.
 */
export function layoutDiagram(
  nodes: ReferenceNode[],
  edges: ReferenceEdge[],
  options: DiagramOptions & { measure?: TextMeasure } = {},
): Diagram {
  const { measure, ...rest } = options;
  const opt = { ...DIAGRAM_DEFAULTS, ...rest };

  if (nodes.length === 0) return { width: opt.padding * 2, height: opt.padding * 2, nodes: [], edges: [], options: opt };

  // Text: measured when the host can (the real font), else the average glyph advance.
  const nodeWidth = (text: string) => (measure ? measure(text, 'node') : text.length * opt.charWidth);
  const labelWidth = (text: string) => (measure ? measure(text, 'label') : text.length * opt.labelCharWidth);
  const wrapNode = (text: string) =>
    measure
      ? wrapMeasured(text, opt.nodeMaxWidth - opt.nodePadX * 2, nodeWidth)
      : wrapText(text, (opt.nodeMaxWidth - opt.nodePadX * 2) / opt.charWidth);
  const wrapLabel = (text: string) =>
    measure
      ? wrapMeasured(text, opt.labelMaxWidth - opt.labelPadX * 2, labelWidth)
      : wrapText(text, (opt.labelMaxWidth - opt.labelPadX * 2) / opt.labelCharWidth);
  const sized = nodes.map((node) => {
    const lines = wrapNode(node.text);
    const widest = Math.max(...lines.map(nodeWidth));

    return {
      id: node.id,
      lines,
      w: Math.max(opt.nodeMinWidth, Math.ceil(widest + opt.nodePadX * 2)),
      h: Math.ceil(lines.length * opt.lineHeight + opt.nodePadY * 2),
    };
  });
  const size = new Map(sized.map((node) => [node.id, node]));
  const labels = edges.map((edge) => {
    const label = edge.label?.trim() || null;
    const lines = label ? wrapLabel(label) : [];
    const widest = Math.max(0, ...lines.map(labelWidth));

    return {
      label,
      lines,
      w: label ? Math.ceil(widest + opt.labelPadX * 2) : 0,
      h: label ? Math.ceil(lines.length * opt.labelLineHeight + opt.labelPadY * 2) : 0,
    };
  });
  const laid = layeredLayout(
    sized.map((node) => ({ id: node.id, w: node.w, h: node.h })),
    edges.map((edge, index) => ({
      from: edge.from,
      to: edge.to,
      label: labels[index]!.label ? { w: labels[index]!.w, h: labels[index]!.h } : null,
    })),
    { layerGap: opt.layerGap, nodeGap: opt.nodeGap, mixedGap: 24, pointGap: 12, padding: opt.padding },
  );
  const laidNodes: DiagramNode[] = laid.nodes.map((node) => ({ ...node, lines: size.get(node.id)!.lines }));
  const laidEdges: DiagramEdge[] = laid.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: labels[edge.index]!.label,
    labelLines: labels[edge.index]!.lines,
    labelBox: edge.labelBox,
    points: edge.points,
    path: pathThrough(edge.points),
  }));

  return { width: laid.width, height: laid.height, nodes: laidNodes, edges: laidEdges, options: opt };
}
const r1 = (value: number) => Math.round(value * 10) / 10;

/** Vertical cubic segments through the points, so the curve leaves and enters boxes straight. */
export function pathThrough(points: [number, number][]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  let d = `M${r1(first![0])},${r1(first![1])}`;
  let prev = first!;

  for (const point of rest) {
    const mid = (prev[1] + point[1]) / 2;

    d += ` C${r1(prev[0])},${r1(mid)} ${r1(point[0])},${r1(mid)} ${r1(point[0])},${r1(point[1])}`;
    prev = point;
  }

  return d;
}

// ---------------------------------------------------------------------------
// Hand-placed nodes: the reader drags a box; its links follow, nothing ends up on anything else.
// ---------------------------------------------------------------------------

/** How far each dragged node sits from where the layout put it (drawing units). */
export type NodeOffsets = Record<string, { dx: number; dy: number }>;

type Rect = { x: number; y: number; w: number; h: number };

const rectsHit = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** Where the line from a box's centre toward `toward` leaves the box. */
function borderPoint(box: Rect, toward: [number, number]): [number, number] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;

  if (dx === 0 && dy === 0) return [cx, cy];
  const t = Math.min(box.w / 2 / Math.abs(dx || 1e-9), box.h / 2 / Math.abs(dy || 1e-9));

  return [cx + dx * t, cy + dy * t];
}

/**
 * The nearest shift (rings round the start, `step` apart) that puts `box` clear of every rect in
 * `others` by `gap`. Zero when it is already clear.
 */
export function clearShift(box: Rect, others: Rect[], gap: number, step = 8): { dx: number; dy: number } {
  // (Drawing coordinates start at 0: a spot off the top / left edge is not one.)
  const clear = (dx: number, dy: number) =>
    box.x + dx >= 0 && box.y + dy >= 0 && !others.some((other) => rectsHit({ ...box, x: box.x + dx, y: box.y + dy }, other, gap));

  if (clear(0, 0)) return { dx: 0, dy: 0 };
  for (let ring = 1; ring <= 200; ring++) {
    let best: { dx: number; dy: number; d: number } | null = null;

    for (let i = -ring; i <= ring; i++)
      for (const j of Math.abs(i) === ring ? Array.from({ length: ring * 2 + 1 }, (_, k) => k - ring) : [-ring, ring]) {
        const d = Math.hypot(i, j);

        if ((!best || d < best.d) && clear(i * step, j * step)) best = { dx: i * step, dy: j * step, d };
      }
    if (best) return { dx: best.dx, dy: best.dy };
  }

  return { dx: 0, dy: 0 };
}

/**
 * The laid-out diagram with dragged nodes moved: a link touching a moved node becomes a straight
 * arrow from border to border, its phrase chip on the middle (slid off any box it would cover).
 * Nothing moves left of / above the drawing's origin; the drawing grows to hold what was dragged out.
 */
export function moveDiagramNodes(diagram: Diagram, offsets: NodeOffsets): Diagram {
  const moved = new Set(Object.keys(offsets).filter((id) => offsets[id]!.dx !== 0 || offsets[id]!.dy !== 0));

  if (moved.size === 0) return diagram;
  const nodes = diagram.nodes.map((node) => {
    const offset = offsets[node.id];

    return offset ? { ...node, x: Math.max(0, node.x + offset.dx), y: Math.max(0, node.y + offset.dy) } : node;
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placedChips: Rect[] = diagram.edges.flatMap((edge) => (edge.labelBox && !moved.has(edge.from) && !moved.has(edge.to) ? [edge.labelBox] : []));
  const edges = diagram.edges.map((edge) => {
    if (!moved.has(edge.from) && !moved.has(edge.to)) return edge;
    const a = byId.get(edge.from)!;
    const b = byId.get(edge.to)!;
    const start = borderPoint(a, [b.x + b.w / 2, b.y + b.h / 2]);
    const end = borderPoint(b, [a.x + a.w / 2, a.y + a.h / 2]);
    let labelBox: Rect | null = null;

    if (edge.labelBox) {
      const chip = { ...edge.labelBox, x: (start[0] + end[0]) / 2 - edge.labelBox.w / 2, y: (start[1] + end[1]) / 2 - edge.labelBox.h / 2 };
      const shift = clearShift(chip, [...nodes, ...placedChips], 4, 6);

      labelBox = { ...chip, x: Math.max(0, chip.x + shift.dx), y: Math.max(0, chip.y + shift.dy) };
      placedChips.push(labelBox);
    }
    const points: [number, number][] = [start, end];

    return { ...edge, labelBox, points, path: `M${r1(start[0])},${r1(start[1])} L${r1(end[0])},${r1(end[1])}` };
  });
  const pad = diagram.options.padding;
  const right = Math.max(...nodes.map((node) => node.x + node.w), ...edges.map((edge) => (edge.labelBox ? edge.labelBox.x + edge.labelBox.w : 0)));
  const bottom = Math.max(...nodes.map((node) => node.y + node.h), ...edges.map((edge) => (edge.labelBox ? edge.labelBox.y + edge.labelBox.h : 0)));

  return { ...diagram, nodes, edges, width: Math.max(diagram.width, right + pad), height: Math.max(diagram.height, bottom + pad) };
}

/** After a drop: the dragged node's offset, nudged so its box sits on no other box. */
export function settleDroppedNode(diagram: Diagram, offsets: NodeOffsets, id: string): NodeOffsets {
  const shown = moveDiagramNodes(diagram, offsets);
  const node = shown.nodes.find((candidate) => candidate.id === id);

  if (!node) return offsets;
  const shift = clearShift(
    node,
    shown.nodes.filter((other) => other.id !== id),
    diagram.options.nodeGap / 2,
  );
  const current = offsets[id] ?? { dx: 0, dy: 0 };

  if (shift.dx === 0 && shift.dy === 0) return offsets;

  return { ...offsets, [id]: { dx: current.dx + shift.dx, dy: current.dy + shift.dy } };
}
