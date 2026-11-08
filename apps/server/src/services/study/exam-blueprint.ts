import { Types } from "mongoose";
import { IStudyQuestion, StudyQuestion, STUDY_QUESTION_TYPES } from "@/models/study/question";
import { ExamBlueprint, ExamBlueprintSection, ExamScheduleEntry, IStudyClassGuide, StudyClassGuide } from "@/models/study/library";
import { IStudyConceptMap, StudyConceptMap } from "@/models/study/concept-map";
import type { Spend } from "./ai-models";
import { generateSimilar } from "./ai";
import { examFocus, generateShortAnswers } from "./concept-maps";
import { normTerm } from "./concept-map-parse";
import { EXAM_MAX_COUNT, EXAM_MAX_MINUTES, focusBonus, pickQuestions, snapshot } from "./exams";
import { QuestionDraft, saveQuestion, toDraft, topicMastery } from "./questions";

/**
 * Class-blueprint mock exams (`POST /study/exams {blueprint:'class'}`): the exam is built in the
 * class's real structure — sections in blueprint order, each question labelled with its section —
 * scoped to the NEXT exam in the schedule. Each section fills from the bank first; the shortfall
 * is generated (source.kind "mock") with the section's type. Optional sections are bank-only.
 */

export class BlueprintError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const DEFAULT_EXAM_MINUTES = 110;
export const BLUEPRINT_TYPES = [...STUDY_QUESTION_TYPES, "any"] as const;

/** An example blueprint (a typical intro-science midterm). Not applied to any course by default. */
export const EXAMPLE_EXAM_BLUEPRINT: ExamBlueprint = {
  minutes: DEFAULT_EXAM_MINUTES,
  sections: [
    { section: "Multiple choice", type: "mcq", count: 25 },
    { section: "Matching", type: "matching", count: 1, preferImage: true },
    { section: "Fill in the blank", type: "fill_blank", count: 5 },
    { section: "Short answer", type: "free", count: 4, from: "concept_map" },
    { section: "Diagram to complete", type: "label_image", count: 1, optional: true },
    { section: "Bonus", type: "any", count: 1, bonus: true },
  ],
};

/** Code defaults per Canvas course; an owner-stored blueprint (study_class_guides.examBlueprint) wins. */
export const DEFAULT_EXAM_BLUEPRINTS: Record<number, ExamBlueprint> = {};

/** Input → a clean blueprint; throws BlueprintError 400 VALIDATION_ERROR. */
export function validateBlueprint(raw: any): ExamBlueprint {
  const bad = (m: string) => new BlueprintError(400, "VALIDATION_ERROR", m);
  if (!raw || typeof raw !== "object") throw bad("blueprint must be an object {minutes?, sections}");
  const minutes = raw.minutes === undefined || raw.minutes === null ? null : Number(raw.minutes);
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > EXAM_MAX_MINUTES)) throw bad(`minutes must be an integer 1–${EXAM_MAX_MINUTES}`);
  if (!Array.isArray(raw.sections) || !raw.sections.length || raw.sections.length > 20) throw bad("sections must be a non-empty array (max 20)");
  const seen = new Set<string>();
  const sections: ExamBlueprintSection[] = raw.sections.map((s: any, i: number) => {
    const name = typeof s?.section === "string" ? s.section.trim() : "";
    if (!name || name.length > 80) throw bad(`sections[${i}].section must be a non-empty string (max 80)`);
    if (seen.has(name.toLowerCase())) throw bad(`sections[${i}]: duplicate section "${name}"`);
    seen.add(name.toLowerCase());
    if (!(BLUEPRINT_TYPES as readonly string[]).includes(s?.type)) throw bad(`sections[${i}].type must be one of ${BLUEPRINT_TYPES.join(", ")}`);
    if (!Number.isInteger(s?.count) || s.count < 1 || s.count > EXAM_MAX_COUNT) throw bad(`sections[${i}].count must be an integer 1–${EXAM_MAX_COUNT}`);
    if (s.points !== undefined && s.points !== null && (typeof s.points !== "number" || !Number.isFinite(s.points) || s.points < 0 || s.points > 1000)) throw bad(`sections[${i}].points must be a number 0–1000`);
    for (const k of ["bonus", "optional", "preferImage"]) if (s[k] !== undefined && typeof s[k] !== "boolean") throw bad(`sections[${i}].${k} must be a boolean`);
    if (s.from !== undefined && s.from !== null && s.from !== "concept_map") throw bad(`sections[${i}].from must be "concept_map" or null`);
    return {
      section: name,
      type: s.type,
      count: s.count,
      ...(typeof s.points === "number" ? { points: s.points } : {}),
      ...(s.bonus ? { bonus: true } : {}),
      ...(s.optional ? { optional: true } : {}),
      ...(s.preferImage ? { preferImage: true } : {}),
      ...(s.from ? { from: s.from } : {}),
    };
  });
  const total = sections.reduce((n, s) => n + s.count, 0);
  if (total > EXAM_MAX_COUNT) throw bad(`the sections add up to ${total} questions (max ${EXAM_MAX_COUNT})`);
  return { minutes, sections };
}

