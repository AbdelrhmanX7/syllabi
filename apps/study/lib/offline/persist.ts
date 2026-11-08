// The React Query cache, saved on the device (IndexedDB) so every screen opens with the last data it
// showed — offline, or before the server answers. Hand-rolled on `dehydrate`/`hydrate` (no extra
// package): a throttled write after study data changes, one read at start-up.
//
// What is saved: `['study', …]` queries from the allowlist below — classes, Today, items, pages,
// questions/flashcards, library lists, concept maps, guide/exams, plans. Never AI (tutor), search,
// Canvas sync status, transcripts or version lists. Signed file links (~1 h B2 URLs) are saved as
// already expired, so a restored screen asks for a fresh one before using it.
//
// Light on 3–4 GB tablets: at most one write per WRITE_DELAY_MS, only when a saved query changed,
// stored as one JSON string, capped at MAX_BYTES (newest data kept first).
import type { DehydratedState, QueryClient } from '@tanstack/react-query';

import { dehydrate, hydrate } from '@tanstack/react-query';

import { type KvStore, offlineKv } from './idb-kv';

export const PERSIST_KEY = 'rq-cache';
/** Bump when the saved shape changes. */
export const PERSIST_SCHEMA = 1;
export const MAX_BYTES = 3_000_000;
export const WRITE_DELAY_MS = 3_000;
/** Restored queries must outlive a session where no screen mounts them, or the next write drops them. */
export const PERSIST_GC_TIME = 24 * 60 * 60_000;
/** Older than this is not worth showing. */
export const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** `queryKey[1]` of the study queries worth having offline. */
export const PERSISTED_KINDS = new Set([
  'today',
  'classes',
  'modules',
  'items',
  'item',
  'pages',
  'rulers',
  'mastery',
  'questions',
  'concept-maps',
  'guide',
  'exams-schedule',
  'exam-results',
  'exam-blueprint',
  'grade-plan',
  'a-plan',
  'calendar',
  'lectures',
  // useLoad-backed screens (question bank, mock exams) — features/bank/hooks/useLoad.ts
  'load',
]);

export function shouldPersistKey(key: readonly unknown[]): boolean {
  if (key[0] !== 'study' || typeof key[1] !== 'string') return false;
  // The library LIST only: a doc carries signed links and a whole note's markdown.
  if (key[1] === 'library') return key[2] === 'list';
  // A useLoad without its own cache name (keyed by a React id) is not stable across starts.
  if (key[1] === 'load') return typeof key[2] === 'string' && !key[2].startsWith(':');

  return PERSISTED_KINDS.has(key[1]);
}

/**
 * Saved kinds live long in memory (PERSIST_GC_TIME) so a restored copy is not dropped before a screen
 * asks for it; everything else keeps React Query's short default (a 3–4 GB tablet).
 */
export function applyPersistDefaults(client: QueryClient): void {
  PERSISTED_KINDS.forEach((kind) => client.setQueryDefaults(['study', kind], { gcTime: PERSIST_GC_TIME }));
  client.setQueryDefaults(['study', 'library', 'list'], { gcTime: PERSIST_GC_TIME });
}

const SIGNED_EXPIRY_KEYS = ['expiresAt', 'urlExpiresAt'];
const MAX_DEPTH = 8;
export const EXPIRED_AT = new Date(0).toISOString();

/**
 * A copy of `value` whose signed links all read as expired: any object with a `url` next to
 * `expiresAt` / `urlExpiresAt` gets that expiry set to the epoch. The screens already ask for a fresh
 * link when the expiry has passed (e.g. the PDF board), so a restored copy never uses a dead one; the
 * link itself stays so «is there a file» checks still hold.
 */
export function expireSignedUrls<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => expireSignedUrls(entry, depth + 1)) as unknown as T;
  const source = value as Record<string, unknown>;
  const signed = typeof source.url === 'string' && SIGNED_EXPIRY_KEYS.some((key) => key in source);
  const out: Record<string, unknown> = {};

  for (const [key, inner] of Object.entries(source)) {
    if (signed && SIGNED_EXPIRY_KEYS.includes(key)) out[key] = EXPIRED_AT;
    else out[key] = expireSignedUrls(inner, depth + 1);
  }

  return out as T;
}

