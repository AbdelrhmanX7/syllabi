import { Types } from "mongoose";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { ConceptVerdict, CriterionScore, IStudyConceptMap, IStudyConceptMapAttempt, StudyConceptMap, StudyConceptMapAttempt } from "@/models/study/concept-map";
import { StudyClassGuide, IStudyClassGuide, StudyExamResult, IStudyExamResult } from "@/models/study/library";
import { parseJsonLoose, Spend, textJson, visionCall } from "./ai-models";
import { cmTextJson } from "./cm-text";
import { htmlToText } from "./extract-sources";
import { collapseLinkingPhrases, conceptLinks, missingTermsOf, Reading, splitTerms, termPresent, unlabeledArrowsOf } from "./concept-map-parse";
import { signedGetUrl } from "./storage";
import { notesContext, notesSuggestions } from "./concept-map-notes";
import { parseTermsHtml } from "./concept-map-terms";
import type { NotesDigest } from "@/models/study/concept-map";

/**
 * Concept maps (P-CM): DTO, lazy Canvas linking, and the model steps of grade / predict /
 * short answers. The grader is grounded in the instructor's rubric page, model answers and
 * comments on past maps (few-shot), and its two countable facts — missing prompt terms and
 * unlabeled arrows — are computed here from the reading, never taken from the model.
 */

/**
 * Rubric criteria, in rubric order. The class rubric publishes no per-criterion points, so 10 is
 * split evenly. The rules are worded the way this professor actually grades (calibrated against
 * their real scores, see CM_CALIBRATION): proportional, lenient deductions — a complete map with
 * most arrows labeled earns 9.5–10.
 */
export const CRITERIA = [
  { name: "Key terms", max: 2, rule: "Every prompt term appears in the map AND is defined (the professor: \"don't forget to define all terms\"). One term left undefined: −0.5." },
  { name: "Labeled arrows", max: 2, rule: "Arrows carry a short label saying what the connection means. Scored by software from the unlabeled-arrow count — give it 2 and never deduct for labels in any other criterion." },
  { name: "Accurate relationships", max: 2, rule: "Each link states a factually correct relationship, in the professor's wording where they have one. −0.5 per clearly wrong link; spelling never counts." },
  { name: "Logical flow", max: 2, rule: "Organised and easy to follow; related terms sit near each other." },
  { name: "Effort & depth", max: 2, rule: "Goes beyond surface links: meaningful extra links, examples, contexts or processes." },
] as const;
export const CM_MAX = CRITERIA.reduce((n, c) => n + c.max, 0);

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function conceptMapDto(m: IStudyConceptMap, classId: Types.ObjectId | string) {
  return {
    id: String(m._id),
    classId: String(classId),
    number: m.number ?? null,
    week: m.week ?? null,
    lecture: m.lecture ?? null,
    dueAt: iso(m.dueAt),
    promptTerms: m.promptTerms ?? [],
    promptTermsSource: m.promptTermsSource ?? null,
    submission: m.submission
      ? { imageUrl: m.submission.imageKey ? (await signedGetUrl(m.submission.imageKey)).url : null, transcription: m.submission.transcription ?? null }
      : null,
    instructor: m.instructor ? { comment: m.instructor.comment ?? null, modelAnswer: m.instructor.modelAnswer ?? null } : null,
    score: m.score ?? null,
    scoreSource: m.scoreSource ?? null,
    canvasScore: m.canvasScore ?? null,
    manualScore: m.manualScore ?? null,
    scoreNote: m.scoreNote ?? null,
    maxScore: m.maxScore ?? 10,
    canvasItemId: m.canvasItemId ? String(m.canvasItemId) : null,
    source: m.source,
    notesPageIds: (m.notesPageIds ?? []).map(String),
    notesDigest: notesDigestDto(m),
  };
}

/** The cached notes digest as the API shows it (null = never built); `generatedAt` = when it was built. */
export const notesDigestDto = (m: Pick<IStudyConceptMap, "notesDigest">) =>
  m.notesDigest?.digest ? { ...m.notesDigest.digest, generatedAt: iso(m.notesDigest.createdAt), model: m.notesDigest.model ?? null } : null;

export const CONCEPT_MAP_TITLE = /concept\s*map\s*(\d+)/i;

/** Prompt terms from a Canvas assignment description ("Prompt terms: A, B and C", a term list, bold terms under a cue) — see concept-map-terms. */
export const termsFromHtml = (html: string | null | undefined): string[] => parseTermsHtml(html).terms;

type ScoreFields = Pick<IStudyConceptMap, "score" | "scoreSource" | "canvasScore" | "manualScore" | "scoreNote">;

