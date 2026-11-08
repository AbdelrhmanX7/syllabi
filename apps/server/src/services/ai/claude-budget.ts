import { Types } from "mongoose";
import { Admin } from "@/models/admin";
import { StudyAiUsage } from "@/models/study/ai-usage";
import { StudyPerfQuota } from "@/models/study/perf";
import { logger } from "@/services/logger.service";
import { claudeOpen, claudeUntil } from "@/auth/ai-access";
import { AI_BUDGET_CODE, AI_BUDGET_MESSAGE, AI_DAILY_LIMIT_CODE, AI_DAILY_LIMIT_MESSAGE, ClaudeError } from "@/services/ai/claude";

/**
 * Spending guards of the Claude path (non-premium accounts, auth/ai-access.ts):
 *  - a global monthly cap: CLAUDE_MONTHLY_BUDGET_USD (default 195), summed from this calendar
 *    month's (UTC) `study_ai_usages` rows that ran a Claude model (`anthropic/…` in `models`).
 *    The sum is cached 60 s, and spend seen in this process since the last read is added on top.
 *    Over the cap → ClaudeError AI_BUDGET "The AI is resting until next month."
 *  - a light per-person limit against abuse: CLAUDE_DAILY_REQUESTS (default 150) AI requests per
 *    account per UTC day (one request = one spend, however many model calls it makes). Fail-open.
 */

export const CLAUDE_LABEL_PREFIX = "anthropic/";
export const DEFAULT_MONTHLY_BUDGET_USD = 195;
export const DEFAULT_DAILY_REQUESTS = 150;
export const BUDGET_CACHE_MS = 60_000;

const num = (v: string | undefined, dflt: number) => {
  const x = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(x) && x >= 0 ? x : dflt;
};
export const monthlyBudgetUsd = (env: NodeJS.ProcessEnv = process.env) => num(env.CLAUDE_MONTHLY_BUDGET_USD, DEFAULT_MONTHLY_BUDGET_USD);
export const dailyRequestLimit = (env: NodeJS.ProcessEnv = process.env) => Math.floor(num(env.CLAUDE_DAILY_REQUESTS, DEFAULT_DAILY_REQUESTS));

export const monthStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const monthKey = (now: Date) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

// ─── monthly cap ────────────────────────────────────────────────────────────────────────

export type MonthSpendLoader = (since: Date) => Promise<number>;

const dbMonthSpend: MonthSpendLoader = async (since) => {
  const rows = await StudyAiUsage.aggregate<{ total: number }>([
    { $match: { createdAt: { $gte: since }, models: { $regex: `^${CLAUDE_LABEL_PREFIX}` } } },
    { $group: { _id: null, total: { $sum: "$costUsd" } } },
  ]);
  return Number(rows[0]?.total ?? 0) || 0;
};

let loader: MonthSpendLoader = dbMonthSpend;
let cache: { month: string; at: number; usd: number } | null = null;
/** Spend seen in this process since the cached sum was read (rows may not be written yet). */
let localSince = 0;

export function setMonthSpendLoaderForTests(fn: MonthSpendLoader | null): void {
  loader = fn ?? dbMonthSpend;
  cache = null;
  localSince = 0;
}

/** This month's Claude spend (cached sum + spend seen since). */
export async function claudeMonthSpendUsd(now: Date = new Date()): Promise<number> {
  const month = monthKey(now);
  if (!cache || cache.month !== month || now.getTime() - cache.at > BUDGET_CACHE_MS) {
    const usd = await loader(monthStartUtc(now));
    cache = { month, at: now.getTime(), usd };
    localSince = 0;
  }
  return cache.usd + localSince;
}

/** Count spend right away so the cap holds between cache refreshes. */
export function noteClaudeSpend(usd: number): void {
  if (Number.isFinite(usd) && usd > 0) localSince += usd;
}

