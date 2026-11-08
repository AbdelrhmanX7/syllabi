import { Types } from "mongoose";
import {
  AttemptResult,
  IStudyQuestion,
  StudyQuestion,
  STUDY_QUESTION_SOURCE_KINDS,
  STUDY_QUESTION_TYPES,
  QuestionSourceKind,
  StudyQuestionType,
} from "@/models/study/question";
import { isNearDuplicateStored, shingleHashes, stemHash } from "./dedupe";
import { newSrs, Rating, schedule } from "./fsrs";
import { normalizeFillBlank, normalizeMatching, StructuredInputError } from "./structured-questions";

/**
 * Question-bank rules (contract "Question bank"): DTO, input normalisation, dedupe-on-save,
 * stats/mastery/FSRS bookkeeping, review ordering, mastery + Today aggregates. Pure helpers
 * are exported for the unit tests.
 */

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const sid = (v: unknown) => (v ? String(v) : null);

export function questionDto(q: IStudyQuestion) {
  return {
    id: String(q._id),
    classId: String(q.classId),
    topic: q.topic,
    subtopic: q.subtopic ?? null,
    difficulty: q.difficulty,
    source: {
      kind: q.source?.kind ?? "manual",
      itemId: sid(q.source?.itemId),
      pageId: sid(q.source?.pageId),
      lectureId: sid(q.source?.lectureId),
      ref: q.source?.ref ?? null,
    },
    type: q.type,
    stem: q.stem,
    imageUrl: q.imageUrl ?? null,
    choices: q.choices ?? [],
    pairs: (q.pairs ?? []).map((p) => ({ left: p.left, right: p.right })),
    answer: q.answer ?? "",
    solutionSteps: q.solutionSteps ?? [],
    tags: q.tags ?? [],
    stats: {
      attempts: q.stats?.attempts ?? 0,
      correct: q.stats?.correct ?? 0,
      lastResult: q.stats?.lastResult ?? null,
      mastery: q.stats?.mastery ?? 0,
    },
    srs: srsDto(q.srs),
    createdAt: iso(q.createdAt),
    /** Set when someone the owner shared it with (an editor) made the last change. */
    editedBy: q.editedBy ? { name: q.editedBy.name || "Someone", at: iso(q.editedBy.at) } : null,
  };
}

export const srsDto = (s: IStudyQuestion["srs"] | undefined) => ({
  dueAt: iso(s?.dueAt),
  stability: s?.stability ?? 0,
  difficulty: s?.difficulty ?? 0,
  reps: s?.reps ?? 0,
  lapses: s?.lapses ?? 0,
});

// ─── input normalisation ────────────────────────────────────────────────────────────────

export class QuestionInputError extends Error {
  constructor(message: string, public index?: number) {
    super(message);
  }
}

export const MAX_STEM = 20_000;
const str = (v: unknown, max: number): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter((x): x is string => !!x).slice(0, maxItems) : [];
const oidOrNull = (v: unknown) => (typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v) ? new Types.ObjectId(v) : null);
export const normTags = (v: unknown) => [...new Set(strList(v, 30, 60).map((t) => t.toLowerCase()))];

export interface QuestionDraft {
  classId: Types.ObjectId;
  topic: string;
  subtopic: string | null;
  difficulty: number;
  source: { kind: QuestionSourceKind; itemId: Types.ObjectId | null; pageId: Types.ObjectId | null; lectureId: Types.ObjectId | null; ref: string | null };
  type: StudyQuestionType;
  stem: string;
  imageUrl: string | null;
  choices: string[];
  pairs: Array<{ left: string; right: string }>;
  answer: string;
  solutionSteps: string[];
  tags: string[];
}

