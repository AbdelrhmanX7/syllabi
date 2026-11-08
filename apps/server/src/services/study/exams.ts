import { Types } from "mongoose";
import { IStudyQuestion, StudyQuestion } from "@/models/study/question";
import type { IStudyExam } from "@/models/study/exam";
import { generateSimilar } from "./ai";
import type { Spend } from "./ai-models";
import { QuestionDraft, questionDto, RESULT_SCORE, saveQuestion, toDraft, topicMastery } from "./questions";
import { StudyClass } from "@/models/study/class";
import { examFocus } from "./concept-maps";
import { normTerm } from "./concept-map-parse";

/** Mock-exam rules: question selection, shortfall generation, scoring, DTOs. */

export const EXAM_MAX_COUNT = 50;
export const EXAM_MAX_MINUTES = 300;
export const EXAM_GRACE_MS = 2 * 60_000;
const POOL_MAX = 2000;
const GEN_CONCURRENCY = 3;
const GEN_PER_CALL = 3;
const GEN_ROUNDS = 3;
/** Selection weights: a due review beats a missed one beats an untried one. */
const W_DUE = 2;
const W_MISSED = 1;
const W_NEW = 0.5;
const DIFFICULTY_PENALTY = 0.25;
/** P-CM: small bonus for a question on the next scheduled exam's topics or a weak exam section. */
export const W_FOCUS = 0.5;

/** Focus keywords → per-question bonus (topic/subtopic/tags containing a keyword, word-aligned). */
export function focusBonus(keywords: string[]): (q: IStudyQuestion) => number {
  // Word-prefix match on a light stem ("volcanoes" → " volcan…" matches "Volcano types").
  const stems = [...new Set(keywords.map(normTerm).filter((k) => k.length >= 4).map((k) => k.slice(0, Math.max(4, k.length - 2))))];
  if (!stems.length) return () => 0;
  return (q) => {
    const hay = ` ${normTerm([q.topic, q.subtopic ?? "", ...(q.tags ?? [])].join(" "))} `;
    return stems.some((k) => hay.includes(` ${k}`)) ? W_FOCUS : 0;
  };
}

const cmpId = (a: IStudyQuestion, b: IStudyQuestion) => (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0);

/**
 * Deterministic pick of `count` from `pool`: priority = due(+2) + topic weakness (1 − topic
 * mastery) + question-level miss(+1)/untried(+0.5); greedily take the best, docking 0.25 per
 * already-picked question of the same difficulty so difficulties mix; ties break on _id.
 */
export function pickQuestions(pool: IStudyQuestion[], topicMasteryByTopic: Map<string, number>, count: number, now = new Date(), bonus: (q: IStudyQuestion) => number = () => 0): IStudyQuestion[] {
  const prio = new Map<string, number>();
  for (const q of pool) {
    const due = (q.srs?.reps ?? 0) > 0 && new Date(q.srs.dueAt).getTime() <= now.getTime();
    const attempts = q.stats?.attempts ?? 0;
    const missed = attempts > 0 && q.stats?.lastResult !== "right";
    const weak = 1 - (topicMasteryByTopic.get(q.topic) ?? 0);
    prio.set(String(q._id), (due ? W_DUE : 0) + weak + (missed ? W_MISSED : 0) + (attempts === 0 ? W_NEW : 0) + bonus(q));
  }
  const left = [...pool].sort(cmpId);
  const perDifficulty = new Map<number, number>();
  const out: IStudyQuestion[] = [];
  while (out.length < count && left.length) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < left.length; i++) {
      const s = prio.get(String(left[i]._id))! - DIFFICULTY_PENALTY * (perDifficulty.get(left[i].difficulty) ?? 0);
      if (s > bestScore + 1e-9) {
        best = i;
        bestScore = s;
      }
    }
    const [q] = left.splice(best, 1);
    perDifficulty.set(q.difficulty, (perDifficulty.get(q.difficulty) ?? 0) + 1);
    out.push(q);
  }
  return out;
}

export interface SelectOpts {
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  topics: string[];
  scopeItemIds: Types.ObjectId[];
  count: number;
}

/**
 * Bank questions for the exam; the shortfall is generated from picked questions (seeds) via the
 * similar-question generator and saved to the bank as `source.kind "mock"`.
 */
