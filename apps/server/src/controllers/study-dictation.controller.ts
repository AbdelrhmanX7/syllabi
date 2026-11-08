import express from "express";
import { Types } from "mongoose";
import { StudyAiUsage } from "@/models/study/ai-usage";
import { logger } from "@/services/logger.service";
import { ACCEPTED_AUDIO, DICTATION_MAX_BYTES, DictationError, transcribeDictation } from "@/services/study/dictation";
import { fail, uid, wrap } from "./study.controller";

/** Raw audio body, 5 MB. An oversized body becomes 413 in routes/study/router.ts's error shaper. */
export const dictationRaw = express.raw({ type: "*/*", limit: DICTATION_MAX_BYTES });

/** One `study_ai_usages` row per request — duration and spend only, NEVER the transcript. */
const writeUsage = async (userId: Types.ObjectId, row: { models: string[]; startedAt: number; costUsd: number; status: "done" | "error"; error?: string; errorCode?: string }) => {
  try {
    await StudyAiUsage.create({
      userId,
      endpoint: "dictate",
      status: row.status,
      error: row.error ?? null,
      errorCode: row.status === "error" ? row.errorCode ?? null : null,
      models: row.models,
      audioCostUsd: Number(row.costUsd.toFixed(6)),
      costUsd: Number(row.costUsd.toFixed(6)),
      latencyMs: Date.now() - row.startedAt,
    });
  } catch (e) {
    await logger.error("study dictate usage write failed", e as Error);
  }
};

/**
 * `POST /study/ai/transcribe` (English; a legacy `?lang=` is ignored), body = raw audio bytes with the
 * recording's mime type → 200 `{text}`. 400 empty body, 413 over 5 MB or 120 s,
 * 415 not audio, 402 AI_QUOTA, 502 AI_UPSTREAM, 503 no key.
 */
export const transcribe = wrap(async (req, res) => {
  const mime = String(req.headers["content-type"] ?? "");
  if (!ACCEPTED_AUDIO.test(mime)) return fail(res, 415, "UNSUPPORTED_AUDIO", "Content-Type must be an audio/* recording (audio/webm, audio/mp4, …)");
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || !audio.length) return fail(res, 400, "BAD_REQUEST", "Empty recording");
  if (audio.length > DICTATION_MAX_BYTES) return fail(res, 413, "PAYLOAD_TOO_LARGE", "Recording exceeds the 5 MB limit");

  const userId = uid(req);
  const startedAt = Date.now();
  try {
    const r = await transcribeDictation(audio);
    await writeUsage(userId, { models: [r.model], startedAt, costUsd: r.costUsd, status: "done" });
    return res.json({ text: r.text });
  } catch (e) {
    if (!(e instanceof DictationError)) throw e;
    if (e.status >= 500 || e.status === 402) await logger.error("study dictate failed", e, { code: e.code, bytes: audio.length });
    await writeUsage(userId, { models: e.models, startedAt, costUsd: e.costUsd, status: "error", error: e.message, errorCode: e.code });
    return fail(res, e.status, e.code, e.message);
  }
});