/** Partial<Question> from a client or a model → a storable draft (throws QuestionInputError). */
export function toDraft(raw: any, defaults: Partial<QuestionDraft> = {}, opts: { strictType?: boolean } = {}): QuestionDraft {
  if (!raw || typeof raw !== "object") throw new QuestionInputError("question must be an object");
  const stem = str(raw.stem, MAX_STEM);
  if (!stem) throw new QuestionInputError("stem is required");
  const classId = oidOrNull(raw.classId) ?? defaults.classId ?? null;
  if (!classId) throw new QuestionInputError("classId is required");
  // Client input names an unknown type → 400; model output keeps the lenient fallback to free.
  if (opts.strictType && raw.type != null && !(STUDY_QUESTION_TYPES as readonly string[]).includes(raw.type)) {
    throw new QuestionInputError(`type must be one of ${STUDY_QUESTION_TYPES.join(", ")}`);
  }
  let type = (STUDY_QUESTION_TYPES as readonly string[]).includes(raw.type) ? (raw.type as StudyQuestionType) : (defaults.type ?? "free");
  const choices = strList(raw.choices, 10, 2000);
  if (type === "mcq" && choices.length < 2) type = "free";
  const d = Number(raw.difficulty);
  const src = raw.source && typeof raw.source === "object" ? raw.source : {};
  const kind = (STUDY_QUESTION_SOURCE_KINDS as readonly string[]).includes(src.kind) ? (src.kind as QuestionSourceKind) : (defaults.source?.kind ?? "manual");
  // matching / fill_blank: the key is validated here (a malformed one throws → 400, or a dropped model question).
  let structured: { pairs: QuestionDraft["pairs"]; choices: string[]; answer: string } | null = null;
  try {
    if (type === "matching") structured = normalizeMatching(raw);
    else if (type === "fill_blank") structured = { pairs: [], choices: [], ...normalizeFillBlank(stem, raw.answer) };
  } catch (e) {
    if (e instanceof StructuredInputError) throw new QuestionInputError(e.message);
    throw e;
  }
  return {
    classId,
    topic: str(raw.topic, 120) ?? defaults.topic ?? "General",
    subtopic: str(raw.subtopic, 120) ?? defaults.subtopic ?? null,
    difficulty: Number.isFinite(d) ? Math.min(5, Math.max(1, Math.round(d))) : (defaults.difficulty ?? 3),
    source: {
      kind,
      itemId: oidOrNull(src.itemId) ?? defaults.source?.itemId ?? null,
      pageId: oidOrNull(src.pageId) ?? defaults.source?.pageId ?? null,
      lectureId: oidOrNull(src.lectureId) ?? defaults.source?.lectureId ?? null,
      ref: str(src.ref, 200) ?? defaults.source?.ref ?? null,
    },
    type,
    stem,
    imageUrl: str(raw.imageUrl, 2000) ?? null,
    choices: structured ? structured.choices : type === "mcq" ? choices : [],
    pairs: structured ? structured.pairs : [],
    answer: structured ? structured.answer : (str(raw.answer, MAX_STEM) ?? ""),
    solutionSteps: strList(raw.solutionSteps, 40, 4000),
    tags: normTags(raw.tags),
  };
}

// ─── save with dedupe ───────────────────────────────────────────────────────────────────

/**
 * The text the dedupe keys are computed from. A matching question's stem is usually generic
 * ("Match each term…"), so its lefts join the stem; blanks normalise to one token.
 */
export function dedupeText(d: Pick<QuestionDraft, "type" | "stem" | "pairs">): string {
  if (d.type === "matching") return `${d.stem}\n${(d.pairs ?? []).map((p) => p.left).join("\n")}`;
  if (d.type === "fill_blank") return d.stem.replace(/_{3,}/g, " blank ");
  return d.stem;
}

/**
 * Insert one draft, or merge it into a near-duplicate already in the same class (identical
 * normalised stem, or shingle Jaccard ≥ 0.85): the EXISTING doc is returned with the tags
 * unioned. Returns `{doc, merged}`.
 */
export async function saveQuestion(userId: Types.ObjectId, draft: QuestionDraft, now = new Date()) {
  const hash = stemHash(dedupeText(draft));
  const shingles = shingleHashes(dedupeText(draft));
  const candidates = await StudyQuestion.find(
    { userId, classId: draft.classId, $or: [{ stemHash: hash }, ...(shingles.length ? [{ shingles: { $in: shingles } }] : [])] },
    { _id: 1, stemHash: 1, shingles: 1, tags: 1, createdAt: 1 }
  )
    .sort({ createdAt: 1, _id: 1 })
    .limit(200)
    .lean<IStudyQuestion[]>();
  const dup = candidates.find((c) => isNearDuplicateStored({ stemHash: hash, shingles }, c));
  if (dup) {
    const merged = await StudyQuestion.findOneAndUpdate(
      { _id: dup._id, userId },
      draft.tags.length ? { $addToSet: { tags: { $each: draft.tags } } } : {},
      { new: true }
    ).lean<IStudyQuestion>();
    return { doc: merged!, merged: true };
  }
  const created = await StudyQuestion.create({
    userId,
    ...draft,
    stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
    srs: newSrs(now),
    stemHash: hash,
    shingles,
  });
  return { doc: created.toObject() as IStudyQuestion, merged: false };
}