export async function selectExamQuestions(o: SelectOpts, spend: Spend, signal?: AbortSignal, now = new Date()): Promise<IStudyQuestion[]> {
  const scope: Record<string, unknown> = { userId: o.userId, classId: o.classId };
  if (o.topics.length) scope.topic = { $in: o.topics };
  else if (o.scopeItemIds.length) scope["source.itemId"] = { $in: o.scopeItemIds };
  const [pool, mastery] = await Promise.all([
    StudyQuestion.find(scope, { shingles: 0 }).sort({ _id: 1 }).limit(POOL_MAX).lean<IStudyQuestion[]>(),
    topicMastery(o.userId, { classId: o.classId }, now),
  ]);
  const m = new Map(mastery.map((t) => [t.topic, t.mastery]));
  const cls = await StudyClass.findOne({ _id: o.classId, userId: o.userId }, { canvasCourseId: 1 }).lean<{ canvasCourseId: number }>();
  const focus = cls ? await examFocus(o.userId, cls.canvasCourseId, now).catch(() => null) : null;
  const picked = pickQuestions(pool, m, o.count, now, focusBonus(focus ? [...(focus.next?.topics ?? []), ...focus.weak] : []));
  if (picked.length >= o.count || !picked.length) return picked;

  const have = new Set(picked.map((q) => String(q._id)));
  const seeds = [...picked];
  for (let round = 0; round < GEN_ROUNDS && picked.length < o.count; round++) {
    const need = o.count - picked.length;
    const jobs: Array<{ seed: IStudyQuestion; n: number }> = [];
    for (let i = 0, left = need; left > 0; i++, left -= GEN_PER_CALL) {
      jobs.push({ seed: seeds[(i + round) % seeds.length], n: Math.min(GEN_PER_CALL, left) });
    }
    const batches: any[][] = jobs.map(() => []);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(GEN_CONCURRENCY, jobs.length) }, async () => {
        while (next < jobs.length && !signal?.aborted) {
          const j = next++;
          batches[j] = await generateSimilar(jobs[j].seed, jobs[j].n, spend, signal).catch(() => []);
        }
      })
    );
    for (let j = 0; j < jobs.length; j++) {
      const seed = jobs[j].seed;
      for (const r of batches[j]) {
        if (picked.length >= o.count) break;
        let draft: QuestionDraft;
        try {
          const { classId: _c, source: _s, type: _t, topic: _p, ...rest } = r ?? {};
          draft = toDraft(
            { ...rest, type: seed.type, topic: seed.topic, subtopic: rest.subtopic ?? seed.subtopic },
            { classId: seed.classId, source: { kind: "mock", itemId: seed.source?.itemId ?? null, pageId: seed.source?.pageId ?? null, lectureId: seed.source?.lectureId ?? null, ref: String(seed._id) } }
          );
          draft.source = { kind: "mock", itemId: seed.source?.itemId ?? null, pageId: seed.source?.pageId ?? null, lectureId: seed.source?.lectureId ?? null, ref: String(seed._id) };
        } catch {
          continue;
        }
        const { doc } = await saveQuestion(o.userId, draft, now);
        if (have.has(String(doc._id))) continue; // merged into one already on the exam
        have.add(String(doc._id));
        picked.push(doc);
      }
    }
  }
  return picked;
}

// ─── scoring ────────────────────────────────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * right=1, partial=0.5, wrong=0 → mean ×100, overall and per topic (topics in exam order).
 * A `bonus` row (blueprint exams) is extra credit: it adds to the sum but not the denominator,
 * and the overall score is capped at 100.
 */
export function scoreExam(rows: Array<{ topic: string; result: keyof typeof RESULT_SCORE; bonus?: boolean }>) {
  const by = new Map<string, { sum: number; n: number }>();
  let sum = 0;
  const graded = rows.filter((r) => !r.bonus).length || rows.length;
  for (const r of rows) {
    const s = RESULT_SCORE[r.result];
    sum += s;
    const e = by.get(r.topic) ?? { sum: 0, n: 0 };
    e.sum += s;
    e.n += 1;
    by.set(r.topic, e);
  }
  return {
    score: rows.length ? Math.min(100, round1((sum / graded) * 100)) : 0,
    byTopic: [...by.entries()].map(([topic, e]) => ({ topic, score: round1((e.sum / e.n) * 100) })),
  };
}

/** Per blueprint section (sections in exam order): mean ×100. Rows without a section are skipped. */
export function scoreSections(rows: Array<{ section?: string | null; result: keyof typeof RESULT_SCORE }>) {
  const by = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (!r.section) continue;
    const e = by.get(r.section) ?? { sum: 0, n: 0 };
    e.sum += RESULT_SCORE[r.result];
    e.n += 1;
    by.set(r.section, e);
  }
  return [...by.entries()].map(([section, e]) => ({ section, score: round1((e.sum / e.n) * 100) }));
}

// ─── DTOs ───────────────────────────────────────────────────────────────────────────────

export const snapshot = (q: IStudyQuestion) => questionDto(q);

/** While the exam is open the key must not leak: answer + solutionSteps are removed. */
export const hideKey = (q: any) => {
  const { answer: _a, solutionSteps: _s, ...rest } = q;
  // matching: the lefts stay (the student needs them), the rights are the key.
  if (Array.isArray(rest.pairs)) rest.pairs = rest.pairs.map((p: any) => ({ left: p.left, right: null }));
  return rest;
};

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function examDto(e: IStudyExam) {
  const submitted = !!e.submittedAt;
  return {
    id: String(e._id),
    classId: String(e.classId),
    topics: e.topics ?? [],
    count: e.count,
    minutes: e.minutes,
    startedAt: iso(e.startedAt),
    submittedAt: iso(e.submittedAt),
    late: !!e.late,
    blueprint: e.blueprint ?? null,
    sections: e.sections ?? [],
    questions: (e.questions ?? []).map((q) => (submitted ? q : hideKey(q))),
    ...(submitted ? { score: e.score, byTopic: e.byTopic ?? [], bySection: e.bySection ?? [], results: e.results ?? [] } : {}),
  };
}

export function examListDto(e: IStudyExam, questionCount: number) {
  return {
    id: String(e._id),
    classId: String(e.classId),
    topics: e.topics ?? [],
    questionCount,
    minutes: e.minutes,
    startedAt: iso(e.startedAt),
    submittedAt: iso(e.submittedAt),
    late: !!e.late,
    score: e.submittedAt ? e.score : null,
  };
}

