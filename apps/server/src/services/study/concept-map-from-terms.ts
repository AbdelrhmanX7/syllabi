import sharp from "sharp";
import { parseJsonLoose, Spend, visionCall } from "./ai-models";
import { guidedSystem } from "./class-guide";

/**
 * "Map my terms" (`POST /study/ai/concept-map/from-terms`): the owner lassos hand-written terms on
 * a notebook page; the FE redraws them as a concept map in his own ink. This module decides only
 * the STRUCTURE — which ink clusters form which term, and the labelled edges between terms.
 *
 * The vision model sees the lassoed image with every cluster boxed and tagged by a short alias
 * ("1", "2", …, in input order) — FE cluster ids can be long, a 1–2 digit tag reads reliably — and
 * the alias list as text. Its reply is validated deterministically here (validateTermsMap): unknown
 * clusters dropped, one node per cluster, edges de-duplicated, labels bounded, levels recomputed.
 */

export const FROM_TERMS_CLUSTERS_MAX = 80;
export const FROM_TERMS_HINT_MAX = 300;
/** Lecture material in the prompt — bounded, this is a vision call. */
export const FROM_TERMS_CONTEXT_MAX_CHARS = 40_000;
export const EDGE_LABEL_MAX = 40;
const NODE_TEXT_MAX = 120;
const EXTRA_MAX = 4;
export const UNRANKED = 1e9;
const MAX_ROOTS = 2;
export const ORPHAN_LABEL = "relates to";

export interface InkCluster {
  id: string;
  bbox: { x: number; y: number; w: number; h: number };
}
export type MapDirection = "TB" | "LR" | "radial";
export interface TermsMap {
  title?: string;
  direction: MapDirection;
  nodes: Array<{ id: string; text: string; clusterIds: string[]; level: number; focus?: boolean }>;
  edges: Array<{ from: string; to: string; label: string }>;
  extra: Array<{ id: string; text: string; level: number }>;
}

