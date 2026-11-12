import mongoose, { Types } from "mongoose";
import { IStudyClass, StudyClass } from "@/models/study/class";
import {
  IStudyConcept,
  StudyConcept,
  StudyConceptEvidence,
  StudyConceptEvidenceKind,
  StudyConceptSource,
} from "@/models/study/concept";
import { IStudyConceptMap, IStudyConceptMapAttempt, StudyConceptMap, StudyConceptMapAttempt } from "@/models/study/concept-map";
import { IStudyClassGuide, StudyClassGuide } from "@/models/study/library";
import { StudyQuestion } from "@/models/study/question";
import { logger } from "@/services/logger.service";
import { normTerm } from "./concept-map-parse";

/**
 * The class knowledge map: a list of CONCEPTS per class, built without a model from what the
 * account already has (question topics + subtopics, concept-map prompt terms, the class guide's
 * exam topics), right/wrong EVIDENCE recorded against them, and a strength per concept.
 *
 *   syncClassConcepts      — rebuild the concept list (idempotent, merges by `norm`)
 *   recordConceptEvidence  — append evidence; never throws into its caller
 *   classKnowledge         — sync, then concepts with strength + the edges between them
 */

export const CONCEPT_HALF_LIFE_DAYS = 21;
export const CONCEPT_LABEL_MAX = 120;
export const CONCEPT_ALIASES_MAX = 12;
export const KNOWLEDGE_LINKS_MAX = 200;
/** Graded map attempts read for 'linked' edges (newest first). */
const LINK_ATTEMPTS_MAX = 60;
/**
 * A concept whose questions were tried before evidence was kept: those question stats count as up
 * to this many pieces of evidence, less one for every real piece — so one new answer does not
 * swing a topic with a long history to 0 % or 100 %, and after this many the evidence stands alone.
 */
export const BOOTSTRAP_PRIOR = 3;
const SKIP_NORMS = new Set(["", "general"]);
const DAY_MS = 86_400_000;

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, CONCEPT_LABEL_MAX) : "");

/** The merge key of a concept: `normTerm`, or (labels with no Latin letters or digits) the lower-cased text itself. */
export const conceptNorm = (label: string) => normTerm(label) || clean(label).toLowerCase();

const hasCapital = (s: string) => /\p{Lu}/u.test(s);
/** First seen wins, unless it has no capital letter and a later spelling has one. */
export const nicestLabel = (labels: string[]) => labels.find(hasCapital) ?? labels[0];

// Prod runs with autoIndex off; the merge relies on the unique (userId, classId, norm) index, so build it once per process.
let indexes: Promise<unknown> | null = null;
const ensureIndexes = () =>
  (indexes ??= Promise.all([StudyConcept.createIndexes(), StudyConceptEvidence.createIndexes()]).catch((e) => {
    indexes = null;
    return logger.warn("study concept index build failed", { error: String((e as Error)?.message ?? e) });
  }));

const isDuplicateKey = (e: unknown) => {
  const err = e as { code?: number; writeErrors?: Array<{ code?: number; err?: { code?: number } }> };
  if (err?.code === 11000) return true;
  return Array.isArray(err?.writeErrors) && err.writeErrors.length > 0 && err.writeErrors.every((w) => (w.code ?? w.err?.code) === 11000);
};

/** Insert concepts, ignoring the ones another request created in the meantime (same norm). */
async function insertConcepts(rows: Array<Pick<IStudyConcept, "userId" | "classId" | "label" | "norm" | "aliases" | "sources">>) {
  if (!rows.length) return;
  try {
    await StudyConcept.insertMany(rows, { ordered: false });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
  }
}

// ─── sync ───────────────────────────────────────────────────────────────────────────────

interface Candidate {
  labels: string[];
  sources: Set<StudyConceptSource>;
  /** Norm of the topic a subtopic sits under; null for a topic, a map term or an exam topic. */
  parentNorm: string | null;
}

