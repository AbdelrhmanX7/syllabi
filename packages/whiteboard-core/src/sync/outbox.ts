import { createWhiteboardId } from '../id';

/**
 * Durable sync outbox (FE-2).
 *
 * A pure, fully unit-testable queue over an INJECTED async key-value store. It
 * guarantees that every local change is captured and only marked `synced` AFTER
 * the cloud confirms the append (write-confirm-then-advance). Nothing is dropped
 * to a stuck sync or a crash:
 *
 * - `enqueue` appends a `pending` snapshot with a per-document strictly-increasing
 *   `localSeq`. The heavy gzipped blob lives elsewhere and is referenced by
 *   `rawDataKey`; the outbox only holds metadata + the pointer.
 * - The syncer marks an entry `inflight`, then `synced` (with the server seq) only
 *   once the cloud acknowledges — never before.
 * - `markFailed` bumps `attempts` and reschedules via bounded exponential backoff.
 *   It NEVER permanently dead-letters: backoff caps at `BACKOFF_MAX_MS` and keeps
 *   retrying forever.
 * - Eviction honors the cap by dropping only the OLDEST `synced` entries. It never
 *   evicts the newest unsynced state of a document and never drops a
 *   pending/inflight/failed entry. Durability beats the cap.
 *
 * No network and no real IndexedDB here — that is wired in by the syncer (FE-3).
 */

export type OutboxStatus = 'pending' | 'inflight' | 'synced' | 'failed';

export interface OutboxEntry {
  id: string;
  documentId: string;
  /** Strictly increasing per document; assigned by `enqueue`. */
  localSeq: number;
  /** Server seq this edit was based on, or null when there is no known base. */
  baseSeq: number | null;
  deviceId: string;
  /** Pointer to the gzipped snapshot blob stored separately (e.g. a blob store key). */
  rawDataKey?: string;
  pageCount: number;
  title: string;
  thumbnail: string | null;
  fileSize: number;
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms; the entry is not due for sync before this time. */
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  /** Set once the cloud confirms the append. */
  serverSeq?: number;
}

export interface OutboxStore {
  get(key: string): Promise<OutboxEntry | null>;
  put(entry: OutboxEntry): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<OutboxEntry[]>;
}

export interface OutboxEnqueueInput {
  documentId: string;
  deviceId: string;
  baseSeq: number | null;
  pageCount: number;
  title: string;
  thumbnail?: string | null;
  fileSize: number;
  rawDataKey?: string;
  /** Optional explicit id (defaults to a generated whiteboard id). */
  id?: string;
}