/**
 * Score precedence for a Canvas-linked map, given the linked submission's graded score (null =
 * not graded). Canvas is the source of truth, but the owner may override:
 *   1. Canvas CHANGED (graded ≠ the last `canvasScore` seen, incl. first grade) → Canvas wins:
 *      score = graded, any manual override is dropped and `scoreNote` records that.
 *   2. otherwise a manual override wins;
 *   3. otherwise the last Canvas score; 4. otherwise the stored (import) score stays.
 * Returns only the fields that change (empty = nothing to write). A grade that DISAPPEARS from
 * Canvas (graded → null) is not a change: the last seen score stays.
 */
export function resolveScore(m: Partial<ScoreFields>, graded: number | null): Partial<ScoreFields> {
  const cur: ScoreFields = { score: m.score ?? null, scoreSource: m.scoreSource ?? null, canvasScore: m.canvasScore ?? null, manualScore: m.manualScore ?? null, scoreNote: m.scoreNote ?? null };
  const next: ScoreFields = { ...cur };
  if (graded != null && graded !== cur.canvasScore) {
    next.canvasScore = graded;
    next.score = graded;
    next.scoreSource = "canvas";
    if (cur.manualScore != null) {
      next.scoreNote = `Canvas changed the score to ${graded} — it replaced your manual ${cur.manualScore}.`;
      next.manualScore = null;
    }
  } else if (cur.manualScore != null) {
    next.score = cur.manualScore;
    next.scoreSource = "manual";
  } else if (cur.canvasScore != null) {
    next.score = cur.canvasScore;
    next.scoreSource = "canvas";
  }
  const out: Partial<ScoreFields> = {};
  for (const k of Object.keys(next) as Array<keyof ScoreFields>) if (next[k] !== cur[k]) (out as any)[k] = next[k];
  return out;
}

/** PATCH semantics: a number sets the override (it wins until Canvas changes); null clears it back to Canvas / the import. */
export function manualScoreUpdate(m: Partial<ScoreFields>, score: number | null): ScoreFields {
  if (score != null) return { score, scoreSource: "manual", canvasScore: m.canvasScore ?? null, manualScore: score, scoreNote: null };
  const canvas = m.canvasScore ?? null;
  return {
    score: canvas ?? (m.scoreSource === "manual" ? null : m.score ?? null),
    scoreSource: canvas != null ? "canvas" : null,
    canvasScore: canvas,
    manualScore: null,
    scoreNote: null,
  };
}

/**
 * Lazy link (on GET): every synced assignment in the class titled "Concept Map N" is joined to
 * the map with that number (canvasItemId; due date / terms / score filled where the map has
 * none), or becomes a new `source: 'canvas'` map. Practice maps are never linked.
 */
export async function linkCanvasConceptMaps(userId: Types.ObjectId, cls: IStudyClass): Promise<void> {
  const items = await StudyItem.find(
    { userId, classId: cls._id, type: "assignment", title: { $regex: "concept\\s*map\\s*\\d+", $options: "i" } },
    { title: 1, html: 1, dueAt: 1, submission: 1, points: 1, canvasId: 1 }
  ).lean<IStudyItem[]>();
  if (!items.length) return;
  const maps = await StudyConceptMap.find({ userId, canvasCourseId: cls.canvasCourseId, source: { $ne: "practice" } }).lean<IStudyConceptMap[]>();
  for (const it of items) {
    const n = Number(it.title.match(CONCEPT_MAP_TITLE)?.[1]);
    if (!Number.isInteger(n)) continue;
    const m = maps.find((x) => x.canvasAssignmentId && x.canvasAssignmentId === it.canvasId) ?? maps.find((x) => x.number === n);
    const terms = termsFromHtml(it.html);
    const graded = it.submission?.state === "graded" && typeof it.submission.score === "number" ? it.submission.score : null;
    if (m) {
      const set: Record<string, unknown> = {};
      if (!m.canvasItemId || String(m.canvasItemId) !== String(it._id)) set.canvasItemId = it._id;
      if (!m.dueAt && it.dueAt) set.dueAt = it.dueAt;
      if (!m.promptTerms?.length && terms.length && m.promptTermsSource !== "manual") Object.assign(set, { promptTerms: terms, promptTermsSource: "canvas" });
      Object.assign(set, resolveScore(m, graded));
      if (Object.keys(set).length) await StudyConceptMap.updateOne({ _id: m._id }, { $set: set });
    } else {
      await StudyConceptMap.create({
        userId,
        canvasUserId: null,
        canvasCourseId: cls.canvasCourseId,
        source: "canvas",
        number: n,
        dueAt: it.dueAt ?? null,
        promptTerms: terms,
        promptTermsSource: terms.length ? "canvas" : null,
        score: graded,
        scoreSource: graded != null ? "canvas" : null,
        canvasScore: graded,
        maxScore: it.points ?? 10,
        canvasItemId: it._id,
        canvasAssignmentId: it.canvasId,
      });
    }
  }
}