export interface PersistContext {
  /** App version + backend URL + mock mode: any change makes the saved copy unusable. */
  buster: string;
  /** The signed-in account id, or null when there is no live session. */
  owner: string | null;
}

export interface Snapshot {
  schema: number;
  buster: string;
  owner: string | null;
  savedAt: number;
  state: DehydratedState;
}

type DehydratedQuery = DehydratedState['queries'][number];

/** The saved form of the client's cache: allowlisted, successful, url-stripped, newest first, capped. */
export function buildSnapshot(client: QueryClient, ctx: PersistContext, now = Date.now(), maxBytes = MAX_BYTES): string {
  const state = dehydrate(client, {
    shouldDehydrateQuery: (query) => query.state.status === 'success' && shouldPersistKey(query.queryKey),
    shouldDehydrateMutation: () => false,
  });
  const queries = state.queries
    .filter((query) => query.state.data !== undefined)
    .map((query) => ({ ...query, state: { ...query.state, data: expireSignedUrls(query.state.data) } }) as DehydratedQuery)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  const kept: DehydratedQuery[] = [];
  let bytes = 200;

  for (const query of queries) {
    const size = JSON.stringify(query).length;

    if (bytes + size > maxBytes) continue;
    bytes += size;
    kept.push(query);
  }
  const snapshot: Snapshot = {
    schema: PERSIST_SCHEMA,
    buster: ctx.buster,
    owner: ctx.owner,
    savedAt: now,
    state: { queries: kept, mutations: [] },
  };

  return JSON.stringify(snapshot);
}

/** Whether a saved snapshot may be shown to this session. */
export function snapshotUsable(snapshot: Snapshot | null, ctx: PersistContext, now = Date.now()): boolean {
  if (!snapshot || snapshot.schema !== PERSIST_SCHEMA || snapshot.buster !== ctx.buster) return false;
  if (now - snapshot.savedAt > MAX_AGE_MS) return false;
  // Only the account that saved it sees it (`owner` is the last signed-in account, kept through an
  // expired token — lib/offline/owner.ts). A copy saved with no account is shown to no account.
  if (ctx.owner !== snapshot.owner && !(ctx.owner === null && snapshot.owner === null)) return false;

  return true;
}

function parseSnapshot(raw: unknown): Snapshot | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Snapshot;

    return parsed && typeof parsed === 'object' && Array.isArray(parsed.state?.queries) ? parsed : null;
  } catch {
    return null;
  }
}

/** Load the saved cache into `client`. Resolves true when something was restored; never throws. */
export async function restoreQueryCache(client: QueryClient, ctx: PersistContext, kv: KvStore = offlineKv()): Promise<boolean> {
  try {
    const snapshot = parseSnapshot(await kv.get(PERSIST_KEY));

    if (!snapshotUsable(snapshot, ctx)) {
      if (snapshot) await kv.del(PERSIST_KEY);

      return false;
    }
    hydrate(client, snapshot!.state);

    return snapshot!.state.queries.length > 0;
  } catch {
    return false;
  }
}

/** Forget the saved cache (sign-out). */
export async function clearPersistedQueries(kv: KvStore = offlineKv()): Promise<void> {
  cancelPending?.();
  await kv.del(PERSIST_KEY).catch(() => undefined);
}

let cancelPending: (() => void) | null = null;

/**
 * Save the cache after study data changes (throttled) and when the app goes to the background.
 * Returns the unsubscribe.
 */
export function startPersisting(
  client: QueryClient,
  context: () => PersistContext,
  kv: KvStore = offlineKv(),
  delayMs = WRITE_DELAY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const write = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      void kv.set(PERSIST_KEY, buildSnapshot(client, context())).catch(() => undefined);
    } catch {
      // a value that will not serialize: skip this round
    }
  };
  const schedule = () => {
    dirty = true;
    if (timer === null) timer = setTimeout(write, delayMs);
  };

  cancelPending = () => {
    dirty = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (shouldPersistKey(event.query.queryKey)) schedule();
  });
  const onHide = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'hidden') write();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', write);
    document.addEventListener('visibilitychange', onHide);
  }

  return () => {
    unsubscribe();
    write();
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', write);
      document.removeEventListener('visibilitychange', onHide);
    }
  };
}