// ─── attempts: mastery, rating, FSRS ────────────────────────────────────────────────────

export const MASTERY_ALPHA = 0.3;
export const RESULT_SCORE: Record<AttemptResult, number> = { right: 1, partial: 0.5, wrong: 0 };
/** "Fast" = under this many ms per difficulty point (difficulty 3 → 90 s). */
export const FAST_MS_PER_DIFFICULTY = 30_000;

export const nextMastery = (prev: number, result: AttemptResult) =>
  Number(((1 - MASTERY_ALPHA) * (prev || 0) + MASTERY_ALPHA * RESULT_SCORE[result]).toFixed(4));

/** right → Good (Easy when fast with no hint/reveal), partial → Hard, wrong → Again. */
export function ratingFor(result: AttemptResult, opts: { timeMs?: number; difficulty?: number; usedHelp?: boolean }): Rating {
  if (result === "wrong") return Rating.Again;
  if (result === "partial") return Rating.Hard;
  const t = Number(opts.timeMs);
  const fast = Number.isFinite(t) && t > 0 && t < FAST_MS_PER_DIFFICULTY * (opts.difficulty || 3);
  return fast && !opts.usedHelp ? Rating.Easy : Rating.Good;
}

export async function recordAttempt(
  q: IStudyQuestion,
  result: AttemptResult,
  opts: { timeMs?: number; usedHelp?: boolean; now?: Date; rating?: Rating }
) {
  const now = opts.now ?? new Date();
  const stats = {
    attempts: (q.stats?.attempts ?? 0) + 1,
    correct: (q.stats?.correct ?? 0) + (result === "right" ? 1 : 0),
    lastResult: result,
    mastery: nextMastery(q.stats?.mastery ?? 0, result),
  };
  const prev = q.srs?.reps ? q.srs : newSrs(now);
  const srs = schedule(
    { dueAt: prev.dueAt, stability: prev.stability, difficulty: prev.difficulty, reps: prev.reps, lapses: prev.lapses, lastReviewAt: prev.lastReviewAt ?? null },
    opts.rating ?? ratingFor(result, { timeMs: opts.timeMs, difficulty: q.difficulty, usedHelp: opts.usedHelp }),
    now
  );
  const updated = await StudyQuestion.findOneAndUpdate({ _id: q._id, userId: q.userId }, { $set: { stats, srs } }, { new: true }).lean<IStudyQuestion>();
  return { stats: updated!.stats, srs: srsDto(updated!.srs) };
}

// ─── review queue + aggregates ──────────────────────────────────────────────────────────

/** Reviewed at least once and due now. New (never reviewed) cards are counted separately. */
export const dueRule = (now: Date) => ({ "srs.reps": { $gt: 0 }, "srs.dueAt": { $lte: now } });
export const newRule = () => ({ "srs.reps": 0 });

export interface TopicMastery {
  classId: string;
  topic: string;
  mastery: number;
  attempts: number;
  dueCount: number;
}

/**
 * Per (class, topic): mastery = mean mastery over the topic's ATTEMPTED questions (0 when none
 * has been tried), attempts = summed attempts, dueCount = due-now reviews.
 */
export async function topicMastery(userId: Types.ObjectId, match: Record<string, unknown>, now = new Date()): Promise<TopicMastery[]> {
  const rows = await StudyQuestion.aggregate([
    { $match: { userId, ...match } },
    {
      $group: {
        _id: { classId: "$classId", topic: "$topic" },
        masterySum: { $sum: { $cond: [{ $gt: ["$stats.attempts", 0] }, "$stats.mastery", 0] } },
        tried: { $sum: { $cond: [{ $gt: ["$stats.attempts", 0] }, 1, 0] } },
        attempts: { $sum: "$stats.attempts" },
        dueCount: { $sum: { $cond: [{ $and: [{ $gt: ["$srs.reps", 0] }, { $lte: ["$srs.dueAt", now] }] }, 1, 0] } },
      },
    },
  ]);
  return rows
    .map((r: any) => ({
      classId: String(r._id.classId),
      topic: r._id.topic,
      mastery: r.tried ? Number((r.masterySum / r.tried).toFixed(4)) : 0,
      attempts: r.attempts,
      dueCount: r.dueCount,
    }))
    .sort((a, b) => a.mastery - b.mastery || a.topic.localeCompare(b.topic) || a.classId.localeCompare(b.classId));
}