// ─── reading ────────────────────────────────────────────────────────────────────────────

export const CM_READ_PROMPT_EN = [
  "This image is a student's hand-drawn (or digitally drawn) concept map for a college class.",
  "Transcribe it as a graph EXACTLY as drawn — do not correct spelling, do not add or complete anything.",
  'Return ONE JSON object: {"nodes":[{"id":"n1","label":"...","kind":"concept|note"}],"edges":[{"from":"n1","to":"n2","label":"..."}]}',
  "- nodes: every separate block of text that an arrow starts or ends at. label = the text verbatim (join wrapped lines with a space).",
  "- kind: concept = a term or idea (usually short, often boxed/circled/underlined/bold); note = a definition, explanation or example sentence attached to a concept.",
  "- edges: every arrow or connecting line, from its tail node to its head node.",
  "- edge label = words written ALONG or right beside the arrow's shaft (e.g. \"leads to\", \"is an example of\", \"depends on\"). Those words are the arrow's label and are NEVER a separate node. \"\" when the arrow carries no words.",
  "- If an arrow points at a block of text and nothing else, that text is a node (usually kind note) and the arrow's label is \"\" unless other words sit on the shaft.",
  '- Nothing readable → {"nodes":[],"edges":[]}.',
].join("\n");

export function parseReading(raw: unknown): Reading {
  const o = typeof raw === "string" ? parseJsonLoose(raw) : raw;
  const nodes: Reading["nodes"] = [];
  const ids = new Set<string>();
  for (const n of Array.isArray((o as any)?.nodes) ? (o as any).nodes : []) {
    const label = typeof n?.label === "string" ? n.label.trim().slice(0, 400) : typeof n?.text === "string" ? n.text.trim().slice(0, 400) : "";
    if (!label || nodes.length >= 80) continue;
    let id = typeof n?.id === "string" && n.id.trim() ? n.id.trim().slice(0, 40) : `n${nodes.length + 1}`;
    if (ids.has(id)) id = `${id}_${nodes.length + 1}`;
    ids.add(id);
    nodes.push({ id, label, kind: n?.kind === "note" ? "note" : "concept" });
  }
  const edges: Reading["edges"] = [];
  for (const e of Array.isArray((o as any)?.edges) ? (o as any).edges : []) {
    const from = String(e?.from ?? "");
    const to = String(e?.to ?? "");
    if (!ids.has(from) || !ids.has(to) || from === to || edges.length >= 160) continue;
    edges.push({ from, to, label: typeof e?.label === "string" ? e.label.trim().slice(0, 200) : "" });
  }
  return { nodes, edges };
}

export async function readConceptMap(png: Buffer, spend: Spend, signal?: AbortSignal): Promise<Reading> {
  return parseReading(await visionCall(png, "image/png", CM_READ_PROMPT_EN, spend, { signal, json: true }));
}

// ─── grading ────────────────────────────────────────────────────────────────────────────

export interface GradeExample {
  number: number | null;
  lecture: string | null;
  terms: string[];
  transcription: string | null;
  comment: string | null;
  modelAnswer: string | null;
  score: number | null;
}

/** How many past maps go into the few-shot in full (reading + score + comment); every past score feeds the distribution line. */
export const FEW_SHOT_MAX = 6;

/**
 * The grader's calibration anchors: the class's past (non-practice) maps, minus `excludeId` (the
 * map being graded — leave-one-out, so its own score is never in its prompt). `examples` = up to
 * FEW_SHOT_MAX maps that carry content (the owner's transcription, else the reading of the latest
 * graded attempt, plus the professor's comment / model answer / score), most recent first;
 * `scores` = every past score, the professor's distribution.
 */
