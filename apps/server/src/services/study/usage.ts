import { Types } from "mongoose";
import { StudyAiUsage, StudyAiEndpoint } from "@/models/study/ai-usage";
import { logger } from "@/services/logger.service";
import { classifyAiError } from "./ai-errors";
import { Spend, spendTotal } from "./ai-models";

const usd = (n: number) => Number(n.toFixed(6));

/** Persist one `study_ai_usages` row; a logging failure never reaches the caller. No model → no row. */
export async function recordStudyUsage(
  userId: Types.ObjectId,
  endpoint: StudyAiEndpoint,
  spend: Spend,
  startedAt: number,
  status: "done" | "error" | "stopped",
  extra: { questionId?: Types.ObjectId | null; itemId?: Types.ObjectId | null; lectureId?: Types.ObjectId | null; error?: string; errorCode?: string | null } = {}
): Promise<void> {
  // A failed call often died before any model was recorded — the error row is still the evidence.
  if (!spend.models.length && status !== "error") return;
  try {
    await StudyAiUsage.create({
      userId,
      endpoint,
      questionId: extra.questionId ?? null,
      itemId: extra.itemId ?? null,
      lectureId: extra.lectureId ?? null,
      status,
      error: extra.error ? extra.error.slice(0, 500) : null,
      errorCode: status === "error" ? (extra.errorCode ?? (extra.error ? classifyAiError(extra.error, { code: "", message: "" }).code || null : null)) : null,
      models: spend.models,
      visionCostUsd: usd(spend.visionCostUsd),
      textCostUsd: usd(spend.textCostUsd),
      audioCostUsd: usd(spend.audioCostUsd ?? 0),
      imageCostUsd: usd(spend.imageCostUsd ?? 0),
      costUsd: usd(spendTotal(spend)),
      latencyMs: Date.now() - startedAt,
    });
  } catch (e) {
    await logger.error("study ai usage write failed", e as Error, { endpoint });
  }
}
