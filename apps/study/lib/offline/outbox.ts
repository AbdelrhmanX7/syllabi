// A small durable outbox for work that must not be lost offline (a flashcard grade, a new note page,
// «seen» marks). Jobs live in IndexedDB (via KvStore) and are sent in order when the server can be
// reached; a job whose send fails on the NETWORK stays and retries with backoff, a job the server
// REFUSES (4xx) is dropped — retrying it would only fail again.
//
// Every job carries `id` (a client id, sent along where the endpoint takes one) and its `scope`
// (account + server): only jobs of the current session are sent, so account B never sends A's work.
// Delivery is at-least-once: a crash between the server's answer and the job's removal resends it.

import { type KvStore, offlineKv } from './idb-kv';

export interface OutboxJob<P = unknown> {
  id: string;
  kind: string;
  payload: P;
  scope: string;
  createdAt: number;
  attempts: number;
  /** Not before (ms epoch): the backoff. */
  nextAt: number;
  lastError?: string;
  /** Merge key: a newer job with the same key replaces the queued one (e.g. «seen» per item). */
  dedupeKey?: string;
}

/**
 * What a handler says about one send: `done` (sent), `drop` (the server refused it for good),
 * `retry` (the network broke: back off, stop this flush), `later` (not now for a local reason — keep
 * it, no backoff, go on with the next job).
 */
export type SendResult = 'done' | 'retry' | 'drop' | 'later';

export type JobHandler = (job: OutboxJob) => Promise<SendResult>;

const OUTBOX_KEY = 'outbox';
const MAX_JOBS = 500;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/** A random id (Chrome 103 safe — no crypto.randomUUID needed). */
export function newClientId(prefix = ''): string {
  const bytes = new Uint8Array(12);

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);

  return prefix + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Listener = (jobs: readonly OutboxJob[]) => void;

export interface OutboxOptions {
  kv?: KvStore;
  now?: () => number;
}

export class Outbox {
  private jobs: OutboxJob[] | null = null;
  private loading: Promise<OutboxJob[]> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private flushing: Promise<number> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly kv: KvStore;
  private readonly now: () => number;

  constructor(options: OutboxOptions = {}) {
    this.kv = options.kv ?? offlineKv();
    this.now = options.now ?? Date.now;
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.jobs) listener(this.jobs);
    else void this.load().then((jobs) => listener(jobs));

    return () => {
      this.listeners.delete(listener);
    };
  }

  private load(): Promise<OutboxJob[]> {
    if (this.jobs) return Promise.resolve(this.jobs);
    this.loading ??= this.kv
      .get<OutboxJob[]>(OUTBOX_KEY)
      .then((stored) => (Array.isArray(stored) ? stored : []))
      .catch(() => [])
      .then((stored) => {
        // Something may have been queued in memory before the disk answered.
        this.jobs = [...stored, ...(this.jobs ?? [])];

        return this.jobs;
      });

    return this.loading;
  }

  /** Serialise every read-modify-write so two callers never overwrite each other. */
  private mutate<T>(fn: (jobs: OutboxJob[]) => { jobs: OutboxJob[]; result: T }): Promise<T> {
    const run = this.chain.then(async () => {
      const current = await this.load();
      const { jobs, result } = fn(current);

      this.jobs = jobs;
      await this.kv.set(OUTBOX_KEY, jobs).catch(() => undefined);
      this.emit();

      return result;
    });

    this.chain = run.catch(() => undefined);

    return run;
  }

  private emit(): void {
    const jobs = this.jobs ?? [];

    Array.from(this.listeners).forEach((listener) => {
      try {
        listener(jobs);
      } catch {
        // ignore
      }
    });
  }

  async all(): Promise<readonly OutboxJob[]> {
    await this.chain;

    return this.load();
  }

  async pending(scope?: string): Promise<number> {
    const jobs = await this.all();

    return scope === undefined ? jobs.length : jobs.filter((job) => job.scope === scope).length;
  }

  /** Queue a job. Same `dedupeKey` (and scope) replaces the older queued one. Resolves with the job. */
  enqueue<P>(input: { kind: string; payload: P; scope: string; id?: string; dedupeKey?: string }): Promise<OutboxJob<P>> {
    const job: OutboxJob<P> = {
      id: input.id ?? newClientId(),
      kind: input.kind,
      payload: input.payload,
      scope: input.scope,
      createdAt: this.now(),
      attempts: 0,
      nextAt: 0,
      dedupeKey: input.dedupeKey,
    };

    return this.mutate((jobs) => {
      let next = jobs;

      if (job.dedupeKey) next = next.filter((other) => !(other.dedupeKey === job.dedupeKey && other.scope === job.scope));
      next = [...next, job as OutboxJob];
      // A runaway queue drops its oldest jobs rather than filling the disk.
      if (next.length > MAX_JOBS) next = next.slice(next.length - MAX_JOBS);

      return { jobs: next, result: job };
    });
  }

  /** Update a queued job's payload (a handler recording progress, e.g. the server id it got). */
  patch(id: string, payload: unknown): Promise<void> {
    return this.mutate((jobs) => ({
      jobs: jobs.map((job) => (job.id === id ? { ...job, payload } : job)),
      result: undefined,
    }));
  }

  remove(id: string): Promise<void> {
    return this.mutate((jobs) => ({ jobs: jobs.filter((job) => job.id !== id), result: undefined }));
  }

  /** Drop every job of a scope (an account's queued work, when asked to). */
  clearScope(scope: string): Promise<void> {
    return this.mutate((jobs) => ({ jobs: jobs.filter((job) => job.scope !== scope), result: undefined }));
  }

  /**
   * Send the due jobs of `scope`, oldest first, one at a time. Stops at the first network failure
   * (the rest would fail the same way). Resolves with how many were sent. One flush at a time.
   */
  flush(scope: string, options: { force?: boolean } = {}): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.runFlush(scope, options.force === true).finally(() => {
      this.flushing = null;
    });

    return this.flushing;
  }

  private async runFlush(scope: string, force: boolean): Promise<number> {
    let sent = 0;
    const jobs = (await this.all()).filter((job) => job.scope === scope);

    for (const queued of jobs) {
      // Re-read: a patch or removal may have happened since the snapshot.
      const job = (await this.all()).find((candidate) => candidate.id === queued.id);

      if (!job) continue;
      if (!force && job.nextAt > this.now()) continue;
      const handler = this.handlers.get(job.kind);

      if (!handler) continue;
      let result: SendResult;
      let message: string | undefined;

      try {
        result = await handler(job);
      } catch (error) {
        result = 'retry';
        message = error instanceof Error ? error.message : String(error);
      }
      if (result === 'done' || result === 'drop') {
        await this.remove(job.id);
        if (result === 'done') sent++;
        continue;
      }
      if (result === 'later') continue;
      const attempts = job.attempts + 1;

      await this.mutate((all) => ({
        jobs: all.map((other) =>
          other.id === job.id ? { ...other, attempts, nextAt: this.now() + backoffMs(attempts), lastError: message } : other,
        ),
        result: undefined,
      }));
      break;
    }

    return sent;
  }
}
