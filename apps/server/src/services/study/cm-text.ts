import { deepseekFlashModel } from "@/services/ai/config";
import { logger } from "@/services/logger.service";
import { openRouterTextJson, Spend, textJson } from "./ai-models";

/**
 * Context budget (chars) of one concept-map turn's packed course material, per link of the
 * chain: gpt-6.1 takes ~300k (~75k tokens) comfortably; DeepSeek flash's window is smaller, so
 * the fallback re-packs the same blocks to its own budget instead of resending the big turn.
 */
export const CM_CONTEXT_BUDGET = { openrouter: 300_000, deepseek: 200_000 } as const;

/**
 * The concept-map text chain (reference, grade, predict, notes digest — nothing else in the
 * study module): STUDY_CM_TEXT_MODELS via OpenRouter first, DeepSeek flash when that throws
 * (HTTP/quota error, timeout, a reply that is not JSON). `model` = the id that actually answered;
 * every model tried is already in `spend.models`. A stop (aborted signal) never falls back.
 * `user` may be a function of the context budget: it is called with CM_CONTEXT_BUDGET.openrouter
 * for OpenRouter and again with .deepseek for the fallback; `maxChars` = the budget of the turn
 * that answered (null for a plain string), so the caller can report the sources that turn held.
 * Lives outside ./ai-models so the jest mocks of that file reach both links of the chain.
 */
export async function cmTextJson(
  system: string,
  user: string | ((maxChars: number) => string),
  spend: Spend,
  opts: { signal?: AbortSignal; maxTokens?: number } = {}
): Promise<{ out: any; model: string; maxChars: number | null }> {
  const turn = (maxChars: number) => (typeof user === "string" ? user : user(maxChars));
  const budget = (maxChars: number) => (typeof user === "string" ? null : maxChars);
  if (spend.route !== "premium") {
    // Non-premium (Claude route): ONE call, no chain, packed at the smaller budget (the biggest
    // cost lever). Sonnet: these turns grade / predict from a whole course pack.
    const before = spend.models.length;
    const out = await textJson(system, turn(CM_CONTEXT_BUDGET.deepseek), spend, { ...opts, claude: "sonnet" });
    return { out, model: spend.models.length > before ? spend.models[spend.models.length - 1] : "anthropic/claude-sonnet-5-5", maxChars: budget(CM_CONTEXT_BUDGET.deepseek) };
  }
  try {
    const r = await openRouterTextJson(system, turn(CM_CONTEXT_BUDGET.openrouter), spend, opts);
    if (r && r.out && typeof r.out === "object") return { ...r, maxChars: budget(CM_CONTEXT_BUDGET.openrouter) };
    throw new Error("openrouter: no JSON");
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    await logger.warn("study concept-map text: OpenRouter failed, falling back to DeepSeek", { error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
  const before = spend.models.length;
  const out = await textJson(system, turn(CM_CONTEXT_BUDGET.deepseek), spend, opts);
  return { out, model: spend.models.length > before ? spend.models[spend.models.length - 1] : deepseekFlashModel(), maxChars: budget(CM_CONTEXT_BUDGET.deepseek) };
}