export async function gradeExamples(
  userId: Types.ObjectId,
  canvasCourseId: number,
  excludeId?: string | null
): Promise<{ examples: GradeExample[]; rubric: string | null; scores: Array<{ number: number | null; score: number }> }> {
  const [maps, guide] = await Promise.all([
    StudyConceptMap.find({ userId, canvasCourseId, source: { $ne: "practice" }, $or: [{ "instructor.modelAnswer": { $ne: null } }, { "instructor.comment": { $ne: null } }, { score: { $ne: null } }] })
      .sort({ number: 1 })
      .lean<IStudyConceptMap[]>(),
    StudyClassGuide.findOne({ userId, canvasCourseId }, { conceptMapRubric: 1 }).lean<IStudyClassGuide>(),
  ]);
  const others = maps.filter((m) => String(m._id) !== String(excludeId ?? ""));
  const needReading = others.filter((m) => m.score != null && !m.submission?.transcription).map((m) => m._id);
  const readings = new Map<string, Reading>();
  if (needReading.length) {
    const atts = await StudyConceptMapAttempt.find({ userId, mapId: { $in: needReading } }, { mapId: 1, reading: 1 }).sort({ createdAt: -1 }).lean<IStudyConceptMapAttempt[]>();
    for (const a of atts) if (!readings.has(String(a.mapId)) && a.reading?.nodes?.length) readings.set(String(a.mapId), a.reading as Reading);
  }
  const transcriptionOf = (m: IStudyConceptMap) => m.submission?.transcription ?? (readings.has(String(m._id)) ? lines(readings.get(String(m._id))!) : null);
  return {
    examples: others
      .filter((m) => transcriptionOf(m) || m.instructor?.comment || m.instructor?.modelAnswer)
      .reverse()
      .slice(0, FEW_SHOT_MAX)
      .reverse()
      .map((m) => ({
        number: m.number,
        lecture: m.lecture,
        terms: m.promptTerms,
        transcription: transcriptionOf(m),
        comment: m.instructor?.comment ?? null,
        modelAnswer: m.instructor?.modelAnswer ?? null,
        score: m.score,
      })),
    rubric: guide?.conceptMapRubric ?? null,
    scores: others.filter((m) => m.score != null).map((m) => ({ number: m.number, score: m.score as number })),
  };
}

export const CM_GRADE_SYSTEM_PROMPT = [
  "You grade a college student's concept map exactly the way their professor does, so your score predicts the professor's.",
  "You get: the professor's rubric page, their model answers and comments on the student's past maps, the prompt terms, the student's map as a graph (nodes + labeled arrows) read from their drawing, and two facts counted by software.",
  'Return ONE JSON object: {"criteria":[{"name":"Key terms","score":0,"note":"..."},{"name":"Labeled arrows","score":0,"note":"..."},{"name":"Accurate relationships","score":0,"note":"..."},{"name":"Logical flow","score":0,"note":"..."},{"name":"Effort & depth","score":0,"note":"..."}],"wrongLinks":[{"from":"...","to":"...","label":"...","why":"..."}],"suggestions":["..."]}',
  "Criteria (each scored 0 to its max in steps of 0.5):",
  ...CRITERIA.map((c) => `- ${c.name} (max ${c.max}): ${c.rule}`),
  "Rules:",
  "- Grade on THIS professor's scale, not a literal reading of the rubric. Learn it from their real scores on the student's past maps (listed, with the maps themselves): whatever gaps those maps had (unlabeled arrows, a thin definition, few extra links) cost only what their score shows — usually 0–0.5 in total. A map as complete as those past ones gets about the same score. Deduct more ONLY for what is clearly worse than every past map: prompt terms missing, terms left undefined, factually wrong links, or a map that is barely a map.",
  "- Trust the software facts: a term listed as missing IS missing; unlabeled arrows ARE unlabeled. Software already caps Key terms and Labeled arrows from those counts — do not penalise the same gap twice.",
  "- A term that appears but is never defined loses Key terms points — the professor's standing comment is \"don't forget to define all terms\".",
  "- Accurate relationships: judge against the professor's model answers and wording first, the textbook second. Spelling slips do not cost accuracy points.",
  "- wrongLinks: only links that state something false or backwards (from/to = node labels as read). why = one short sentence, in the professor's wording where possible.",
  "- note: one short sentence per criterion saying what cost points (\"\" when full marks).",
  "- suggestions: 2–5 concrete fixes, most valuable first (missing terms, definitions to add, arrows to label, links to correct).",
  "- Write for a beginner; define any term you use the first time it appears.",
].join("\n");

const lines = (r: Reading) => {
  const byId = new Map(r.nodes.map((n) => [n.id, n.label]));
  const nodes = r.nodes.map((n) => `- ${n.label}${n.kind === "note" ? " (definition/note)" : ""}`).join("\n") || "(none)";
  const edges = r.edges.map((e) => `- ${byId.get(e.from)} —${e.label ? `"${e.label}"` : "(unlabeled)"}→ ${byId.get(e.to)}`).join("\n") || "(none)";
  return `NODES:\n${nodes}\nARROWS:\n${edges}`;
};