export async function resolveBlueprint(userId: Types.ObjectId, canvasCourseId: number): Promise<{ blueprint: ExamBlueprint; source: "stored" | "default" } | null> {
  const g = await StudyClassGuide.findOne({ userId, canvasCourseId }, { examBlueprint: 1 }).sort({ updatedAt: -1 }).lean<IStudyClassGuide>();
  if (g?.examBlueprint?.sections?.length) return { blueprint: g.examBlueprint, source: "stored" };
  const d = DEFAULT_EXAM_BLUEPRINTS[canvasCourseId];
  return d ? { blueprint: d, source: "default" } : null;
}

// ─── composition ────────────────────────────────────────────────────────────────────────

const POOL_MAX = 3000;
const GEN_PER_CALL = 3;
const GEN_CONCURRENCY = 3;
const GEN_ROUNDS = 2;
const IMAGE_BONUS = 5;

const isConceptMapQ = (q: IStudyQuestion) => q.type === "free" && ((q.tags ?? []).includes("concept-map") || String(q.source?.ref ?? "").startsWith("concept-map:"));

export interface BlueprintExamOut {
  minutes: number;
  scope: { name: string; date: string | null; chapters: string[]; topics: string[] } | null;
  questions: any[];
  sections: Array<{ name: string; bonus?: boolean; points?: number; questionIds: string[] }>;
  skipped: Array<{ section: string; wanted: number; got: number; reason: string }>;
}

/** Previous scheduled exam's week (the start of the next exam's window), 0 when none. */
const prevWeek = (schedule: ExamScheduleEntry[], next: ExamScheduleEntry) =>
  Math.max(0, ...schedule.filter((e) => e.week != null && next.week != null && e.week < next.week).map((e) => e.week as number));

