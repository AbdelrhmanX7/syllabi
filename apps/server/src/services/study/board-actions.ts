import { parseJsonLoose, Spend, visionCall } from "./ai-models";
import { guidedSystem } from "./class-guide";

/**
 * "Board actions" (`POST /study/ai/board-actions`): the owner asks a question about the page he is
 * looking at; a vision model answers as a tutor marking up that page — pointing, circling,
 * underlining, arrows, short hand-written notes, free pen strokes — and the FE animates the
 * actions onto the board. This module owns the input contract, the prompt, and the deterministic
 * sanitizer the model's reply always passes through (sanitizeBoardActions).
 *
 * Coordinates are normalised 0..1, origin top-left (the NormalizedBox convention of
 * concept-map-from-terms). The model refers to the FE's ink clusters by a short tag ("1", "2", …,
 * in input order) — a raw FE id is accepted too — and every cluster reference is mapped back to
 * the FE id; a reference to a cluster the FE did not send drops the action.
 */

export const BOARD_ACTIONS_MAX = 12;
export const WRITE_TEXT_MAX = 120;
export const NOTE_MAX = 120;
export const LABEL_MAX = 60;
export const SAY_MAX = 600;
export const STROKE_POINTS_MAX = 64;
export const QUESTION_MAX = 2000;
export const BOARD_CLUSTERS_MAX = 200;
/** A write's `size` (fraction of page height) is clamped into this range. */
export const WRITE_SIZE_MIN = 0.01;
export const WRITE_SIZE_MAX = 0.2;
/** A coordinate this far past the page edge is clamped back on; further out the action is dropped. */
const EDGE_SLACK = 0.05;

export interface BoardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface BoardCluster {
  id: string;
  box: BoardBox;
}
export interface BoardInput {
  question: string;
  clusters: BoardCluster[];
}
export interface Pt {
  x: number;
  y: number;
}
export type Target = { clusterId: string } | { box: BoardBox };
export type Endpoint = Pt | { clusterId: string };
export type StrokeTool = "pen" | "marker" | "highlighter";
export type BoardAction =
  | { type: "point_at"; at: Pt; note?: string }
  | { type: "circle"; target: Target }
  | { type: "underline"; target: Target }
  | { type: "arrow"; from: Endpoint; to: Endpoint; label?: string }
  | { type: "write"; text: string; at: Pt; size?: number }
  | { type: "pen_stroke"; points: Array<[number, number]>; tool?: StrokeTool };
export interface BoardReply {
  actions: BoardAction[];
  say?: string;
}

const ID_RX = /^[\w.:-]{1,64}$/;
const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** The multipart `json` field → the clean input, or the 400 message. */
export function parseBoardInput(raw: unknown): { input: BoardInput } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "json must be a JSON string field" };
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return { error: "json is not valid JSON" };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "json must be an object" };
  const question = typeof o.question === "string" ? o.question.trim() : "";
  if (!question || question.length > QUESTION_MAX) return { error: `question must be a non-empty string of at most ${QUESTION_MAX} characters` };
  const list = o.clusters ?? [];
  if (!Array.isArray(list) || list.length > BOARD_CLUSTERS_MAX) return { error: `clusters must be an array of at most ${BOARD_CLUSTERS_MAX}` };
  const seen = new Set<string>();
  const clusters: BoardCluster[] = [];
  for (const c of list) {
    const id = typeof c?.id === "string" ? c.id : typeof c?.id === "number" ? String(c.id) : "";
    if (!ID_RX.test(id)) return { error: "every cluster needs an id (1–64 letters, digits, _ . : -)" };
    if (seen.has(id)) return { error: `duplicate cluster id ${id}` };
    seen.add(id);
    const b = c?.box;
    // a hair of float slack past the edge, then clamped
    const fits = (o: number, s: number) => unit(o) && typeof s === "number" && Number.isFinite(s) && s > 0 && o + s <= 1.001;
    if (!b || !fits(b.x, b.w) || !fits(b.y, b.h)) return { error: `cluster ${id}: box {x,y,w,h} must lie inside 0..1` };
    clusters.push({ id, box: { x: b.x, y: b.y, w: Math.min(b.w, 1 - b.x), h: Math.min(b.h, 1 - b.y) } });
  }
  return { input: { question, clusters } };
}

