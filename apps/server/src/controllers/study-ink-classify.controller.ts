import { NextFunction, Request, Response } from "express";
import express from "express";
import { Types } from "mongoose";
import { StudyAiUsage } from "@/models/study/ai-usage";
import { AI_QUOTA_CODE, AI_QUOTA_MESSAGE } from "@/services/study/ai-errors";
import {
  buildInkRequest,
  callInkDecisions,
  checkInkQuota,
  InkUpstreamError,
  parseInkAnswers,
  parseInkBody,
  sentIndices,
} from "@/services/study/ink-classify";
import { JEV_MODEL } from "@/services/ai/jev-models";
import { logger } from "@/services/logger.service";
import { fail, uid, wrap } from "./study.controller";

export const INK_BODY_LIMIT = "16kb";
const inkJsonParser = express.json({ limit: INK_BODY_LIMIT });

/** index.ts skips the app-wide parser here (STUDY_OWN_JSON_PARSER_PATH); this one caps the body at 16 KB. */
export const inkJson = (req: Request, res: Response, next: NextFunction) =>
  inkJsonParser(req, res, (err?: any) => {
    if (!err) return next();
    if (err?.type === "entity.too.large" || err?.status === 413) return fail(res, 413, "PAYLOAD_TOO_LARGE", "Body exceeds the 16 KB limit");
    return fail(res, 400, "BAD_REQUEST", "Malformed JSON body");
  });

/** One `study_ai_usages` row per request — counts and spend only, NEVER the note text. */
const writeInkUsage = async (userId: Types.ObjectId, row: { model: string; lineCount: number; startedAt: number; costUsd: number; status: "done" | "error"; error?: string; errorCode?: string }) => {
  try {
    await StudyAiUsage.create({
      userId,
      endpoint: "ink_classify",
      status: row.status,
      error: row.error ?? null,
      errorCode: row.status === "error" ? row.errorCode ?? null : null,
      models: [row.model],
      textCostUsd: Number(row.costUsd.toFixed(6)),
      costUsd: Number(row.costUsd.toFixed(6)),
      latencyMs: Date.now() - row.startedAt,
      lineCount: row.lineCount,
    });
  } catch (e) {
    await logger.error("study ink_classify usage write failed", e as Error);
  }
};

/**
 * `POST /study/ai/ink-classify` {lines:[{text, lang, cues?}]} (1..20) → 200 {results:[{cls, confidence}]},
 * same length and order. 400 BAD_REQUEST, 413 over 16 KB, 429 QUOTA (+Retry-After), 402 AI_QUOTA
 * (provider out of credit), 502 AI_UPSTREAM.
 */
export const inkClassify = wrap(async (req, res) => {
  const parsed = parseInkBody(req.body);
  if ("error" in parsed) return fail(res, 400, "BAD_REQUEST", parsed.error);
  const { lines } = parsed;
  const sent = sentIndices(lines);
  const userId = uid(req);

  const startedAt = Date.now();
  const retryAfter = await checkInkQuota(userId, sent.length, startedAt);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    return fail(res, 429, "QUOTA", "Ink classification quota exceeded");
  }
  if (!sent.length) return res.json({ results: parseInkAnswers({}, lines.length, sent) });

  try {
    const r = await callInkDecisions(buildInkRequest(lines, sent));
    await writeInkUsage(userId, { model: r.model, lineCount: sent.length, startedAt, costUsd: r.costUsd, status: "done" });
    return res.json({ results: parseInkAnswers(r.answers, lines.length, sent) });
  } catch (e) {
    const quota = e instanceof InkUpstreamError && e.status === 402;
    const code = quota ? AI_QUOTA_CODE : "AI_UPSTREAM";
    const message = e instanceof InkUpstreamError ? e.message : "unexpected";
    await logger.error("study ink_classify failed", new Error(message), { lines: sent.length, provider: "openrouter", code });
    await writeInkUsage(userId, { model: JEV_MODEL, lineCount: sent.length, startedAt, costUsd: 0, status: "error", error: message, errorCode: code });
    if (quota) return fail(res, 402, AI_QUOTA_CODE, AI_QUOTA_MESSAGE);
    return fail(res, 502, "AI_UPSTREAM", "Couldn't classify the lines this time — try again");
  }
});