/** Throws AI_BUDGET when this month's Claude spend reached the cap. A failed read lets the call through. */
export async function assertClaudeBudget(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let spent: number;
  try {
    spent = await claudeMonthSpendUsd(now);
  } catch (e) {
    await logger.error("claude budget read failed (fail-open)", e as Error);
    return;
  }
  if (spent >= monthlyBudgetUsd(env)) throw new ClaudeError(AI_BUDGET_CODE, AI_BUDGET_MESSAGE);
}

// ─── per-person daily limit ─────────────────────────────────────────────────────────────

export const claudeDayKey = (now: number) => `claude:d:${Math.floor(now / 86_400_000)}`;

export type DailyCounter = (userId: string, key: string, expireAt: Date) => Promise<number>;

const dbDailyCounter: DailyCounter = async (userId, key, expireAt) => {
  const user = new Types.ObjectId(userId);
  const run = () => StudyPerfQuota.findOneAndUpdate({ user, key }, { $inc: { count: 1 }, $setOnInsert: { expireAt } }, { upsert: true, new: true }).lean();
  try {
    return (await run())?.count ?? 0;
  } catch (e: any) {
    if (e?.code === 11000) return (await run())?.count ?? 0;
    throw e;
  }
};

let counter: DailyCounter = dbDailyCounter;
export function setDailyCounterForTests(fn: DailyCounter | null): void {
  counter = fn ?? dbDailyCounter;
}

/** Counts one AI request for this account today; throws AI_DAILY_LIMIT past the limit. Fail-open. */
export async function countClaudeRequest(userId: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const limit = dailyRequestLimit(env);
  if (!limit || !Types.ObjectId.isValid(userId)) return;
  let count: number;
  try {
    const day = Math.floor(now / 86_400_000);
    count = await counter(userId, claudeDayKey(now), new Date((day + 2) * 86_400_000));
  } catch (e) {
    await logger.error("claude daily limit check failed (fail-open)", e as Error, { user: userId });
    return;
  }
  if (count > limit) throw new ClaudeError(AI_DAILY_LIMIT_CODE, AI_DAILY_LIMIT_MESSAGE);
}

// ─── owner report ───────────────────────────────────────────────────────────────────────

export interface ClaudeUsageReport {
  month: string;
  open: boolean;
  until: string | null;
  budgetUsd: number;
  dailyRequests: number;
  totalUsd: number;
  requests: number;
  users: { userId: string; email: string | null; requests: number; costUsd: number }[];
}

/** This month's Claude use per account (most spend first), for GET /admin/claude-usage. */
export async function claudeUsageReport(now: Date = new Date()): Promise<ClaudeUsageReport> {
  const rows = await StudyAiUsage.aggregate<{ _id: Types.ObjectId; requests: number; costUsd: number }>([
    { $match: { createdAt: { $gte: monthStartUtc(now) }, models: { $regex: `^${CLAUDE_LABEL_PREFIX}` } } },
    { $group: { _id: "$userId", requests: { $sum: 1 }, costUsd: { $sum: "$costUsd" } } },
    { $sort: { costUsd: -1 } },
  ]);
  const accounts = await Admin.find({ _id: { $in: rows.map((r) => r._id) } })
    .select("email")
    .lean();
  const email = new Map(accounts.map((a: any) => [String(a._id), (a.email as string | undefined) ?? null]));
  const users = rows.map((r) => ({ userId: String(r._id), email: email.get(String(r._id)) ?? null, requests: r.requests, costUsd: Number(r.costUsd.toFixed(4)) }));
  const until = claudeUntil();
  return {
    month: monthKey(now),
    open: claudeOpen(now),
    until: until ? until.toISOString() : null,
    budgetUsd: monthlyBudgetUsd(),
    dailyRequests: dailyRequestLimit(),
    totalUsd: Number(rows.reduce((s, r) => s + r.costUsd, 0).toFixed(4)),
    requests: rows.reduce((s, r) => s + r.requests, 0),
    users,
  };
}
