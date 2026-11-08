// A tiny async key → value store on IndexedDB (database `study-offline`, store `kv`) for the offline
// layer: the saved query cache and the outbox. Values are structured-cloned (plain JSON objects here).
// Any IndexedDB failure (private mode, a WebView that blocks it) degrades to an in-memory map, so the
// app keeps working for the session — it just forgets on restart.

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const DB_NAME = 'study-offline';
const STORE = 'kv';

export function createMemoryKv(): KvStore {
  const map = new Map<string, unknown>();

  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => {
      map.set(key, value);
    },
    del: async (key) => {
      map.delete(key);
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);

    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('offline db blocked'));
  });
}

/** IndexedDB-backed store; falls back to memory when IndexedDB is missing or refuses to open. */
export function createIdbKv(factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): KvStore {
  const memory = createMemoryKv();
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  const db = () => {
    dbPromise ??= factory ? openDb(factory).catch(() => null) : Promise.resolve(null);

    return dbPromise;
  };
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => {
    const handle = await db();

    if (!handle) return null;
    const tx = handle.transaction(STORE, mode);

    return request(fn(tx.objectStore(STORE)));
  };

  return {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const handle = await db();

        if (!handle) return memory.get<T>(key);

        return ((await run('readonly', (store) => store.get(key))) ?? undefined) as T | undefined;
      } catch {
        return memory.get<T>(key);
      }
    },
    async set(key, value) {
      try {
        const handle = await db();

        if (!handle) return memory.set(key, value);
        await run('readwrite', (store) => store.put(value, key));
      } catch {
        await memory.set(key, value);
      }
    },
    async del(key) {
      await memory.del(key);
      try {
        await run('readwrite', (store) => store.delete(key));
      } catch {
        // nothing stored there
      }
    },
  };
}

let shared: KvStore | null = null;

/** The app's one offline store (lazily opened on first use). */
export function offlineKv(): KvStore {
  shared ??= createIdbKv();

  return shared;
}