export function buildGradeTurn(o: {
  terms: string[];
  reading: Reading;
  missing: string[];
  unlabeled: number;
  examples: GradeExample[];
  rubric: string | null;
  scores?: Array<{ number: number | null; score: number }>;
  notes?: NotesDigest | null;
  material?: string | null;
}): string {
  const parts: string[] = [];
  if (o.rubric) parts.push(`PROFESSOR'S RUBRIC PAGE:\n${o.rubric.slice(0, 6000)}`);
  if (o.material) parts.push(`THIS LECTURE'S COURSE MATERIAL (to judge Accurate relationships — the professor's wording first, the textbook second):\n${o.material}`);
  if (o.examples.length) {
    parts.push(
      "PAST MAPS WITH THE PROFESSOR'S FEEDBACK:\n" +
        o.examples
          .map((e) =>
            [
              `## Concept Map ${e.number ?? "?"}${e.lecture ? ` — ${e.lecture}` : ""}`,
              `Prompt terms: ${e.terms.join(", ")}`,
              e.transcription ? `Student's map (transcribed):\n${e.transcription.slice(0, 2500)}` : "",
              e.comment ? `Professor's comment: ${e.comment}` : "",
              e.modelAnswer ? `Professor's model answer:\n${e.modelAnswer.slice(0, 3000)}` : "",
              e.score != null ? `Professor's score: ${e.score}/10` : "",
            ]
              .filter(Boolean)
              .join("\n")
          )
          .join("\n\n")
    );
  }
  if (o.scores?.length) {
    const xs = o.scores.map((x) => x.score);
    parts.push(
      `THE PROFESSOR'S SCORES ON THE STUDENT'S OTHER MAPS (out of 10): ${o.scores.map((x) => `CM${x.number ?? "?"} ${x.score}`).join(", ")} — mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)}, lowest ${Math.min(...xs)}.`
    );
  }
  parts.push(`PROMPT TERMS: ${o.terms.join(", ")}`);
  parts.push(`STUDENT'S MAP (read from the drawing):\n${lines(o.reading)}`);
  const notes = o.notes ? notesContext(o.notes) : "";
  if (notes)
    parts.push(`THE STUDENT'S OWN LECTURE NOTES (context for your suggestions ONLY — they never raise or lower any criterion score; grade the map exactly as you would without them):\n${notes.slice(0, 6000)}`);
  parts.push(`SOFTWARE FACTS:\n- Missing prompt terms: ${o.missing.length ? o.missing.join(", ") : "none"}\n- Unlabeled arrows between concepts: ${o.unlabeled} of ${conceptLinks(o.reading).length} (arrows to a definition note are not counted)`);
  return parts.join("\n\n");
}

const half = (n: number) => Math.round(n * 2) / 2;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Gentle penalty curve for unlabeled concept links → share (0..1) of "Labeled arrows" lost.
 * Up to UNLABELED_FREE of the links unlabeled costs nothing (the professor labels most arrows,
 * not all), then it rises linearly until UNLABELED_ZERO unlabeled loses the whole criterion.
 * Non-decreasing in `unlabeled` for a fixed link count. No links at all = nothing labeled = 1.
 */
export const UNLABELED_FREE = 0.1;
export const UNLABELED_ZERO = 0.8;
export function unlabeledPenalty(unlabeled: number, links: number): number {
  if (!links) return 1;
  return clamp01((unlabeled / links - UNLABELED_FREE) / (UNLABELED_ZERO - UNLABELED_FREE));
}

/**
 * Deterministic per-criterion limits from the two countable facts (missing share m = missing /
 * prompt terms, unlabeled penalty u from the curve above).
 *  - Labeled arrows is SET (not capped) from the count: 2 × (1 − u/2), so even a fully unlabeled
 *    map keeps 1 — the professor's real scores show they barely deduct for labels (maps whose
 *    concept links were mostly unlabeled still got 9.5). No concept links at all → 0.
 *  - A missing term also removes every relationship and every bit of depth it would have carried,
 *    so Key terms, Accurate relationships and Effort & depth are capped at 2 × (1 − m), Logical
 *    flow at 2 × (1 − m/2).
 * Half the terms missing + no labels → 1 + 1 + 1 + 1.5 + 1 = 5.5 at most, whatever the model says.
 */
export function criterionCaps(o: { terms: number; missing: number; unlabeled: number; links: number }): Record<string, number> {
  const m = o.terms ? clamp01(o.missing / o.terms) : 0;
  const u = unlabeledPenalty(o.unlabeled, o.links);
  return {
    "Key terms": 2 * (1 - m),
    "Labeled arrows": o.links ? 2 * (1 - u / 2) : 0,
    "Accurate relationships": 2 * (1 - m),
    "Logical flow": 2 * (1 - m / 2),
    "Effort & depth": 2 * (1 - m),
  };
}

/**
 * Post-hoc calibration: raw criteria sum → the professor's scale. A bounded bump that lifts only
 * the upper range, where their lenient grading differs from a literal reading of the rubric:
 *   score = raw + LIFT × max(0, raw − KNEE) × (10 − raw) / (10 − KNEE)
 * Identity at or below KNEE (a failing map is never lifted) and at 10; monotonic for 0 ≤ LIFT ≤ 1
 * (the derivative's minimum, at raw = 10, is 1 − LIFT); never above 10; rounded to 0.5.
 * LIFT is a least-squares fit on the owner's real leave-one-out (prediction, score) pairs —
 * re-fit with `tests/harness/study-concept-map-probe.ts --calibrate`, which prints it. With only
 * a handful of pairs, all at 9.5–10, the 1-parameter bounded form is deliberate: it cannot
 * collapse every map onto 9.5.
 */