export interface OutboxOptions {
  /** Max retained entries per document. Default 30. */
  maxEntriesPerDocument?: number;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

export interface Outbox {
  enqueue(input: OutboxEnqueueInput): Promise<OutboxEntry>;
  /**
   * Coalescing enqueue. If the document's newest entry is still `pending`, mutate
   * it in place (overwrite metadata/baseSeq, reset `nextAttemptAt`) and return it —
   * keeping "newest pending == latest doc state" without flooding the ring. If the
   * newest entry is inflight/synced/failed (or there is none), fall through to
   * `enqueue` (new localSeq). An in-flight upload is never disturbed; the change
   * rides the next cycle as a fresh pending entry.
   */
  upsertPending(input: OutboxEnqueueInput): Promise<OutboxEntry>;
  listDue(now: number): Promise<OutboxEntry[]>;
  /**
   * The due set of ONE document, same ordering rules as {@link listDue}.
   *
   * Exists because the API key an entry must upload under is a property of the entry's
   * DOCUMENT (each teacher has their own device key), while this store is global. A caller
   * that holds one teacher's client — the app-wide auto-upload worker — must therefore be
   * able to ask for exactly the entries that client is entitled to send, instead of draining
   * whatever `listDue` happens to return and 4xx-ing another teacher's rows forever.
   */
  listDueForDocument(documentId: string, now: number): Promise<OutboxEntry[]>;
  markInflight(id: string): Promise<OutboxEntry>;
  markSynced(id: string, serverSeq: number): Promise<OutboxEntry>;
  markFailed(id: string): Promise<OutboxEntry>;
  /**
   * Cold-start recovery: flip stranded `inflight` entries back to `failed` so they
   * re-enter the due set. A crash mid-upload leaves an entry `inflight`, which is
   * outside `DUE_STATUSES` and would otherwise never re-drain. Attempts are
   * preserved; `nextAttemptAt` is set to now so the entry is immediately due.
   * Returns the number of entries reclaimed.
   *
   * ## `documentId` — a PARTIAL guard, not a complete one
   *
   * Narrowing the sweep to one document keeps an engine from touching a board it is not
   * currently draining, and a caller that does not own every document MUST pass it. But be
   * precise about what that buys: scoping only protects OTHER documents. Two engines run against
   * this one store — the open board's editor syncer and the app-wide auto-upload worker — and if
   * they ever drain the SAME document at the same time, a scoped sweep from the second still
   * flips the first's genuinely in-flight entry to `failed` mid-upload, putting it back in the
   * due set for a second, duplicate append.
   *
   * What actually prevents that overlap is the active-document registry
   * (`apps/whiteboard/lib/cloud-sync/active-document.ts`): the worker re-reads it immediately
   * before every board and skips whichever board the editor holds. This scoping is defence in
   * depth underneath that, plus `staleBefore` below.
   *
   * ## `isStranded` — the test that replaced a once-per-session latch
   *
   * The caller decides, per entry, whether an `inflight` row is genuinely on the wire or merely
   * stuck looking like it. Only entries this returns `true` for are reclaimed; omitted → every
   * inflight entry is (the original whole-store behaviour, and what a single-engine cold start
   * wants). The store deliberately does not guess: it cannot see which uploads are running, and
   * the syncer can — see `INFLIGHT_STALE_MS` and the live-upload registry beside it.
   */
  reclaimInflight(documentId?: string, isStranded?: (entry: OutboxEntry) => boolean): Promise<number>;
  pendingCount(documentId?: string): Promise<number>;
  latest(documentId: string): Promise<OutboxEntry | null>;
}

const DEFAULT_MAX_ENTRIES_PER_DOCUMENT = 30;

/** Backoff: 5s, 10s, 20s, 40s, 80s, then capped at 120s — forever. Never dead-letters. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_FACTOR = 2;
export const BACKOFF_MAX_MS = 120_000;

const UNSYNCED_STATUSES: ReadonlySet<OutboxStatus> = new Set<OutboxStatus>(['pending', 'inflight', 'failed']);
const DUE_STATUSES: ReadonlySet<OutboxStatus> = new Set<OutboxStatus>(['pending', 'failed']);

/**
 * Delay before the next attempt given the number of attempts already made.
 * `attempts` is 1 after the first failure. Bounded exponential, capped at the max.
 */
export function backoffDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = BACKOFF_BASE_MS * BACKOFF_FACTOR ** exponent;

  return Math.min(raw, BACKOFF_MAX_MS);
}

function isUnsynced(entry: OutboxEntry): boolean {
  return UNSYNCED_STATUSES.has(entry.status);
}

function byLocalSeqAsc(a: OutboxEntry, b: OutboxEntry): number {
  return a.localSeq - b.localSeq;
}

