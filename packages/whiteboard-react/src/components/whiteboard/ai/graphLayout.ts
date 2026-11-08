import type { ConceptMapDirection } from './types';

/**
 * Deterministic layout for concept maps and flowcharts — tidy tree (top-down, left-to-right,
 * right-to-left) and radial. No dependencies, no randomness: the same graph always lands the same
 * way, so a regenerated map does not jump around.
 *
 * Graphs are not always trees (a flowchart merges, a concept map cross-links). The layout runs on a
 * BFS spanning forest; the edges it dropped are still drawn by the caller, just not used for
 * placement. Each subtree reserves the breadth its widest level needs, so siblings never overlap.
 */

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
  /** A hint from the source (concept map `level`) — 0 marks a root. */
  level?: number;
}

export interface LayoutEdgeInput {
  from: string;
  to: string;
}

export interface LayoutOptions {
  direction: ConceptMapDirection;
  /** Gap between consecutive levels (depth axis). */
  levelGap?: number;
  /** Gap between siblings (breadth axis). */
  siblingGap?: number;
}

export interface PlacedNode {
  id: string;
  /** Centre. */
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  parent: string | null;
}

export interface GraphLayout {
  nodes: Map<string, PlacedNode>;
  /** Bounding box of every node, top-left origin. */
  bounds: { left: number; top: number; width: number; height: number };
  /** Edges that were part of the spanning forest (the rest are cross-links). */
  treeEdges: Set<string>;
}

export const edgeKey = (from: string, to: string) => `${from}\u0000${to}`;

interface TreeNode {
  id: string;
  children: string[];
  parent: string | null;
  depth: number;
}

/** BFS spanning forest. Roots: `level === 0` nodes, else nodes with no incoming edge, else the first. */
export function spanningForest(nodes: LayoutNodeInput[], edges: LayoutEdgeInput[]): { roots: string[]; tree: Map<string, TreeNode> } {
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();

  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, 0);
  }

  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  // Undirected neighbours too: a concept map's links are often drawn child → parent.
  const neighbours = new Map<string, string[]>();

  for (const node of nodes) neighbours.set(node.id, [...(outgoing.get(node.id) ?? [])]);

  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;

    const back = neighbours.get(edge.to)!;

    if (!back.includes(edge.from)) back.push(edge.from);
  }

  const levelRoots = nodes.filter((node) => node.level === 0).map((node) => node.id);
  const sourceRoots = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0 && (outgoing.get(node.id)?.length ?? 0) > 0).map((node) => node.id);
  const preferred = levelRoots.length > 0 ? levelRoots : sourceRoots.length > 0 ? sourceRoots : nodes.slice(0, 1).map((n) => n.id);
  const tree = new Map<string, TreeNode>();
  const roots: string[] = [];

  const grow = (rootId: string) => {
    if (tree.has(rootId)) return;

    roots.push(rootId);
    tree.set(rootId, { id: rootId, children: [], parent: null, depth: 0 });

    const queue = [rootId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentNode = tree.get(current)!;
      // Directed children first, then reverse links, so arrows mostly point away from the root.
      const ordered = [...(outgoing.get(current) ?? []), ...(neighbours.get(current) ?? [])];

      for (const next of ordered) {
        if (tree.has(next)) continue;

        tree.set(next, { id: next, children: [], parent: current, depth: currentNode.depth + 1 });
        currentNode.children.push(next);
        queue.push(next);
      }
    }
  };

  preferred.forEach(grow);
  nodes.forEach((node) => grow(node.id));

  return { roots, tree };
}

