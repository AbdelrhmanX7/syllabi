// Live co-editing of a notebook page (sharing phase 2 part B): the owner and the people they invited to
// edit see each other's ink within a second or two, and nobody is ever asked "keep mine / keep theirs".
//
// The device keeps a BASE: one stored version of the page (number + board). Its own changes are the
// difference between the board on screen and that base (live-merge.ts), sent in small batches a moment
// after each stroke ends. The server applies them to its current version and answers `{prevVersion,
// version}`; everyone else on the page gets the same ops over the stream as `{prevVersion, version, ops}`.
//   - An event or answer that continues the base (`prevVersion === base.version`) moves the base along.
//   - Anything else (a gap, a whole-board save, ops too big to send) re-reads the page: the base becomes
//     the server's board and what changed since the old base is put onto the screen.
// Someone else's change never overwrites an item this device changed and has not sent yet: that item
// goes out with the next batch and, arriving later, wins.

import type { BoardDoc, LiveOps } from './live-merge';

import { applyOps, diffDocs, ensureDocIds, itemIdOf } from './live-merge';

export interface LivePerson {
  clientId: string;
  userId: string;
  name: string;
}

export interface LiveOpsEvent {
  prevVersion: number;
  version: number;
  ops: LiveOps | null;
  by: LivePerson;
}

export interface LiveStreamHandlers {
  onHello: (version: number, people: LivePerson[]) => void;
  onPeople: (people: LivePerson[]) => void;
  onOps: (event: LiveOpsEvent) => void;
}

export interface LiveBase {
  version: number;
  doc: BoardDoc;
}

export type LiveStatus = 'connecting' | 'live' | 'sending' | 'offline' | 'revoked' | 'error';

export interface LiveSessionDeps {
  pageId: string;
  clientId: string;
  /** The board on screen right now; null while the editor is not mounted. */
  getLocal: () => BoardDoc | null;
  /** Put someone else's ops on the screen. False = could not; the host reloads the board with them. */
  applyRemote: (ops: LiveOps) => Promise<boolean>;
  push: (ops: LiveOps) => Promise<{ prevVersion: number; version: number }>;
  fetchLatest: () => Promise<{ version: number; doc: BoardDoc | null }>;
  /** An earlier stored version (null = gone). Used once when the page opened offline, without a base. */
  fetchVersion?: (version: number) => Promise<BoardDoc | null>;
  /** The version this device last had, when it opened without a base (offline). */
  lastVersion?: number | null;
  openStream: (handlers: LiveStreamHandlers, signal: AbortSignal) => Promise<void>;
  onPeople?: (people: LivePerson[]) => void;
  onStatus?: (status: LiveStatus, detail?: string) => void;
  /** The base moved (to remember which version this device has, and whether it still has unsent changes). */
  onSynced?: (version: number, dirty: boolean) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A batch goes out this long after the last stroke ends (strokes finished meanwhile ride along). */
export const BATCH_MS = 300;
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 20_000];
const STREAM_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export const emptyBoard = (pageId: string): BoardDoc => ({ id: pageId, title: '', pages: [], currentPageIndex: 0 });

const errorStatus = (error: unknown) => (error as { status?: number } | null)?.status;
const errorCode = (error: unknown) => (error as { code?: string } | null)?.code;

function hasItem(doc: BoardDoc, pageId: string, id: string | null): boolean {
  if (!id) return false;
  const page = doc.pages.find((candidate) => candidate.id === pageId);

  if (!page || typeof page.canvasJSON !== 'string') return false;

  return page.canvasJSON.includes(`"oid":${JSON.stringify(id)}`);
}

/** Items (page + id) and pages `pending` touches: someone else's change to them waits for ours. */
function touched(pending: LiveOps | null): { items: Set<string>; pages: Set<string> } {
  const items = new Set<string>();
  const pages = new Set<string>();

  for (const op of pending?.items ?? []) {
    for (const item of op.put ?? []) items.add(`${op.page}\n${itemIdOf(item)}`);
    for (const id of op.del ?? []) items.add(`${op.page}\n${id}`);
  }
  for (const page of pending?.pages ?? []) pages.add(String(page.id));
  for (const id of pending?.removedPages ?? []) pages.add(id);

  return { items, pages };
}

/** `ops` without the parts that would overwrite this device's unsent changes. */
export function withoutPending(ops: LiveOps, pending: LiveOps | null): LiveOps | null {
  if (!pending) return ops;
  const mine = touched(pending);
  const out: LiveOps = {};
  const items = (ops.items ?? [])
    .map((op) => ({
      page: op.page,
      ...(op.put ? { put: op.put.filter((item) => !mine.items.has(`${op.page}\n${itemIdOf(item)}`)) } : {}),
      ...(op.del ? { del: op.del.filter((id) => !mine.items.has(`${op.page}\n${id}`)) } : {}),
    }))
    .filter((op) => (op.put?.length ?? 0) + (op.del?.length ?? 0) > 0);
  const pages = (ops.pages ?? []).filter((page) => !mine.pages.has(String(page.id)));

  if (items.length) out.items = items;
  if (pages.length) out.pages = pages;
  if (ops.removedPages?.length) out.removedPages = ops.removedPages;
  if (ops.order && !pending.order) out.order = ops.order;

  return Object.keys(out).length ? out : null;
}

