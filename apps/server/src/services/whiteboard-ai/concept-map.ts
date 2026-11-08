/**
 * Concept-map graph helpers for the study app's reference maps (POST /study/concept-maps/reference):
 * the generate prompt, JSON → graph parsing, connectivity check and a server-side layout so every
 * node arrives with a box.
 */
export type Bbox = [number, number, number, number];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** A model box ([x,y,w,h], 0..1 or 0..1000) → a normalised, clamped box; null when unusable. */
export function parseBox(raw: unknown): Bbox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const nums = raw.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const scale = nums.every((n) => n <= 1) ? 1 : 1000;
  let [x, y, w, h] = nums.map((n) => n / scale);
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  if (w <= 0.002 || h <= 0.002) return null;
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return [r(x), r(y), r(w), r(h)];
}

export const NODE_SHAPES = ["ellipse", "rect", "rounded", "none"] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];
export const DIRECTIONS = ["TB", "LR", "RL", "BT", "radial"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const ARROWS = ["none", "end", "both"] as const;
export type Arrow = (typeof ARROWS)[number];

export interface GraphNode {
  id: string;
  text: string;
  bbox: Bbox | null;
  shape: NodeShape;
  color?: string;
  level: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  arrow: Arrow;
}
export interface GraphStyle {
  nodeColors: string[];
  edgeColor: string;
  strokeWidth: number;
  font: "handwriting" | "print";
}
export interface ConceptGraph {
  title: string;
  direction: Direction;
  nodes: GraphNode[];
  edges: GraphEdge[];
  style: GraphStyle;
}
export const MAX_NODES = 60;
export const MAX_EDGES = 120;
/**
 * The concept-map generate prompt (POST /study/concept-maps/reference, prompt terms). The JSON
 * contract matches `parseGraph` / `isConnected` / `layoutGraph`.
 */
export const CM_GENERATE_SYSTEM_PROMPT_EN = [
  "You are an expert college instructor. Draw a reference concept map for the given prompt terms (or, when only a topic is given, for that topic), in the style of a model answer: boxes for concepts and short labeled arrows between them.",
  "Return ONE JSON object only:",
  '{"title":"...","nodes":[{"id":"n1","text":"...","level":0}],"edges":[{"from":"n1","to":"n2","label":"..."}]}',
  "- Every prompt term (when given) must appear as its own node, spelled exactly as given. Add a few connecting concepts (and short definitions as nodes) where they make the relationships clear: 6–20 nodes.",
  "- One level-0 node for the overarching concept, then the levels below it. Node text short (1–8 words); a definition node may be up to 15 words.",
  "- Every non-root node connects to a node one level above it. EVERY edge has a short label (\"is part of\", \"leads to\", \"causes\", \"is defined as\", \"forms by\").",
  "- Accurate content for the course only; use the professor's wording from the class guide when it defines a term.",
].join("\n");

export function buildGenerateTurnEn(input: {
  terms?: string[];
  title?: string | null;
  context?: string | null;
  /** Cap on `context` (chars); 12k by default — the study reference passes its own packed budget. */
  contextMax?: number;
  /** Put `context` first (study: the class-wide material is the shared, cacheable prompt prefix). */
  contextFirst?: boolean;
  /** A free topic (when there are no prompt terms), plus optional subject/grade. */
  topic?: string | null;
  subject?: string | null;
  grade?: string | null;
}): string {
  const parts: string[] = [];
  if (input.terms?.length) parts.push(`[Prompt terms] ${input.terms.join(", ")}`);
  if (flatEn(input.title)) parts.unshift(`[Lecture] ${flatEn(input.title)}`);
  if (flatEn(input.subject)) parts.push(`[Subject] ${flatEn(input.subject)}`);
  if (flatEn(input.grade)) parts.push(`[Grade] ${flatEn(input.grade)}`);
  if (input.topic?.trim()) parts.push(`[Topic]\n${input.topic.trim()}`);
  if (flatEn(input.context)) {
    const material = `[Course material]\n${String(input.context).slice(0, input.contextMax ?? 12000)}`;
    if (input.contextFirst) parts.unshift(material);
    else parts.push(material);
  }
  return parts.join("\n");
}
const flatEn = (s?: string | null) => (s ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();

const str = (v: unknown, max = 200): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v: unknown): string | undefined => {
  const s = str(v, 9);
  if (!s) return undefined;
  if (HEX.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return ("#" + [...s.slice(1)].map((c) => c + c).join("")).toLowerCase();
  return undefined;
};

export const DEFAULT_STYLE: GraphStyle = { nodeColors: ["#1747d1"], edgeColor: "#333333", strokeWidth: 3, font: "handwriting" };

const parseJson = (raw: unknown): any => {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
};

/**
 * A graph from the model's JSON: unique ids, edges only between existing nodes (no self-loops,
 * no duplicates), enums enforced, levels repaired from the edges when missing. Null when no
 * node survives.
 */
export function parseGraph(raw: unknown, opts: { requireBoxes?: boolean } = {}): ConceptGraph | null {
  const o = parseJson(raw);
  if (!o || typeof o !== "object") return null;
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  for (const n of Array.isArray(o.nodes) ? o.nodes : []) {
    if (nodes.length >= MAX_NODES) break;
    const text = str(n?.text, 120);
    let id = str(n?.id, 40) ?? `n${nodes.length + 1}`;
    if (!text) continue;
    if (ids.has(id)) id = `${id}_${nodes.length + 1}`;
    ids.add(id);
    const lv = Number(n?.level);
    const color = hex(n?.color);
    nodes.push({
      id,
      text,
      bbox: parseBox(n?.box ?? n?.bbox),
      shape: NODE_SHAPES.includes(n?.shape) ? n.shape : "rect",
      ...(color ? { color } : {}),
      level: Number.isInteger(lv) && lv >= 0 && lv < 20 ? lv : -1,
    });
  }
  if (!nodes.length) return null;
  if (opts.requireBoxes && nodes.every((n) => !n.bbox)) return null;

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(o.edges) ? o.edges : []) {
    if (edges.length >= MAX_EDGES) break;
    const from = str(e?.from, 40);
    const to = str(e?.to, 40);
    if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) continue;
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = str(e?.label, 60);
    edges.push({ from, to, ...(label ? { label } : {}), arrow: ARROWS.includes(e?.arrow) ? e.arrow : "end" });
  }

  repairLevels(nodes, edges);
  const st = o.style && typeof o.style === "object" ? o.style : {};
  const nodeColors = (Array.isArray(st.nodeColors) ? st.nodeColors : []).map(hex).filter((c: string | undefined): c is string => !!c).slice(0, 8);
  const sw = Number(st.strokeWidth);
  return {
    title: str(o.title, 120) ?? nodes.find((n) => n.level === 0)?.text ?? nodes[0].text,
    direction: DIRECTIONS.includes(o.direction) ? o.direction : "TB",
    nodes,
    edges,
    style: {
      nodeColors: nodeColors.length ? nodeColors : [...DEFAULT_STYLE.nodeColors],
      edgeColor: hex(st.edgeColor) ?? DEFAULT_STYLE.edgeColor,
      strokeWidth: Number.isFinite(sw) && sw > 0 && sw <= 20 ? Math.round(sw) : DEFAULT_STYLE.strokeWidth,
      font: st.font === "print" ? "print" : "handwriting",
    },
  };
}

