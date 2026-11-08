import { logger } from "@/services/logger.service";
import { getAiProvider } from "@/services/ai/config";

/**
 * The ONE place a failed AI call becomes a study error code. A provider that is out of credit
 * answers HTTP 402 (`Insufficient Balance`); the AI SDK surfaces it as `APICallError`
 * (`statusCode`), the OpenAI-compatible client as `APIError` (`status`). Either way the account
 * needs a top-up — a distinct code so the FE can say so instead of "try again".
 */
export const AI_QUOTA_CODE = "AI_QUOTA";
export const AI_QUOTA_MESSAGE = "AI credits ran out — the account needs a top-up";
const QUOTA_RX = /insufficient balance|quota|billing|credit/i;

export interface ClassifiedAiError {
  code: string;
  message: string;
}

const MAX_DEPTH = 4;

function quotaIn(err: unknown, depth = 0): boolean {
  if (err === null || err === undefined || depth > MAX_DEPTH) return false;
  if (typeof err === "string") return QUOTA_RX.test(err);
  if (typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.statusCode === 402 || e.status === 402) return true;
  for (const f of [e.message, e.responseBody, e.body]) {
    if (typeof f === "string" && QUOTA_RX.test(f)) return true;
  }
  if (e.error && typeof e.error === "object" && quotaIn(e.error, depth + 1)) return true;
  return quotaIn(e.cause, depth + 1);
}

export const isAiQuotaError = (err: unknown): boolean => quotaIn(err);

/** AI_QUOTA for an out-of-credit failure; otherwise the caller's fallback (default AI_FAILED). */
export function classifyAiError(err: unknown, fallback: ClassifiedAiError = { code: "AI_FAILED", message: "The AI step failed — try again" }): ClassifiedAiError {
  return isAiQuotaError(err) ? { code: AI_QUOTA_CODE, message: AI_QUOTA_MESSAGE } : fallback;
}

/** One `logger.error` per failure, carrying the provider and the resolved code. */
export async function logAiFailure(label: string, err: unknown, ctx: Record<string, unknown> = {}, code = classifyAiError(err).code): Promise<void> {
  let provider = "unknown";
  try {
    provider = getAiProvider();
  } catch {
    /* config unreadable — still log */
  }
  await logger.error(label, err instanceof Error ? err : new Error(String(err)), { ...ctx, provider, code });
}
