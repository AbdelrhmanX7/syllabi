/**
 * The glyph bank's persistence: an IndexedDB copy per user on this device (`study-glyph-bank`), and
 * an optional remote the host app injects through `BoardAiService` (`getGlyphBank` / `putGlyphBank`,
 * i.e. GET/PUT /study/handwriting/bank). Every accepted cell is written locally at once; the remote is
 * pushed after a short debounce with the server's version as the expected one. A conflict (someone
 * else wrote first) re-fetches, re-merges the samples (`merge.ts`) and tries again. A remote that
 * answers «no such route» puts the store in local-only mode until the next load.
 */
import type { GlyphBank, GlyphKey, GlyphSample } from './types';

import {
  addSampleToBank,
  bankSampleCount,
  clearedBank,
  mergeGlyphBanks,
  removeGlyphFromBank,
  sameBankContent,
} from './merge';
import { EMPTY_GLYPH_BANK } from './types';

// ---------------------------------------------------------------------------
// Remote
// ---------------------------------------------------------------------------

/** The server's copy: the bank plus the version the next PUT must name. */
export interface GlyphBankRemoteSnapshot {
  bank: GlyphBank;
  version: number;
}

/**
 * What the host app's transport implements. `getGlyphBank` resolves null when the user has no bank
 * yet; both throw {@link GlyphBankUnavailableError} when the route does not exist (local-only mode)
 * and `putGlyphBank` throws {@link GlyphBankConflictError} when `version` is no longer the server's.
 */
export interface GlyphBankRemote {
  getGlyphBank(signal?: AbortSignal): Promise<GlyphBankRemoteSnapshot | null>;
  putGlyphBank(bank: GlyphBank, version: number, signal?: AbortSignal): Promise<GlyphBankRemoteSnapshot>;
}

export class GlyphBankConflictError extends Error {
  constructor(
    /** The server's current copy when the 409 body carried it; null = fetch it again. */
    readonly current: GlyphBankRemoteSnapshot | null = null,
  ) {
    super('glyph bank version conflict');
    this.name = 'GlyphBankConflictError';
  }
}

export class GlyphBankUnavailableError extends Error {
  constructor() {
    super('glyph bank route unavailable');
    this.name = 'GlyphBankUnavailableError';
  }
}

/** The optional methods of a `BoardAiService`, as a remote — null when the service has neither. */
export function glyphBankRemoteFrom(service: Partial<GlyphBankRemote> | null | undefined): GlyphBankRemote | null {
  if (!service?.getGlyphBank || !service.putGlyphBank) return null;

  return {
    getGlyphBank: (signal) => service.getGlyphBank!(signal),
    putGlyphBank: (bank, version, signal) => service.putGlyphBank!(bank, version, signal),
  };
}

// ---------------------------------------------------------------------------
// Local (IndexedDB)
// ---------------------------------------------------------------------------

export const GLYPH_BANK_DB_NAME = 'study-glyph-bank';
export const GLYPH_BANK_STORE_NAME = 'banks';
const DB_VERSION = 1;

/** One row per user: the bank on this device plus the server state it was last synced to. */
export interface GlyphBankRecord {
  userId: string;
  bank: GlyphBank;
  /** The remote copy this device last saw — the three-way merge base and the next PUT's version. */
  synced: GlyphBankRemoteSnapshot | null;
}