// Fitted 2026-10-05 on 12 leave-one-out pairs (CM4/6/7/9 × 3 runs, all actual 9.5): least squares 0.952.
export const CM_CALIBRATION = { knee: 6, lift: 0.95 } as const;
export function calibrateScore(raw: number, lift: number = CM_CALIBRATION.lift, knee: number = CM_CALIBRATION.knee): number {
  const c = Math.min(1, Math.max(0, Number.isFinite(lift) ? lift : 0));
  const r = Math.min(CM_MAX, Math.max(0, Number.isFinite(raw) ? raw : 0));
  const bump = r > knee ? (c * (r - knee) * (CM_MAX - r)) / (CM_MAX - knee) : 0;
  return half(Math.min(CM_MAX, r + bump));
}
/** The shape of the bump at `raw` for LIFT = 1 — the probe fits LIFT = Σφ·(actual − raw) / Σφ². */
export const calibrationBasis = (raw: number, knee: number = CM_CALIBRATION.knee) => (raw > knee ? ((raw - knee) * (CM_MAX - raw)) / (CM_MAX - knee) : 0);

/**
 * Model reply → 5 criterion frames + verdict. Scores are clamped to each max and to the
 * deterministic caps (criterionCaps). verdict.rawScore = the criteria sum; verdict.score = that
 * sum calibrated to the professor's scale (calibrateScore).
 */
export function settleGrade(raw: any, terms: string[], read: Reading, lift: number = CM_CALIBRATION.lift): { criteria: CriterionScore[]; verdict: ConceptVerdict } {
  const reading = collapseLinkingPhrases(read, terms);
  const missingTerms = missingTermsOf(terms, reading);
  const unlabeledArrows = unlabeledArrowsOf(reading);
  const got = new Map<string, any>((Array.isArray(raw?.criteria) ? raw.criteria : []).map((c: any) => [String(c?.name ?? "").toLowerCase(), c]));
  const caps = criterionCaps({ terms: terms.length, missing: missingTerms.length, unlabeled: unlabeledArrows, links: conceptLinks(reading).length });
  const criteria: CriterionScore[] = CRITERIA.map((c) => {
    const r = got.get(c.name.toLowerCase());
    let score = Number(r?.score);
    score = Number.isFinite(score) ? Math.min(c.max, Math.max(0, half(score))) : 0;
    score = c.name === "Labeled arrows" ? half(caps[c.name]) : Math.min(score, half(caps[c.name] ?? c.max));
    if (!reading.nodes.length) score = 0;
    return { name: c.name, score, max: c.max, note: str(r?.note, 400) };
  });
  const labels = reading.nodes.map((n) => n.label);
  const wrongLinks = (Array.isArray(raw?.wrongLinks) ? raw.wrongLinks : [])
    .slice(0, 10)
    .map((w: any) => ({ from: str(w?.from, 200), to: str(w?.to, 200), label: str(w?.label, 200), why: str(w?.why, 400) }))
    .filter((w: any) => w.why && (termPresent(w.from, labels) || termPresent(w.to, labels)));
  const suggestions = (Array.isArray(raw?.suggestions) ? raw.suggestions : []).map((s: unknown) => str(s, 400)).filter(Boolean).slice(0, 6);
  if (missingTerms.length && !suggestions.some((s: string) => missingTerms.some((t) => s.toLowerCase().includes(t.toLowerCase()))))
    suggestions.unshift(`Add the missing term${missingTerms.length > 1 ? "s" : ""}: ${missingTerms.join(", ")} — and define each one.`);
  if (unlabeledArrows && !suggestions.some((s: string) => /label/i.test(s))) suggestions.push(`Label all ${unlabeledArrows} unlabeled arrow${unlabeledArrows > 1 ? "s" : ""} with what the connection means.`);
  const rawScore = half(criteria.reduce((n, c) => n + c.score, 0));
  const score = calibrateScore(rawScore, lift);
  return { criteria, verdict: { score, rawScore, max: CM_MAX, missingTerms, unlabeledArrows, wrongLinks, suggestions: suggestions.slice(0, 6) } };
}

