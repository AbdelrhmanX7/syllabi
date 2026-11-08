import type { ChunkStore, LectureSession, PendingChunk } from './chunkQueue';

const DB_NAME = 'study-lectures';
const DB_VERSION = 1;
const CHUNKS = 'chunks';
const SESSIONS = 'sessions';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB-backed {@link ChunkStore}: audio blobs survive a crash or an app kill. */
export function createIdbChunkStore(factory: IDBFactory = indexedDB): ChunkStore {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const db = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(DB_NAME, DB_VERSION);

      open.onupgradeneeded = () => {
        const database = open.result;

        if (!database.objectStoreNames.contains(CHUNKS)) {
          database.createObjectStore(CHUNKS, { keyPath: ['lectureId', 'index'] });
        }
        if (!database.objectStoreNames.contains(SESSIONS)) {
          database.createObjectStore(SESSIONS, { keyPath: 'lectureId' });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => {
        dbPromise = null;
        reject(open.error);
      };
    });

    return dbPromise;
  };

  const run = async <T>(name: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) => {
    const tx = (await db()).transaction(name, mode);
    const result = await request(fn(tx.objectStore(name)));

    if (mode === 'readwrite') {
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }

    return result;
  };

  return {
    putChunk: async (chunk: PendingChunk) => void (await run(CHUNKS, 'readwrite', (s) => s.put(chunk))),
    listChunks: () => run(CHUNKS, 'readonly', (s) => s.getAll() as IDBRequest<PendingChunk[]>),
    deleteChunk: async (lectureId, index) => void (await run(CHUNKS, 'readwrite', (s) => s.delete([lectureId, index]))),
    putSession: async (session: LectureSession) => void (await run(SESSIONS, 'readwrite', (s) => s.put(session))),
    getSession: async (lectureId) =>
      ((await run(SESSIONS, 'readonly', (s) => s.get(lectureId))) as LectureSession | undefined) ?? null,
    listSessions: () => run(SESSIONS, 'readonly', (s) => s.getAll() as IDBRequest<LectureSession[]>),
    deleteSession: async (lectureId) => void (await run(SESSIONS, 'readwrite', (s) => s.delete(lectureId))),
  };
}