export interface GlyphBankLocal {
  load(userId: string): Promise<GlyphBankRecord | null>;
  save(record: GlyphBankRecord): Promise<void>;
  remove(userId: string): Promise<void>;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** The IndexedDB adapter. `factory` is injectable so tests can hand in fake-indexeddb. */
export function createIndexedDbGlyphBankLocal(
  factory: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB,
  dbName = GLYPH_BANK_DB_NAME,
): GlyphBankLocal {
  if (!factory) return createMemoryGlyphBankLocal();
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise((resolve, reject) => {
      const request = factory.open(dbName, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(GLYPH_BANK_STORE_NAME)) {
          db.createObjectStore(GLYPH_BANK_STORE_NAME, { keyPath: 'userId' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;

        // Another tab upgraded the schema: drop this handle so the next call reopens.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
    });

    return dbPromise;
  };

  return {
    async load(userId) {
      const db = await open();
      const store = db.transaction(GLYPH_BANK_STORE_NAME, 'readonly').objectStore(GLYPH_BANK_STORE_NAME);
      const record = (await requestToPromise(store.get(userId))) as GlyphBankRecord | undefined;

      return record ?? null;
    },
    async save(record) {
      const db = await open();
      const transaction = db.transaction(GLYPH_BANK_STORE_NAME, 'readwrite');

      transaction.objectStore(GLYPH_BANK_STORE_NAME).put(record);
      await transactionDone(transaction);
    },
    async remove(userId) {
      const db = await open();
      const transaction = db.transaction(GLYPH_BANK_STORE_NAME, 'readwrite');

      transaction.objectStore(GLYPH_BANK_STORE_NAME).delete(userId);
      await transactionDone(transaction);
    },
  };
}

/** In-memory adapter: SSR, a browser without IndexedDB, and tests. */
export function createMemoryGlyphBankLocal(): GlyphBankLocal {
  const rows = new Map<string, GlyphBankRecord>();

  return {
    load: async (userId) => rows.get(userId) ?? null,
    save: async (record) => {
      rows.set(record.userId, record);
    },
    remove: async (userId) => {
      rows.delete(userId);
    },
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type GlyphBankRemoteStatus = 'idle' | 'syncing' | 'synced' | 'local-only' | 'error';

export interface GlyphBankState {
  /** `loading` until the local copy was read. */
  status: 'loading' | 'ready';
  bank: GlyphBank;
  remote: GlyphBankRemoteStatus;
  /** Last remote failure, for the UI; cleared by the next successful sync. */
  error: string | null;
}

export interface GlyphBankStoreOptions {
  userId: string;
  local: GlyphBankLocal;
  remote?: GlyphBankRemote | null;
  /** Wait after the last local write before the PUT goes out. */
  pushDebounceMs?: number;
  /** How many conflict rounds a push survives before giving up until the next write. */
  maxConflictRetries?: number;
  now?: () => number;
}

const INITIAL_STATE: GlyphBankState = { status: 'loading', bank: EMPTY_GLYPH_BANK, remote: 'idle', error: null };

export class GlyphBankStore {
  private state: GlyphBankState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private record: GlyphBankRecord;
  private readonly remote: GlyphBankRemote | null;
  private readonly local: GlyphBankLocal;
  private readonly pushDebounceMs: number;
  private readonly maxConflictRetries: number;
  private readonly now: () => number;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing: Promise<void> | null = null;
  private dirtySinceSync = false;
  private disposed = false;
  private loaded: Promise<void> | null = null;

  constructor(options: GlyphBankStoreOptions) {
    this.record = { userId: options.userId, bank: EMPTY_GLYPH_BANK, synced: null };
    this.local = options.local;
    this.remote = options.remote ?? null;
    this.pushDebounceMs = options.pushDebounceMs ?? 1_500;
    this.maxConflictRetries = options.maxConflictRetries ?? 3;
    this.now = options.now ?? Date.now;
  }

  getState(): GlyphBankState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<GlyphBankState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** Read the device copy, then (once) pull and merge the remote. Safe to call more than once. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const record = await this.local.load(this.record.userId);

        if (record) this.record = record;
      } catch {
        // an unreadable store starts empty; the first accept rewrites it
      }
      if (this.disposed) return;
      this.setState({ status: 'ready', bank: this.record.bank });
      if (this.remote) void this.sync();
    })();

    return this.loaded;
  }

  async addSample(key: GlyphKey, sample: GlyphSample): Promise<void> {
    await this.write(addSampleToBank(this.record.bank, key, sample, { now: this.now() }));
  }

  async removeGlyph(key: GlyphKey): Promise<void> {
    await this.write(removeGlyphFromBank(this.record.bank, key, this.now()));
  }

  async clear(): Promise<void> {
    await this.write(clearedBank(this.record.bank, this.now()));
  }

  private async write(bank: GlyphBank): Promise<void> {
    this.record = { ...this.record, bank };
    this.dirtySinceSync = true;
    this.setState({ bank });
    await this.persist();
    this.schedulePush();
  }

  private async persist(): Promise<void> {
    try {
      await this.local.save(this.record);
    } catch {
      // quota / private mode — the bank still lives in memory for this session
    }
  }

  private schedulePush(): void {
    if (!this.remote || this.state.remote === 'local-only') return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.sync();
    }, this.pushDebounceMs);
  }

  /**
   * Pull → three-way merge → push when the merge differs from the server's copy. Conflicts loop with
   * a fresh pull; «no route» flips to local-only. Concurrent calls share one run; a write during the
   * run queues another.
   */
  sync(): Promise<void> {
    if (!this.remote || this.disposed) return Promise.resolve();
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSync().finally(() => {
      this.syncing = null;
      if (this.dirtySinceSync && this.state.remote !== 'local-only' && !this.disposed) this.schedulePush();
    });

    return this.syncing;
  }

  /** Push whatever is pending now (the page is closing). */
  async flush(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.sync();
  }

  private async runSync(): Promise<void> {
    const remote = this.remote!;

    this.setState({ remote: 'syncing' });
    this.dirtySinceSync = false;

    try {
      let server = await remote.getGlyphBank();

      for (let attempt = 0; ; attempt++) {
        const base = this.record.synced?.bank ?? null;
        const localBefore = this.record.bank;
        const serverBank = server?.bank ?? EMPTY_GLYPH_BANK;
        const merged = mergeGlyphBanks(localBefore, serverBank, base);
        const expectedVersion = server?.version ?? 0;
        // A write that landed while the request was in flight is folded back in, never overwritten.
        const settle = (saved: GlyphBankRemoteSnapshot) => {
          const bank = this.record.bank === localBefore ? merged : mergeGlyphBanks(this.record.bank, saved.bank, base);

          this.record = {
            ...this.record,
            bank: { ...bank, version: Math.max(bank.version, saved.version) },
            synced: saved,
          };
        };

        if (server ? sameBankContent(merged, serverBank) : bankSampleCount(merged) === 0) {
          // Nothing of ours to send; the server copy (or «no bank yet») is the new base.
          if (server) settle(server);
          break;
        }

        try {
          settle(await remote.putGlyphBank(merged, expectedVersion));
          break;
        } catch (error) {
          if (!(error instanceof GlyphBankConflictError) || attempt >= this.maxConflictRetries) throw error;
          server = error.current ?? (await remote.getGlyphBank());
        }
      }

      if (this.disposed) return;
      this.setState({ bank: this.record.bank, remote: 'synced', error: null });
      await this.persist();
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof GlyphBankUnavailableError) {
        this.setState({ remote: 'local-only', error: null });

        return;
      }
      this.dirtySinceSync = true;
      this.setState({ remote: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.listeners.clear();
  }
}
