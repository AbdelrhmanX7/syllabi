import { Request, Response } from "express";
import { Types } from "mongoose";
import { StudyClass } from "@/models/study/class";
import { StudyExam, IStudyExam } from "@/models/study/exam";
import { StudyQuestion, IStudyQuestion, AttemptResult } from "@/models/study/question";
import { StudyAiUsage } from "@/models/study/ai-usage";
import { openStudySse } from "@/services/study/sse";
import { newSpend, Spend } from "@/services/study/ai-models";
import { AttemptInputError, AttemptPlan, planAttempt, runPlan } from "@/services/study/attempt-grading";
import { recordAttempt } from "@/services/study/questions";
import { runWithGuide, withClassGuide } from "@/services/study/ai";
import { loadClassGuide } from "@/services/study/class-guide";
import {
  EXAM_GRACE_MS,
  EXAM_MAX_COUNT,
  EXAM_MAX_MINUTES,
  examDto,
  examListDto,
  scoreExam,
  scoreSections,
  selectExamQuestions,
  snapshot,
} from "@/services/study/exams";
import { logger } from "@/services/logger.service";
import { BlueprintError, composeBlueprintExam } from "@/services/study/exam-blueprint";
import { validBlanks, validMatches } from "@/services/study/structured-questions";
import { classifyAiError, logAiFailure } from "@/services/study/ai-errors";
import { decodeB64Image } from "./study-questions.controller";
import { fail, isOid, uid, wrap } from "./study.controller";

/** Mock exams (contract "Mock exams", P5). Started at creation: `startedAt` = create time. */

const GRADE_CONCURRENCY = 3;
const GRADING_LEASE_MS = 10 * 60_000;
const MAX_ANSWERS = 100;
const LIST_MAX = 100;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

async function recordUsage(userId: Types.ObjectId, endpoint: "attempt" | "similar", spend: Spend, startedAt: number, status: "done" | "error" | "stopped", error?: string, errorCode?: string) {
  if (!spend.models.length && status !== "error") return;
  try {
    await StudyAiUsage.create({
      userId,
      endpoint,
      questionId: null,
      status,
      error: error ? error.slice(0, 500) : null,
      errorCode: status === "error" ? errorCode ?? null : null,
      models: spend.models,
      visionCostUsd: Number(spend.visionCostUsd.toFixed(6)),
      textCostUsd: Number(spend.textCostUsd.toFixed(6)),
      costUsd: Number((spend.visionCostUsd + spend.textCostUsd).toFixed(6)),
      latencyMs: Date.now() - startedAt,
    });
  } catch (e) {
    await logger.error("study exam usage write failed", e as Error, { endpoint });
  }
}

// ─── create ─────────────────────────────────────────────────────────────────────────────

