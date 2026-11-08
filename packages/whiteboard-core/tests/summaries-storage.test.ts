import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlankWhiteboardDocument, createBlankWhiteboardPage } from '../src/defaults';
import { createIndexedDbWhiteboardStorage } from '../src/storage/indexeddb';

import type { WhiteboardDocument, WhiteboardStorage, WhiteboardSummary } from '../src/types';

const DB_NAME = 'whiteboard-store';
const DOCUMENTS_STORE = 'whiteboards';
const SUMMARIES_STORE = 'whiteboardSummaries';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const OID = 'a1b2c3d4e5f60718293a4b5c';
const COVER = 'data:image/png;base64,COVER';

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Recreate a v4 database EXACTLY as the previous build left it — every v4 store, and crucially no
 * summaries store — so the backfill can be exercised against real pre-upgrade data.
 */
function openAtV4(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);

    req.onupgradeneeded = () => {
      const db = req.result;
      const documents = db.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' });

      documents.createIndex('updatedAt', 'updatedAt', { unique: false });

      const assets = db.createObjectStore('pdfAssets', { keyPath: 'id' });

      assets.createIndex('createdAt', 'createdAt', { unique: false });

      const outbox = db.createObjectStore('whiteboard-outbox', { keyPath: 'id' });

      outbox.createIndex('documentId', 'documentId', { unique: false });
      db.createObjectStore('whiteboard-outbox-payloads', { keyPath: 'id' });
      db.createObjectStore('whiteboard-sync-cursor', { keyPath: 'documentId' });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function putRaw(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');

    tx.objectStore(store).put(value as never);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteRaw(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');

    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getRaw<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);

    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();

    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

function makeBoard(
  id: string,
  { pages = 1, title = 'Algebra board', updatedAt = 1_000 }: { pages?: number; title?: string; updatedAt?: number } = {},
): WhiteboardDocument {
  const doc = createBlankWhiteboardDocument({ id, title });

  while (doc.pages.length < pages) {
    doc.pages.push(createBlankWhiteboardPage());
  }

  // Real pages carry a full Fabric JSON + a base64 thumbnail each — the payload the summaries store
  // exists to keep out of the library list.
  doc.pages = doc.pages.map((page, index) => ({
    ...page,
    canvasJSON: JSON.stringify({ objects: [{ type: 'path', path: `p${index}` }] }),
    thumbnail: `data:image/png;base64,PAGE${index}`,
  }));
  doc.thumbnail = COVER;
  doc.createdAt = 500;
  doc.updatedAt = updatedAt;

  return doc;
}

async function seedBoard(storage: WhiteboardStorage, doc: WhiteboardDocument): Promise<void> {
  await storage.saveWhiteboard(doc);
}

test('saveWhiteboard writes a summary carrying every list field and NO page content', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID, { pages: 3 });

  doc.teacherId = 'teacher-1';
  doc.teacherType = 'StudioTeacher';
  doc.teacherName = 'Jane Smith';
  await seedBoard(storage, doc);

  const db = await openRaw();
  const stored = await getRaw<WhiteboardSummary>(db, SUMMARIES_STORE, UUID);

  assert.ok(stored, 'a summary row must be written alongside the document');
  assert.deepEqual(stored, {
    id: UUID,
    title: 'Algebra board',
    createdAt: 500,
    updatedAt: 1_000,
    thumbnail: COVER,
    pageCount: 3,
    teacherId: 'teacher-1',
    teacherType: 'StudioTeacher',
    teacherName: 'Jane Smith',
  });

  // THE POINT OF THE STORE: no page array, no canvasJSON, nothing page-shaped.
  const keys = Object.keys(stored as unknown as Record<string, unknown>);

  assert.ok(!keys.includes('pages'), 'the summary must not carry pages');
  assert.ok(!keys.includes('canvasJSON'), 'the summary must not carry canvas JSON');
  assert.ok(!keys.includes('pdfImageUrl'), 'the summary must not carry pdf page images');
  db.close();

  const summaries = await storage.listWhiteboardSummaries();

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].pageCount, 3);
  storage.close();
});

test('an untagged board round-trips with the teacher fields ABSENT (never an empty tag)', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID));

  const [summary] = await storage.listWhiteboardSummaries();

  assert.equal(summary.teacherId, undefined);
  assert.equal(summary.teacherType, undefined);
  assert.equal(summary.teacherName, undefined);
  storage.close();
});

