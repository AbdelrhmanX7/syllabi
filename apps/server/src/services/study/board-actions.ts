import sharp from "sharp";
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
/** «Solve it»: how many steps, and how long each may be. */
export const STEPS_MAX = 14;
export const STEP_MAX = 400;
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
  /**
   * The client's contract version. 2 = it understands `mark` actions, `write` with `near`, and the
   * reply's `verdict` (and the model gets the tagged copy of the page + the checking prompt).
   * 1 (or absent) = the first contract, unchanged.
   * 3 = v2 plus the buddy's experts (services/study/buddy): `skill`, `classId`, `pageId` in, and
   * `quiz`, `similar`, `skill`, `turnId`, `trace` out.
   */
  v: 1 | 2 | 3;
  /** v3: the expert the student picked with a button; absent = the picker chooses. */
  skill?: string;
  /** v3: the page's class and the page itself (memory, class knowledge, the turn log). */
  classId?: string;
  pageId?: string;
}
/** v3 «quick check»: one multiple-choice question about the idea behind the page. */
export interface BoardQuiz {
  /** Markdown; maths as $LaTeX$. */
  question: string;
  choices: string[];
  /** Index of the right choice. */
  answer: number;
  why: string;
  topic?: string;
}
/** v3 «similar question»: a new question of the same kind, for a fresh page. Markdown; maths as $LaTeX$. */
export interface BoardSimilar {
  title: string;
  markdown: string;
}
export interface Pt {
  x: number;
  y: number;
}
export type Target = { clusterId: string } | { box: BoardBox };
export type Endpoint = Pt | { clusterId: string };
export type StrokeTool = "pen" | "marker" | "highlighter";
export type MarkVerdict = "correct" | "wrong" | "warning";
export type PageVerdict = "correct" | "wrong" | "partly";
export type BoardAction =
  /** v2: ✓ / ✗ / ! beside a region, with a few words (the fix or the reason). */
  | { type: "mark"; target: Target; verdict: MarkVerdict; label?: string }
  /** v2: a note beside a region — the client finds the empty space. */
  | { type: "write"; text: string; near: Target; size?: number }
  | { type: "point_at"; at: Pt; note?: string }
  | { type: "circle"; target: Target }
  | { type: "underline"; target: Target }
  | { type: "arrow"; from: Endpoint; to: Endpoint; label?: string }
  | { type: "write"; text: string; at: Pt; size?: number }
  | { type: "pen_stroke"; points: Array<[number, number]>; tool?: StrokeTool };