export const BOARD_ACTIONS_PROMPT_EN = [
  "You are a tutor sitting next to a college student, marking up the student's OWN notebook page (the image) to answer their question.",
  "Point at, circle or underline what matters; draw arrows between related parts; write SHORT hand-written notes near the relevant ink.",
  "Rules:",
  "- NEVER cover existing ink: put notes, arrows and labels in empty space next to what they refer to.",
  "- Answer in English. Keep every written note brief (a few words, at most 120 characters); put any longer explanation in `say`.",
  "- Use few, purposeful marks: at most 12 actions.",
  "- Coordinates are normalised 0..1 of the image, origin top-left (x to the right, y down).",
  "- To target an ink group listed below, use {\"clusterId\":\"<tag>\"}; otherwise give a box {\"x\",\"y\",\"w\",\"h\"}.",
  "Action types (use only these):",
  '- {"type":"point_at","at":{"x":0.5,"y":0.4},"note":"optional short note"}',
  '- {"type":"circle","target":{"clusterId":"3"}}  or  {"type":"circle","target":{"box":{"x":0.1,"y":0.2,"w":0.3,"h":0.05}}}',
  '- {"type":"underline","target":{"clusterId":"2"}}',
  '- {"type":"arrow","from":{"x":0.8,"y":0.3},"to":{"clusterId":"1"},"label":"optional"}',
  '- {"type":"write","text":"short note","at":{"x":0.7,"y":0.25},"size":0.03}   (size = text height as a fraction of the page height)',
  '- {"type":"pen_stroke","points":[[0.1,0.2],[0.15,0.25]],"tool":"pen"}   (at most 64 points; tool: pen | marker | highlighter)',
  'Return ONE JSON object: {"actions":[...],"say":"optional spoken answer"}',
].join("\n");

export function buildBoardActionsPrompt(input: BoardInput, retryNote?: string | null): string {
  const lines = input.clusters.map((c, i) => {
    const b = c.box;
    return `${i + 1}: x=${b.x.toFixed(3)} y=${b.y.toFixed(3)} w=${b.w.toFixed(3)} h=${b.h.toFixed(3)}`;
  });
  return [
    guidedSystem(BOARD_ACTIONS_PROMPT_EN),
    "",
    lines.length ? `INK GROUPS (tag: normalised box) — ${lines.length}:` : "INK GROUPS: none listed — target with boxes and points.",
    ...lines,
    "",
    `The student's question: ${input.question}`,
    ...(retryNote ? ["", retryNote] : []),
  ].join("\n");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max).trim() : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A coordinate within the edge slack → clamped onto the page; anything else → null (drop). */
const coord = (v: unknown): number | null => {
  const n = num(v);
  if (n === null || n < -EDGE_SLACK || n > 1 + EDGE_SLACK) return null;
  return Math.min(1, Math.max(0, n));
};
const point = (v: any): Pt | null => {
  const x = coord(v?.x);
  const y = coord(v?.y);
  return x === null || y === null ? null : { x, y };
};
const box = (v: any): BoardBox | null => {
  const x = num(v?.x);
  const y = num(v?.y);
  const w = num(v?.w);
  const h = num(v?.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  // clip to the page; a box that lies (almost) entirely off it is dropped
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(1, x + w);
  const y1 = Math.min(1, y + h);
  if (x1 - x0 <= 0.001 || y1 - y0 <= 0.001) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Evenly thins a stroke to `max` points, keeping both ends. */
function thin<T>(pts: T[], max: number): T[] {
  if (pts.length <= max) return pts;
  return Array.from({ length: max }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (max - 1))]);
}

/**
 * The model's reply → the clean reply, or null when it is not a JSON object with an `actions`
 * array (the caller's retry signal). Deterministic: unknown types dropped; points clamped onto
 * the page within a small slack, dropped beyond it; boxes clipped; cluster references mapped from
 * tag to FE id, an unknown one drops the action; text bounded; strokes thinned to 64 points;
 * at most 12 actions, in the model's order.
 */
