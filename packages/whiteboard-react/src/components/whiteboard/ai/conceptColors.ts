// Ink colours for a concept map, by meaning: each top-level branch (a child of the root) has a hue of
// its own and its descendants and links inherit it; the root and the title are written darker; a
// link's phrase is a muted version of the link's colour. Pure, dependency-free (shared by the board's
// hand-drawn map and the study app's SVG viewer — see `concept-layout.ts`).
//
// Every ink is ≥ 4.5:1 on its paper (checked in conceptColors.test.ts): the light set on white /
// lined paper, the dark set on the dark page. No black, no neon.

export interface ConceptInks {
  /** The root's and the title's ink. */
  root: string;
  /** One hue per branch, cycled when a map has more branches than hues. */
  branches: string[];
}

export const CONCEPT_INKS_LIGHT: ConceptInks = {
  root: '#1e2a4a',
  branches: ['#1d4ed8', '#0f766e', '#b45309', '#7e22ce', '#be123c', '#4d7c0f'],
};

export const CONCEPT_INKS_DARK: ConceptInks = {
  root: '#e0e7ff',
  branches: ['#93c5fd', '#5eead4', '#fdba74', '#d8b4fe', '#fda4af', '#86efac'],
};

/** A node's branch: its index, or -1 for a root (and anything no root reaches). */
export type BranchOf = (id: string) => number;

interface GraphLike {
  nodes: { id: string }[];
  edges: { from: string; to: string }[];
}

/**
 * Branches by breadth-first walk from the roots (nothing points at them, they point at something):
 * a root's child starts a branch (in edge order) and everything below inherits the branch that
 * reached it first.
 */
export function branchesOf(graph: GraphLike): BranchOf {
  const known = new Set(graph.nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to);
  const incoming = new Set(edges.map((edge) => edge.to));
  const roots = new Set(graph.nodes.filter((node) => !incoming.has(node.id) && edges.some((edge) => edge.from === node.id)).map((node) => node.id));
  const branch = new Map<string, number>();
  let next = 0;
  let queue: string[] = [];

  for (const edge of edges)
    if (roots.has(edge.from) && !roots.has(edge.to) && !branch.has(edge.to)) {
      branch.set(edge.to, next++);
      queue.push(edge.to);
    }
  while (queue.length) {
    const following: string[] = [];

    for (const id of queue)
      for (const edge of edges)
        if (edge.from === id && !roots.has(edge.to) && !branch.has(edge.to)) {
          branch.set(edge.to, branch.get(id)!);
          following.push(edge.to);
        }
    queue = following;
  }

  return (id) => branch.get(id) ?? -1;
}

/** A node's ink (and its outline's, and its text's). */
export const nodeInk = (inks: ConceptInks, branch: number): string => (branch < 0 ? inks.root : inks.branches[branch % inks.branches.length]!);

/**
 * A link's branch: from a root → the child's; otherwise the parent's (a cross-link keeps the colour of
 * the node it leaves). -1 = the root ink.
 */
export const edgeBranch = (branchOf: BranchOf, from: string, to: string): number => (branchOf(from) < 0 ? branchOf(to) : branchOf(from));

const channels = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (rgb: number[]) => `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;

/** The link's colour softened toward slate — a phrase is a gloss, not a heading — kept readable on `paper`. */
export function mutedInk(hex: string, paper: 'light' | 'dark' = 'light'): string {
  const slate = channels(paper === 'light' ? '#5b6577' : '#a1a9b8');
  const from = channels(hex);

  return toHex(from.map((value, i) => value * 0.6 + slate[i]! * 0.4));
}