export async function gradeReading(
  o: {
    terms: string[];
    reading: Reading;
    examples: GradeExample[];
    rubric: string | null;
    scores?: Array<{ number: number | null; score: number }>;
    lift?: number;
    notes?: NotesDigest | null;
    /** This lecture's course material, or a function of the chain's context budget (re-packed for the DeepSeek fallback). */
    material?: string | null | ((maxChars: number) => string);
  },
  spend: Spend,
  signal?: AbortSignal
) {
  const reading = collapseLinkingPhrases(o.reading, o.terms);
  const missing = missingTermsOf(o.terms, reading);
  const unlabeled = unlabeledArrowsOf(reading);
  const material = o.material;
  const turn = typeof material === "function" ? (max: number) => buildGradeTurn({ ...o, reading, missing, unlabeled, material: material(max) || null }) : buildGradeTurn({ ...o, reading, missing, unlabeled, material });
  const { out: raw, model, maxChars } = await cmTextJson(CM_GRADE_SYSTEM_PROMPT, turn, spend, { signal, maxTokens: 16_000 }); // reasoning alone can pass 6k tokens — 8k truncated the JSON
  if (!raw) throw new Error("grader returned no JSON");
  const settled = settleGrade(raw, o.terms, reading, o.lift);
  return { ...(o.notes ? withNotesSuggestions(settled, o.notes, reading, o.terms) : settled), model, maxChars };
}

/**
 * Add the notes-grounded lines (concept-map-notes.notesSuggestions) to a settled verdict. Only
 * `suggestions` changes — criteria, score and rawScore are passed through untouched.
 */
export function withNotesSuggestions<T extends { criteria: CriterionScore[]; verdict: ConceptVerdict }>(g: T, notes: NotesDigest, reading: Reading, terms: string[]): T {
  const extra = notesSuggestions(notes, collapseLinkingPhrases(reading, terms), terms).filter((x) => !g.verdict.suggestions.includes(x));
  return extra.length ? { ...g, verdict: { ...g.verdict, suggestions: [...g.verdict.suggestions, ...extra] } } : g;
}

// ─── predict ────────────────────────────────────────────────────────────────────────────

export const CM_PREDICT_SYSTEM_PROMPT = [
  "You predict the exact prompt terms a college professor will post for their NEXT in-class concept map: the one for the lecture named under NEXT LECTURE.",
  "Learn how the professor picks them from PAST CONCEPT MAPS — each lists that lecture's readings, the professor's terms, how many there were, and their own model answer. Their terms are the lecture's central vocabulary from ITS OWN readings (named processes, classifications, and the concepts that link them), written as short noun phrases capitalised like theirs, and their term count stays close to their usual count.",
  'Return ONE JSON object: {"terms":[{"term":"...","p":0.0}],"prompt":["..."],"modelAnswer":"...","why":"...","alternatives":[{"prompt":["..."],"why":"..."}]}',
  "Rules:",
  "- terms: 8–15 candidate terms, ranked, each with p = your probability (0–1) that the professor uses that term in this prompt. Take them from the NEXT LECTURE MATERIAL first; the textbook is background only.",
  "- prompt: the single most likely exact term list the professor will post — their usual count, in the order they would list them; mostly your highest-p terms.",
  "- modelAnswer: the model answer the professor would write for that prompt, in the style and length of their past model answers (define each term and say how they link).",
  "- why: one sentence on why this prompt (what the lecture's readings emphasise; mention the next exam or a weak area when it applies).",
  "- If a POSTED line says one of the professor's pages names this concept map and that page lists its terms, the prompt was posted: return exactly those terms as the prompt (p 1).",
  "- alternatives: 2–3 other plausible term lists (e.g. if their emphasis falls on a different part of the readings), each with a one-sentence why. Never repeat a past map's term set.",
].join("\n");

export interface Prediction {
  /** Ranked candidates, highest p first. */
  terms: Array<{ term: string; p: number }>;
  /** The most likely exact prompt. */
  prompt: string[];
  modelAnswer: string;
  why: string;
  alternatives: Array<{ prompt: string[]; why: string }>;
}

const PREDICT_TERMS_MAX = 20;
const PROMPT_TERMS_MAX = 10;
const termKey = (t: string) => t.trim().toLowerCase();
const termArray = (v: unknown, max: number): string[] => {
  const raw = Array.isArray(v) ? v.map((t: any) => (typeof t === "string" ? t : t?.term)) : typeof v === "string" ? splitTerms(v) : [];
  const out = new Map<string, string>();
  for (const t of raw) {
    const x = str(t, 80);
    if (x && !out.has(termKey(x))) out.set(termKey(x), x);
  }
  return [...out.values()].slice(0, max);
};
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((t) => b.some((u) => termKey(u) === termKey(t)));
const probability = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Number(Math.min(1, n > 1 ? n / 100 : n).toFixed(3));
};

/**
 * The predict reply → a Prediction, or null when it holds no usable prompt (< 3 terms). Lenient:
 * a missing `prompt` is the top-5 ranked terms; percentages become 0–1; the legacy
 * `{prompts:[{terms}]}` shape reads as prompt = the first, alternatives = the rest.
 */