test('re-saving a board updates its summary in place (rename + page count + teacher assign)', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 2 }));

  const renamed = makeBoard(UUID, { pages: 5, title: 'Geometry board', updatedAt: 2_000 });

  renamed.teacherId = 'teacher-9';
  renamed.teacherName = 'John Doe';
  await seedBoard(storage, renamed);

  const summaries = await storage.listWhiteboardSummaries();

  assert.equal(summaries.length, 1, 're-saving must UPDATE the summary, not add a second row');
  assert.equal(summaries[0].title, 'Geometry board');
  assert.equal(summaries[0].pageCount, 5);
  assert.equal(summaries[0].updatedAt, 2_000);
  assert.equal(summaries[0].teacherId, 'teacher-9');
  assert.equal(summaries[0].teacherName, 'John Doe');
  storage.close();
});

test('deleteWhiteboard drops the summary with the document', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 2 }));
  await seedBoard(storage, makeBoard(OID, { pages: 4, title: 'Kept', updatedAt: 3_000 }));

  await storage.deleteWhiteboard(UUID);

  const db = await openRaw();

  assert.equal(await getRaw(db, SUMMARIES_STORE, UUID), undefined, 'deleted board must leave no summary');
  db.close();

  const summaries = await storage.listWhiteboardSummaries();

  assert.deepEqual(
    summaries.map((summary) => summary.id),
    [OID],
  );
  storage.close();
});

test('listWhiteboardSummaries backfills from a pre-existing v4 database on first read', async () => {
  await deleteDb();

  // Seed a REAL v4 database (no summaries store) the way the previous build would have left it.
  const v4 = await openAtV4();

  await putRaw(v4, DOCUMENTS_STORE, makeBoard(UUID, { pages: 7, title: 'Old', updatedAt: 1_000 }));
  await putRaw(v4, DOCUMENTS_STORE, makeBoard(OID, { pages: 286, title: 'Huge', updatedAt: 4_000 }));
  v4.close();

  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const summaries = await storage.listWhiteboardSummaries();

  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.title, summary.pageCount]),
    [
      [OID, 'Huge', 286],
      [UUID, 'Old', 7],
    ],
    'both v4 boards backfill, newest first, with real page counts',
  );

  // The backfill must PERSIST, so the next read is summary-only.
  const db = await openRaw();
  const rows = await getAll<WhiteboardSummary>(db, SUMMARIES_STORE);

  assert.equal(rows.length, 2);
  assert.equal((await getAll(db, DOCUMENTS_STORE)).length, 2, 'documents are untouched by the backfill');
  db.close();

  storage.close();
});

test('the reconcile repairs drift left by a build that does not maintain summaries', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 2 }));
  await seedBoard(storage, makeBoard(OID, { pages: 3, title: 'Deleted', updatedAt: 2_000 }));

  const db = await openRaw();

  // An OLD build renames + grows a board, writing ONLY the document store...
  await putRaw(db, DOCUMENTS_STORE, makeBoard(UUID, { pages: 9, title: 'Changed', updatedAt: 5_000 }));
  // ...creates a brand-new board with no summary at all...
  await putRaw(db, DOCUMENTS_STORE, makeBoard('board-3', { pages: 1, title: 'Fresh', updatedAt: 3_000 }));
  // ...and deletes one, leaving its summary orphaned.
  await deleteRaw(db, DOCUMENTS_STORE, OID);
  db.close();

  const summaries = await storage.listWhiteboardSummaries();

  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.title, summary.pageCount]),
    [
      [UUID, 'Changed', 9],
      ['board-3', 'Fresh', 1],
    ],
    'stale summary refreshed, missing summary built, orphaned summary gone',
  );

  const after = await openRaw();

  assert.equal(await getRaw(after, SUMMARIES_STORE, OID), undefined, 'the orphaned summary row is purged');
  assert.equal((await getAll(after, SUMMARIES_STORE)).length, 2);
  after.close();

  storage.close();
});

test('a second listWhiteboardSummaries returns the same list with nothing left to reconcile', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 2 }));
  await seedBoard(storage, makeBoard(OID, { pages: 3, title: 'Second', updatedAt: 2_000 }));

  const first = await storage.listWhiteboardSummaries();
  const second = await storage.listWhiteboardSummaries();

  assert.deepEqual(second, first);
  assert.deepEqual(
    second.map((summary) => summary.id),
    [OID, UUID],
    'newest first',
  );
  storage.close();
});

