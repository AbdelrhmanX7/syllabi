import type { Request, Response, NextFunction } from "express";
import type Redis from "ioredis";
import { createRedisClient } from "@/config/redis";

/**
 * Two limiters live here on purpose; they are NOT interchangeable.
 *
 * - `createRateLimiter` (in-memory, below) is a coarse per-worker abuse guard for
 *   low-volume public/device endpoints. No external dependency, so it cannot fail.
 * - `makeRateLimiter` (Redis, below) is app-wide across the PM2 cluster and is
 *   deliberately FAIL-OPEN — a Redis hiccup must not lock students out.
 *
 * Neither is a quota. A daily spend limit must fail CLOSED and must reserve before
 * it acts; see `services/ai-assistant/quota.service.ts`.
 */

interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface RedisRateLimiterOptions {
  windowSec: number;
  max: number;
  keyPrefix: string;
  keyFn: (req: Request) => string | null | undefined;
  redis?: RedisLike;
}

let shared: Redis | null = null;
function defaultRedis(): RedisLike {
  if (!shared) shared = createRedisClient();
  return shared;
}

/** Close the shared limiter connection (tests, so the process can exit). */
export function closeRateLimitRedis(): void {
  shared?.disconnect();
  shared = null;
}

/**
 * Redis fixed-window limiter. Counts requests per (keyPrefix, key, window bucket).
 *
 * NOTE: a falsy key means UNLIMITED, not blocked. Callers must key on a value that
 * is always present for the identities they mean to limit — `req.userId` is unset
 * for admin tokens on `teacherVerification` routes, which would silently disable it.
 */
export function makeRateLimiter(opts: RedisRateLimiterOptions) {
  const redis = opts.redis ?? defaultRedis();
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const id = opts.keyFn(req);
    if (!id) { next(); return; }
    const bucket = Math.floor(Date.now() / 1000 / opts.windowSec);
    const key = `rl:${opts.keyPrefix}:${id}:${bucket}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, opts.windowSec);
      if (count > opts.max) {
        res.status(429).json({ message: "Too many requests, try again later." });
        return;
      }
      next();
    } catch {
      next(); // fail-open: a Redis hiccup must not lock students out
    }
  };
}

/**
 * Tiny dependency-free, in-memory fixed-window rate limiter + body-size guard.
 * Sufficient for low-volume device-integration endpoints (e.g. the VF-Cash SMS
 * ingest, which a single forwarder hits). In a multi-process PM2 cluster the
 * window is per-worker — acceptable for a coarse abuse guard. For app-wide
 * limits, use `makeRateLimiter` above.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  message?: string;
  /** When set, the 429 body is `{ message, code }` (the study module's error shape). */
  code?: string;
  keyGenerator?: (req: Request) => string;
}

export const createRateLimiter = (opts: RateLimiterOptions) => {
  const { windowMs, max, message = "Too many requests, try again later.", code, keyGenerator } = opts;
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();

    // Opportunistic prune so the map can't grow unbounded.
    if (buckets.size > 5000) {
      for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
    }

    const key = keyGenerator ? keyGenerator(req) : req.ip || req.socket.remoteAddress || "unknown";
    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json(code ? { message, code } : { success: false, message });
    }

    next();
  };
};

/**
 * Reject obviously-oversized requests early via the Content-Length header
 * (the body parser still enforces the real cap). Cheap defense for endpoints
 * that should only ever receive tiny payloads.
 */
export const maxBodyBytes = (limitBytes: number) => (req: Request, res: Response, next: NextFunction) => {
  const len = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(len) && len > limitBytes) {
    return res.status(413).json({ success: false, message: "Request body too large" });
  }
  next();
};