export function parsePredictions(raw: any): Prediction | null {
  const o = raw?.prediction && typeof raw.prediction === "object" ? raw.prediction : raw;
  if (!o || typeof o !== "object") return null;
  const legacy: any[] = Array.isArray(o) ? o : Array.isArray(o.prompts) ? o.prompts : [];
  const ranked = new Map<string, { term: string; p: number }>();
  for (const t of Array.isArray(o.terms) ? o.terms : []) {
    const term = str(typeof t === "string" ? t : t?.term, 80);
    if (term && !ranked.has(termKey(term))) ranked.set(termKey(term), { term, p: typeof t === "string" ? 0 : probability(t?.p ?? t?.probability) });
  }
  const terms = [...ranked.values()].sort((a, b) => b.p - a.p).slice(0, PREDICT_TERMS_MAX);
  let prompt = termArray(o.prompt?.terms ?? o.prompt ?? o.promptTerms, PROMPT_TERMS_MAX);
  if (prompt.length < 3 && legacy.length) prompt = termArray(legacy[0]?.terms ?? legacy[0]?.promptTerms, PROMPT_TERMS_MAX);
  if (prompt.length < 3) prompt = terms.slice(0, 5).map((t) => t.term);
  if (prompt.length < 3) return null;
  const alternatives: Prediction["alternatives"] = [];
  for (const a of [...(Array.isArray(o.alternatives) ? o.alternatives : []), ...legacy.slice(1)]) {
    const p = termArray(a?.prompt?.terms ?? a?.prompt ?? a?.terms, PROMPT_TERMS_MAX);
    if (p.length < 3 || sameSet(p, prompt) || alternatives.some((x) => sameSet(x.prompt, p))) continue;
    alternatives.push({ prompt: p, why: str(a?.why, 500) });
    if (alternatives.length === 3) break;
  }
  return { terms, prompt, modelAnswer: str(o.modelAnswer ?? o.model_answer, 8000), why: str(o.why ?? legacy[0]?.why, 500), alternatives };
}

/** Next scheduled exam (by date ≥ today) + weak sections from real results — the predict/exam focus. */
export async function examFocus(userId: Types.ObjectId, canvasCourseId: number, now = new Date()) {
  const [guide, results] = await Promise.all([
    StudyClassGuide.findOne({ userId, canvasCourseId }, { examsSchedule: 1 }).lean<IStudyClassGuide>(),
    StudyExamResult.find({ userId, canvasCourseId }).sort({ date: -1 }).limit(5).lean<IStudyExamResult[]>(),
  ]);
  const today = now.toISOString().slice(0, 10);
  const upcoming = (guide?.examsSchedule ?? []).filter((e) => e.date && e.date >= today).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const next = upcoming[0] ?? null;
  const weak = results.flatMap((r) => (r.sections ?? []).filter((s) => s.max > 0 && s.score / s.max < 0.7).map((s) => s.name));
  return { next, weak: [...new Set(weak)], results };
}

// ─── short answers ──────────────────────────────────────────────────────────────────────

export const CM_SHORT_ANSWER_SYSTEM_PROMPT = [
  "You write exam short-answer questions for a beginner college student. Assume the short-answer questions on this professor's exams come from their concept maps.",
  'Return ONE JSON object: {"questions":[{"stem":"...","answer":"...","difficulty":2,"tags":["..."]}]}',
  "Rules:",
  "- 3–5 questions in the professor's exam style: \"Explain…\", \"Describe how … relates to …\", \"Compare … and …\", \"Define … and give an example\". Each needs a 3–6 sentence answer.",
  "- Together they cover every prompt term and the key relationships between them.",
  "- answer: a model answer that uses the professor's model-answer wording wherever it covers the point (quote their definitions), defines every term, and is accurate.",
  "- difficulty 1–5. tags: 1–3 short lowercase keywords.",
].join("\n");

export async function generateShortAnswers(m: IStudyConceptMap, spend: Spend, signal?: AbortSignal): Promise<any[]> {
  const turn = [
    `LECTURE: ${m.lecture ?? (m.number ? `Concept Map ${m.number}` : "concept map")}`,
    `PROMPT TERMS: ${(m.promptTerms ?? []).join(", ")}`,
    m.instructor?.modelAnswer ? `PROFESSOR'S MODEL ANSWER:\n${m.instructor.modelAnswer}` : "PROFESSOR'S MODEL ANSWER: (none yet — write from accurate textbook knowledge)",
  ].join("\n\n");
  const out = await textJson(CM_SHORT_ANSWER_SYSTEM_PROMPT, turn, spend, { signal });
  return Array.isArray(out?.questions) ? out.questions.slice(0, 5) : [];
}

export const ownClassForCourse = (userId: Types.ObjectId, canvasCourseId: number) =>
  StudyClass.findOne({ userId, canvasCourseId }, { _id: 1, name: 1 }).lean<IStudyClass>();
