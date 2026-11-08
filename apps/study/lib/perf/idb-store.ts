// IndexedDB mirror of the perf ring (database `study-perf`, store `events`, key = ring id, value = the
// event's JSON text). The in-memory index from MemoryPerfStore stays the source of truth for caps and
// batching; disk is written once per collector flush (one transaction), so nothing here runs per event.
// Any IndexedDB failure (private mode, quota, a WebView that blocks it) degrades to memory only.

import type { PerfCaps } from './store';
import type { PerfEvent } from './types';

import { DEFAULT_PERF_CAPS, MemoryPerfStore, utf8Length } from './store';

const DB_NAME = 'study-perf';
const STORE = 'events';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('perf db blocked'));
  });
}

export class IdbPerfStore extends MemoryPerfStore {
  private db: IDBDatabase | null = null;
  /** Disk writes run one after another so a delete never overtakes the put it follows. */
  private chain: Promise<void> = Promise.resolve();

  constructor(caps: PerfCaps = DEFAULT_PERF_CAPS) {
    super(caps);
  }

  /** Open the database and load what a previous session left queued. Resolves even on failure. */
  async init(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    try {
      const db = await openDb();
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const [keys, values] = await Promise.all([
        request(store.getAllKeys() as IDBRequest<IDBValidKey[]>),
        request(store.getAll() as IDBRequest<unknown[]>),
      ]);
      const entries: { id: number; bytes: number }[] = [];

      keys.forEach((key, position) => {
        const json = values[position];

        if (typeof key !== 'number' || typeof json !== 'string') return;
        this.bodies.set(key, json);
        entries.push({ id: key, bytes: utf8Length(json) });
      });
      this.index.load(entries);
      this.db = db;
      // A previous session queued more than today's caps allow (caps lowered): trim now.
      const evicted = this.index.enforce();

      if (evicted.length > 0) {
        for (const id of evicted) this.bodies.delete(id);
        await this.write((target) => {
          for (const id of evicted) target.delete(id);
        });
      }
    } catch {
      this.db = null;
    }
  }

  private write(apply: (store: IDBObjectStore) => void): Promise<void> {
    const db = this.db;

    if (!db) return Promise.resolve();
    this.chain = this.chain
      .then(async () => {
        const tx = db.transaction(STORE, 'readwrite');

        apply(tx.objectStore(STORE));
        await done(tx);
      })
      .catch(() => {
        // Disk is best-effort: memory still holds the queue for this session.
      });

    return this.chain;
  }

  override async append(events: PerfEvent[]): Promise<void> {
    const { added, evicted } = this.appendLocal(events);

    if (added.length === 0 && evicted.length === 0) return;
    await this.write((store) => {
      for (const id of evicted) store.delete(id);
      for (const entry of added) store.put(entry.json, entry.id);
    });
  }

  override async remove(ids: number[]): Promise<void> {
    await super.remove(ids);
    if (ids.length === 0) return;
    await this.write((store) => {
      for (const id of ids) store.delete(id);
    });
  }

  override async clear(): Promise<void> {
    await super.clear();
    await this.write((store) => store.clear());
  }
}
