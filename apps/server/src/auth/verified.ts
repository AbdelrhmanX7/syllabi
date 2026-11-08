/**
 * AI routes cost the server money on every call, so they have two gates:
 *  1. AI on: the owner and the accounts the owner turned on (`premium`, see auth/router.ts
 *     /admin/premium and auth/premium-cli.ts) — and, while Claude AI is open (auth/ai-access.ts),
 *     every other account for text / vision AI. Voice and image AI stay premium only
 *     (`requirePremiumAi` / `denyUnlessPremiumAi`). 403 AI_NOT_ENABLED.
 *  2. a verified email (docs/accounts.md): an unverified account can use everything else right
 *     away, but cannot spend the server's AI budget until it proves its address. 403 EMAIL_NOT_VERIFIED.
 * Premium is checked first: verifying would not help an account that has no AI.
 * Runs after adminVerification, which sets req.aiEnabled and req.emailVerified.
 *
 * Paths with no `req` from adminVerification (background jobs, the MCP tools, controllers the MCP
 * runs in-process) use `aiEnabledFor(userId)` / `denyUnlessAi(req, res)` instead.
 */
import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { Admin } from "@/models/admin";
import { aiTierOfAccount, type AiTier } from "@/auth/ai-access";

export const EMAIL_NOT_VERIFIED = {
  code: "EMAIL_NOT_VERIFIED",
  message: "Confirm your email address to use the AI features. Check your inbox for the link, or send a new one from Settings.",
} as const;

export const AI_NOT_ENABLED = {
  code: "AI_NOT_ENABLED",
  message: "AI features are only on for some accounts right now.",
} as const;

/** Voice (speech to text) and image generation: premium accounts only, even when Claude AI is open. */
export const VOICE_AI_NOT_ENABLED = {
  code: "AI_NOT_ENABLED",
  message: "Voice and picture AI are only on for some accounts right now.",
} as const;

/**
 * The account's AI tier from the database (auth/ai-access.ts): "premium", "claude" (verified
 * accounts only, while Claude AI is open) or "none". Missing account → "none".
 */
export async function aiTierFor(userId: string | Types.ObjectId | null | undefined): Promise<AiTier> {
  if (!userId || !Types.ObjectId.isValid(String(userId))) return "none";
  const row = await Admin.findById(String(userId)).select("role premium isVerified").lean();
  return row ? aiTierOfAccount(row) : "none";
}

/** Whether this account may use the (text / vision) AI features (database lookup). Missing account → false. */
export async function aiEnabledFor(userId: string | Types.ObjectId | null | undefined): Promise<boolean> {
  return (await aiTierFor(userId)) !== "none";
}

/** Whether this account may use voice / image AI: premium only (database lookup). */
export async function premiumAiFor(userId: string | Types.ObjectId | null | undefined): Promise<boolean> {
  return (await aiTierFor(userId)) === "premium";
}

/** The caller's tier: from adminVerification when it ran, else (MCP in-process requests) the database. */
export async function aiTierOfRequest(req: Request): Promise<AiTier> {
  if (req.aiRoute && typeof req.aiEnabled === "boolean") {
    if (!req.aiEnabled) return "none";
    return req.aiRoute === "claude" && req.emailVerified === false ? "none" : req.aiRoute;
  }
  return aiTierFor(req.adminId ?? req.userId);
}

/** For controllers: answers 403 (AI_NOT_ENABLED / EMAIL_NOT_VERIFIED) and returns true when the caller has no AI. */
export async function denyUnlessAi(req: Request, res: Response): Promise<boolean> {
  const ok = typeof req.aiEnabled === "boolean" ? req.aiEnabled : await aiEnabledFor(req.adminId ?? req.userId);
  if (!ok) {
    res.status(403).json(AI_NOT_ENABLED);
    return true;
  }
  if (req.aiRoute === "claude" && req.emailVerified === false) {
    res.status(403).json(EMAIL_NOT_VERIFIED);
    return true;
  }
  return false;
}

/** For controllers of voice / image features: 403 unless the caller is premium. */
export async function denyUnlessPremiumAi(req: Request, res: Response): Promise<boolean> {
  const ok = req.aiRoute ? req.aiRoute === "premium" && req.aiEnabled === true : await premiumAiFor(req.adminId ?? req.userId);
  if (ok) return false;
  res.status(403).json(VOICE_AI_NOT_ENABLED);
  return true;
}

export const requireVerifiedEmail = (req: Request, res: Response, next: NextFunction) => {
  if (req.aiEnabled !== true) return res.status(403).json(AI_NOT_ENABLED);
  if (req.emailVerified === false) return res.status(403).json(EMAIL_NOT_VERIFIED);
  next();
};

/** Voice / image routes: premium only (Claude AI does not cover them). */
export const requirePremiumAi = (req: Request, res: Response, next: NextFunction) => {
  if (req.aiEnabled !== true || req.aiRoute !== "premium") return res.status(403).json(VOICE_AI_NOT_ENABLED);
  if (req.emailVerified === false) return res.status(403).json(EMAIL_NOT_VERIFIED);
  next();
};

/** Same check, skipped for reads (GET/HEAD), for route groups that mix AI calls with plain listings. */
export const requireVerifiedEmailForWrites = (req: Request, res: Response, next: NextFunction) =>
  req.method === "GET" || req.method === "HEAD" ? next() : requireVerifiedEmail(req, res, next);

/** The name the gate goes by in new code: premium + verified email. */
export const requireAi = requireVerifiedEmail;