/** Topics merged across classes (GET /study/mastery without a classId). */
export function mergeTopics(rows: TopicMastery[]) {
  const by = new Map<string, { topic: string; mSum: number; mN: number; attempts: number; dueCount: number }>();
  for (const r of rows) {
    const e = by.get(r.topic) ?? { topic: r.topic, mSum: 0, mN: 0, attempts: 0, dueCount: 0 };
    if (r.attempts > 0) {
      e.mSum += r.mastery;
      e.mN += 1;
    }
    e.attempts += r.attempts;
    e.dueCount += r.dueCount;
    by.set(r.topic, e);
  }
  return [...by.values()]
    .map((e) => ({ topic: e.topic, mastery: e.mN ? Number((e.mSum / e.mN).toFixed(4)) : 0, attempts: e.attempts, dueCount: e.dueCount }))
    .sort((a, b) => a.mastery - b.mastery || a.topic.localeCompare(b.topic));
}

export const REVIEW_MAX = 100;

/**
 * Review queue: every due card before any new one. Inside each bucket the weakest topic
 * (lowest topic mastery) comes first, then the most overdue (due) / oldest (new), then _id —
 * a total order, so the same state always yields the same queue.
 */
export async function reviewNext(userId: Types.ObjectId, classId: Types.ObjectId | null, limit: number, now = new Date()) {
  const scope: Record<string, unknown> = classId ? { classId } : {};
  const [due, fresh, topics] = await Promise.all([
    StudyQuestion.find({ userId, ...scope, ...dueRule(now) }, { shingles: 0 }).sort({ "srs.dueAt": 1, _id: 1 }).limit(1000).lean<IStudyQuestion[]>(),
    StudyQuestion.find({ userId, ...scope, ...newRule() }, { shingles: 0 }).sort({ createdAt: 1, _id: 1 }).limit(1000).lean<IStudyQuestion[]>(),
    topicMastery(userId, scope, now),
  ]);
  const m = new Map(topics.map((t) => [`${t.classId}|${t.topic}`, t.mastery]));
  const tm = (q: IStudyQuestion) => m.get(`${String(q.classId)}|${q.topic}`) ?? 0;
  const byId = (a: IStudyQuestion, b: IStudyQuestion) => (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0);
  due.sort((a, b) => tm(a) - tm(b) || new Date(a.srs.dueAt).getTime() - new Date(b.srs.dueAt).getTime() || byId(a, b));
  fresh.sort((a, b) => tm(a) - tm(b) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || byId(a, b));
  return [...due, ...fresh].slice(0, limit);
}

export const WEAK_TOPIC_MIN_ATTEMPTS = 2;
export const WEAK_TOPICS_MAX = 5;

/** Today's `review` + `weakTopics` for the given classes. */
export async function todayReview(userId: Types.ObjectId, classIds: Types.ObjectId[], now = new Date()) {
  const scope = { classId: { $in: classIds } };
  const [dueCount, newCount, topics] = await Promise.all([
    StudyQuestion.countDocuments({ userId, ...scope, ...dueRule(now) }),
    StudyQuestion.countDocuments({ userId, ...scope, ...newRule() }),
    topicMastery(userId, scope, now),
  ]);
  const weakTopics = topics
    .filter((t) => t.attempts >= WEAK_TOPIC_MIN_ATTEMPTS)
    .slice(0, WEAK_TOPICS_MAX)
    .map((t) => ({ classId: t.classId, topic: t.topic, mastery: t.mastery }));
  return { review: { dueCount, newCount }, weakTopics };
}

// ─── cursor ─────────────────────────────────────────────────────────────────────────────

export const encodeCursor = (q: { createdAt: Date; _id: Types.ObjectId }) =>
  Buffer.from(JSON.stringify([new Date(q.createdAt).toISOString(), String(q._id)])).toString("base64url");

export function decodeCursor(c: string): { createdAt: Date; id: Types.ObjectId } | null {
  try {
    const [at, id] = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    const createdAt = new Date(at);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f]{24}$/i.test(id)) return null;
    return { createdAt, id: new Types.ObjectId(id) };
  } catch {
    return null;
  }
}