export const createExam = wrap(async (req, res) => {
  const { classId, topics, scopeItemIds, count, minutes } = req.body ?? {};
  if (!isOid(classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
  if (req.body?.blueprint !== undefined && req.body?.blueprint !== null) return createBlueprintExam(req, res);
  if (!isInt(count, 1, EXAM_MAX_COUNT)) return fail(res, 400, "VALIDATION_ERROR", `count must be an integer 1–${EXAM_MAX_COUNT}`);
  if (!isInt(minutes, 1, EXAM_MAX_MINUTES)) return fail(res, 400, "VALIDATION_ERROR", `minutes must be an integer 1–${EXAM_MAX_MINUTES}`);
  if (topics !== undefined && topics !== null && (!Array.isArray(topics) || topics.length > 30 || topics.some((t) => typeof t !== "string" || !t.trim() || t.length > 120)))
    return fail(res, 400, "VALIDATION_ERROR", "topics must be an array of up to 30 strings");
  if (scopeItemIds !== undefined && scopeItemIds !== null && (!Array.isArray(scopeItemIds) || scopeItemIds.length > 200 || scopeItemIds.some((i) => !isOid(i))))
    return fail(res, 400, "VALIDATION_ERROR", "scopeItemIds must be an array of up to 200 ids");
  const userId = uid(req);
  if (!(await StudyClass.exists({ _id: classId, userId }))) return fail(res, 404, "NOT_FOUND", "Class not found");

  const topicList: string[] = [...new Set<string>((topics ?? []).map((t: string) => t.trim()))];
  const itemIds = [...new Set<string>(scopeItemIds ?? [])].map((i) => new Types.ObjectId(i));
  const spend = newSpend();
  const t0 = Date.now();
  let picked: IStudyQuestion[];
  try {
    picked = await withClassGuide(userId, classId, () => selectExamQuestions({ userId, classId: new Types.ObjectId(classId), topics: topicList, scopeItemIds: itemIds, count }, spend));
  } catch (e) {
    await recordUsage(userId, "similar", spend, t0, "error", String((e as Error)?.message ?? e));
    throw e;
  }
  await recordUsage(userId, "similar", spend, t0, "done");
  if (!picked.length) return fail(res, 409, "NO_QUESTIONS", "The question bank has no questions for this class and scope — add or extract some first");

  const exam = await StudyExam.create({
    userId,
    classId,
    topics: topicList,
    scopeItemIds: itemIds,
    count,
    minutes,
    startedAt: new Date(),
    questions: picked.map(snapshot),
  });
  res.json(examDto(exam.toObject() as IStudyExam));
});

/**
 * `{classId, blueprint:'class', minutes?}` → an exam in the class's real structure (stored
 * blueprint, or the course default), scoped to the next scheduled exam. Each question carries
 * its `section`; the response adds `scope` and `skipped` (sections the bank could not fill).
 */
async function createBlueprintExam(req: Request, res: Response) {
  const { classId, blueprint, minutes, topics } = req.body ?? {};
  if (topics !== undefined && topics !== null && (!Array.isArray(topics) || topics.length > 30 || topics.some((t) => typeof t !== "string" || !t.trim() || t.length > 120)))
    return fail(res, 400, "VALIDATION_ERROR", "topics must be an array of up to 30 strings");
  if (blueprint !== "class") return fail(res, 400, "VALIDATION_ERROR", "blueprint must be 'class'");
  if (minutes !== undefined && minutes !== null && !isInt(minutes, 1, EXAM_MAX_MINUTES)) return fail(res, 400, "VALIDATION_ERROR", `minutes must be an integer 1–${EXAM_MAX_MINUTES}`);
  const userId = uid(req);
  const cls = await StudyClass.findOne({ _id: classId, userId }, { canvasCourseId: 1 }).lean<{ _id: Types.ObjectId; canvasCourseId: number }>();
  if (!cls) return fail(res, 404, "NOT_FOUND", "Class not found");
  const spend = newSpend();
  const t0 = Date.now();
  let out: Awaited<ReturnType<typeof composeBlueprintExam>>;
  try {
    out = await withClassGuide(userId, cls._id, () => composeBlueprintExam({ userId, classId: cls._id, canvasCourseId: cls.canvasCourseId, topics: [...new Set<string>((topics ?? []).map((t: string) => t.trim()))] }, spend));
  } catch (e) {
    if (e instanceof BlueprintError) {
      await recordUsage(userId, "similar", spend, t0, "error", e.message);
      return fail(res, e.status, e.code, e.message);
    }
    await recordUsage(userId, "similar", spend, t0, "error", String((e as Error)?.message ?? e));
    throw e;
  }
  await recordUsage(userId, "similar", spend, t0, "done");
  const exam = await StudyExam.create({
    userId,
    classId: cls._id,
    topics: out.scope?.topics ?? [],
    scopeItemIds: [],
    count: out.questions.length,
    minutes: minutes ?? out.minutes,
    startedAt: new Date(),
    blueprint: "class",
    sections: out.sections,
    questions: out.questions,
  });
  res.json({ ...examDto(exam.toObject() as IStudyExam), scope: out.scope, skipped: out.skipped });
}

// ─── read ───────────────────────────────────────────────────────────────────────────────

export const listExams = wrap(async (req, res) => {
  const filter: Record<string, unknown> = { userId: uid(req) };
  const { classId } = req.query;
  if (classId !== undefined && classId !== "") {
    if (!isOid(classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
    filter.classId = new Types.ObjectId(String(classId));
  }
  const rows = await StudyExam.aggregate<IStudyExam & { questionCount: number }>([
    { $match: filter },
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: LIST_MAX },
    { $addFields: { questionCount: { $size: { $ifNull: ["$questions", []] } } } },
    { $project: { questions: 0, results: 0 } },
  ]);
  res.json(rows.map((r) => examListDto(r, r.questionCount)));
});

export const getExam = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid exam id");
  const e = await StudyExam.findOne({ _id: req.params.id, userId: uid(req) }).lean<IStudyExam>();
  if (!e) return fail(res, 404, "NOT_FOUND", "Exam not found");
  res.json(examDto(e));
});

// ─── submit (SSE) ───────────────────────────────────────────────────────────────────────

const MISSING_INK_HINT = "Couldn't read any handwriting in the answer image.";

export const submitExam = wrap(async (req: Request, res: Response) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid exam id");
  const userId = uid(req);
  const exam = await StudyExam.findOne({ _id: req.params.id, userId }).lean<IStudyExam>();
  if (!exam) return fail(res, 404, "NOT_FOUND", "Exam not found");
  if (exam.submittedAt) return fail(res, 409, "ALREADY_SUBMITTED", "This exam was already submitted");

  const answers = req.body?.answers;
  if (!Array.isArray(answers) || answers.length > MAX_ANSWERS) return fail(res, 400, "VALIDATION_ERROR", `answers must be an array (max ${MAX_ANSWERS})`);
  const inExam = new Set((exam.questions ?? []).map((q: any) => String(q.id)));
  const byQ = new Map<string, any>();
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    if (!a || typeof a !== "object" || typeof a.questionId !== "string" || !inExam.has(a.questionId))
      return fail(res, 400, "VALIDATION_ERROR", `answers[${i}]: questionId is not part of this exam`);
    if (byQ.has(a.questionId)) return fail(res, 400, "VALIDATION_ERROR", `answers[${i}]: duplicate questionId`);
    for (const k of ["typed", "code"] as const)
      if (a[k] !== undefined && a[k] !== null && (typeof a[k] !== "string" || a[k].length > 50_000)) return fail(res, 400, "VALIDATION_ERROR", `answers[${i}].${k} must be a string`);
    if (a.matches !== undefined && a.matches !== null && !validMatches(a.matches)) return fail(res, 400, "VALIDATION_ERROR", `answers[${i}].matches must be an object {left: right}`);
    if (a.blanks !== undefined && a.blanks !== null && !validBlanks(a.blanks)) return fail(res, 400, "VALIDATION_ERROR", `answers[${i}].blanks must be an array of strings`);
    let ink: Buffer | null = null;
    if (a.inkPngB64 !== undefined && a.inkPngB64 !== null && a.inkPngB64 !== "") {
      ink = decodeB64Image(a.inkPngB64);
      if (!ink) return fail(res, 400, "VALIDATION_ERROR", `answers[${i}].inkPngB64 must be a base64 image (max ~8 MB)`);
    }
    byQ.set(a.questionId, { typed: a.typed, choice: a.choice, code: a.code, ink, matches: a.matches ?? undefined, blanks: a.blanks ?? undefined });
  }

  // Grade against the FROZEN snapshot content, bookkeeping against the live bank row.
  const ids = (exam.questions as any[]).map((q) => new Types.ObjectId(q.id));
  const live = new Map((await StudyQuestion.find({ _id: { $in: ids }, userId }, { shingles: 0 }).lean<IStudyQuestion[]>()).map((q) => [String(q._id), q]));
  type Item = { snap: any; q: IStudyQuestion; inBank: boolean; plan: AttemptPlan | null };
  const items: Item[] = [];
  for (let i = 0; i < exam.questions.length; i++) {
    const snap: any = exam.questions[i];
    const l = live.get(String(snap.id));
    const q = { ...(l ?? { _id: new Types.ObjectId(snap.id), userId, classId: exam.classId, difficulty: snap.difficulty, topic: snap.topic, stats: snap.stats, srs: snap.srs }), type: snap.type, stem: snap.stem, choices: snap.choices ?? [], pairs: snap.pairs ?? [], answer: snap.answer ?? "", solutionSteps: snap.solutionSteps ?? [] } as IStudyQuestion;
    const input = byQ.get(String(snap.id));
    let plan: AttemptPlan | null = null;
    const structuredAnswered =
      (snap.type === "matching" && input?.matches && Object.values(input.matches).some((v) => typeof v === "string" && v.trim())) ||
      (snap.type === "fill_blank" && Array.isArray(input?.blanks) && input.blanks.some((v: unknown) => typeof v === "string" && v.trim()));
    const structured = snap.type === "matching" || snap.type === "fill_blank";
    if (input && (structured ? structuredAnswered : input.ink || [input.typed, input.code].some((v) => typeof v === "string" && v.trim()) || (input.choice !== undefined && input.choice !== null))) {
      try {
        plan = planAttempt(q, input);
      } catch (e) {
        if (!(e instanceof AttemptInputError)) throw e;
        // An MCQ whose stored key matches no choice cannot be graded deterministically — let the model judge it.
        if (e.code === "ANSWER_NOT_A_CHOICE") plan = { kind: "model", work: String(typeof input.choice === "number" ? q.choices[input.choice] ?? input.choice : input.choice) };
        else return fail(res, e.status, e.code, `question ${snap.id}: ${e.message}`);
      }
    }
    items.push({ snap, q, inBank: !!l, plan });
  }

  // Claim the submit: a second (or concurrent) submit loses here, before any model spend.
  const now = new Date();
  const claimed = await StudyExam.findOneAndUpdate(
    { _id: exam._id, userId, submittedAt: null, $or: [{ gradingStartedAt: null }, { gradingStartedAt: { $lt: new Date(now.getTime() - GRADING_LEASE_MS) } }] },
    { $set: { gradingStartedAt: now } }
  ).lean<IStudyExam>();
  if (!claimed) return fail(res, 409, "ALREADY_SUBMITTED", "This exam was already submitted");
  const late = now.getTime() > new Date(exam.startedAt).getTime() + (exam.minutes * 60_000 + EXAM_GRACE_MS);

  const guide = await loadClassGuide(userId, exam.classId).catch(() => null); // P-CM: class guide as system context
  const t0 = Date.now();
  const sse = openStudySse(res);
  const spend = newSpend();
  const release = () => StudyExam.updateOne({ _id: exam._id, userId, submittedAt: null }, { $set: { gradingStartedAt: null } }).catch(() => undefined);
  try {
    type Row = IStudyExam["results"][number];
    const settle: Array<(v: Row | Error) => void> = [];
    const results = items.map(() => new Promise<Row | Error>((r) => settle.push(r)));
    let next = 0;
    let failed = false;
    const gradeOne = async (it: Item): Promise<Row> => {
      const sec = it.snap.section && typeof it.snap.section === "object" ? it.snap.section : null;
      const base = { questionId: String(it.snap.id), topic: it.snap.topic as string, ...(sec ? { section: String(sec.name) } : {}), ...(sec?.bonus ? { bonus: true } : {}) };
      let result: AttemptResult = "wrong";
      let row: Row = { ...base, result, steps: [], firstErrorStep: null, hint: null, solution: null, answered: false };
      if (it.plan) {
        const out = await runWithGuide(guide, () => runPlan(it.q, it.plan!, false, spend, sse.signal));
        if ("aborted" in out) throw new Error("aborted");
        row = "nothingRead" in out
          ? { ...row, answered: true, hint: MISSING_INK_HINT }
          : { ...base, answered: true, result: out.verdict.result, steps: out.verdict.steps, firstErrorStep: out.verdict.firstErrorStep, hint: out.verdict.hint, solution: out.verdict.solution };
        result = row.result;
      }
      if (it.inBank) await recordAttempt(it.q, result, { usedHelp: false });
      return row;
    };
    const workers = Array.from({ length: Math.min(GRADE_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        settle[i](failed || sse.signal.aborted ? new Error("aborted") : await gradeOne(items[i]).catch((e: Error) => ((failed = true), e)));
      }
    });
    void Promise.all(workers);

    const rows: Row[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = await results[i];
      if (r instanceof Error) throw r;
      if (sse.signal.aborted) throw new Error("aborted");
      rows.push(r);
      sse.send("graded", { questionId: r.questionId, result: r.result, steps: r.steps, firstErrorStep: r.firstErrorStep, hint: r.hint, solution: r.solution });
    }
    const { score, byTopic } = scoreExam(rows);
    const bySection = scoreSections(rows);
    await StudyExam.updateOne({ _id: exam._id, userId }, { $set: { submittedAt: now, gradingStartedAt: null, late, results: rows, score, byTopic, bySection } });
    await recordUsage(userId, "attempt", spend, t0, "done");
    sse.done({ score, byTopic, bySection, sections: exam.sections ?? [], late });
  } catch (e) {
    await release();
    const aborted = sse.signal.aborted;
    const c = classifyAiError(e, { code: "AI_FAILED", message: "The AI step failed — the exam is not submitted yet, try again" });
    if (!aborted) await logAiFailure("study exam submit failed", e, {}, c.code);
    await recordUsage(userId, "attempt", spend, t0, aborted ? "stopped" : "error", String((e as Error)?.message ?? e), c.code);
    sse.error(c.message, c.code);
  }
});