test('a settled list reads ZERO full documents — the whole reason the store exists', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 120 }));
  await seedBoard(storage, makeBoard(OID, { pages: 286, title: 'Huge', updatedAt: 2_000 }));

  // Let the reconcile settle first; the backfill is the one pass allowed to read documents.
  await storage.listWhiteboardSummaries();

  const originalGet = IDBObjectStore.prototype.get;
  const originalIndexCursor = IDBIndex.prototype.openCursor;
  let documentReads = 0;

  IDBObjectStore.prototype.get = function countedGet(this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    if (this.name === DOCUMENTS_STORE) {
      documentReads += 1;
    }

    return originalGet.call(this, key);
  } as typeof originalGet;

  // A VALUE cursor over the documents store deserializes every record it walks — the original bug.
  // Only a KEY cursor is allowed here.
  IDBIndex.prototype.openCursor = function countedCursor(
    this: IDBIndex,
    range?: IDBValidKey | IDBKeyRange | null,
    direction?: IDBCursorDirection,
  ) {
    if (this.objectStore.name === DOCUMENTS_STORE) {
      documentReads += 1;
    }

    return originalIndexCursor.call(this, range, direction);
  } as typeof originalIndexCursor;

  try {
    const summaries = await storage.listWhiteboardSummaries();

    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].pageCount, 286);
  } finally {
    IDBObjectStore.prototype.get = originalGet;
    IDBIndex.prototype.openCursor = originalIndexCursor;
  }

  assert.equal(documentReads, 0, 'the library list must never deserialize a board document');
  storage.close();
});

test('a settled list never takes a write lock on the documents store', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 3 }));
  await storage.listWhiteboardSummaries();

  const originalTransaction = IDBDatabase.prototype.transaction;
  const documentModes: string[] = [];

  IDBDatabase.prototype.transaction = function spiedTransaction(
    this: IDBDatabase,
    storeNames: string | string[],
    mode?: IDBTransactionMode,
  ) {
    const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);

    if (names.includes(DOCUMENTS_STORE)) {
      documentModes.push(mode ?? 'readonly');
    }

    return originalTransaction.call(this, storeNames, mode);
  } as typeof originalTransaction;

  try {
    await storage.listWhiteboardSummaries();
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }

  // A readwrite here would stall the editor's autosave every time the library refreshes.
  assert.deepEqual(documentModes, ['readonly']);
  storage.close();
});

test('loadWhiteboard refreshes a summary the document store drifted away from', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 2 }));

  const db = await openRaw();

  await putRaw(db, DOCUMENTS_STORE, makeBoard(UUID, { pages: 6, title: 'After load', updatedAt: 7_000 }));
  db.close();

  const loaded = await storage.loadWhiteboard(UUID);

  assert.equal(loaded?.pages.length, 6);

  const after = await openRaw();
  const summary = await getRaw<WhiteboardSummary>(after, SUMMARIES_STORE, UUID);

  assert.equal(summary?.title, 'After load');
  assert.equal(summary?.pageCount, 6);
  after.close();

  storage.close();
});

test('rekeyWhiteboard moves the summary from the local UUID to the server _id', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 4, title: 'Claimed' }));

  await storage.rekeyWhiteboard(UUID, OID);

  const summaries = await storage.listWhiteboardSummaries();

  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.title, summary.pageCount]),
    [[OID, 'Claimed', 4]],
  );

  const db = await openRaw();

  assert.equal(await getRaw(db, SUMMARIES_STORE, UUID), undefined, 'the local-id summary must not linger');
  db.close();

  storage.close();
});

test('rekeyWhiteboard onto an already-present _id keeps that board summary and drops the stale one', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedBoard(storage, makeBoard(UUID, { pages: 4, title: 'Local' }));
  await seedBoard(storage, makeBoard(OID, { pages: 2, title: 'Existing', updatedAt: 2_000 }));

  await storage.rekeyWhiteboard(UUID, OID);

  const summaries = await storage.listWhiteboardSummaries();

  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.title, summary.pageCount]),
    [[OID, 'Existing', 2]],
    'the existing _id summary must NOT be overwritten by the stale local board',
  );
  storage.close();
});
