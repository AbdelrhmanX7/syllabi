import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { createRedisClient } from "@/config/redis";

/**
 * Live notebook pages (sharing phase 2 part B): the per-page write lock, the cross-process event
 * channel and "who is here".
 *
 * Prod runs several API forks behind a round-robin upstream, so two editors' pushes can land on
 * different forks and a page's open streams sit on any of them. Same pattern as the inbox bus
 * (services/study/inbox/bus.ts): events go out on Redis channel `study:page:<pageId>`, every fork
 * pattern-subscribes and hands them to its local streams, the sending fork delivers locally first and
 * skips its own echo. Redis down = same-fork delivery only; the app also re-reads the page when it
 * notices a gap in the version chain.
 *
 * Every Redis use here fails open and never waits for a Redis that is not connected (ioredis would
 * queue the command until it is).
 */

export const PAGE_CHANNEL_PREFIX = "study:page:";
const PATTERN = `${PAGE_CHANNEL_PREFIX}*`;
const origin = randomUUID();

export interface PagePerson {
  clientId: string;
  userId: string;
  name: string;
}

export type PageEvent =
  /** A push or a save: `ops` null = too big to send, or a whole-board save; re-read the page. */
  | { type: "ops"; prevVersion: number; version: number; ops: unknown | null; by: PagePerson }
  | { type: "presence"; people: PagePerson[] }
  /** Sharing changed (someone removed or lowered, share stopped, page deleted): re-check access. */
  | { type: "revoke" };

type Listener = (event: PageEvent) => void;

const listeners = new Map<string, Set<Listener>>();
let pub: Redis | null = null;
let sub: Redis | null = null;
let cmd: Redis | null = null;

const ready = (client: Redis | null): client is Redis => Boolean(client) && client!.status === "ready";

function deliver(pageId: string, event: PageEvent) {
  for (const fn of listeners.get(pageId) ?? []) {
    try {
      fn(event);
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
    s.on("ready", () => {
      if (sub !== s) return;
      s.psubscribe(PATTERN, () => undefined);
    });
    s.on("pmessage", (_p: string, channel: string, raw: string) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg || msg.origin === origin || !msg.event) return;
        deliver(channel.slice(PAGE_CHANNEL_PREFIX.length), msg.event as PageEvent);
      } catch {
        /* malformed message must never take a worker down */
      }
    });
  } catch {
    sub = null;
  }
}

function client(kind: "pub" | "cmd"): Redis | null {
  const existing = kind === "pub" ? pub : cmd;
  if (existing) return existing;
  try {
    const c = createRedisClient();
    if (kind === "pub") pub = c;
    else cmd = c;
    return c;
  } catch {
    return null;
  }
}

/** Register a stream's listener for one page. Returns the unsubscribe function. */
export function subscribePage(pageId: string, fn: Listener): () => void {
  ensureSub();
  let set = listeners.get(pageId);
  if (!set) listeners.set(pageId, (set = new Set()));
  set.add(fn);
  return () => {
    const s = listeners.get(pageId);
    if (!s) return;
    s.delete(fn);
    if (!s.size) listeners.delete(pageId);
  };
}

/** Fan an event out to every stream of the page, on every fork. Never throws, never awaits Redis. */
export function publishPageEvent(pageId: string, event: PageEvent): void {
  deliver(pageId, event);
  const p = client("pub");
  if (!p) return;
  try {
    void Promise.resolve(p.publish(`${PAGE_CHANNEL_PREFIX}${pageId}`, JSON.stringify({ origin, event }))).catch(() => undefined);
  } catch {
    /* the local delivery above already happened */
  }
}

// ─── the write lock ─────────────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<void>>();
const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 4_000;
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function redisLock(pageId: string): Promise<(() => void) | null> {
  const c = client("cmd");
  if (!ready(c)) return null;
  const key = `study:lock:page:${pageId}`;
  const token = randomUUID();
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let got: unknown = null;
    try {
      got = await c.set(key, token, "PX", LOCK_TTL_MS, "NX");
    } catch {
      return null; // Redis went away: the version check still guards the commit
    }
    if (got === "OK") {
      return () => {
        if (ready(c)) void Promise.resolve(c.eval(RELEASE, 1, key, token)).catch(() => undefined);
      };
    }
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
}

/**
 * Run `fn` holding page `pageId`'s write lock: one at a time per page in this process, and (when Redis
 * is up) across forks. Writers still commit with the version check, which is the last guard.
 */
export async function withPageLock<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(pageId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  chains.set(pageId, tail);
  await prev;
  let unlockRedis: (() => void) | null = null;
  try {
    unlockRedis = await redisLock(pageId);
    return await fn();
  } finally {
    unlockRedis?.();
    release();
    if (chains.get(pageId) === tail) chains.delete(pageId);
  }
}

// ─── who is here ────────────────────────────────────────────────────────────────────────

/** A stream refreshes its entry on every ping (10 s); an entry not refreshed for this long is gone. */
export const PRESENCE_STALE_MS = 35_000;
const local = new Map<string, Map<string, PagePerson & { at: number }>>();
const presenceKey = (pageId: string) => `study:presence:page:${pageId}`;

export async function touchPresence(pageId: string, person: PagePerson): Promise<void> {
  let m = local.get(pageId);
  if (!m) local.set(pageId, (m = new Map()));
  m.set(person.clientId, { ...person, at: Date.now() });
  const c = client("cmd");
  if (!ready(c)) return;
  try {
    await c.hset(presenceKey(pageId), person.clientId, JSON.stringify({ ...person, at: Date.now() }));
    await c.pexpire(presenceKey(pageId), PRESENCE_STALE_MS * 2);
  } catch {
    /* local list still answers */
  }
}

export async function dropPresence(pageId: string, clientId: string): Promise<void> {
  const m = local.get(pageId);
  m?.delete(clientId);
  if (m && !m.size) local.delete(pageId);
  const c = client("cmd");
  if (!ready(c)) return;
  try {
    await c.hdel(presenceKey(pageId), clientId);
  } catch {
    /* expires by itself */
  }
}

/** Everyone with the page open, one entry per device, freshest first. */
export async function pagePeople(pageId: string): Promise<PagePerson[]> {
  const now = Date.now();
  const all = new Map<string, PagePerson & { at: number }>();
  for (const [id, p] of local.get(pageId) ?? []) if (now - p.at < PRESENCE_STALE_MS) all.set(id, p);
  const c = client("cmd");
  if (ready(c)) {
    try {
      const raw = await c.hgetall(presenceKey(pageId));
      for (const [id, value] of Object.entries(raw ?? {})) {
        try {
          const p = JSON.parse(value);
          if (p && typeof p.at === "number" && now - p.at < PRESENCE_STALE_MS && !all.has(id))
            all.set(id, { clientId: id, userId: String(p.userId), name: String(p.name || "Someone"), at: p.at });
        } catch {
          /* skip a bad entry */
        }
      }
    } catch {
      /* local only */
    }
  }
  return [...all.values()].sort((a, b) => b.at - a.at).map(({ clientId, userId, name }) => ({ clientId, userId, name }));
}

/** Test/shutdown helper. */
export function closePageLive(): void {
  const clients = [pub, sub, cmd];
  pub = sub = cmd = null;
  listeners.clear();
  local.clear();
  for (const c of clients) {
    try {
      c?.disconnect();
    } catch {
      /* ignore */
    }
  }
}
