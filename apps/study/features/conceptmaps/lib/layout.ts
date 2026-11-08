// Layered layout for drawing a concept graph (the AI reference map, a thumbnail) as SVG. Roots on
// top, each level centred, straight arrows with their label at the midpoint. Pure — unit-tested.
import type { ReferenceEdge, ReferenceNode } from '../types';

export interface LayoutNode {
  id: string;
  label: string;
  level: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  label: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Label anchor. */
  lx: number;
  ly: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

export interface LayoutOptions {
  /** Approximate px per character for sizing boxes. */
  charWidth?: number;
  minNodeWidth?: number;
  maxNodeWidth?: number;
  nodeHeight?: number;
  hGap?: number;
  vGap?: number;
  padding?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  charWidth: 7.4,
  minNodeWidth: 96,
  maxNodeWidth: 220,
  nodeHeight: 44,
  hGap: 28,
  vGap: 96,
  padding: 24,
};

/**
 * BFS levels. Roots (no incoming edge, at least one outgoing) start at 0; a cycle with no root
 * starts from its first node; nodes with no edges at all sit in a row under everything. An explicit
 * `level` on a node is kept.
 */
export function assignLevels(nodes: ReferenceNode[], edges: ReferenceEdge[]): Map<string, number> {
  const level = new Map<string, number>();
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  const valid = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);

  for (const edge of valid) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  }
  for (const node of nodes)
    if (node.level !== undefined && Number.isFinite(node.level))
      level.set(node.id, Math.max(0, Math.round(node.level)));

  const bfs = (queue: string[]) => {
    while (queue.length) {
      const current = queue.shift()!;
      const base = level.get(current) ?? 0;

      for (const edge of valid) {
        if (edge.from !== current || level.has(edge.to)) continue;
        level.set(edge.to, base + 1);
        queue.push(edge.to);
      }
    }
  };
  const roots = nodes.filter(
    (node) => !level.has(node.id) && (incoming.get(node.id) ?? 0) === 0 && (outgoing.get(node.id) ?? 0) > 0,
  );

  for (const node of roots) level.set(node.id, 0);
  bfs(roots.map((node) => node.id));
  // Explicitly levelled nodes spread to their children too.
  bfs(nodes.filter((node) => level.has(node.id)).map((node) => node.id));
  // Cycles with no root: start each from its first node.
  for (const node of nodes) {
    if (level.has(node.id) || (outgoing.get(node.id) ?? 0) === 0) continue;
    level.set(node.id, 0);
    bfs([node.id]);
  }
  const deepest = Math.max(-1, ...Array.from(level.values()));

  for (const node of nodes) if (!level.has(node.id)) level.set(node.id, deepest + 1);

  return level;
}

/** Where the segment from a box's centre toward (tx, ty) leaves the box. */
function boxExit(box: LayoutNode, tx: number, ty: number): [number, number] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;

  if (dx === 0 && dy === 0) return [cx, cy];
  const scale = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy),
  );

  return [cx + dx * scale, cy + dy * scale];
}

/** Drawing size for fractional boxes: a 0.11-wide box fits ~20 characters of label. */
const FRACTION_WIDTH = 1400;
const FRACTION_HEIGHT = 640;

/**
 * The backend's own layout (reference maps arrive laid out: every node has a `bbox`): boxes as
 * given, shifted so the drawing starts at the padding; arrows run centre to centre, clipped to the
 * box borders. Null when any node lacks a box — the layered layout takes over.
 */
