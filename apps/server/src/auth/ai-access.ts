/**
 * Who gets which AI, and whose bill it lands on.
 *
 *  - "premium": the owner and the accounts the owner turned on (auth/premium.ts). Every AI
 *    feature, on the server's usual models (services/study/ai-models.ts). Unchanged.
 *  - "claude":  every other signed-in account, while the server has an Anthropic key
 *    (ANTHROPIC_API_KEY) and the optional end date (CLAUDE_AI_UNTIL) has not passed. Text and
 *    vision AI run on Claude through that key (services/study/ai-claude.ts), under a monthly
 *    budget. Voice (speech to text, dictation) and image generation stay premium only.
 *  - "none":    no AI (no key, the end date passed, or a background path for an unverified account).
 *
 * Pure except for reading process.env at call time (never at module load).
 */
import { isAiAccount } from "@/auth/roles";

export type AiRoute = "premium" | "claude";
export type AiTier = AiRoute | "none";

/**
 * CLAUDE_AI_UNTIL as the last moment Claude AI is open. A date-only value ("2026-11-30") means the
 * end of that day (UTC); a full ISO timestamp is used as is. Unset or unreadable → null (no end).
 */
export function claudeUntil(env: NodeJS.ProcessEnv = process.env): Date | null {
  const raw = (env.CLAUDE_AI_UNTIL ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = Date.parse(`${raw}T23:59:59.999Z`);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Claude AI is open to non-premium accounts: a key is set and the end date (if any) has not passed. */
export function claudeOpen(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (!(env.ANTHROPIC_API_KEY ?? "").trim()) return false;
  const until = claudeUntil(env);
  return !until || now.getTime() <= until.getTime();
}

/**
 * The account's AI tier, not counting email verification (request paths check that separately,
 * so an unverified account gets the friendlier "confirm your email" answer).
 */
export function aiTierOf(role: string | null | undefined, premium: unknown, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): AiTier {
  if (isAiAccount(role, premium)) return "premium";
  return claudeOpen(now, env) ? "claude" : "none";
}

/** Same, for paths with no request (background jobs, MCP): an unverified account gets no Claude AI. */
export function aiTierOfAccount(
  a: { role?: string | null; premium?: unknown; isVerified?: boolean | null },
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): AiTier {
  const tier = aiTierOf(a.role, a.premium, now, env);
  return tier === "claude" && a.isVerified === false ? "none" : tier;
}