export function layoutGraph(nodes: LayoutNodeInput[], edges: LayoutEdgeInput[], options: LayoutOptions): GraphLayout {
  const levelGap = options.levelGap ?? 70;
  const siblingGap = options.siblingGap ?? 28;
  const sizes = new Map(nodes.map((node) => [node.id, node]));
  const { roots, tree } = spanningForest(nodes, edges);
  const treeEdges = new Set<string>();

  for (const node of Array.from(tree.values())) {
    if (node.parent) treeEdges.add(edgeKey(node.parent, node.id));
  }

  const placed = new Map<string, PlacedNode>();
  const place = (id: string, x: number, y: number) => {
    const size = sizes.get(id)!;
    const treeNode = tree.get(id)!;

    placed.set(id, { id, x, y, width: size.width, height: size.height, depth: treeNode.depth, parent: treeNode.parent });
  };

  if (options.direction === 'radial') {
    layoutRadial(roots, tree, sizes, levelGap, siblingGap, place);

    // Leaf-weighted wedges can still seat two small subtrees too close on an inner ring. Pushing
    // every ring out by the same factor widens every gap while the nodes keep their size.
    for (let attempt = 0; attempt < 8 && hasOverlap({ nodes: placed, bounds: { left: 0, top: 0, width: 0, height: 0 }, treeEdges }, siblingGap / 3); attempt += 1) {
      for (const node of Array.from(placed.values())) {
        node.x *= 1.2;
        node.y *= 1.2;
      }
    }
  } else {
    layoutTidy(roots, tree, sizes, options.direction, levelGap, siblingGap, place);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of Array.from(placed.values())) {
    minX = Math.min(minX, node.x - node.width / 2);
    minY = Math.min(minY, node.y - node.height / 2);
    maxX = Math.max(maxX, node.x + node.width / 2);
    maxY = Math.max(maxY, node.y + node.height / 2);
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  return { nodes: placed, bounds: { left: minX, top: minY, width: maxX - minX, height: maxY - minY }, treeEdges };
}

function layoutTidy(
  roots: string[],
  tree: Map<string, TreeNode>,
  sizes: Map<string, LayoutNodeInput>,
  direction: ConceptMapDirection,
  levelGap: number,
  siblingGap: number,
  place: (id: string, x: number, y: number) => void,
) {
  const vertical = direction === 'tb';
  // Breadth = the axis siblings spread along; depth = the axis levels step along.
  const breadthOf = (id: string) => (vertical ? sizes.get(id)!.width : sizes.get(id)!.height);
  const depthSizeOf = (id: string) => (vertical ? sizes.get(id)!.height : sizes.get(id)!.width);

  // Level extents: every node of a level shares one depth band, sized by its deepest node.
  const levelDepth: number[] = [];

  for (const node of Array.from(tree.values())) {
    levelDepth[node.depth] = Math.max(levelDepth[node.depth] ?? 0, depthSizeOf(node.id));
  }

  const levelCentre: number[] = [];
  let cursor = 0;

  for (let level = 0; level < levelDepth.length; level += 1) {
    const size = levelDepth[level] ?? 0;

    levelCentre[level] = cursor + size / 2;
    cursor += size + levelGap;
  }

  const subtreeBreadth = new Map<string, number>();
  const measure = (id: string): number => {
    const node = tree.get(id)!;
    const childrenTotal =
      node.children.reduce((sum, child) => sum + measure(child), 0) + siblingGap * Math.max(0, node.children.length - 1);
    const breadth = Math.max(breadthOf(id), childrenTotal);

    subtreeBreadth.set(id, breadth);

    return breadth;
  };

  const assign = (id: string, start: number) => {
    const node = tree.get(id)!;
    const breadth = subtreeBreadth.get(id)!;
    const centre = start + breadth / 2;
    const depthCentre = levelCentre[node.depth] ?? 0;

    if (vertical) place(id, centre, depthCentre);
    else place(id, direction === 'rtl' ? -depthCentre : depthCentre, centre);

    const childrenTotal =
      node.children.reduce((sum, child) => sum + (subtreeBreadth.get(child) ?? 0), 0) +
      siblingGap * Math.max(0, node.children.length - 1);
    let childStart = start + (breadth - childrenTotal) / 2;

    for (const child of node.children) {
      assign(child, childStart);
      childStart += (subtreeBreadth.get(child) ?? 0) + siblingGap;
    }
  };

  let start = 0;

  for (const root of roots) {
    measure(root);
    assign(root, start);
    start += (subtreeBreadth.get(root) ?? 0) + siblingGap * 2;
  }
}

function layoutRadial(
  roots: string[],
  tree: Map<string, TreeNode>,
  sizes: Map<string, LayoutNodeInput>,
  levelGap: number,
  siblingGap: number,
  place: (id: string, x: number, y: number) => void,
) {
  // Several roots: the first is the centre, the others hang off it as if they were its children.
  const centre = roots[0];

  if (!centre) return;

  const children = (id: string): string[] => {
    const own = tree.get(id)?.children ?? [];

    return id === centre ? [...own, ...roots.slice(1)] : own;
  };
  const depthOf = new Map<string, number>();
  const leaves = new Map<string, number>();
  const countLeaves = (id: string, depth: number): number => {
    depthOf.set(id, depth);

    const kids = children(id);
    const count = kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + countLeaves(kid, depth + 1), 0);

    leaves.set(id, count);

    return count;
  };

  countLeaves(centre, 0);

  const diameter = (id: string) => Math.hypot(sizes.get(id)!.width, sizes.get(id)!.height);
  const byLevel: string[][] = [];

  depthOf.forEach((depth, id) => (byLevel[depth] ??= []).push(id));

  // Each ring is far enough out to clear the previous one AND long enough to seat its nodes.
  const radius: number[] = [0];

  for (let level = 1; level < byLevel.length; level += 1) {
    const ring = byLevel[level] ?? [];
    const previous = byLevel[level - 1] ?? [];
    const clearance =
      (radius[level - 1] ?? 0) +
      Math.max(...previous.map(diameter)) / 2 +
      Math.max(...ring.map(diameter)) / 2 +
      levelGap;
    const circumferenceNeed = ring.reduce((sum, id) => sum + diameter(id) + siblingGap, 0) / (2 * Math.PI);

    radius[level] = Math.max(clearance, circumferenceNeed);
  }

  const assign = (id: string, from: number, to: number) => {
    const depth = depthOf.get(id) ?? 0;
    const angle = (from + to) / 2;
    const r = radius[depth] ?? 0;

    place(id, depth === 0 ? 0 : r * Math.cos(angle), depth === 0 ? 0 : r * Math.sin(angle));

    const kids = children(id);
    const total = leaves.get(id) ?? 1;
    let cursor = from;

    for (const kid of kids) {
      const span = ((to - from) * (leaves.get(kid) ?? 1)) / total;

      assign(kid, cursor, cursor + span);
      cursor += span;
    }
  };

  // Start at the top and go clockwise.
  assign(centre, -Math.PI / 2, (3 * Math.PI) / 2);
}

