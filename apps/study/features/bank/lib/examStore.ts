/**
 * In-progress exam answers survive an app kill: every change is written to IndexedDB (keyed by
 * exam id) and the runner restores them when the same exam is opened again. Everything is wrapped so
 * a missing / blocked IndexedDB (private mode, thumbnail capture) degrades to "no persistence",
 * never to a crash.
 */

import type { InkStroke } from './ink';

export interface ExamDraft {
  strokes: InkStroke[];
  typed: string;
  choice: number | null;
  /** `matching` — left → chosen right. Optional: drafts saved before the type existed lack it. */
  matches?: Record<string, string>;
  /** `fill_blank` — one entry per blank. */
  blanks?: string[];
}

export const EMPTY_DRAFT: ExamDraft = { strokes: [], typed: '', choice: null };

export interface StoredExam {
  examId: string;
  classId: string;
  drafts: Record<string, ExamDraft>;
  /** Question index the student was on. */
  index: number;
  /** Epoch ms; lets the setup screen drop stale entries without a network call. */
  deadline: number;
  savedAt: number;
}

const DB_NAME = 'study-bank';
const STORE = 'examDrafts';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = indexedDB.open(DB_NAME, VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;

          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'examId' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);

          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const request = op(tx.objectStore(STORE));

          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export const saveExamDraft = (entry: StoredExam): Promise<unknown> => run('readwrite', (store) => store.put(entry));

export const loadExamDraft = (examId: string): Promise<StoredExam | null> =>
  run<StoredExam | undefined>('readonly', (store) => store.get(examId)).then((value) => value ?? null);

export const deleteExamDraft = (examId: string): Promise<unknown> => run('readwrite', (store) => store.delete(examId));

export const listExamDrafts = (): Promise<StoredExam[]> =>
  run<StoredExam[]>('readonly', (store) => store.getAll()).then((value) => value ?? []);

/** Coalesces rapid saves (every pen stroke) into one write per `delayMs`. */
export function createDraftSaver(delayMs = 800) {
  let pending: StoredExam | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (!pending) return;
    const entry = pending;

    pending = null;
    void saveExamDraft(entry);
  };

  return {
    save(entry: StoredExam) {
      pending = entry;
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