/** Everything in the account that names a concept of this class, merged by norm, in first-seen order. */
async function gatherCandidates(userId: Types.ObjectId, cls: Pick<IStudyClass, "_id" | "canvasCourseId">): Promise<Map<string, Candidate>> {
  const [topicRows, maps, guides] = await Promise.all([
    StudyQuestion.aggregate<{ _id: { topic: string; subtopic: string | null }; first: Date }>([
      { $match: { userId, classId: cls._id } },
      { $group: { _id: { topic: "$topic", subtopic: "$subtopic" }, first: { $min: "$createdAt" } } },
      { $sort: { first: 1, "_id.topic": 1, "_id.subtopic": 1 } },
    ]),
    StudyConceptMap.find({ userId, canvasCourseId: cls.canvasCourseId }, { promptTerms: 1 }).sort({ createdAt: 1, _id: 1 }).lean<IStudyConceptMap[]>(),
    StudyClassGuide.find({ userId, canvasCourseId: cls.canvasCourseId }, { examsSchedule: 1 }).sort({ updatedAt: -1 }).limit(1).lean<IStudyClassGuide[]>(),
  ]);

  const out = new Map<string, Candidate>();
  const add = (raw: unknown, source: StudyConceptSource): string | null => {
    const label = clean(raw);
    const norm = conceptNorm(label);
    if (SKIP_NORMS.has(norm)) return null;
    const c = out.get(norm) ?? { labels: [], sources: new Set<StudyConceptSource>(), parentNorm: null };
    if (!c.labels.includes(label)) c.labels.push(label);
    c.sources.add(source);
    out.set(norm, c);
    return norm;
  };

  for (const r of topicRows) add(r._id.topic, "topic");
  for (const r of topicRows) {
    const sub = add(r._id.subtopic, "subtopic");
    const parent = conceptNorm(clean(r._id.topic));
    if (!sub || sub === parent || SKIP_NORMS.has(parent)) continue;
    const c = out.get(sub)!;
    c.parentNorm ??= parent;
  }
  for (const m of maps) for (const t of m.promptTerms ?? []) add(t, "map-term");
  for (const e of guides[0]?.examsSchedule ?? []) for (const t of e.topics ?? []) add(t, "exam-topic");
  // A name that is a topic somewhere is a main concept, never a part of another one.
  for (const c of out.values()) if (c.sources.has("topic")) c.parentNorm = null;
  return out;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Rebuild the class's concept list from the account's data. Idempotent (a second run writes
 * nothing). Concepts merge by `norm`; a concept that is no longer named anywhere is removed,
 * unless it has evidence — then it stays, with no sources.
 */
export async function syncClassConcepts(userId: Types.ObjectId, classId: Types.ObjectId | string): Promise<IStudyConcept[]> {
  const cls = await StudyClass.findOne({ _id: classId, userId }, { canvasCourseId: 1 }).lean<IStudyClass>();
  if (!cls) return [];
  await ensureIndexes();
  const scope = { userId, classId: cls._id };
  const wanted = await gatherCandidates(userId, cls);
  const load = () => StudyConcept.find(scope).sort({ createdAt: 1, _id: 1 }).lean<IStudyConcept[]>();

  let existing = await load();
  const have = new Set(existing.map((c) => c.norm));
  const fresh = [...wanted].filter(([norm]) => !have.has(norm));
  if (fresh.length) {
    await insertConcepts(fresh.map(([norm, c]) => ({ ...scope, norm, label: nicestLabel(c.labels), aliases: [], sources: [...c.sources] })));
    existing = await load();
  }

  const idOf = new Map(existing.map((c) => [c.norm, c._id]));
  const gone = existing.filter((c) => !wanted.has(c.norm));
  const withEvidence = gone.length
    ? new Set((await StudyConceptEvidence.distinct("conceptId", { ...scope, conceptId: { $in: gone.map((c) => c._id) } })).map(String))
    : new Set<string>();
  const removeIds = gone.filter((c) => !withEvidence.has(String(c._id))).map((c) => c._id);

  const ops: any[] = [];
  for (const c of existing) {
    const w = wanted.get(c.norm);
    if (!w) {
      if (withEvidence.has(String(c._id)) && (c.sources ?? []).length) ops.push({ updateOne: { filter: { _id: c._id, userId }, update: { $set: { sources: [] } } } });
      continue;
    }
    const label = hasCapital(c.label) ? c.label : nicestLabel([c.label, ...w.labels]);
    const aliases = [...new Set([...(c.aliases ?? []), c.label, ...w.labels])].filter((a) => a !== label).slice(0, CONCEPT_ALIASES_MAX);
    const sources = [...w.sources];
    const parentId = w.parentNorm ? (idOf.get(w.parentNorm) ?? null) : null;
    const set: Record<string, unknown> = {};
    if (label !== c.label) set.label = label;
    if (!sameSet(aliases, c.aliases ?? [])) set.aliases = aliases;
    if (!sameSet(sources, c.sources ?? [])) set.sources = sources;
    if (String(parentId ?? "") !== String(c.parentId ?? "")) set.parentId = parentId;
    if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: c._id, userId }, update: { $set: set } } });
  }
  if (removeIds.length) ops.push({ deleteMany: { filter: { ...scope, _id: { $in: removeIds } } } });
  if (!ops.length) return existing;
  await StudyConcept.bulkWrite(ops, { ordered: false });
  return load();
}

