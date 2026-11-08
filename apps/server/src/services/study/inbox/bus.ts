import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { createRedisClient } from "@/config/redis";

/**
 * Cross-process fan-out of new inbox items to open `GET /study/inbox/stream` connections.
 *
 * Prod runs four API forks behind a round-robin upstream: the phone's upload can land on any of
 * them while the tablet's stream sits on another. Every upload is published on Redis channel
 * `study:inbox:<userId>`; every fork pattern-subscribes `study:inbox:*` and hands the frame to its
 * local listeners. The publishing fork delivers locally first and skips the echo of its own
 * message (origin id), so a Redis outage still serves a stream on the same fork and never
 * double-delivers. Redis down = silent degrade: the FE also polls `GET /study/inbox` every 10 s.
 *
 * Same subscribe rule as services/cache.service.ts: (re)PSUBSCRIBE on every `ready`, because a
 * subscribe issued while Redis is down is dropped for good by ioredis. Clients are created
 * lazily, so scripts and tests that never touch the inbox open no connection.
 */

export const INBOX_CHANNEL_PREFIX = "study:inbox:";
const PATTERN = `${INBOX_CHANNEL_PREFIX}*`;

type Listener = (item: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
const origin = randomUUID();
let pub: Redis | null = null;
let sub: Redis | null = null;

function deliver(userId: string, item: unknown) {
  for (const fn of listeners.get(userId) ?? []) {
    try {
      fn(item);
    } catch {
      /* one broken stream must not starve the others */
    }
  }
}

function ensureSub() {
  if (sub) return;
  try {
    const s = createRedisClient();
    sub = s;
    s.on("error", () => undefined);
    s.on("ready", () => {
      if (sub !== s) return;
      s.psubscribe(PATTERN, () => undefined);
    });
    s.on("pmessage", (_p: string, channel: string, raw: string) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg || msg.origin === origin) return;
        deliver(channel.slice(INBOX_CHANNEL_PREFIX.length), msg.item);
      } catch {
        /* malformed message must never take a worker down */
      }
    });
  } catch {
    sub = null;
  }
}

function ensurePub(): Redis | null {
  if (pub) return pub;
  try {
    pub = createRedisClient();
    pub.on("error", () => undefined);
  } catch {
    pub = null;
  }
  return pub;
}

/** Register a stream's listener for one user. Returns the unsubscribe function. */
export function subscribeInbox(userId: string, fn: Listener): () => void {
  ensureSub();
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(fn);
  return () => {
    const s = listeners.get(userId);
    if (!s) return;
    s.delete(fn);
    if (!s.size) listeners.delete(userId);
  };
}

/** Fan a new item out to every stream of `userId`, on every fork. Never throws, never awaits Redis. */
export function publishInboxItem(userId: string, item: unknown): void {
  deliver(userId, item);
  const p = ensurePub();
  if (!p) return;
  try {
    // publish() rejects asynchronously when Redis is unreachable; claim it synchronously
    // (index.ts exits on unhandledRejection — see cache.service.ts publishInvalidation).
    void Promise.resolve(p.publish(`${INBOX_CHANNEL_PREFIX}${userId}`, JSON.stringify({ origin, item }))).catch(() => undefined);
  } catch {
    /* ended client / serialisation — the local delivery above already happened */
  }
}

/** Test/shutdown helper. */
export async function closeInboxBus(): Promise<void> {
  const p = pub;
  const s = sub;
  pub = null;
  sub = null;
  listeners.clear();
  try {
    await p?.quit();
  } catch {
    /* ignore */
  }
  try {
    await s?.quit();
  } catch {
    /* ignore */
  }
}

export const listenerCount = (userId: string) => listeners.get(userId)?.size ?? 0;