export function createOutbox(store: OutboxStore, opts: OutboxOptions = {}): Outbox {
  const maxEntriesPerDocument = Math.max(1, opts.maxEntriesPerDocument ?? DEFAULT_MAX_ENTRIES_PER_DOCUMENT);
  const now = opts.now ?? Date.now;

  // Serialize the read-modify-write of `enqueue` so concurrent enqueues cannot
  // read the same max localSeq and collide. The store is async (IndexedDB), so
  // overlapping calls would otherwise interleave their list→max+1→put. Chaining
  // on a single tail promise keeps localSeq strictly increasing per instance.
  let enqueueTail: Promise<unknown> = Promise.resolve();

  const serializeEnqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = enqueueTail.then(task, task);

    enqueueTail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  };

  const requireEntry = async (id: string): Promise<OutboxEntry> => {
    const entry = await store.get(id);

    if (!entry) {
      throw new Error(`Outbox entry not found: ${id}`);
    }

    return entry;
  };

  const entriesForDocument = async (documentId: string): Promise<OutboxEntry[]> => {
    const all = await store.list();

    return all.filter((entry) => entry.documentId === documentId);
  };

  const nextLocalSeq = (entries: OutboxEntry[]): number => {
    return entries.reduce((max, entry) => Math.max(max, entry.localSeq), 0) + 1;
  };

  /**
   * Drop the oldest SYNCED entries until the document is within the cap. Never
   * touches pending/inflight/failed entries, and never removes the newest entry
   * of the document — even when that newest entry is already `synced`, it is the
   * live state that `latest()`/resume depend on, so it is structurally protected
   * here. If only protected entries remain over the cap, they all stay.
   */
  const evictForDocument = async (documentId: string): Promise<void> => {
    let entries = await entriesForDocument(documentId);

    if (entries.length <= maxEntriesPerDocument) {
      return;
    }

    const newestLocalSeq = entries.reduce((max, entry) => Math.max(max, entry.localSeq), 0);
    const evictable = entries
      .filter((entry) => entry.status === 'synced' && entry.localSeq !== newestLocalSeq)
      .sort(byLocalSeqAsc);

    for (const candidate of evictable) {
      if (entries.length <= maxEntriesPerDocument) {
        break;
      }

      await store.delete(candidate.id);
      entries = entries.filter((entry) => entry.id !== candidate.id);
    }
  };

  /**
   * The read-modify-write body of `enqueue` WITHOUT the serialize wrapper. Call
   * only from inside the `serializeEnqueue` tail (so it stays atomic). `enqueue`
   * and `upsertPending` (when it falls through) both reuse it.
   */
  const enqueueLocked = async (input: OutboxEnqueueInput): Promise<OutboxEntry> => {
    const timestamp = now();
    const existing = await entriesForDocument(input.documentId);
    const entry: OutboxEntry = {
      id: input.id ?? createWhiteboardId(),
      documentId: input.documentId,
      localSeq: nextLocalSeq(existing),
      baseSeq: input.baseSeq,
      deviceId: input.deviceId,
      rawDataKey: input.rawDataKey,
      pageCount: input.pageCount,
      title: input.title,
      thumbnail: input.thumbnail ?? null,
      fileSize: input.fileSize,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await store.put(entry);
    await evictForDocument(input.documentId);

    return entry;
  };

  const enqueue = (input: OutboxEnqueueInput): Promise<OutboxEntry> => serializeEnqueue(() => enqueueLocked(input));

  /**
   * Coalesce onto the document's newest entry when it is still `pending`,
   * otherwise enqueue a fresh entry. Runs through the same `serializeEnqueue`
   * tail as `enqueue` so it cannot race enqueue or itself: the read-modify-write
   * of "find newest → mutate or append" stays atomic per instance.
   */
  const upsertPending = (input: OutboxEnqueueInput): Promise<OutboxEntry> =>
    serializeEnqueue(async () => {
      const existing = await entriesForDocument(input.documentId);
      const newest =
        existing.length === 0 ? null : existing.reduce((acc, entry) => (entry.localSeq > acc.localSeq ? entry : acc));

      if (!newest || newest.status !== 'pending') {
        return enqueueLocked(input);
      }

      const timestamp = now();
      const updated: OutboxEntry = {
        ...newest,
        baseSeq: input.baseSeq,
        deviceId: input.deviceId,
        rawDataKey: input.rawDataKey,
        pageCount: input.pageCount,
        title: input.title,
        thumbnail: input.thumbnail ?? null,
        fileSize: input.fileSize,
        nextAttemptAt: timestamp,
        updatedAt: timestamp,
      };

      await store.put(updated);

      return updated;
    });

  const reclaimInflight = (documentId?: string, isStranded?: (entry: OutboxEntry) => boolean): Promise<number> =>
    serializeEnqueue(async () => {
      const all = await store.list();
      const stranded = all.filter(
        (entry) =>
          entry.status === 'inflight' &&
          (documentId === undefined || entry.documentId === documentId) &&
          (isStranded === undefined || isStranded(entry)),
      );
      const timestamp = now();

      for (const entry of stranded) {
        const reclaimed: OutboxEntry = {
          ...entry,
          status: 'failed',
          nextAttemptAt: timestamp,
          updatedAt: timestamp,
        };

        await store.put(reclaimed);
      }

      return stranded.length;
    });

  /**
   * The shared due-set projection: filter by status + schedule, then order per document by
   * `localSeq` so a document's edits are always uploaded oldest-first. Documents themselves keep
   * whatever order the store handed back — the drain is serial, so grouping is what matters.
   */
  const collectDue = (all: OutboxEntry[], currentTime: number): OutboxEntry[] => {
    const due = all.filter((entry) => DUE_STATUSES.has(entry.status) && entry.nextAttemptAt <= currentTime);
    const byDocument = new Map<string, OutboxEntry[]>();

    for (const entry of due) {
      const bucket = byDocument.get(entry.documentId);

      if (bucket) {
        bucket.push(entry);
      } else {
        byDocument.set(entry.documentId, [entry]);
      }
    }

    const result: OutboxEntry[] = [];

    for (const bucket of Array.from(byDocument.values())) {
      result.push(...bucket.sort(byLocalSeqAsc));
    }

    return result;
  };

  const listDue = async (currentTime: number): Promise<OutboxEntry[]> => {
    return collectDue(await store.list(), currentTime);
  };

  const listDueForDocument = async (documentId: string, currentTime: number): Promise<OutboxEntry[]> => {
    return collectDue(await entriesForDocument(documentId), currentTime);
  };

  const markInflight = async (id: string): Promise<OutboxEntry> => {
    const entry = await requireEntry(id);
    const updated: OutboxEntry = { ...entry, status: 'inflight', updatedAt: now() };

    await store.put(updated);

    return updated;
  };

  const markSynced = async (id: string, serverSeq: number): Promise<OutboxEntry> => {
    const entry = await requireEntry(id);
    const updated: OutboxEntry = { ...entry, status: 'synced', serverSeq, updatedAt: now() };

    await store.put(updated);
    await evictForDocument(updated.documentId);

    return updated;
  };

  const markFailed = async (id: string): Promise<OutboxEntry> => {
    const entry = await requireEntry(id);
    const attempts = entry.attempts + 1;
    const timestamp = now();
    const updated: OutboxEntry = {
      ...entry,
      status: 'failed',
      attempts,
      nextAttemptAt: timestamp + backoffDelayMs(attempts),
      updatedAt: timestamp,
    };

    await store.put(updated);

    return updated;
  };

  const pendingCount = async (documentId?: string): Promise<number> => {
    const all = await store.list();

    return all.filter((entry) => isUnsynced(entry) && (documentId === undefined || entry.documentId === documentId))
      .length;
  };

  const latest = async (documentId: string): Promise<OutboxEntry | null> => {
    const entries = await entriesForDocument(documentId);

    if (entries.length === 0) {
      return null;
    }

    return entries.reduce((newest, entry) => (entry.localSeq > newest.localSeq ? entry : newest));
  };

  return {
    enqueue,
    upsertPending,
    listDue,
    listDueForDocument,
    markInflight,
    markSynced,
    markFailed,
    reclaimInflight,
    pendingCount,
    latest,
  };
}