// ─── evidence ───────────────────────────────────────────────────────────────────────────

export interface ConceptEvidenceInput {
  userId: Types.ObjectId;
  classId: Types.ObjectId | string;
  /** Concept names (a topic, a subtopic, a map term); unknown ones are created. Empty and "General" are skipped. */
  labels?: Array<string | null | undefined>;
  conceptIds?: Array<Types.ObjectId | string>;
  kind: StudyConceptEvidenceKind;
  /** 0 = wrong … 1 = right. */
  result: number;
  refId?: string | null;
  at?: Date;
}

/**
 * Append one piece of evidence per named concept. Safe to fire and forget: it never throws
 * (a failure is logged), and does nothing when the database is not connected.
 */
export async function recordConceptEvidence(input: ConceptEvidenceInput): Promise<number> {
  try {
    if (mongoose.connection.readyState !== 1) return 0;
    const result = Number(input.result);
    if (!Number.isFinite(result)) return 0;
    const classId = new Types.ObjectId(String(input.classId));
    const scope = { userId: input.userId, classId };
    const ids = new Map<string, Types.ObjectId>();

    const byNorm = new Map<string, string>();
    for (const raw of input.labels ?? []) {
      const label = clean(raw);
      const norm = conceptNorm(label);
      if (!SKIP_NORMS.has(norm) && !byNorm.has(norm)) byNorm.set(norm, label);
    }
    if (byNorm.size) {
      await ensureIndexes();
      const find = () => StudyConcept.find({ ...scope, norm: { $in: [...byNorm.keys()] } }, { norm: 1 }).lean<IStudyConcept[]>();
      let found = await find();
      const missing = [...byNorm].filter(([norm]) => !found.some((c) => c.norm === norm));
      if (missing.length) {
        // `sources` stays empty here: the next sync fills in where the concept is found.
        await insertConcepts(missing.map(([norm, label]) => ({ ...scope, norm, label, aliases: [], sources: [] })));
        found = await find();
      }
      for (const c of found) ids.set(String(c._id), c._id);
    }
    const given = (input.conceptIds ?? []).map(String).filter((v) => /^[0-9a-fA-F]{24}$/.test(v));
    if (given.length) {
      const own = await StudyConcept.find({ ...scope, _id: { $in: given } }, { _id: 1 }).lean<IStudyConcept[]>();
      for (const c of own) ids.set(String(c._id), c._id);
    }
    if (!ids.size) return 0;
    const at = input.at ?? new Date();
    const value = Math.min(1, Math.max(0, result));
    await StudyConceptEvidence.insertMany([...ids.values()].map((conceptId) => ({ ...scope, conceptId, kind: input.kind, result: value, refId: input.refId ?? null, at })));
    return ids.size;
  } catch (e) {
    void logger.warn("study concept evidence not recorded", { kind: input.kind, error: String((e as Error)?.message ?? e) });
    return 0;
  }
}

