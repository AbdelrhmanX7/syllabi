import { Request, Response } from "express";
import { Types } from "mongoose";
import { StudyClass } from "@/models/study/class";
import { StudyAiUsage } from "@/models/study/ai-usage";
import { CODE_PROJECT_ID_RE, IStudyCodeProject, StudyCodeProject } from "@/models/study/code-project";
import { runCode, SandboxError, validateFiles, validateRunBody } from "@/services/study/code/sandbox";
import { buildReviewTurn, REVIEW_SYSTEM_PROMPT } from "@/services/study/code/review";
import { textStream } from "@/services/study/ai-stream";
import { newSpend, Spend } from "@/services/study/ai-models";
import { openStudySse } from "@/services/study/sse";
import { logger } from "@/services/logger.service";
import { classifyAiError, logAiFailure } from "@/services/study/ai-errors";
import { fail, isOid, uid, wrap } from "./study.controller";

/** Code (C++ class) — contract "Code (C++ class)", P4. */

const sendSandboxError = (res: Response, e: unknown): boolean => {
  if (e instanceof SandboxError) {
    fail(res, e.status, e.code, e.message);
    return true;
  }
  return false;
};

// ─── run ────────────────────────────────────────────────────────────────────────────────

export const postRun = wrap(async (req, res) => {
  try {
    const input = validateRunBody(req.body);
    const result = await runCode(input);
    res.status(200).json(result);
  } catch (e) {
    if (sendSandboxError(res, e)) {
      if ((e as SandboxError).status === 503 && (e as SandboxError).code !== "CODE_EXEC_DISABLED") await logger.error("study code sandbox unavailable", e as Error, {});
      return;
    }
    throw e;
  }
});

// ─── review (SSE) ───────────────────────────────────────────────────────────────────────

const REVIEW_PROMPT_MAX = 4000;

async function recordReviewUsage(userId: Types.ObjectId, spend: Spend, startedAt: number, status: "done" | "error" | "stopped", error?: string, errorCode?: string) {
  if (!spend.models.length && status !== "error") return;
  try {
    await StudyAiUsage.create({
      userId,
      endpoint: "code_review",
      questionId: null,
      status,
      error: error ? error.slice(0, 500) : null,
      errorCode: status === "error" ? errorCode ?? null : null,
      models: spend.models,
      visionCostUsd: 0,
      textCostUsd: Number(spend.textCostUsd.toFixed(6)),
      costUsd: Number(spend.textCostUsd.toFixed(6)),
      latencyMs: Date.now() - startedAt,
    });
  } catch (e) {
    await logger.error("study ai usage write failed", e as Error, { endpoint: "code_review" });
  }
}

export const postReview = wrap(async (req, res) => {
  let files;
  try {
    files = validateFiles(req.body?.files, { requireCpp: false });
  } catch (e) {
    if (sendSandboxError(res, e)) return;
    throw e;
  }
  const prompt = req.body?.prompt;
  if (prompt !== undefined && prompt !== null && (typeof prompt !== "string" || prompt.length > REVIEW_PROMPT_MAX))
    return fail(res, 400, "VALIDATION_ERROR", `prompt must be a string of at most ${REVIEW_PROMPT_MAX} characters`);

  const userId = uid(req);
  const startedAt = Date.now();
  const spend = newSpend();
  const sse = openStudySse(res);
  try {
    await textStream(REVIEW_SYSTEM_PROMPT, buildReviewTurn(files, typeof prompt === "string" && prompt.trim() ? prompt.trim() : null), spend, (text) => sse.send("delta", { text }), {
      signal: sse.signal,
    });
    await recordReviewUsage(userId, spend, startedAt, sse.signal.aborted ? "stopped" : "done");
    sse.done();
  } catch (e) {
    const stopped = sse.signal.aborted;
    const c = classifyAiError(e, { code: "AI_FAILED", message: "The AI review failed — try again" });
    if (!stopped) await logAiFailure("study code review failed", e, {}, c.code);
    await recordReviewUsage(userId, spend, startedAt, stopped ? "stopped" : "error", String((e as Error)?.message ?? e), c.code);
    sse.error(c.message, c.code);
  }
});

// ─── projects ───────────────────────────────────────────────────────────────────────────

const TITLE_MAX = 200;

export const projectDto = (p: IStudyCodeProject) => ({
  id: p.clientId,
  classId: p.classId ? String(p.classId) : null,
  title: p.title,
  files: (p.files ?? []).map((f) => ({ name: f.name, content: f.content })),
  updatedAt: new Date(p.updatedAt).toISOString(),
});

const projectId = (req: Request, res: Response): string | null => {
  const id = req.params.id;
  if (typeof id !== "string" || !CODE_PROJECT_ID_RE.test(id)) {
    fail(res, 400, "INVALID_ID", "Project id must match cp_[A-Za-z0-9_-]{6,64}");
    return null;
  }
  return id;
};

export const listProjects = wrap(async (req, res) => {
  const filter: Record<string, unknown> = { userId: uid(req) };
  const { classId } = req.query;
  if (classId !== undefined && classId !== "") {
    if (!isOid(classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
    filter.classId = new Types.ObjectId(String(classId));
  }
  const rows = await StudyCodeProject.find(filter).sort({ updatedAt: -1 }).limit(500).lean<IStudyCodeProject[]>();
  res.status(200).json(rows.map(projectDto));
});

export const getProject = wrap(async (req, res) => {
  const id = projectId(req, res);
  if (!id) return;
  const p = await StudyCodeProject.findOne({ userId: uid(req), clientId: id }).lean<IStudyCodeProject>();
  if (!p) return fail(res, 404, "NOT_FOUND", "Project not found");
  res.status(200).json(projectDto(p));
});

export const putProject = wrap(async (req, res) => {
  const id = projectId(req, res);
  if (!id) return;
  const body = req.body ?? {};
  if (body.id !== undefined && body.id !== id) return fail(res, 400, "VALIDATION_ERROR", "Body id does not match the URL id");
  const title = body.title ?? "";
  if (typeof title !== "string" || title.length > TITLE_MAX) return fail(res, 400, "VALIDATION_ERROR", `title must be a string of at most ${TITLE_MAX} characters`);
  let files;
  try {
    files = validateFiles(body.files ?? [], { requireCpp: false, allowEmpty: true });
  } catch (e) {
    if (sendSandboxError(res, e)) return;
    throw e;
  }
  const userId = uid(req);
  let classId: Types.ObjectId | null = null;
  if (body.classId !== undefined && body.classId !== null && body.classId !== "") {
    if (!isOid(body.classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
    const cls = await StudyClass.findOne({ _id: body.classId, userId }, { _id: 1 }).lean();
    if (!cls) return fail(res, 404, "NOT_FOUND", "Class not found");
    classId = cls._id as Types.ObjectId;
  }
  const doc = await StudyCodeProject.findOneAndUpdate(
    { userId, clientId: id },
    { $set: { classId, title, files }, $setOnInsert: { userId, clientId: id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean<IStudyCodeProject>();
  res.status(200).json(projectDto(doc!));
});

export const deleteProject = wrap(async (req, res) => {
  const id = projectId(req, res);
  if (!id) return;
  const r = await StudyCodeProject.deleteOne({ userId: uid(req), clientId: id });
  if (!r.deletedCount) return fail(res, 404, "NOT_FOUND", "Project not found");
  res.status(204).end();
});
