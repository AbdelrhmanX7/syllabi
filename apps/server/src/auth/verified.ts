/**
 * AI routes need a verified email (docs/accounts.md): an unverified account can use everything
 * else right away, but cannot spend the server's AI budget until it proves its address.
 * Runs after adminVerification, which sets req.emailVerified.
 */
import type { NextFunction, Request, Response } from "express";

export const EMAIL_NOT_VERIFIED = {
  code: "EMAIL_NOT_VERIFIED",
  message: "Confirm your email address to use the AI features. Check your inbox for the link, or send a new one from Settings.",
} as const;

export const requireVerifiedEmail = (req: Request, res: Response, next: NextFunction) => {
  if (req.emailVerified === false) return res.status(403).json(EMAIL_NOT_VERIFIED);
  next();
};

/** Same check, skipped for reads (GET/HEAD), for route groups that mix AI calls with plain listings. */
export const requireVerifiedEmailForWrites = (req: Request, res: Response, next: NextFunction) =>
  req.method === "GET" || req.method === "HEAD" ? next() : requireVerifiedEmail(req, res, next);