// ─── knowledge ──────────────────────────────────────────────────────────────────────────

export interface KnowledgeConcept {
  id: string;
  label: string;
  parentId: string | null;
  sources: StudyConceptSource[];
  /** 0..1; null = not tried yet. */
  strength: number | null;
  attempts: number;
  lastAt: string | null;
}
export interface KnowledgeEdge {
  from: string;
  to: string;
  kind: "part-of" | "linked";
}
export interface ClassKnowledge {
  concepts: KnowledgeConcept[];
  edges: KnowledgeEdge[];
}

interface Tally {
  /** Summed mastery of the tried questions. */
  sum: number;
  tried: number;
  attempts: number;
  lastAt: Date | null;
}

/** Per-question `stats` rolled up by topic norm and by subtopic norm (the maths of `topicMastery`). */
async function questionTallies(userId: Types.ObjectId, classId: Types.ObjectId): Promise<Map<string, Tally>> {
  const rows = await StudyQuestion.aggregate<{ _id: { topic: string; subtopic: string | null }; sum: number; tried: number; attempts: number; lastAt: Date | null }>([
    { $match: { userId, classId } },
    {
      $group: {
        _id: { topic: "$topic", subtopic: "$subtopic" },
        sum: { $sum: { $cond: [{ $gt: ["$stats.attempts", 0] }, "$stats.mastery", 0] } },
        tried: { $sum: { $cond: [{ $gt: ["$stats.attempts", 0] }, 1, 0] } },
        attempts: { $sum: "$stats.attempts" },
        lastAt: { $max: "$srs.lastReviewAt" },
      },
    },
  ]);
  const out = new Map<string, Tally>();
  const add = (norm: string, r: (typeof rows)[number]) => {
    if (SKIP_NORMS.has(norm)) return;
    const t = out.get(norm) ?? { sum: 0, tried: 0, attempts: 0, lastAt: null };
    t.sum += r.sum;
    t.tried += r.tried;
    t.attempts += r.attempts;
    if (r.lastAt && (!t.lastAt || r.lastAt > t.lastAt)) t.lastAt = r.lastAt;
    out.set(norm, t);
  };
  for (const r of rows) {
    const topic = conceptNorm(clean(r._id.topic));
    const sub = conceptNorm(clean(r._id.subtopic));
    add(topic, r);
    if (sub !== topic) add(sub, r);
  }
  return out;
}

const round4 = (n: number) => Number(n.toFixed(4));

/** 'linked' edges from graded concept-map attempts: a drawn link whose two ends are both concepts of the class. */
async function linkedEdges(userId: Types.ObjectId, cls: Pick<IStudyClass, "canvasCourseId">, concepts: IStudyConcept[], taken: Set<string>): Promise<KnowledgeEdge[]> {
  const maps = await StudyConceptMap.find({ userId, canvasCourseId: cls.canvasCourseId }, { _id: 1 }).lean<IStudyConceptMap[]>();
  if (!maps.length || concepts.length < 2) return [];
  const attempts = await StudyConceptMapAttempt.find({ userId, mapId: { $in: maps.map((m) => m._id) } }, { reading: 1 })
    .sort({ createdAt: -1 })
    .limit(LINK_ATTEMPTS_MAX)
    .lean<IStudyConceptMapAttempt[]>();
  const idOf = new Map(concepts.map((c) => [c.norm, String(c._id)]));
  const longestFirst = [...concepts].sort((a, b) => b.norm.length - a.norm.length);
  /** The concept a drawn box names: the same norm, else the longest concept its label contains as whole words. */
  const resolve = (label: string): string | null => {
    const n = conceptNorm(clean(label));
    if (!n) return null;
    const exact = idOf.get(n);
    if (exact) return exact;
    const hit = longestFirst.find((c) => ` ${n} `.includes(` ${c.norm} `));
    return hit ? String(hit._id) : null;
  };
  const out: KnowledgeEdge[] = [];
  for (const a of attempts) {
    const labelOf = new Map((a.reading?.nodes ?? []).map((n) => [String(n.id), String(n.label ?? "")]));
    for (const e of a.reading?.edges ?? []) {
      const from = resolve(labelOf.get(String(e.from)) ?? "");
      const to = resolve(labelOf.get(String(e.to)) ?? "");
      if (!from || !to || from === to) continue;
      const key = [from, to].sort().join("|");
      if (taken.has(key)) continue;
      taken.add(key);
      out.push({ from, to, kind: "linked" });
      if (out.length >= KNOWLEDGE_LINKS_MAX) return out;
    }
  }
  return out;
}

