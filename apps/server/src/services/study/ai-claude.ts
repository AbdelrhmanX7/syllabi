import type { Spend } from "./ai-models";
import { logger } from "@/services/logger.service";
import { CLAUDE_MODELS, ClaudeError, claudeCall, type ClaudeEffort, type ClaudeTier } from "@/services/ai/claude";
import { routeClaudeTier } from "@/services/ai/claude-router";
import { assertClaudeBudget, countClaudeRequest, noteClaudeSpend, CLAUDE_LABEL_PREFIX } from "@/services/ai/claude-budget";

/**
 * The non-premium side of services/study/ai-models.ts: every model call of a spend whose route is
 * "claude" (a non-premium account, auth/ai-access.ts) lands here. Claude goes FIRST (its credit is
 * the bigger one and runs out at the end of the month). Order per call:
 * per-person daily limit (once per spend) → tier (fixed, or the Jev router for "auto") →
 * monthly Claude cap → one Claude message. Text calls fall back to DeepSeek (the owner's small
 * balance) when the cap is reached or the Claude call fails; vision has no fallback.
 * Cost goes into the spend (text or vision), every model that ran into `spend.models` as
 * `anthropic/<id>` (the router as `openrouter/<id>`, DeepSeek under its own id), so
 * `study_ai_usages` keeps the record and the monthly sum (services/ai/claude-budget.ts) sees it.
 */

/** A fixed Claude tier, or "auto" = ask the router. */
export type ClaudeChoice = ClaudeTier | "auto";

export const AI_NOT_ENABLED_CODE = "AI_NOT_ENABLED";

export interface ClaudeSpendCall {
  kind: "text" | "vision";
  choice: ClaudeChoice;
  /** Short hint for the router (defaults to the start of the system prompt). */
  feature?: string;
  system: string;
  user: string;
  images?: { data: Buffer; mime: string }[];
  maxTokens: number;
  effort?: ClaudeEffort;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  json?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Text calls: the same request on DeepSeek (records its own spend), run when the Claude cap is
   * reached or the Claude call failed (never after a streamed Claude delta reached the student).
   */
  deepseek?: () => Promise<string>;
}

const addCost = (spend: Spend, kind: "text" | "vision", usd: number) => {
  if (!(usd > 0)) return;
  if (kind === "vision") spend.visionCostUsd += usd;
  else spend.textCostUsd += usd;
};

export async function claudeForSpend(spend: Spend, o: ClaudeSpendCall): Promise<string> {
  if (spend.route !== "claude") throw new ClaudeError(AI_NOT_ENABLED_CODE, "AI features aren't on for your account.");
  if (!spend.counted && spend.userId) {
    spend.counted = true;
    await countClaudeRequest(spend.userId);
  }
  let streamed = false;
  const onDelta = o.onDelta
    ? (t: string) => {
        streamed = true;
        o.onDelta!(t);
      }
    : undefined;
  try {
    await assertClaudeBudget(); // before the router: over the cap, the router call is wasted
    let tier: ClaudeTier;
    if (o.choice === "auto") {
      const feature = o.feature ?? o.system.split("\n")[0].slice(0, 160);
      const r = await routeClaudeTier(feature, o.user, { signal: o.signal });
      tier = r.tier;
      if (r.model) {
        spend.models.push(`openrouter/${r.model}`);
        spend.textCostUsd += r.costUsd;
      }
    } else tier = o.choice;
    return await claudeOnce(spend, o, tier, onDelta);
  } catch (e) {
    if (o.kind !== "text" || !o.deepseek || o.signal?.aborted || streamed) throw e;
    await logger.warn("study ai: Claude unavailable for a non-premium account, falling back to DeepSeek", {
      code: e instanceof ClaudeError ? e.code : null,
      error: String((e as Error)?.message ?? e).slice(0, 300),
    });
    try {
      return await o.deepseek();
    } catch (e2) {
      if (o.signal?.aborted) throw e2;
      throw e; // the Claude reason (e.g. the monthly cap) is the one the student should see
    }
  }
}

async function claudeOnce(spend: Spend, o: ClaudeSpendCall, tier: ClaudeTier, onDelta?: (t: string) => void): Promise<string> {
  const slot = spend.models.push(`${CLAUDE_LABEL_PREFIX}${CLAUDE_MODELS[tier]}`) - 1;
  try {
    const r = await claudeCall({
      tier,
      system: o.system,
      user: o.user,
      images: o.images,
      maxTokens: o.maxTokens,
      effort: o.effort,
      signal: o.signal,
      onDelta,
      json: o.json,
      maxRetries: o.maxRetries,
      timeoutMs: o.timeoutMs,
    });
    spend.models[slot] = `${CLAUDE_LABEL_PREFIX}${r.model}`;
    addCost(spend, o.kind, r.costUsd);
    noteClaudeSpend(r.costUsd);
    return r.text;
  } catch (e) {
    const usd = e instanceof ClaudeError ? e.costUsd : 0;
    addCost(spend, o.kind, usd);
    noteClaudeSpend(usd);
    throw e;
  }
}