export function sanitizeBoardActions(raw: unknown, clusters: BoardCluster[]): BoardReply | null {
  const o = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  if (!o || typeof o !== "object" || Array.isArray(o) || !Array.isArray((o as any).actions)) return null;
  const byTag = new Map<string, string>();
  clusters.forEach((c, i) => byTag.set(String(i + 1), c.id));
  for (const c of clusters) if (!byTag.has(c.id)) byTag.set(c.id, c.id);
  const clusterRef = (v: unknown): string | null => {
    if (typeof v !== "string" && typeof v !== "number") return null;
    return byTag.get(String(v).trim().replace(/^#/, "")) ?? null;
  };
  const target = (v: any): Target | null => {
    if (v && v.clusterId !== undefined) {
      const id = clusterRef(v.clusterId);
      return id ? { clusterId: id } : null;
    }
    const b = box(v?.box);
    return b ? { box: b } : null;
  };
  const endpoint = (v: any): Endpoint | null => {
    if (v && v.clusterId !== undefined) {
      const id = clusterRef(v.clusterId);
      return id ? { clusterId: id } : null;
    }
    return point(v);
  };

  const actions: BoardAction[] = [];
  for (const a of (o as any).actions) {
    if (actions.length >= BOARD_ACTIONS_MAX) break;
    switch (a?.type) {
      case "point_at": {
        const at = point(a.at);
        if (!at) break;
        const note = str(a.note, NOTE_MAX);
        actions.push({ type: "point_at", at, ...(note ? { note } : {}) });
        break;
      }
      case "circle":
      case "underline": {
        const t = target(a.target);
        if (t) actions.push({ type: a.type, target: t });
        break;
      }
      case "arrow": {
        const from = endpoint(a.from);
        const to = endpoint(a.to);
        if (!from || !to) break;
        const label = str(a.label, LABEL_MAX);
        actions.push({ type: "arrow", from, to, ...(label ? { label } : {}) });
        break;
      }
      case "write": {
        const text = str(a.text, WRITE_TEXT_MAX);
        const at = point(a.at);
        if (!text || !at) break;
        const s = num(a.size);
        actions.push({ type: "write", text, at, ...(s !== null && s > 0 ? { size: Math.min(WRITE_SIZE_MAX, Math.max(WRITE_SIZE_MIN, s)) } : {}) });
        break;
      }
      case "pen_stroke": {
        if (!Array.isArray(a.points)) break;
        const pts: Array<[number, number]> = [];
        for (const p of a.points) {
          const q = Array.isArray(p) ? point({ x: p[0], y: p[1] }) : null;
          if (q) pts.push([q.x, q.y]);
        }
        if (pts.length < 2) break;
        const tool = a.tool === "pen" || a.tool === "marker" || a.tool === "highlighter" ? (a.tool as StrokeTool) : null;
        actions.push({ type: "pen_stroke", points: thin(pts, STROKE_POINTS_MAX), ...(tool ? { tool } : {}) });
        break;
      }
      default:
        break;
    }
  }
  const say = str((o as any).say, SAY_MAX);
  return { actions, ...(say ? { say } : {}) };
}

/**
 * One vision read → sanitized reply. A reply that is not the JSON shape is retried ONCE with a
 * note; null = both replies unusable (the caller's AI_EMPTY).
 */
export async function boardActionsFromPage(o: {
  image: Buffer;
  mime: string;
  input: BoardInput;
  spend: Spend;
  signal?: AbortSignal;
}): Promise<{ reply: BoardReply; attempts: number } | null> {
  let retryNote: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await visionCall(o.image, o.mime, buildBoardActionsPrompt(o.input, retryNote), o.spend, { signal: o.signal, json: true, deadlineMs: 90_000 });
    if (o.signal?.aborted) return null;
    const reply = sanitizeBoardActions(raw, o.input.clusters);
    if (reply) return { reply, attempts: attempt };
    retryNote = 'Your previous answer was not valid JSON. Return ONE JSON object exactly as specified: {"actions":[...],"say":"..."}.';
  }
  return null;
}