/**
 * The class knowledge map. Strength = the time-decayed mean of the concept's evidence (half-life
 * CONCEPT_HALF_LIFE_DAYS), null when nothing has been tried. A topic / subtopic concept with no
 * evidence yet takes strength and attempts from its questions' `stats`; its first few pieces of
 * evidence are blended with those stats (BOOTSTRAP_PRIOR).
 */
export async function classKnowledge(userId: Types.ObjectId, classId: Types.ObjectId | string, now = new Date()): Promise<ClassKnowledge> {
  const cls = await StudyClass.findOne({ _id: classId, userId }, { canvasCourseId: 1 }).lean<IStudyClass>();
  if (!cls) return { concepts: [], edges: [] };
  const concepts = await syncClassConcepts(userId, cls._id);
  if (!concepts.length) return { concepts: [], edges: [] };

  const [evidence, tallies] = await Promise.all([
    StudyConceptEvidence.aggregate<{ _id: Types.ObjectId; ws: number; w: number; n: number; lastAt: Date }>([
      { $match: { userId, classId: cls._id } },
      // weight = 0.5 ^ (age in days / half-life); evidence dated in the future counts as "now".
      {
        $set: {
          w: { $pow: [0.5, { $divide: [{ $max: [0, { $subtract: [now, "$at"] }] }, CONCEPT_HALF_LIFE_DAYS * DAY_MS] }] },
        },
      },
      { $group: { _id: "$conceptId", ws: { $sum: { $multiply: ["$w", "$result"] } }, w: { $sum: "$w" }, n: { $sum: 1 }, lastAt: { $max: "$at" } } },
    ]),
    questionTallies(userId, cls._id),
  ]);
  const ev = new Map(evidence.map((e) => [String(e._id), e]));

  const rows: KnowledgeConcept[] = concepts.map((c) => {
    const e = ev.get(String(c._id));
    const t = tallies.get(c.norm);
    const prior = t && t.tried ? t.sum / t.tried : null;
    // The stats stand in for the tries made before evidence was kept (at most BOOTSTRAP_PRIOR of them), and fade out as evidence comes in.
    const n = e?.n ?? 0;
    const priorWeight = prior === null ? 0 : Math.max(0, Math.min(BOOTSTRAP_PRIOR, (t?.attempts ?? 0) - n) - n);
    const weight = (e?.w ?? 0) + priorWeight;
    const strength = weight > 0 ? round4(((e?.ws ?? 0) + priorWeight * (prior ?? 0)) / weight) : null;
    const lastAt = [e?.lastAt, t?.lastAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return {
      id: String(c._id),
      label: c.label,
      parentId: c.parentId ? String(c.parentId) : null,
      sources: c.sources ?? [],
      strength,
      attempts: Math.max(e?.n ?? 0, t?.attempts ?? 0),
      lastAt: lastAt ? new Date(lastAt).toISOString() : null,
    };
  });

  const ids = new Set(rows.map((r) => r.id));
  const edges: KnowledgeEdge[] = rows.filter((r) => r.parentId && ids.has(r.parentId)).map((r) => ({ from: r.id, to: r.parentId!, kind: "part-of" as const }));
  const taken = new Set(edges.map((e) => [e.from, e.to].sort().join("|")));
  edges.push(...(await linkedEdges(userId, cls, concepts, taken)));
  return { concepts: rows, edges };
}