export function layoutFromBoxes(
  nodes: ReferenceNode[],
  edges: ReferenceEdge[],
  padding = DEFAULTS.padding,
): GraphLayout | null {
  if (nodes.length === 0 || !nodes.every((node) => node.bbox)) return null;
  // The live backend sends page fractions (0–1, the whiteboard concept-map frame); scale those to a
  // drawing big enough for the labels. Pixel boxes pass through.
  const fractional = nodes.every((node) => node.bbox!.every((value) => value <= 1.5));
  const boxOf = (node: ReferenceNode): [number, number, number, number] => {
    const [x, y, w, h] = node.bbox!;

    return fractional ? [x * FRACTION_WIDTH, y * FRACTION_HEIGHT, w * FRACTION_WIDTH, h * FRACTION_HEIGHT] : [x, y, w, h];
  };
  const minX = Math.min(...nodes.map((node) => boxOf(node)[0]));
  const minY = Math.min(...nodes.map((node) => boxOf(node)[1]));
  const levels = assignLevels(nodes, edges);
  const placed: LayoutNode[] = nodes.map((node) => {
    const [x, y, w, h] = boxOf(node);

    return {
      id: node.id,
      label: node.text,
      level: levels.get(node.id) ?? 0,
      x: x - minX + padding,
      y: y - minY + padding,
      w,
      h,
    };
  });
  const byId = new Map(placed.map((node) => [node.id, node]));
  const laid: LayoutEdge[] = [];

  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);

    if (!from || !to || from === to) continue;
    const [x1, y1] = boxExit(from, to.x + to.w / 2, to.y + to.h / 2);
    const [x2, y2] = boxExit(to, from.x + from.w / 2, from.y + from.h / 2);

    laid.push({
      from: edge.from,
      to: edge.to,
      label: edge.label ?? null,
      x1,
      y1,
      x2,
      y2,
      lx: (x1 + x2) / 2,
      ly: (y1 + y2) / 2,
    });
  }

  return {
    width: Math.max(...placed.map((node) => node.x + node.w)) + padding,
    height: Math.max(...placed.map((node) => node.y + node.h)) + padding,
    nodes: placed,
    edges: laid,
  };
}

export function layoutConceptGraph(
  nodes: ReferenceNode[],
  edges: ReferenceEdge[],
  options: LayoutOptions = {},
): GraphLayout {
  const opt = { ...DEFAULTS, ...options };
  const boxed = layoutFromBoxes(nodes, edges, opt.padding);

  if (boxed) return boxed;
  const levels = assignLevels(nodes, edges);
  const rows = new Map<number, ReferenceNode[]>();

  for (const node of nodes) {
    const row = levels.get(node.id) ?? 0;
    const list = rows.get(row) ?? [];

    list.push(node);
    rows.set(row, list);
  }
  const sizeOf = (text: string) => ({
    w: Math.min(opt.maxNodeWidth, Math.max(opt.minNodeWidth, Math.round(text.length * opt.charWidth + 28))),
    h: opt.nodeHeight,
  });
  const rowWidths = new Map<number, number>();

  for (const [row, list] of rows) {
    rowWidths.set(
      row,
      list.reduce((sum, node) => sum + sizeOf(node.text).w, 0) + opt.hGap * Math.max(0, list.length - 1),
    );
  }
  const width = Math.max(...Array.from(rowWidths.values()), opt.minNodeWidth) + opt.padding * 2;
  const placed: LayoutNode[] = [];
  const byId = new Map<string, LayoutNode>();
  const rowKeys = Array.from(rows.keys()).sort((a, b) => a - b);

  rowKeys.forEach((row, rowIndex) => {
    const list = rows.get(row)!;
    let x = (width - rowWidths.get(row)!) / 2;
    const y = opt.padding + rowIndex * (opt.nodeHeight + opt.vGap);

    for (const node of list) {
      const { w, h } = sizeOf(node.text);
      const item: LayoutNode = { id: node.id, label: node.text, level: rowIndex, x, y, w, h };

      placed.push(item);
      byId.set(node.id, item);
      x += w + opt.hGap;
    }
  });
  const height = opt.padding * 2 + rowKeys.length * opt.nodeHeight + Math.max(0, rowKeys.length - 1) * opt.vGap;
  const laid: LayoutEdge[] = [];

  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);

    if (!from || !to || from === to) continue;
    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;

    if (to.level > from.level) {
      x1 = from.x + from.w / 2;
      y1 = from.y + from.h;
      x2 = to.x + to.w / 2;
      y2 = to.y;
    } else if (to.level < from.level) {
      x1 = from.x + from.w / 2;
      y1 = from.y;
      x2 = to.x + to.w / 2;
      y2 = to.y + to.h;
    } else {
      const leftToRight = to.x > from.x;

      x1 = leftToRight ? from.x + from.w : from.x;
      y1 = from.y + from.h / 2;
      x2 = leftToRight ? to.x : to.x + to.w;
      y2 = to.y + to.h / 2;
    }
    laid.push({
      from: edge.from,
      to: edge.to,
      label: edge.label ?? null,
      x1,
      y1,
      x2,
      y2,
      lx: (x1 + x2) / 2,
      ly: (y1 + y2) / 2,
    });
  }

  return { width, height, nodes: placed, edges: laid };
}