/**
 * A layout handed to us: node boxes normalised 0..1 (server-generated maps) placed in a `frame` of
 * scene units, keeping the measured node sizes. Null when any node lacks a box or two nodes would
 * overlap — the caller then lays the graph out itself.
 */
export function layoutFromBoxes(
  nodes: Array<LayoutNodeInput & { bbox?: { x: number; y: number; w: number; h: number } }>,
  edges: LayoutEdgeInput[],
  frame: { width: number; height: number },
): GraphLayout | null {
  if (nodes.length === 0 || nodes.some((node) => !node.bbox)) return null;

  const placed = new Map<string, PlacedNode>();

  for (const node of nodes) {
    const box = node.bbox!;

    placed.set(node.id, {
      id: node.id,
      x: (box.x + box.w / 2) * frame.width,
      y: (box.y + box.h / 2) * frame.height,
      width: node.width,
      height: node.height,
      depth: node.level ?? 0,
      parent: null,
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of Array.from(placed.values())) {
    minX = Math.min(minX, node.x - node.width / 2);
    minY = Math.min(minY, node.y - node.height / 2);
    maxX = Math.max(maxX, node.x + node.width / 2);
    maxY = Math.max(maxY, node.y + node.height / 2);
  }

  const layout: GraphLayout = {
    nodes: placed,
    bounds: { left: minX, top: minY, width: maxX - minX, height: maxY - minY },
    // Every given edge is a real link — none drawn dashed as a cross-link.
    treeEdges: new Set(edges.map((edge) => edgeKey(edge.from, edge.to))),
  };

  return hasOverlap(layout, 4) ? null : layout;
}

/** Does any pair of placed nodes overlap (with `margin`)? Used by tests and as a radial safety net. */
export function hasOverlap(layout: GraphLayout, margin = 0): boolean {
  const list = Array.from(layout.nodes.values());

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]!;
      const b = list[j]!;

      if (
        Math.abs(a.x - b.x) < (a.width + b.width) / 2 + margin &&
        Math.abs(a.y - b.y) < (a.height + b.height) / 2 + margin
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Where a straight edge between two node centres leaves a node's outline (rect / ellipse / diamond),
 * so arrows touch the shapes instead of their centres.
 */
export function boundaryPoint(
  centre: { x: number; y: number },
  size: { width: number; height: number },
  toward: { x: number; y: number },
  shape: 'rect' | 'rounded' | 'ellipse' | 'diamond' | 'none',
): { x: number; y: number } {
  const dx = toward.x - centre.x;
  const dy = toward.y - centre.y;

  if (dx === 0 && dy === 0) return { ...centre };

  const hw = size.width / 2;
  const hh = size.height / 2;
  let t: number;

  if (shape === 'ellipse') {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  } else if (shape === 'diamond') {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  }

  return { x: centre.x + dx * t, y: centre.y + dy * t };
}