export interface BoardReply {
  actions: BoardAction[];
  say?: string;
  /** v2: was the student's own work right? Absent when there was nothing to check. */
  verdict?: PageVerdict;
  /** v2, handwritten question: the question as the tutor read it. */
  heard?: string;
  /** v2, «solve it»: the worked solution, one step per item, the last one the final answer. */
  steps?: string[];
  quiz?: BoardQuiz;
  similar?: BoardSimilar;
  /** v3: short facts about the student worth keeping (the buddy's memory); never sent to the client. */
  remember?: string[];
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
  const v = Number(o.v) >= 3 ? 3 : Number(o.v) >= 2 ? 2 : 1;
  const oidOf = (x: unknown) => (typeof x === "string" && /^[0-9a-f]{24}$/.test(x) ? x : undefined);
  const skill = v === 3 && typeof o.skill === "string" && /^[a-z_]{2,24}$/.test(o.skill) ? o.skill : undefined;
  const classId = v === 3 ? oidOf(o.classId) : undefined;
  const pageId = v === 3 ? oidOf(o.pageId) : undefined;
  return { input: { question, clusters, v, ...(skill ? { skill } : {}), ...(classId ? { classId } : {}), ...(pageId ? { pageId } : {}) } };
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

/**
 * v2: the tutor CHECKS the student's work before marking. The model gets two images — the clean
 * page and a copy with every listed region outlined and numbered — so it names regions by tag
 * instead of guessing coordinates, and it never chooses where a note goes (the app finds the gap).
 */
export const BOARD_ACTIONS_PROMPT_V2_EN = [
  "You are a tutor sitting next to a college student, looking at the page they have open.",
  "Image 1 is the page. Image 2 is the SAME page with thin magenta outlines and small numbered tags: each tag names one region (a group of the student's handwriting or a block of printed content) listed below. Read from image 1; use image 2 only to find tags.",
  "",
  "Think in this order before you answer (silently):",
  "1. Read the whole page. Tell the student's own handwriting apart from printed material.",
  "2. If the page has the student's own work or answer that the question touches (or they ask whether it is right), solve the problem yourself first, independently. Then compare with their work line by line and find the FIRST place it goes wrong, if any. A different but valid method is not a mistake. If handwriting is unreadable, say so instead of guessing.",
  '3. Decide `verdict`: "correct" (their work/answer is right), "wrong" (the answer is wrong), "partly" (right idea, a slip or a missing piece). Leave it out when there is nothing of theirs to check (a pure explanation).',
  "",
  "Then answer by marking the page. Rules:",
  "- Never invent a mistake. If their work is right, say so plainly and tick the final answer.",
  "- A mistake gets ONE `mark` with verdict \"wrong\" on the exact region where it happens, and `label` = the fix in a few words (e.g. \"sign: should be −3x\"). Something incomplete or risky gets \"warning\". Correct work gets \"correct\" on the final answer only — at most 3 ticks, never one per line.",
  "- Keep the page clean. A mark's label already states the fix, so do NOT add a note that repeats it. Add a `write` only when one more line is really worth seeing on the page (for example the corrected line), at most one per mistake and at most 60 characters; everything else belongs in `say`.",
  "- To say «look here» use circle / underline / arrow / point_at.",
  "- Notes: {\"type\":\"write\",\"text\":\"…\",\"near\":{\"clusterId\":\"<tag>\"}}. You do NOT choose where a note goes — the app puts it in empty space next to that region. Keep notes to a few words (max 120 characters); longer explanations go in `say`.",
  "- Target regions by tag: {\"clusterId\":\"<tag>\"}. Only when what you mean has no tag, give a tight box {\"box\":{\"x\",\"y\",\"w\",\"h\"}} in 0..1 of image 1 (origin top-left).",
  "- Few, purposeful marks: usually 1 to 5, never more than 12. Label what you mark; do not decorate.",
  "- `say`: 1–3 short sentences in plain English. The FIRST sentence answers directly — when you checked their work it gives the verdict (\"Yes, this is right.\" / \"Almost: line 3 drops the minus sign.\"). Be encouraging; never shame.",
  "- ONLY when the student asks you to SOLVE it (work it out, show the full solution, step by step): return `steps` — the whole worked solution in order, one step per item: what you do and the line it gives (e.g. \"Subtract 3 from both sides: 2x = 8\"). 3 to 12 steps, each at most 200 characters, plain text maths (x^2, sqrt(3), a/b — no LaTeX), the last step states the final answer. If the page has several questions, solve the one they point at or wrote about, else the first unsolved one, and name it in `say`. Then `say` is one sentence, and the page gets at most one circle on the question you solved — the steps are NOT written on the page. For any other request leave `steps` out.",
  "Action types (use only these):",
  '- {"type":"mark","target":{"clusterId":"4"},"verdict":"wrong","label":"should be 2x, not x²"}   (verdict: correct | wrong | warning)',
  '- {"type":"circle","target":{"clusterId":"3"}}',
  '- {"type":"underline","target":{"clusterId":"2"}}',
  '- {"type":"arrow","from":{"clusterId":"1"},"to":{"clusterId":"5"},"label":"optional"}',
  '- {"type":"point_at","at":{"x":0.5,"y":0.4},"note":"optional short note"}',
  '- {"type":"write","text":"short note","near":{"clusterId":"2"}}',
  'Return ONE JSON object: {"verdict":"correct|wrong|partly (optional)","actions":[...],"say":"...","steps":["..."] (only when asked to solve)}',
].join("\n");

/** The page with every cluster outlined and numbered (image 2 of the v2 call); null when it cannot be drawn. */
export async function tagBoardImage(image: Buffer, clusters: BoardCluster[]): Promise<Buffer | null> {
  if (clusters.length === 0) return null;
  try {
    const meta = await sharp(image).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return null;
    const font = Math.max(11, Math.round(Math.max(W, H) / 110));
    const parts = clusters.map((c, i) => {
      const x = c.box.x * W;
      const y = c.box.y * H;
      const w = c.box.w * W;
      const h = c.box.h * H;
      const label = String(i + 1);
      const tw = label.length * font * 0.62 + 6;
      const th = font + 4;
      // The tag sits just above the region's top-left corner (inside it when at the page top).
      const tx = Math.max(0, Math.min(W - tw, x - 2));
      const ty = y - th - 1 >= 0 ? y - th - 1 : y + 1;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="#d6009a" stroke-width="1.5" stroke-opacity="0.75"/>` +
        `<rect x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${tw.toFixed(1)}" height="${th}" rx="3" fill="#d6009a"/>` +
        `<text x="${(tx + 3).toFixed(1)}" y="${(ty + font).toFixed(1)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${font}" font-weight="700" fill="#ffffff">${label}</text>`
      );
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
    return await sharp(image)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return null;
  }
}

export function buildBoardActionsPrompt(input: BoardInput, retryNote?: string | null, images?: { tagged: boolean; ask: boolean }, brief?: string | null): string {
  const lines = input.clusters.map((c, i) => {
    const b = c.box;
    return `${i + 1}: x=${b.x.toFixed(3)} y=${b.y.toFixed(3)} w=${b.w.toFixed(3)} h=${b.h.toFixed(3)}`;
  });
  return [
    guidedSystem(input.v >= 2 ? BOARD_ACTIONS_PROMPT_V2_EN : BOARD_ACTIONS_PROMPT_EN),
    ...(brief ? ["", brief] : []),
    "",
    input.v >= 2
      ? lines.length
        ? `REGIONS (tag: normalised box) — ${lines.length}:`
        : "REGIONS: none listed — target with boxes and points; for notes use \"at\":{\"x\",\"y\"} instead of \"near\"."
      : lines.length
        ? `INK GROUPS (tag: normalised box) — ${lines.length}:`
        : "INK GROUPS: none listed — target with boxes and points.",
    ...lines,
    "",
    ...(images?.ask
      ? [
          `IMAGES: 1 = the page${images.tagged ? "; 2 = the tagged copy" : " (no tagged copy this time)"}; the LAST image = the student's question, written by hand on a separate pad (it is NOT part of the page — never mark it).`,
          'Read that handwritten question and answer it. Also return "heard": the question as plain text (your best reading, at most 200 characters).',
          "",
        ]
      : images && !images.tagged && input.v >= 2
        ? ["IMAGES: only the page was sent (no tagged copy).", ""]
        : []),
    images?.ask ? "The student's question: (handwritten — the last image)" : `The student's question: ${input.question}`,
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
export function sanitizeBoardActions(raw: unknown, clusters: BoardCluster[], version: 1 | 2 | 3 = 1): BoardReply | null {
  const v = version >= 2 ? 2 : 1;
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
      case "mark": {
        if (v !== 2) break;
        const t = target(a.target);
        const verdict = a.verdict === "correct" || a.verdict === "wrong" || a.verdict === "warning" ? (a.verdict as MarkVerdict) : null;
        if (!t || !verdict) break;
        const label = str(a.label, LABEL_MAX);
        actions.push({ type: "mark", target: t, verdict, ...(label ? { label } : {}) });
        break;
      }
      case "write": {
        const text = str(a.text, WRITE_TEXT_MAX);
        const near = v === 2 && a.near !== undefined ? target(a.near) : null;
        if (text && near) {
          const size = num(a.size);
          actions.push({ type: "write", text, near, ...(size !== null && size > 0 ? { size: Math.min(WRITE_SIZE_MAX, Math.max(WRITE_SIZE_MIN, size)) } : {}) });
          break;
        }
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
  const pv = (o as any).verdict;
  const verdict = v === 2 && (pv === "correct" || pv === "wrong" || pv === "partly") ? (pv as PageVerdict) : null;
  const heard = v === 2 ? str((o as any).heard, 200) : "";
  const rawSteps = v === 2 && Array.isArray((o as any).steps) ? ((o as any).steps as unknown[]) : [];
  const steps = rawSteps.map((step) => str(step, STEP_MAX)).filter(Boolean).slice(0, STEPS_MAX);
  const quiz = version === 3 ? cleanQuiz((o as any).quiz) : null;
  const similar = version === 3 ? cleanSimilar((o as any).similar) : null;
  const remember =
    version === 3 && Array.isArray((o as any).remember)
      ? ((o as any).remember as unknown[])
          .map((line) => str(line, 160))
          .filter(Boolean)
          .slice(0, 2)
      : [];
  return {
    actions,
    ...(say ? { say } : {}),
    ...(verdict ? { verdict } : {}),
    ...(heard ? { heard } : {}),
    ...(steps.length ? { steps } : {}),
    ...(quiz ? { quiz } : {}),
    ...(similar ? { similar } : {}),
    ...(remember.length ? { remember } : {}),
  };
}

/** Markdown from the model: trimmed and bounded, line breaks kept (`str` would flatten them). */
const md = (v: unknown, max: number) =>
  typeof v === "string"
    ? v
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
        .trim()
    : "";

/** A usable quick check: a question, 2–5 different choices, one of them right. */
export function cleanQuiz(raw: any): BoardQuiz | null {
  if (!raw || typeof raw !== "object") return null;
  const question = md(raw.question, 600);
  const choices = Array.isArray(raw.choices) ? (raw.choices as unknown[]).map((c) => md(c, 200)).filter(Boolean) : [];
  const answer = Number(raw.answer);
  if (!question || choices.length < 2 || choices.length > 5 || new Set(choices).size !== choices.length) return null;
  if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) return null;
  const topic = str(raw.topic, 80);
  return { question, choices, answer, why: md(raw.why, 400), ...(topic ? { topic } : {}) };
}

export function cleanSimilar(raw: any): BoardSimilar | null {
  if (!raw || typeof raw !== "object") return null;
  const markdown = md(raw.markdown, 2000);
  if (!markdown) return null;
  return { title: str(raw.title, 80) || "Practice question", markdown };
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
  /** v2: the student's question, handwritten on the buddy's pad (JPEG). */
  ask?: Buffer | null;
  /** v3: this turn's expert job, memory and knowledge (services/study/buddy), placed after the shared rules. */
  brief?: string | null;
}): Promise<{ reply: BoardReply; attempts: number } | null> {
  let retryNote: string | null = null;
  // v2: the clean page + the tagged copy (same mime needed: the tagged copy is a JPEG, so both are sent as JPEG).
  let images: Buffer | Buffer[] = o.image;
  let mime = o.mime;
  let shape: { tagged: boolean; ask: boolean } | undefined;
  if (o.input.v >= 2) {
    const tagged = await tagBoardImage(o.image, o.input.clusters);
    const ask = o.ask?.length ? o.ask : null;
    if (tagged || ask) {
      const clean = o.mime === "image/jpeg" ? o.image : await sharp(o.image).jpeg({ quality: 88 }).toBuffer();
      images = [clean, ...(tagged ? [tagged] : []), ...(ask ? [ask] : [])];
      mime = "image/jpeg";
    }
    shape = { tagged: Boolean(tagged), ask: Boolean(ask) };
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await visionCall(images, mime, buildBoardActionsPrompt(o.input, retryNote, shape, o.brief), o.spend, { signal: o.signal, json: true, deadlineMs: 90_000 });
    if (o.signal?.aborted) return null;
    const reply = sanitizeBoardActions(raw, o.input.clusters, o.input.v);
    if (reply) return { reply, attempts: attempt };
    retryNote = 'Your previous answer was not valid JSON. Return ONE JSON object exactly as specified: {"actions":[...],"say":"..."}.';
  }
  return null;
}
