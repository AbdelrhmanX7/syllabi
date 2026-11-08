/**
 * A tiny in-memory fixed-window limiter for the credential endpoints. Kept in memory (not Redis)
 * so sign-in keeps working when Redis is down. Keyed by client IP by default; pass `key` to
 * limit per something else (e.g. the email in the body). A request with no key is not counted.
 * Single process: with several replicas each one counts on its own.
 */
import type { NextFunction, Request, Response } from "express";
import { normaliseEmail } from "@/auth/validate";

type KeyFn = (req: Request) => string | null | undefined;

export const ipKey: KeyFn = (req) => req.ip || req.socket.remoteAddress || "unknown";

/** The normalised `email` field of the JSON body (per-email limits). */
export const bodyEmailKey: KeyFn = (req) => normaliseEmail(req.body?.email) || null;

export function memoryRateLimit({
  windowMs,
  max,
  message,
  key = ipKey,
}: {
  windowMs: number;
  max: number;
  message: string;
  key?: KeyFn;
}) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const k = key(req);
    if (!k) return next();
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ message });
    }
    next();
  };
}