export async function composeBlueprintExam(
  o: { userId: Types.ObjectId; classId: Types.ObjectId; canvasCourseId: number; topics?: string[] },
  spend: Spend,
  signal?: AbortSignal,
  now = new Date()
): Promise<BlueprintExamOut> {
  const resolved = await resolveBlueprint(o.userId, o.canvasCourseId);
  if (!resolved) throw new BlueprintError(400, "NO_BLUEPRINT", "This class has no exam blueprint — set one with PUT /study/classes/:id/exam-blueprint");
  const { blueprint } = resolved;

  const [focus, pool, mastery, guide] = await Promise.all([
    examFocus(o.userId, o.canvasCourseId, now),
    StudyQuestion.find({ userId: o.userId, classId: o.classId }, { shingles: 0 }).sort({ _id: 1 }).limit(POOL_MAX).lean<IStudyQuestion[]>(),
    topicMastery(o.userId, { classId: o.classId }, now),
    StudyClassGuide.findOne({ userId: o.userId, canvasCourseId: o.canvasCourseId }, { examsSchedule: 1 }).sort({ updatedAt: -1 }).lean<IStudyClassGuide>(),
  ]);
  const next = focus.next;
  const m = new Map(mastery.map((t) => [t.topic, t.mastery]));

  // Scope = explicit `topics` (exact topic names) when sent, else the next exam's topics/chapters
  // (keyword match on topic/subtopic/tags). No usable keywords → the whole class.
  const explicit = o.topics?.length ? new Set(o.topics) : null;
  const keywords = next ? [...(next.topics ?? []), ...(next.chapters ?? [])] : [];
  const usable = keywords.some((k) => normTerm(k).length >= 4);
  const inScopeFn = explicit ? (q: IStudyQuestion) => (explicit.has(q.topic) ? 1 : 0) : usable ? focusBonus(keywords) : () => 1;
  const inScope = pool.filter((q) => inScopeFn(q) > 0);
  const weak = focusBonus(focus.weak);

  // Concept maps in the next exam's week window (all maps when the schedule has no weeks).
  const maps = await StudyConceptMap.find({ userId: o.userId, canvasCourseId: o.canvasCourseId, promptTerms: { $ne: [] } }).sort({ week: -1, number: -1 }).lean<IStudyConceptMap[]>();
  const windowMaps = next?.week != null ? maps.filter((cm) => cm.week != null && cm.week <= next.week! && cm.week > prevWeek(guide?.examsSchedule ?? [], next)) : maps;
  const windowRefs = new Set(windowMaps.map((cm) => `concept-map:${cm._id}`));

  const used = new Set<string>();
  const questions: any[] = [];
  const sections: BlueprintExamOut["sections"] = [];
  const skipped: BlueprintExamOut["skipped"] = [];

  for (const sec of blueprint.sections) {
    if (signal?.aborted) break;
    const ofType = (q: IStudyQuestion) => !used.has(String(q._id)) && (sec.type === "any" || q.type === sec.type);
    let candidates: IStudyQuestion[];
    if (sec.from === "concept_map") candidates = pool.filter((q) => ofType(q) && isConceptMapQ(q) && (windowRefs.has(String(q.source?.ref)) || inScope.includes(q)));
    else candidates = inScope.filter(ofType);
    if (sec.optional && !candidates.length) candidates = pool.filter(ofType); // bank-only: the class's own, when the scope has none
    const bonus = (q: IStudyQuestion) => weak(q) + (sec.preferImage && q.imageUrl ? IMAGE_BONUS : 0);
    const picked = pickQuestions(candidates, m, sec.count, now, bonus);
    picked.forEach((q) => used.add(String(q._id)));

    if (picked.length < sec.count && !sec.optional) {
      const need = sec.count - picked.length;
      if (sec.from === "concept_map" && windowMaps.length) picked.push(...(await fromConceptMaps(o, windowMaps, need, used, spend, signal, now)));
      if (picked.length < sec.count) {
        const sameType = (sec.type === "any" ? inScope : inScope.filter((q) => q.type === sec.type));
        const seeds = [...picked, ...sameType, ...inScope, ...pool].filter((q, i, a) => a.findIndex((x) => String(x._id) === String(q._id)) === i);
        picked.push(...(await generateFor(o, seeds, sec.type === "any" ? null : sec.type, sec.count - picked.length, used, spend, signal, now)));
      }
    }
    if (picked.length < sec.count)
      skipped.push({ section: sec.section, wanted: sec.count, got: picked.length, reason: sec.optional ? `No ${sec.type} question in the bank` : "Not enough questions could be found or generated" });
    const label = { name: sec.section, ...(sec.bonus ? { bonus: true } : {}) };
    for (const q of picked) questions.push({ ...snapshot(q), section: label });
    sections.push({ ...label, ...(typeof sec.points === "number" ? { points: sec.points } : {}), questionIds: picked.map((q) => String(q._id)) });
  }
  if (!questions.length) throw new BlueprintError(409, "NO_QUESTIONS", "The question bank has no questions for this class — add or extract some first");
  return {
    minutes: blueprint.minutes ?? DEFAULT_EXAM_MINUTES,
    scope: explicit ? { name: "Selected topics", date: null, chapters: [], topics: [...explicit] } : next ? { name: next.name, date: next.date ?? null, chapters: next.chapters ?? [], topics: next.topics ?? [] } : null,
    questions,
    sections,
    skipped,
  };
}