/** Levels from the edges (BFS from the roots) wherever the model gave none or an impossible one. */
export function repairLevels(nodes: GraphNode[], edges: GraphEdge[]): void {
  const incoming = new Map<string, number>();
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const given = nodes.filter((n) => n.level >= 0);
  const roots = given.length ? nodes.filter((n) => n.level === 0) : nodes.filter((n) => !incoming.get(n.id));
  const depth = new Map<string, number>();
  const queue = (roots.length ? roots : [nodes[0]]).map((n) => n.id);
  queue.forEach((id) => depth.set(id, 0));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const e of edges) {
      const other = e.from === id ? e.to : e.to === id && e.arrow !== "end" ? e.from : null;
      if (other && !depth.has(other)) {
        depth.set(other, depth.get(id)! + 1);
        queue.push(other);
      }
    }
  }
  for (const n of nodes) if (n.level < 0) n.level = depth.get(n.id) ?? 1;
}

/**
 * Server-side layout for a generated graph: nodes grouped by level, each level a row (TB/BT)
 * or column (LR/RL), spread evenly; radial puts the root in the middle and each level on a
 * ring. Boxes are normalised 0..1 like everything else on this surface.
 */
export function layoutGraph(g: ConceptGraph): ConceptGraph {
  const byLevel = new Map<number, GraphNode[]>();
  for (const n of g.nodes) byLevel.set(n.level, [...(byLevel.get(n.level) ?? []), n]);
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const L = levels.length;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const nodes = g.nodes.map((n) => ({ ...n }));
  const find = (id: string) => nodes.find((x) => x.id === id)!;
  if (g.direction === "radial") {
    levels.forEach((lv, li) => {
      const row = byLevel.get(lv)!;
      row.forEach((n, i) => {
        const w = 0.16, h = 0.08;
        const radius = li === 0 ? 0 : (0.42 * li) / Math.max(1, L - 1);
        const angle = (2 * Math.PI * i) / row.length - Math.PI / 2;
        const cx = 0.5 + radius * Math.cos(angle);
        const cy = 0.5 + radius * Math.sin(angle);
        find(n.id).bbox = [r4(Math.min(1 - w, Math.max(0, cx - w / 2))), r4(Math.min(1 - h, Math.max(0, cy - h / 2))), w, h];
      });
    });
    return { ...g, nodes };
  }
  const vertical = g.direction === "TB" || g.direction === "BT";
  levels.forEach((lv, li) => {
    const row = byLevel.get(lv)!;
    const along = (li + 0.5) / L; // position of this level across the flow axis
    row.forEach((n, i) => {
      const across = (i + 0.5) / row.length;
      const w = vertical ? Math.min(0.2, 0.9 / row.length) : Math.min(0.2, 0.9 / L);
      const h = vertical ? Math.min(0.1, 0.8 / L) : Math.min(0.1, 0.8 / row.length);
      let cx = vertical ? across : along;
      let cy = vertical ? along : across;
      if (g.direction === "BT") cy = 1 - cy;
      if (g.direction === "RL") cx = 1 - cx;
      find(n.id).bbox = [r4(Math.max(0, cx - w / 2)), r4(Math.max(0, cy - h / 2)), r4(w), r4(h)];
    });
  });
  return { ...g, nodes };
}

/** Every node reachable from the root (level 0, else the first node), edges taken both ways. */
export function isConnected(g: ConceptGraph): boolean {
  if (!g.nodes.length) return false;
  const root = (g.nodes.find((n) => n.level === 0) ?? g.nodes[0]).id;
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
  }
  const seen = new Set([root]);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) for (const next of adj.get(queue[i]) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen.size === g.nodes.length;
}
