// Drains the perf ring to the backend in batches. Pure orchestration with injected store/sender/clock,
// so batching and backoff are unit-tested without a network: a 2xx deletes exactly the events it
// carried; anything else keeps them and schedules the next attempt with backoff. A payload the server
// rejects as malformed or too large (400/413/422) is dropped, so one poison batch cannot wedge the queue.

import type { PerfStore, StoredPerfEvent } from './store';
import type { PerfApp, PerfBatch, PerfDevice, PerfEvent } from './types';

import { PERF_SCHEMA } from './types';

/** Raw JSON per regular batch. Gzip only shrinks it, so ≤ 256 KB on the wire is guaranteed. */
export const PERF_BATCH_MAX_BYTES = 256 * 1024;
/** Raw JSON per keepalive batch (page going hidden): browsers cap in-flight keepalive bodies at 64 KB. */
export const PERF_KEEPALIVE_MAX_BYTES = 56 * 1024;
/** Room left in a batch for the header (device/app/ids) and the array's commas. */
export const PERF_BATCH_OVERHEAD_BYTES = 8 * 1024;
/** Batches per upload pass (a backlog drains over a few minutes, not in one burst). */
export const PERF_MAX_BATCHES_PER_PASS = 4;

export interface PerfSendResult {
  ok: boolean;
  /** HTTP status; 0 = network failure / no response; -1 = not attempted (no session). */
  status: number;
  /** A 429's `Retry-After`, in ms — the next attempt waits at least this long. */
  retryAfterMs?: number;
}

/** Longest `Retry-After` honoured (the backend's daily byte quota resets within 24 h). */
export const PERF_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;

/** `Retry-After` header → ms (delta-seconds or an HTTP date); null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Math.min(PERF_RETRY_AFTER_MAX_MS, Number(trimmed) * 1000);
  const at = Date.parse(trimmed);

  return Number.isNaN(at) ? null : Math.min(PERF_RETRY_AFTER_MAX_MS, Math.max(0, at - now));
}

export type PerfSender = (batch: PerfBatch, options: { keepalive: boolean }) => Promise<PerfSendResult>;

export interface PerfUploaderDeps {
  store: PerfStore;
  send: PerfSender;
  now: () => number;
  random: () => number;
  newId: () => string;
  header: () => { session: string; device: PerfDevice; app: PerfApp };
}

export type PerfUploadOutcome = 'sent' | 'empty' | 'backoff' | 'busy' | 'failed';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Delay before attempt `attempt + 1` after a failure with `status`. Jitter ±20 % (random ∈ [0, 1)).
 * - network / 5xx / 429: 1 min doubling, ≤ 30 min (a 429's Retry-After wins when longer)
 * - 401 / 403 / no session: 5 min doubling, ≤ 1 h (a sign-in later picks it up)
 * - 404 (route not shipped yet): 30 min doubling, ≤ 6 h
 */
export function backoffDelay(status: number, attempt: number, random: number): number {
  let base = MINUTE;
  let cap = 30 * MINUTE;

  if (status === 401 || status === 403 || status === -1) {
    base = 5 * MINUTE;
    cap = HOUR;
  } else if (status === 404) {
    base = 30 * MINUTE;
    cap = 6 * HOUR;
  }
  const raw = Math.min(cap, base * 2 ** Math.max(0, Math.min(attempt, 20) - 1));

  return Math.round(raw * (0.8 + 0.4 * random));
}

/** Statuses that mean «this payload will never be accepted» — drop it rather than retry forever. */
export function isPoisonStatus(status: number): boolean {
  return status === 400 || status === 413 || status === 422;
}

export function parseStored(entries: readonly StoredPerfEvent[]): PerfEvent[] {
  const events: PerfEvent[] = [];

  for (const entry of entries) {
    try {
      events.push(JSON.parse(entry.json) as PerfEvent);
    } catch {
      // a corrupt row is skipped (and removed with its batch)
    }
  }

  return events;
}