const ID_RX = /^[\w.:-]{1,64}$/;
const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Body `clusters` → the clean list, or the 400 message. */
export function parseClusters(v: unknown): { clusters: InkCluster[] } | { error: string } {
  if (!Array.isArray(v) || v.length < 1 || v.length > FROM_TERMS_CLUSTERS_MAX) return { error: `clusters must be 1–${FROM_TERMS_CLUSTERS_MAX} ink groups` };
  const seen = new Set<string>();
  const clusters: InkCluster[] = [];
  for (const c of v) {
    const id = typeof c?.id === "string" ? c.id : typeof c?.id === "number" ? String(c.id) : "";
    if (!ID_RX.test(id)) return { error: "every cluster needs an id (1–64 letters, digits, _ . : -)" };
    if (seen.has(id)) return { error: `duplicate cluster id ${id}` };
    seen.add(id);
    const b = c?.bbox;
    // a hair of float slack past the edge, then clamped
    const fits = (o: number, s: number) => unit(o) && typeof s === "number" && Number.isFinite(s) && s > 0 && o + s <= 1.001;
    if (!b || !fits(b.x, b.w) || !fits(b.y, b.h)) return { error: `cluster ${id}: bbox {x,y,w,h} must lie inside 0..1` };
    clusters.push({ id, bbox: { x: b.x, y: b.y, w: Math.min(b.w, 1 - b.x), h: Math.min(b.h, 1 - b.y) } });
  }
  return { clusters };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/** PNG or JPEG by magic bytes. */
export const isPngOrJpeg = (b: Buffer) => b.subarray(0, 4).equals(PNG_MAGIC) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** The SVG laid over the image: each cluster's box in red, its alias in a white tag above its top-left corner. */
export function overlaySvg(width: number, height: number, clusters: InkCluster[]): string {
  const font = Math.max(12, Math.round(Math.min(width, height) * 0.03));
  const parts = clusters.map((c, i) => {
    const tag = String(i + 1);
    const x = Math.round(c.bbox.x * width);
    const y = Math.round(c.bbox.y * height);
    const w = Math.max(1, Math.round(c.bbox.w * width));
    const h = Math.max(1, Math.round(c.bbox.h * height));
    const tw = Math.round(font * 0.65 * tag.length + font * 0.4);
    const ty = y - font - 2 >= 0 ? y - font - 2 : y + h + 2;
    return (
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#e11d48" stroke-width="2"/>` +
      `<rect x="${x}" y="${ty}" width="${tw}" height="${font + 2}" fill="#ffffff" stroke="#e11d48" stroke-width="1"/>` +
      `<text x="${x + Math.round(font * 0.2)}" y="${ty + font - 1}" font-family="sans-serif" font-size="${font}" font-weight="bold" fill="#e11d48">${xml(tag)}</text>`
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

/** The PNG with every cluster boxed and tagged (see overlaySvg). */
export async function overlayClusters(png: Buffer, clusters: InkCluster[]): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  return sharp(png)
    .composite([{ input: Buffer.from(overlaySvg(width, height, clusters)), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

export const FROM_TERMS_PROMPT_EN = [
  "This image is a region of a college student's hand-written notebook page. Each red box tagged with a number is one ink group (roughly one written word).",
  "The student wrote down concept terms and wants them arranged as a CONCEPT MAP. Decide the map's structure only: which boxes form which term, and the labelled arrows between terms.",
  "Rules:",
  "- Read EVERY box. When several boxes form ONE term (a multi-word term, a word split across lines), put all their tags in that node's clusterIds.",
  "- Each box belongs to at most one node. Ignore scribbles, crossed-out ink, existing arrows and lines — leave those boxes out of every node.",
  "- node text = the term as written (fix only obvious handwriting misreads, keep the student's words).",
  "- Exactly one root concept at level 0 (two only when the terms clearly form two separate topics); every other node must be reachable from a root through edges.",
  "- Every edge needs a label of 1–4 words. Each proposition «from —label→ to» must read as a TRUE sentence, using the lecture's wording when lecture material is given.",
  '- extra = only missing concepts the map really needs to connect the student\'s terms; a few at most (usually none). Edges may use extra ids.',
  '- direction: "TB" for a hierarchy, "LR" for a process or sequence, "radial" for one central idea with spokes. focus: true marks the one or two key terms (optional).',
  'Return ONE JSON object: {"title":"...","direction":"TB","nodes":[{"id":"n1","text":"...","clusterIds":["1","2"],"level":0,"focus":true}],"edges":[{"from":"n1","to":"n2","label":"..."}],"extra":[{"id":"x1","text":"...","level":1}]}',
].join("\n");

/** Validates the legacy `lang` field (accepted for compatibility; the output is always English). */
export const LANG_RX = /^[a-z]{2}(?:-[A-Za-z]{2})?$/;

export function buildFromTermsPrompt(o: { clusters: InkCluster[]; hint?: string | null; material?: string | null; retryNote?: string | null; lang?: string | null }): string {
  const lines = o.clusters.map((c, i) => {
    const b = c.bbox;
    return `${i + 1}: x=${b.x.toFixed(3)} y=${b.y.toFixed(3)} w=${b.w.toFixed(3)} h=${b.h.toFixed(3)}`;
  });
  return [
    guidedSystem(FROM_TERMS_PROMPT_EN),
    ...(o.material ? ["", "LECTURE MATERIAL (use its wording for the propositions):", o.material] : []),
    "",
    `INK GROUPS (tag: normalized box, origin top-left) — ${o.clusters.length}:`,
    ...lines,
    "",
    `Write the title, the edge labels and any extra concepts in English (node text stays as the student wrote it).`,
    ...(o.hint ? ["", `The student's note: ${o.hint}`] : []),
    ...(o.retryNote ? ["", o.retryNote] : []),
  ].join("\n");
}

const str = (v: unknown, max: number) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, max).trim() : "");

export interface ValidatedMap {
  map: TermsMap;
  /** Node ids the model left unconnected to every root (before any repair). */
  orphans: string[];
}

/**
 * The model's reply → a clean map, or null when nothing usable is left (no node with a known
 * cluster). Deterministic: clusterIds mapped back from tags (a raw FE id is accepted too) and
 * unknown ones dropped, each cluster kept in its first node only, node ids unique, edges only
 * between real nodes / extras, no self-loops, one edge per (from, to), labels 1..40 chars.
 * Levels are recomputed by BFS over the edges taken both ways (a proposition may point up at its
 * parent) from the roots (at most two) — the model's level-0 nodes, else the nodes nothing points at, else the
 * first. Extras nothing reaches are dropped. `attachOrphans` = the last resort: every component
 * no root reaches gets one "relates to" edge from the first root to its top node.
 */
export function validateTermsMap(raw: unknown, clusters: InkCluster[], opts: { attachOrphans?: boolean } = {}): ValidatedMap | null {
  const o = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  if (!o || typeof o !== "object") return null;
  const byTag = new Map<string, string>();
  clusters.forEach((c, i) => {
    byTag.set(String(i + 1), c.id);
    if (!byTag.has(c.id)) byTag.set(c.id, c.id);
  });
  const used = new Set<string>();
  const ids = new Set<string>();
  const nodes: TermsMap["nodes"] = [];
  const modelLevel = new Map<string, number>();
  for (const n of Array.isArray((o as any).nodes) ? (o as any).nodes : []) {
    const text = str(n?.text ?? n?.label, NODE_TEXT_MAX);
    const clusterIds: string[] = [];
    for (const t of Array.isArray(n?.clusterIds) ? n.clusterIds : []) {
      const cid = byTag.get(str(t, 64).replace(/^#/, ""));
      if (cid && !used.has(cid)) {
        used.add(cid);
        clusterIds.push(cid);
      }
    }
    if (!text || !clusterIds.length) continue;
    let id = str(n?.id, 40) || `n${nodes.length + 1}`;
    while (ids.has(id)) id = `${id}_${nodes.length + 1}`;
    ids.add(id);
    nodes.push({ id, text, clusterIds, level: 0, ...(n?.focus === true ? { focus: true } : {}) });
    modelLevel.set(id, Number.isInteger(n?.level) ? n.level : UNRANKED);
  }
  if (!nodes.length) return null;

  const extras: Array<{ id: string; text: string; level: number }> = [];
  for (const x of Array.isArray((o as any).extra) ? (o as any).extra : []) {
    const text = str(x?.text ?? x?.label, NODE_TEXT_MAX);
    if (!text || extras.length >= EXTRA_MAX) continue;
    let id = str(x?.id, 40) || `x${extras.length + 1}`;
    while (ids.has(id)) id = `${id}_x${extras.length + 1}`;
    ids.add(id);
    extras.push({ id, text, level: 0 });
  }

  const edges: TermsMap["edges"] = [];
  const pairs = new Set<string>();
  for (const e of Array.isArray((o as any).edges) ? (o as any).edges : []) {
    const from = str(e?.from, 40);
    const to = str(e?.to, 40);
    const label = str(e?.label, EDGE_LABEL_MAX);
    if (!ids.has(from) || !ids.has(to) || from === to || !label || pairs.has(`${from}\0${to}`)) continue;
    pairs.add(`${from}\0${to}`);
    edges.push({ from, to, label });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  let roots = nodes.filter((n) => modelLevel.get(n.id) === 0).map((n) => n.id);
  if (!roots.length) roots = nodes.filter((n) => !edges.some((e) => e.to === n.id)).map((n) => n.id);
  if (!roots.length) roots = [nodes[0].id];
  // "every node is a root" would pass the reachability check vacuously: at most two roots, the best connected
  const degree = (id: string) => edges.filter((e) => e.from === id || e.to === id).length;
  if (roots.length > MAX_ROOTS) roots = roots.map((id, i) => ({ id, i, d: degree(id) })).sort((a, b) => b.d - a.d || a.i - b.i).slice(0, MAX_ROOTS).sort((a, b) => a.i - b.i).map((r) => r.id);

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
  }
  const bfs = (starts: string[]) => {
    const level = new Map<string, number>(starts.map((s) => [s, 0]));
    const queue = [...starts];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nx of adj.get(cur) ?? [])
        if (!level.has(nx)) {
          level.set(nx, level.get(cur)! + 1);
          queue.push(nx);
        }
    }
    return level;
  };
  let level = bfs(roots);
  const orphans = nodes.filter((n) => !level.has(n.id)).map((n) => n.id);
  if (orphans.length && opts.attachOrphans) {
    // one edge per unreached component, to its node the model ranked highest
    const left = new Set(orphans);
    while (left.size) {
      const top = [...left].sort((a, b) => modelLevel.get(a)! - modelLevel.get(b)!)[0];
      edges.push({ from: roots[0], to: top, label: ORPHAN_LABEL });
      adj.set(roots[0], [...(adj.get(roots[0]) ?? []), top]);
      adj.set(top, [...(adj.get(top) ?? []), roots[0]]);
      level = bfs(roots);
      for (const id of [...left]) if (level.has(id)) left.delete(id);
    }
  }

  const keptExtras = extras.filter((x) => level.has(x.id)).map((x) => ({ ...x, level: level.get(x.id)! }));
  const keep = new Set([...nodeIds, ...keptExtras.map((x) => x.id)]);
  const dir = (o as any).direction;
  const title = str((o as any).title, NODE_TEXT_MAX);
  const map: TermsMap = {
    ...(title ? { title } : {}),
    direction: dir === "LR" || dir === "radial" ? dir : "TB",
    // an unreached node keeps level -1 only on the no-repair path, where the caller retries
    nodes: nodes.map((n) => ({ ...n, level: level.get(n.id) ?? -1 })),
    edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    extra: keptExtras,
  };
  return { map, orphans };
}

/**
 * One vision read → validated map. Policy: a reply that is unusable or leaves nodes unconnected
 * is retried ONCE (told which nodes were left out); a still-disconnected second reply — or the
 * first, when the retry is unusable — gets the "relates to" repair as the last resort. null =
 * both replies unusable (the caller's AI_EMPTY).
 */
export async function mapTermsFromInk(o: {
  png: Buffer;
  clusters: InkCluster[];
  hint?: string | null;
  material?: string | null;
  lang?: string | null;
  spend: Spend;
  signal?: AbortSignal;
}): Promise<{ map: TermsMap; repaired: boolean; attempts: number } | null> {
  const image = await overlayClusters(o.png, o.clusters);
  let firstRaw: unknown = null;
  let retryNote: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await visionCall(image, "image/png", buildFromTermsPrompt({ clusters: o.clusters, hint: o.hint, material: o.material, retryNote, lang: o.lang }), o.spend, { signal: o.signal, json: true });
    if (o.signal?.aborted) return null;
    const v = validateTermsMap(raw, o.clusters);
    if (v && !v.orphans.length) return { map: v.map, repaired: false, attempts: attempt };
    if (attempt === 1) {
      firstRaw = v ? raw : null;
      retryNote = v
        ? `Your previous answer left these nodes unconnected to the root: ${v.orphans.map((id) => v.map.nodes.find((n) => n.id === id)?.text ?? id).join(", ")}. Connect every node with labelled edges.`
        : "Your previous answer was unusable. Return the JSON object exactly as specified, with clusterIds taken from the box tags.";
      continue;
    }
    const src = v ? raw : firstRaw;
    if (!src) return null;
    return { map: validateTermsMap(src, o.clusters, { attachOrphans: true })!.map, repaired: true, attempts: attempt };
  }
  return null;
}
