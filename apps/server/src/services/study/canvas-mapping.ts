/**
 * Pure Canvas → study mapping rules. No I/O here, so every rule is unit-testable against
 * fixture JSON (tests/services/study-canvas-mapping.test.ts).
 */
import type { StudyCanvasType, StudyItemType, SubmissionState } from "@/models/study/item";

type Json = Record<string, any>;

// ─── current-term filter ────────────────────────────────────────────────────────────────

const ts = (v: unknown): number | null => {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

const hasDatedTerm = (c: Json) => ts(c?.term?.start_at) !== null && ts(c?.term?.end_at) !== null;

/**
 * Which enrolled courses are "this term".
 *
 * Rule (designed from real community-college data): a course is academic iff its enrollment TERM has
 * both a start and an end date. Non-academic shells (Disability Support, Orientation,
 * Harassment training) all sit in Canvas's undated "Default Term" — and the harassment
 * training even has course dates that cover today, so course dates alone are not enough.
 * Current = dated term whose [start_at, end_at] contains `now`. Between terms (nothing
 * contains `now`) the most recent dated term is kept, so the app is never empty over a break.
 */
export function selectCurrentTermCourses<T extends Json>(courses: T[], now = new Date()): T[] {
  const dated = courses.filter(hasDatedTerm);
  const t = now.getTime();
  const inWindow = dated.filter((c) => ts(c.term.start_at)! <= t && t <= ts(c.term.end_at)!);
  if (inWindow.length) return inWindow;
  const started = dated.filter((c) => ts(c.term.start_at)! <= t);
  if (!started.length) return [];
  const latestTermId = started.reduce((a, b) => (ts(b.term.end_at)! > ts(a.term.end_at)! ? b : a)).term.id;
  return started.filter((c) => c.term.id === latestTermId);
}

// ─── submissions ────────────────────────────────────────────────────────────────────────

/**
 * Canvas submission → study state. Order matters:
 *  excused / graded → graded (a graded "missing" 0 is a grade, not a todo);
 *  `missing` flag → missing; submitted | pending_review → late if flagged late, else submitted;
 *  everything else → unsubmitted.
 */
export function mapSubmission(sub: Json | null | undefined): { state: SubmissionState; score: number | null } {
  const score = typeof sub?.score === "number" ? sub.score : null;
  if (!sub) return { state: "unsubmitted", score: null };
  if (sub.excused) return { state: "graded", score };
  if (sub.workflow_state === "graded") return { state: "graded", score };
  if (sub.missing) return { state: "missing", score };
  if (sub.workflow_state === "submitted" || sub.workflow_state === "pending_review" || sub.submitted_at) {
    return { state: sub.late ? "late" : "submitted", score };
  }
  return { state: "unsubmitted", score };
}

const OFFLINE_TYPES = new Set(["none", "on_paper", "not_graded", "wiki_page"]);
/** False when nothing can be submitted online — such work is never "overdue" unless Canvas flags it missing. */
export const isSubmittable = (types: unknown): boolean =>
  Array.isArray(types) && types.length > 0 ? types.some((t) => !OFFLINE_TYPES.has(String(t))) : false;

// ─── external tools ─────────────────────────────────────────────────────────────────────

export function externalToolName(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes("derivita")) return "Derivita";
  if (host.includes("gradescope")) return "Gradescope";
  return host;
}

// ─── YouTube ────────────────────────────────────────────────────────────────────────────

const YT_RE =
  /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s<>]*?&(?:amp;)?)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/gi;

/** Every YouTube video id in `text` (iframes, links, bare urls), unique, in first-seen order. */
export function extractYouTubeIds(text: unknown): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(YT_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export const youTubeIdFromUrl = (url: unknown): string | null => extractYouTubeIds(url)[0] ?? null;

// ─── grades ─────────────────────────────────────────────────────────────────────────────

export type GradingScheme = { name: string; value: number }[];
const DEFAULT_SCHEME: GradingScheme = [
  { name: "A", value: 0.9 },
  { name: "B", value: 0.8 },
  { name: "C", value: 0.7 },
  { name: "D", value: 0.6 },
  { name: "F", value: 0 },
];

/** Letter for a percentage: the course's grading scheme when it has one, else A/B/C/D/F at 90/80/70/60. */
export function letterFromScore(score: number | null, scheme?: GradingScheme | null): string | null {
  if (score === null || !Number.isFinite(score)) return null;
  const rows = (scheme?.length ? scheme : DEFAULT_SCHEME).slice().sort((a, b) => b.value - a.value);
  // Canvas compares on the 0..1 scale with 2-decimal rounding of the percentage.
  const pct = Math.round(score * 100) / 10000;
  for (const r of rows) if (pct >= r.value - 1e-9) return r.name;
  return rows[rows.length - 1]?.name ?? null;
}

export const gradeTrend = (prev: number | null | undefined, next: number | null): -1 | 0 | 1 => {
  if (prev === null || prev === undefined || next === null) return 0;
  if (next > prev + 1e-9) return 1;
  if (next < prev - 1e-9) return -1;
  return 0;
};

// ─── assignments ────────────────────────────────────────────────────────────────────────

/**
 * Old course copies leave duplicate external-tool assignments that point at the SAME LTI
 * url under the same name (Calc: 79 rows, 4 duplicate pairs). Keep one per (url, name),
 * preferring the one with a due date, then the most recently updated. `alias` maps each
 * dropped id to the kept id so a module item pointing at a dropped copy resolves to the
 * kept Item.
 */
export function dedupeAssignments<T extends Json>(assignments: T[]): { kept: T[]; alias: Map<number, number> } {
  const best = new Map<string, T>();
  const order: string[] = [];
  const keyOf = (a: T) => {
    const url = a?.external_tool_tag_attributes?.url;
    return url && Array.isArray(a.submission_types) && a.submission_types.includes("external_tool")
      ? `${url}|${String(a.name ?? "").trim()}`
      : `id:${a.id}`;
  };
  const better = (a: T, b: T) => {
    if (!!a.due_at !== !!b.due_at) return a.due_at ? a : b;
    return (ts(b.updated_at) ?? 0) > (ts(a.updated_at) ?? 0) ? b : a;
  };
  for (const a of assignments) {
    const k = keyOf(a);
    const cur = best.get(k);
    if (!cur) {
      best.set(k, a);
      order.push(k);
    } else best.set(k, better(cur, a));
  }
  const alias = new Map<number, number>();
  for (const a of assignments) {
    const kept = best.get(keyOf(a))!;
    if (kept.id !== a.id) alias.set(Number(a.id), Number(kept.id));
  }
  return { kept: order.map((k) => best.get(k)!), alias };
}

/**
 * Identity of an assignment row. A classic-quiz assignment IS the quiz (keyed Quiz/quiz_id),
 * a graded discussion IS the discussion (keyed Discussion/topic id) — so the module item
 * that points at the quiz or discussion lands on the same Item.
 */
export function assignmentIdentity(a: Json): { canvasType: StudyCanvasType; canvasId: string; type: StudyItemType } {
  if (a.quiz_id) return { canvasType: "Quiz", canvasId: String(a.quiz_id), type: "quiz" };
  if (a.discussion_topic?.id) return { canvasType: "Discussion", canvasId: String(a.discussion_topic.id), type: "assignment" };
  return { canvasType: "Assignment", canvasId: String(a.id), type: "assignment" };
}

/** File extension from a Canvas filename, sanitised for an object key. */
export function fileExt(name: unknown): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : "bin";
}