export class PerfUploader {
  attempts = 0;
  nextAttemptAt = 0;
  lastUploadAt: number | null = null;
  lastStatus: number | null = null;
  /** Events confirmed by the server since start. */
  sentEvents = 0;
  private inFlight = false;
  /**
   * The last batch that failed WITHOUT a verdict (network / 5xx / 429 / auth): a retry of the very
   * same events re-sends the same `batchId` and `dropped`, so a lost 204 is deduped by the server
   * instead of storing the events twice.
   */
  private pending: { key: string; count: number; batchId: string; dropped: number } | null = null;

  constructor(private readonly deps: PerfUploaderDeps) {}

  get busy(): boolean {
    return this.inFlight;
  }

  /**
   * One upload pass. `keepalive`: the page is going hidden — one small batch, sent with keepalive.
   * `force`: ignore the backoff window (the Settings «upload now»).
   */
  async upload(options: { keepalive?: boolean; force?: boolean } = {}): Promise<PerfUploadOutcome> {
    const keepalive = options.keepalive ?? false;

    if (this.inFlight) return 'busy';
    if (!options.force && this.deps.now() < this.nextAttemptAt) return 'backoff';
    this.inFlight = true;

    try {
      let outcome: PerfUploadOutcome = 'empty';
      const passes = keepalive ? 1 : PERF_MAX_BATCHES_PER_PASS;

      for (let pass = 0; pass < passes; pass += 1) {
        const result = await this.sendOne(keepalive);

        if (result === 'empty') break;
        outcome = result;
        if (result !== 'sent') break;
      }

      return outcome;
    } finally {
      this.inFlight = false;
    }
  }

  private async sendOne(keepalive: boolean): Promise<PerfUploadOutcome> {
    const { store } = this.deps;
    const cap = keepalive ? PERF_KEEPALIVE_MAX_BYTES : PERF_BATCH_MAX_BYTES;
    // ≤ 1 comma per event: cap the count so the commas fit the overhead budget too.
    // A pending retry re-reads at most its own event count: the ring is oldest-first, so the same
    // prefix comes back (same key → same batchId) even when new events arrived during the backoff.
    const maxEvents = Math.min(PERF_BATCH_OVERHEAD_BYTES / 2, this.pending?.count ?? Infinity);
    const entries = await store.peek(cap - PERF_BATCH_OVERHEAD_BYTES, maxEvents);

    if (entries.length === 0) return 'empty';
    const key = entries.map((entry) => entry.id).join(',');
    const taken = store.takeDropped();
    const retry = this.pending && this.pending.key === key ? this.pending : null;
    // A retry carries the first attempt's count; anything evicted since rides on the next batch.
    const dropped = retry ? Math.min(retry.dropped, taken) : taken;
    const header = this.deps.header();
    const batch: PerfBatch = {
      schema: PERF_SCHEMA,
      batchId: retry?.batchId ?? this.deps.newId(),
      session: header.session,
      sentAt: this.deps.now(),
      device: header.device,
      app: header.app,
      dropped,
      events: parseStored(entries),
    };
    let result: PerfSendResult;

    try {
      result = await this.deps.send(batch, { keepalive });
    } catch {
      result = { ok: false, status: 0 };
    }
    this.lastStatus = result.status;
    const ids = entries.map((entry) => entry.id);

    if (result.ok) {
      this.pending = null;
      await store.remove(ids);
      if (taken > dropped) store.restoreDropped(taken - dropped);
      this.attempts = 0;
      this.nextAttemptAt = 0;
      this.lastUploadAt = this.deps.now();
      this.sentEvents += batch.events.length;

      return 'sent';
    }
    if (isPoisonStatus(result.status)) {
      this.pending = null;
      await store.remove(ids);
      store.restoreDropped(taken + ids.length);

      return 'failed';
    }
    this.pending = { key, count: entries.length, batchId: batch.batchId, dropped };
    store.restoreDropped(taken);
    this.attempts += 1;
    const delay = Math.max(
      backoffDelay(result.status, this.attempts, this.deps.random()),
      Math.min(PERF_RETRY_AFTER_MAX_MS, result.retryAfterMs ?? 0),
    );

    this.nextAttemptAt = this.deps.now() + delay;

    return 'failed';
  }
}
