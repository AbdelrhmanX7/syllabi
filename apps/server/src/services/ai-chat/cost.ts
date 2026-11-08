/**
 * USD cost of an AI chat turn, DERIVED from the persisted DeepSeek `usage` blob.
 *
 * Nothing stores a cost: every number the admin browser reports (per message, per
 * conversation, per day, in the overview totals) comes out of this one pure function,
 * so a repricing moves every view at once and no two views can disagree.
 *
 * Rates come from `DEEPSEEK_FLASH_RATES_USD_PER_M` (services/ai/peak-pricing.ts) — the
 * single source of truth already used by the physics-QA eval runner
 * (services/physics-qa/eval/cost.ts). Chat answers are billed at FLASH rates even on the
 * "pro" tier: since 2026-09-10 DeepSeek routes every Pro request to V4.1 Flash and bills
 * it at Flash prices (see CLAUDE.md, «AI Provider Switching»).
 */
import { DEEPSEEK_FLASH_RATES_USD_PER_M, isDeepSeekPeakInstant } from "@/services/ai/peak-pricing";
import type { AiChatUsage } from "@/models/ai-chat-message";

/** Re-exported so callers/tests assert against the numbers actually in use, never a second copy. */
export const AI_CHAT_RATES_USD_PER_M = DEEPSEEK_FLASH_RATES_USD_PER_M;

/**
 * Billing model (OpenAI-compatible usage shape):
 *  - `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` partition `prompt_tokens`.
 *    When only `prompt_tokens` came back (an older row, or a provider that omits the
 *    split), the unexplained remainder is billed as a cache MISS — the expensive side,
 *    so an unknown never flatters the number.
 *  - `completion_tokens` ALREADY INCLUDES `reasoning_tokens` as a subset (the convention
 *    this repo assumes in services/ai/text-provider.ts and agent/agent.service.ts), so
 *    reasoning is deliberately NOT added on top — that would double-count it.
 *  - Peak windows double every rate. `at` is the turn's wall-clock time; omit it and the
 *    off-peak table is used. Peak is judged by `isDeepSeekPeakInstant`, which reads only the
 *    configured windows/days — NOT `isDeepSeekPeakHour`, whose `DEEPSEEK_PEAK_AVOIDANCE` kill
 *    switch is about scheduling and would halve every peak figure whenever it is off.
 *
 * @param model accepted for call-site symmetry and future multi-model billing; every chat
 *              turn today bills on the flash table regardless of the id it names.
 */
export function messageCostUsd(usage?: AiChatUsage | null, model?: string | null, at?: Date | null): number {
  void model;
  if (!usage) return 0;

  const rates = at && isDeepSeekPeakInstant(at) ? AI_CHAT_RATES_USD_PER_M.peak : AI_CHAT_RATES_USD_PER_M.offPeak;

  const hit = Math.max(0, usage.prompt_cache_hit_tokens ?? 0);
  const miss =
    usage.prompt_cache_miss_tokens != null
      ? Math.max(0, usage.prompt_cache_miss_tokens)
      : Math.max(0, (usage.prompt_tokens ?? 0) - hit);
  const output = Math.max(0, usage.completion_tokens ?? 0);

  return (hit * rates.cacheHit + miss * rates.cacheMiss + output * rates.output) / 1_000_000;
}

/** One generation of an assistant row: the live one, or a snapshot retained in `history[]`. */
export interface BillableGeneration {
  usage?: AiChatUsage | null;
  /**
   * A solver attempt that ran for this generation. Its tokens are NOT in `usage`: when the
   * solver declines, the persona answers and overwrites that field, so billing `usage` alone
   * loses the attempt entirely.
   */
  solver?: { usage?: AiChatUsage | null } | null;
  model?: string | null;
  /** Set by `finalize`: the instant this generation finished. Authoritative when present. */
  completedAt?: Date | string | null;
  createdAt?: Date | string | null;
  replacedAt?: Date | string | null;
}

export interface BillableMessage {
  usage?: AiChatUsage | null;
  /**
   * Money already spent, in USD, reading this turn's attachments. STORED rather than derived:
   * the crop readers are paid per call and the provider returns the real price, which no rate
   * table here could reproduce. It rides the USER row, which is the row that carries the files.
   */
  attachmentsCostUsd?: number | null;
  solver?: { usage?: AiChatUsage | null } | null;
  model?: string | null;
  completedAt?: Date | string | null;
  createdAt?: Date | string | null;
  history?: BillableGeneration[] | null;
}

/**
 * Total spend of a message across EVERY retained generation, not just the live one.
 *
 * «Regenerate» is non-destructive: the answer being replaced is snapshotted into `history[]`
 * with its own `usage`, and the model was paid for it. Billing only the top-level `usage`
 * therefore under-reports every regenerated turn.
 *
 * ⚠️ `history[]` is capped at `AI_CHAT_MAX_HISTORY_GENERATIONS` (10) by the chat controller's
 * `$slice`. A turn regenerated more than that many times loses its oldest snapshots, and their
 * spend becomes unrecoverable — these figures are a floor on such a row, never an overcount.
 */
export function messageTotalCostUsd(m: BillableMessage): number {
  const history = m.history ?? [];
  const ms = (d?: Date | string | null) => (d ? new Date(d).getTime() : 0);

  // `completedAt` is stamped by `finalize` and never moves again, so it is the billing
  // instant whenever it exists. Rows written before that field did fall back to the instant
  // the generation BEGAN (the previous one's `replacedAt`, else the row's `createdAt`).
  // ⚠️ Never `updatedAt` — a feedback vote bumps it (controllers/ai-chat/feedback.controller.ts)
  // and would drag the spend onto whatever day someone happened to click.
  const startedMs = Math.max(ms(m.createdAt), ...history.map((h) => ms(h.replacedAt)), 0);
  const liveAt = m.completedAt ? new Date(m.completedAt) : startedMs ? new Date(startedMs) : null;
  let usd =
    messageCostUsd(m.usage, m.model, liveAt) +
    messageCostUsd(m.solver?.usage, m.model, liveAt) +
    Math.max(0, m.attachmentsCostUsd ?? 0);

  for (const h of history) {
    // Same order: the stamped completion instant, else the archived `createdAt` (the row's
    // `updatedAt` when it was snapshotted), else when its successor began.
    const at = h.completedAt ?? h.createdAt ?? h.replacedAt ?? null;
    const when = at ? new Date(at) : null;
    usd += messageCostUsd(h.usage, h.model, when) + messageCostUsd(h.solver?.usage, h.model, when);
  }
  return usd;
}

/** Money is reported at 6 decimals: a single cheap turn is ~1e-4 USD, so 2dp would read as zero. */
export const roundUsd = (usd: number): number => Number(usd.toFixed(6));