export class LiveSession {
  private base: LiveBase | null;
  private readonly deps: LiveSessionDeps;
  private readonly abort = new AbortController();
  /** Every base change runs here, one after another (events, answers, re-reads). */
  private chain: Promise<unknown> = Promise.resolve();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private again = false;
  private localDirty = false;
  /** Bumped on every local change: a change made while a batch was out keeps the board dirty. */
  private changes = 0;
  private retry = 0;
  private status: LiveStatus = 'connecting';

  constructor(deps: LiveSessionDeps, base: LiveBase | null) {
    this.deps = deps;
    this.base = base;
  }

  get version(): number | null {
    return this.base?.version ?? null;
  }

  start(): void {
    void this.streamLoop();
    // Whatever was left unsent (offline edits merged at open) goes out now.
    this.noteLocalChange();
  }

  stop(): void {
    this.abort.abort();
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
  }

  private get stopped() {
    return this.abort.signal.aborted;
  }

  private setStatus(status: LiveStatus, detail?: string) {
    if (this.stopped && status !== 'revoked') return;
    this.status = status;
    this.deps.onStatus?.(status, detail);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);

    this.chain = run.catch(() => undefined);

    return run;
  }

  private sleep(ms: number) {
    if (this.deps.sleep) return this.deps.sleep(ms, this.abort.signal);

    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);

      this.abort.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }

  /** The user changed the board: send the difference shortly. */
  noteLocalChange(): void {
    if (this.stopped) return;
    this.localDirty = true;
    this.changes += 1;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.flush();
    }, BATCH_MS);
  }

  /** Send now (leaving the page); resolves once nothing is left unsent or sending failed. */
  async flushNow(): Promise<void> {
    // A batch already out finishes first; strokes made meanwhile then go too (a few tries, never forever).
    for (let attempt = 0; attempt < 4 && !this.stopped; attempt += 1) {
      if (this.batchTimer) clearTimeout(this.batchTimer);
      this.batchTimer = null;
      if (this.sending) {
        await this.chain;
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      await this.flush();
      if (!this.localDirty) break;
    }
    await this.chain;
  }

  /** What the screen has that `from` (default: the base) does not: this device's unsent changes. */
  private pending(from: BoardDoc | null = this.base?.doc ?? null): LiveOps | null {
    const local = this.deps.getLocal();

    if (!local || !from) return null;

    return diffDocs(from, ensureDocIds(local));
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.status === 'revoked') return;
    if (this.sending) {
      this.again = true;

      return;
    }
    this.sending = true;
    try {
      await this.enqueue(async () => {
        if (!this.base) await this.resync();
        if (!this.base) return;
        if (!this.deps.getLocal()) {
          // The editor is not up yet (opening, or reloading): try again shortly, still dirty.
          if (this.localDirty && !this.stopped) this.batchTimer = setTimeout(() => void this.flush(), 1_500);

          return;
        }
        const changesAtStart = this.changes;
        const ops = this.pending();

        if (!ops) {
          this.localDirty = false;
          this.deps.onSynced?.(this.base.version, false);

          return;
        }
        this.setStatus('sending');
        // Events wait behind this task in the chain, so the base cannot move while the batch is out.
        const sentFrom = this.base;
        const answer = await this.deps.push(ops);
        const known = applyOps(sentFrom.doc, ops);

        this.retry = 0;
        if (answer.prevVersion === sentFrom.version) this.base = { version: answer.version, doc: known };
        // Someone else's change landed between the base we had and ours: re-read (theirs go on screen).
        else await this.resync(known);
        this.localDirty = this.changes !== changesAtStart;
        this.deps.onSynced?.(this.base!.version, this.localDirty);
        this.setStatus('live');
      });
    } catch (error) {
      if (errorStatus(error) === 404 || errorStatus(error) === 403) {
        this.setStatus('revoked');
        this.stop();
      } else {
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

        this.setStatus(offline ? 'offline' : 'error', error instanceof Error ? error.message : String(error));
        this.deps.onSynced?.(this.base?.version ?? 0, true);
        const wait = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];

        this.retry += 1;
        if (!this.stopped) this.batchTimer = setTimeout(() => void this.flush(), wait);
      }
    } finally {
      this.sending = false;
      if (this.again && !this.stopped) {
        this.again = false;
        this.noteLocalChange();
      }
    }
  }

  /**
   * Re-read the server's board and put what changed since `known` (default: the base) on the screen.
   * `known` is the base plus our own just-sent ops when called after a push.
   */
  private async resync(known?: BoardDoc): Promise<void> {
    if (!this.base && !known) return this.firstSync();
    const latest = await this.deps.fetchLatest();
    const before = known ?? this.base?.doc ?? null;
    const doc = latest.doc ?? emptyBoard(this.deps.pageId);
    const remote = before ? diffDocs(before, doc) : null;
    const pending = remote && this.localDirty ? this.pending(before) : null;

    this.base = { version: latest.version, doc };
    if (remote) await this.putOnScreen(remote, pending);
  }

  /**
   * Opened offline, so no base: catch up against the version this device last had (three-way), or, when
   * that is gone, keep both sides (add what the server has that the screen lacks, delete nothing).
   */
  private async firstSync(): Promise<void> {
    const latest = await this.deps.fetchLatest();
    const doc = latest.doc ?? emptyBoard(this.deps.pageId);
    const last = this.deps.lastVersion ?? 0;
    const before = last > 0 && this.deps.fetchVersion ? await this.deps.fetchVersion(last).catch(() => null) : null;
    const local = this.deps.getLocal();

    this.base = { version: latest.version, doc };
    if (before) {
      const remote = diffDocs(before, doc);

      if (remote) await this.putOnScreen(remote, this.pending(before));

      return;
    }
    if (!local) return;
    const missing = diffDocs(ensureDocIds(local), doc);
    const mine = new Set(ensureDocIds(local).pages.map((page) => page.id));
    const add: LiveOps = {};
    const items = (missing?.items ?? []).filter((op) => op.put?.length).map((op) => ({ page: op.page, put: op.put }));
    const pages = (missing?.pages ?? []).filter((page) => !mine.has(String(page.id)));

    if (items.length) add.items = items;
    if (pages.length) {
      add.pages = pages;
      add.order = doc.pages.map((page) => page.id);
    }
    // Items on both with different content stay mine: they go out next and win.
    const both = (op: { page: string; put?: Record<string, unknown>[] }) => ({
      page: op.page,
      put: (op.put ?? []).filter((item) => !hasItem(local, op.page, itemIdOf(item))),
    });

    if (add.items) add.items = add.items.map(both).filter((op) => op.put.length);
    if (add.items?.length || add.pages) await this.deps.applyRemote(add);
  }

  /** `pending` = this device's unsent changes, measured against the base BEFORE `ops` moved it. */
  private async putOnScreen(ops: LiveOps, pending: LiveOps | null): Promise<void> {
    const visible = withoutPending(ops, pending);

    if (visible) await this.deps.applyRemote(visible);
  }

  private onOps(event: LiveOpsEvent): Promise<void> {
    return this.enqueue(async () => {
      if (event.by?.clientId === this.deps.clientId) return;
      if (this.base && event.version <= this.base.version) return;
      if (this.base && event.ops && event.prevVersion === this.base.version) {
        const pending = this.localDirty ? this.pending() : null;

        this.base = { version: event.version, doc: applyOps(this.base.doc, event.ops) };
        await this.putOnScreen(event.ops, pending);
      } else {
        await this.resync();
      }
      this.deps.onSynced?.(this.base!.version, this.localDirty);
    }).catch(() => undefined);
  }

  private async streamLoop(): Promise<void> {
    let attempt = 0;

    while (!this.stopped) {
      this.setStatus(this.status === 'sending' ? 'sending' : 'connecting');
      try {
        await this.deps.openStream(
          {
            onHello: (version, people) => {
              attempt = 0;
              this.deps.onPeople?.(people);
              if (this.status !== 'sending') this.setStatus('live');
              // Missed something while away (or never had a base): catch up.
              if (!this.base || version !== this.base.version) void this.enqueue(() => this.resync()).catch(() => undefined);
            },
            onPeople: (people) => this.deps.onPeople?.(people),
            onOps: (event) => void this.onOps(event),
          },
          this.abort.signal,
        );
      } catch (error) {
        if (this.stopped) return;
        const status = errorStatus(error);

        if (errorCode(error) === 'ACCESS_REVOKED' || status === 404 || status === 403 || status === 401) {
          this.setStatus('revoked', error instanceof Error ? error.message : undefined);
          this.stop();

          return;
        }
      }
      if (this.stopped) return;
      this.deps.onPeople?.([]);
      this.setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connecting');
      await this.sleep(STREAM_BACKOFF_MS[Math.min(attempt, STREAM_BACKOFF_MS.length - 1)]);
      attempt += 1;
    }
  }
}

/** "Maya is here too" / "Maya and Sam are here too" / "Maya and 2 others are here too"; null alone. */
export function presenceLine(people: LivePerson[], me: { clientId: string; userId?: string | null }): string | null {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const person of people) {
    if (person.clientId === me.clientId) continue;
    // My own other device counts as someone else only when it is another account.
    if (me.userId && person.userId === me.userId) continue;
    if (seen.has(person.userId)) continue;
    seen.add(person.userId);
    names.push((person.name || 'Someone').split(' ')[0] || 'Someone');
  }
  if (!names.length) return null;
  if (names.length === 1) return `${names[0]} is here too`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here too`;

  return `${names[0]} and ${names.length - 1} others are here too`;
}