const mockSource = (seed: { source?: IStudyQuestion["source"] } | null, ref: string): QuestionDraft["source"] => ({
  kind: "mock",
  itemId: seed?.source?.itemId ?? null,
  pageId: seed?.source?.pageId ?? null,
  lectureId: seed?.source?.lectureId ?? null,
  ref,
});

/** Shortfall of a section: the similar-question generator, steered to `type` (null = the seed's own). */
async function generateFor(
  o: { userId: Types.ObjectId },
  seeds: IStudyQuestion[],
  type: string | null,
  need: number,
  used: Set<string>,
  spend: Spend,
  signal: AbortSignal | undefined,
  now: Date
): Promise<IStudyQuestion[]> {
  const out: IStudyQuestion[] = [];
  if (!seeds.length) return out;
  for (let round = 0; round < GEN_ROUNDS && out.length < need && !signal?.aborted; round++) {
    const jobs: Array<{ seed: IStudyQuestion; n: number }> = [];
    for (let i = 0, left = need - out.length; left > 0; i++, left -= GEN_PER_CALL) jobs.push({ seed: seeds[(i + round) % seeds.length], n: Math.min(GEN_PER_CALL, left) });
    const batches: any[][] = jobs.map(() => []);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(GEN_CONCURRENCY, jobs.length) }, async () => {
        while (next < jobs.length && !signal?.aborted) {
          const j = next++;
          batches[j] = await generateSimilar(jobs[j].seed, jobs[j].n, spend, signal, type ?? undefined).catch(() => []);
        }
      })
    );
    for (let j = 0; j < jobs.length; j++) {
      const seed = jobs[j].seed;
      const want = type ?? seed.type;
      for (const r of batches[j]) {
        if (out.length >= need) break;
        let draft: QuestionDraft;
        try {
          const { classId: _c, source: _s, type: _t, topic: _p, ...rest } = r ?? {};
          draft = toDraft({ ...rest, type: want, topic: seed.topic, subtopic: rest.subtopic ?? seed.subtopic }, { classId: seed.classId });
          draft.source = mockSource(seed, String(seed._id));
        } catch {
          continue;
        }
        if (draft.type !== want) continue; // e.g. an "mcq" without choices degrades to free
        const { doc } = await saveQuestion(o.userId, draft, now);
        if (used.has(String(doc._id)) || doc.type !== want) continue;
        used.add(String(doc._id));
        out.push(doc);
      }
    }
  }
  return out;
}

/** Short-answer shortfall: the concept-map short-answers step over the window's maps, newest first. */
async function fromConceptMaps(
  o: { userId: Types.ObjectId; classId: Types.ObjectId },
  maps: IStudyConceptMap[],
  need: number,
  used: Set<string>,
  spend: Spend,
  signal: AbortSignal | undefined,
  now: Date
): Promise<IStudyQuestion[]> {
  const out: IStudyQuestion[] = [];
  for (const cm of maps.slice(0, 2)) {
    if (out.length >= need || signal?.aborted) break;
    const raws = await generateShortAnswers(cm, spend, signal).catch(() => []);
    const topic = (cm.lecture ?? (cm.number ? `Concept Map ${cm.number}` : "Concept map")).slice(0, 120);
    for (const r of raws) {
      if (out.length >= need) break;
      let draft: QuestionDraft;
      try {
        draft = toDraft({ stem: r?.stem, answer: r?.answer, difficulty: r?.difficulty, tags: [...(Array.isArray(r?.tags) ? r.tags : []), "concept-map", "short-answer"], type: "free", topic }, { classId: o.classId });
        draft.source = mockSource(null, `concept-map:${cm._id}`);
      } catch {
        continue;
      }
      const { doc } = await saveQuestion(o.userId, draft, now);
      if (used.has(String(doc._id))) continue;
      used.add(String(doc._id));
      out.push(doc);
    }
  }
  return out;
}
