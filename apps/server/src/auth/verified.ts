/**
 * AI routes cost the server money on every call, so they have two gates:
 *  1. premium: AI is on only for the owner and the accounts the owner turned on
 *     (`premium`, see auth/router.ts /admin/premium and auth/premium-cli.ts). 403 AI_NOT_ENABLED.
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
import { isAiAccount } from "@/auth/roles";

export const EMAIL_NOT_VERIFIED = {
  code: "EMAIL_NOT_VERIFIED",
  message: "Confirm your email address to use the AI features. Check your inbox for the link, or send a new one from Settings.",
} as const;

export const AI_NOT_ENABLED = {
  code: "AI_NOT_ENABLED",
  message: "AI features are only on for some accounts right now.",
} as const;

/** Whether this account may use the AI features (database lookup). Missing account → false. */
export async function aiEnabledFor(userId: string | Types.ObjectId | null | undefined): Promise<boolean> {
  if (!userId || !Types.ObjectId.isValid(String(userId))) return false;
  const row = await Admin.findById(String(userId)).select("role premium").lean();
  return !!row && isAiAccount(row.role, row.premium);
}

/** For controllers: answers 403 AI_NOT_ENABLED and returns true when the caller has no AI. */
export async function denyUnlessAi(req: Request, res: Response): Promise<boolean> {
  const ok = typeof req.aiEnabled === "boolean" ? req.aiEnabled : await aiEnabledFor(req.adminId ?? req.userId);
  if (ok) return false;
  res.status(403).json(AI_NOT_ENABLED);
  return true;
}

export const requireVerifiedEmail = (req: Request, res: Response, next: NextFunction) => {
  if (req.aiEnabled !== true) return res.status(403).json(AI_NOT_ENABLED);
  if (req.emailVerified === false) return res.status(403).json(EMAIL_NOT_VERIFIED);
  next();
};

/** Same check, skipped for reads (GET/HEAD), for route groups that mix AI calls with plain listings. */
export const requireVerifiedEmailForWrites = (req: Request, res: Response, next: NextFunction) =>
  req.method === "GET" || req.method === "HEAD" ? next() : requireVerifiedEmail(req, res, next);

/** The name the gate goes by in new code: premium + verified email. */
export const requireAi = requireVerifiedEmail;
