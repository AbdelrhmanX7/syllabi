import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlankWhiteboardDocument, createBlankWhiteboardPage } from '../src/defaults';
import { createIndexedDbWhiteboardStorage } from '../src/storage/indexeddb';

import type { WhiteboardDocument, WhiteboardPage } from '../src/types';

const DB_NAME = 'whiteboard-store';
const DOCUMENTS_STORE = 'whiteboards';
const SUMMARIES_STORE = 'whiteboardSummaries';
const PAGES_STORE = 'whiteboardPages';
const JOURNAL_STORE = 'whiteboardPageJournal';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const OID = 'a1b2c3d4e5f60718293a4b5c';

interface PageRow {
  key: string;
  documentId: string;
  pageId: string;
  page: WhiteboardPage;
  updatedAt: number;
}

/** The on-disk record as it looks after the split — pages replaced by their order + asset ids. */
interface StoredRecord {
  id: string;
  updatedAt: number;
  pageIds?: string[];
  pdfAssetIds?: string[];
  pages?: WhiteboardPage[];
}

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

/** Recreate a v5 database EXACTLY as that build left it: no journal store and no page store. */
function openAtV5(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 5);

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

      const summaries = db.createObjectStore(SUMMARIES_STORE, { keyPath: 'id' });

      summaries.createIndex('updatedAt', 'updatedAt', { unique: false });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** A v6 database: everything v5 had, plus the page journal that v7 supersedes. */
function openAtV6(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 6);

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

      const summaries = db.createObjectStore(SUMMARIES_STORE, { keyPath: 'id' });

      summaries.createIndex('updatedAt', 'updatedAt', { unique: false });

      const journal = db.createObjectStore(JOURNAL_STORE, { keyPath: 'key' });

      journal.createIndex('documentId', 'documentId', { unique: false });
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

function getRaw<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);

    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function getAllRaw<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();

    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

function countByIndex(db: IDBDatabase, store: string, indexName: string, value: IDBValidKey): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).index(indexName).count(IDBKeyRange.only(value));

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Every raw read below opens and CLOSES its own connection. A leaked connection blocks the next
 * test's deleteDatabase (and its version upgrade) forever, which is a hang, not a failure.
 */
async function readRow<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openRaw();
  const row = await getRaw<T>(db, store, key);

  db.close();

  return row;
}

async function readAll<T>(store: string): Promise<T[]> {
  const db = await openRaw();
  const rows = await getAllRaw<T>(db, store);

  db.close();

  return rows;
}

async function readPageRowCount(documentId: string): Promise<number> {
  const db = await openRaw();
  const count = await countByIndex(db, PAGES_STORE, 'documentId', documentId);

  db.close();

  return count;
}

async function readStoreNames(): Promise<string[]> {
  const db = await openRaw();
  const names = Array.from(db.objectStoreNames);

  db.close();

  return names;
}

function makeBoard(id: string, pageCount = 3, updatedAt = 1_000): WhiteboardDocument {
  const doc = createBlankWhiteboardDocument({ id, title: 'Algebra board' });

  while (doc.pages.length < pageCount) {
    doc.pages.push(createBlankWhiteboardPage());
  }

  doc.pages = doc.pages.map((page, index) => ({
    ...page,
    canvasJSON: JSON.stringify({ objects: [{ type: 'path', path: `p${index}` }] }),
    thumbnail: `data:image/png;base64,PAGE${index}`,
  }));
  doc.createdAt = 500;
  doc.updatedAt = updatedAt;

  return doc;
}

/** The page the teacher just wrote on: same id, new ink. */
function inked(page: WhiteboardPage, ink: string): WhiteboardPage {
  return { ...page, canvasJSON: JSON.stringify({ objects: [{ type: 'path', path: ink }] }) };
}

function ids(doc: WhiteboardDocument): string[] {
  return doc.pages.map((page) => page.id);
}

test('a save writes the pages into their own store and leaves no pages in the document record', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);

  await storage.saveWhiteboard(doc);

  const record = await readRow<StoredRecord>(DOCUMENTS_STORE, UUID);

  assert.equal(record?.pages, undefined, 'page content must not live in the document record');
  assert.deepEqual(record?.pageIds, ids(doc), 'the record keeps the page ORDER');
  assert.equal(await readPageRowCount(UUID), 3);

  const loaded = await storage.loadWhiteboard(UUID);

  assert.deepEqual(
    loaded?.pages.map((page) => page.canvasJSON),
    doc.pages.map((page) => page.canvasJSON),
  );
  assert.equal(loaded?.title, 'Algebra board');
  assert.equal(loaded?.updatedAt, 1_000);
  storage.close();
});

test('changedPageIds writes ONLY the listed pages — an unlisted edit never reaches disk', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);

  await storage.saveWhiteboard(doc);

  // The caller edits page 0 AND page 1 but only declares page 0. The promise `changedPageIds` makes
  // is that every unlisted page is already on disk unchanged; cheating on it is the only way to
  // PROVE the save is O(k) rather than O(N) — an unlisted page that still changed on disk would
  // mean every page was rewritten.
  const cheated: WhiteboardDocument = {
    ...doc,
    pages: [inked(doc.pages[0], 'LISTED'), inked(doc.pages[1], 'CHEATED'), doc.pages[2]],
    updatedAt: 2_000,
  };

  await storage.saveWhiteboard(cheated, { changedPageIds: [doc.pages[0].id] });

  const loaded = await storage.loadWhiteboard(UUID);

  assert.ok(loaded?.pages[0].canvasJSON.includes('LISTED'), 'the declared page is written');
  assert.equal(loaded?.pages[1].canvasJSON, doc.pages[1].canvasJSON, 'the undeclared page was NOT rewritten');
  assert.equal(loaded?.pages[2].canvasJSON, doc.pages[2].canvasJSON);
  assert.equal(loaded?.updatedAt, 2_000, 'the meta record is always written');
  assert.equal(await readPageRowCount(UUID), 3);
  storage.close();
});

test('an id in changedPageIds that the document no longer has is ignored', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);

  await storage.saveWhiteboard(doc);
  await storage.saveWhiteboard({ ...doc, updatedAt: 3_000 }, { changedPageIds: ['a-page-that-is-gone'] });

  const loaded = await storage.loadWhiteboard(UUID);

  assert.equal(loaded?.pages.length, 3);
  assert.equal(loaded?.updatedAt, 3_000);
  assert.equal(await readPageRowCount(UUID), 3);
  storage.close();
});

test('a page added with changedPageIds lands in order, and a deleted page loses its row', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);

  await storage.saveWhiteboard(doc);

  const added = { ...createBlankWhiteboardPage(), canvasJSON: JSON.stringify({ objects: [{ path: 'NEW' }] }) };
  const grown: WhiteboardDocument = {
    ...doc,
    pages: [doc.pages[0], added, doc.pages[1], doc.pages[2]],
    updatedAt: 4_000,
  };

  await storage.saveWhiteboard(grown, { changedPageIds: [added.id] });

  const loaded = await storage.loadWhiteboard(UUID);

  assert.deepEqual(
    loaded?.pages.map((page) => page.id),
    ids(grown),
    'the new page sits where the caller put it',
  );
  assert.ok(loaded?.pages[1].canvasJSON.includes('NEW'));
  assert.equal(await readPageRowCount(UUID), 4);

  const shrunk: WhiteboardDocument = { ...grown, pages: [doc.pages[0], doc.pages[2]], updatedAt: 5_000 };

  await storage.saveWhiteboard(shrunk, { changedPageIds: [] });

  assert.equal(await readPageRowCount(UUID), 2, 'the removed pages lose their rows');

  const afterDelete = await storage.loadWhiteboard(UUID);

  assert.deepEqual(
    afterDelete?.pages.map((page) => page.id),
    [doc.pages[0].id, doc.pages[2].id],
  );
  storage.close();
});

test('a page the caller forgot to declare is still written when it has no row on disk', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);

  await storage.saveWhiteboard(doc);

  // TWO new pages, only one declared. The undeclared one has no row on disk, so the save must
  // notice and write it anyway: a missed id may cost speed, never a page.
  const first = { ...createBlankWhiteboardPage(), canvasJSON: '{"objects":[{"path":"DECLARED"}]}' };
  const second = { ...createBlankWhiteboardPage(), canvasJSON: '{"objects":[{"path":"FORGOTTEN"}]}' };

  await storage.saveWhiteboard(
    { ...doc, pages: [...doc.pages, first, second], updatedAt: 6_000 },
    { changedPageIds: [first.id] },
  );

  const loaded = await storage.loadWhiteboard(UUID);

  assert.equal(loaded?.pages.length, 5);
  assert.ok(loaded?.pages[3].canvasJSON.includes('DECLARED'));
  assert.ok(loaded?.pages[4].canvasJSON.includes('FORGOTTEN'), 'an undeclared NEW page is never lost');
  storage.close();
});

test('a reorder with changedPageIds: [] rewrites no page and the load follows the new order', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);
  const reordered: WhiteboardDocument = {
    ...doc,
    pages: [doc.pages[2], doc.pages[0], doc.pages[1]],
    updatedAt: 7_000,
  };

  await storage.saveWhiteboard(doc);
  await storage.saveWhiteboard(reordered, { changedPageIds: [] });

  const record = await readRow<StoredRecord>(DOCUMENTS_STORE, UUID);

  assert.deepEqual(record?.pageIds, ids(reordered));

  const loaded = await storage.loadWhiteboard(UUID);

  assert.deepEqual(
    loaded?.pages.map((page) => page.id),
    ids(reordered),
  );
  assert.deepEqual(
    loaded?.pages.map((page) => page.canvasJSON),
    reordered.pages.map((page) => page.canvasJSON),
  );
  assert.equal(await readPageRowCount(UUID), 3, 'a reorder adds no rows');
  storage.close();
});

test('savePageSnapshot writes one row, the load merges it, and the record is never touched', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);

  await storage.saveWhiteboard(doc);

  const edited = inked(doc.pages[1], 'FRESH-INK');

  await storage.savePageSnapshot(UUID, edited, 9_000);

  const record = await readRow<StoredRecord>(DOCUMENTS_STORE, UUID);

  assert.equal(record?.updatedAt, 1_000, 'a page save does not rewrite the document record');

  const loaded = await storage.loadWhiteboard(UUID);

  assert.equal(loaded?.pages[1].canvasJSON, edited.canvasJSON, 'the saved page wins');
  assert.equal(loaded?.pages[0].canvasJSON, doc.pages[0].canvasJSON, 'untouched pages stay as they were');
  assert.equal(loaded?.updatedAt, 9_000, 'updatedAt advances to the newest page save');
  assert.equal(await readPageRowCount(UUID), 3, 'a page save overwrites its row, it never adds one');

  // The summary tracks the RECORD, not the merged view: a summary carrying the merged `updatedAt`
  // would disagree with the document's index entry and make every list "repair" it by reading the
  // whole board.
  const summary = await readRow<{ updatedAt: number; pageCount: number }>(SUMMARIES_STORE, UUID);

  assert.equal(summary?.updatedAt, 1_000);
  assert.equal(summary?.pageCount, 3);
  storage.close();
});

test('savePageSnapshot for a document that does not exist writes nothing', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await storage.saveWhiteboard(makeBoard(UUID));
  await storage.savePageSnapshot(OID, createBlankWhiteboardPage(), 2_000);

  assert.equal(await readPageRowCount(OID), 0, 'orphan ink is never stored');
  assert.equal(await readPageRowCount(UUID), 3);
  assert.equal(await storage.loadWhiteboard(OID), null);
  storage.close();
});

test('a full save supersedes a page save, and another board keeps its own rows', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const first = makeBoard(UUID);
  const second = makeBoard(OID);

  await storage.saveWhiteboard(first);
  await storage.saveWhiteboard(second);
  await storage.savePageSnapshot(UUID, inked(first.pages[1], 'STALE'), 5_000);
  await storage.saveWhiteboard({ ...second, updatedAt: 8_000 });
  await storage.saveWhiteboard({ ...first, pages: first.pages.map((page) => inked(page, 'FULL')), updatedAt: 6_000 });

  const loaded = await storage.loadWhiteboard(UUID);

  assert.ok(loaded?.pages[1].canvasJSON.includes('FULL'), 'stale ink must NOT resurrect');
  assert.equal(loaded?.updatedAt, 6_000);
  assert.equal(await readPageRowCount(OID), 3, 'the other board is untouched');
  storage.close();
});

test('deleteWhiteboard removes the page rows too', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);

  await storage.saveWhiteboard(doc);
  await storage.saveWhiteboard(makeBoard(OID));
  await storage.savePageSnapshot(UUID, inked(doc.pages[0], 'GONE'), 5_000);
  await storage.deleteWhiteboard(UUID);

  assert.equal(await readPageRowCount(UUID), 0);
  assert.equal(await readPageRowCount(OID), 3, 'only the deleted board loses its pages');
  assert.equal(await storage.loadWhiteboard(UUID), null);
  storage.close();
});

test('rekeyWhiteboard moves the page rows to the new id', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);

  await storage.saveWhiteboard(doc);
  await storage.savePageSnapshot(UUID, inked(doc.pages[2], 'CLAIMED-INK'), 9_500);
  await storage.rekeyWhiteboard(UUID, OID);

  assert.equal(await readPageRowCount(UUID), 0, 'the old id keeps no rows behind');
  assert.equal(await readPageRowCount(OID), 3);

  const moved = await storage.loadWhiteboard(OID);

  assert.ok(moved);
  assert.equal(moved.id, OID);
  assert.deepEqual(
    moved.pages.map((page) => page.id),
    ids(doc),
    'order survives the claim',
  );
  assert.ok(moved.pages[2].canvasJSON.includes('CLAIMED-INK'), 'no stroke is lost by the claim');
  assert.equal(await storage.loadWhiteboard(UUID), null);
  storage.close();
});

test('rekeying onto an id that already exists drops the old rows instead of merging them', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  await storage.saveWhiteboard(makeBoard(UUID, 3));
  await storage.saveWhiteboard(makeBoard(OID, 2, 2_000));
  await storage.rekeyWhiteboard(UUID, OID);

  assert.equal(await readPageRowCount(UUID), 0);
  assert.equal(await readPageRowCount(OID), 2, 'the already-claimed board keeps exactly its own pages');
  assert.equal((await storage.loadWhiteboard(OID))?.pages.length, 2);
  storage.close();
});

test('the PDF asset cascade still fires after a save that only declares one page', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const doc = makeBoard(UUID);
  const withAsset: WhiteboardDocument = {
    ...doc,
    pages: [doc.pages[0], doc.pages[1], { ...doc.pages[2], pdfAssetId: 'asset-1' }],
  };

  await storage.savePdfAsset({
    id: 'asset-1',
    blob: new Blob(['%PDF-1.4']),
    createdAt: 1,
    fileName: 'exam.pdf',
    fingerprint: 'fp',
    mimeType: 'application/pdf',
    pageCount: 1,
    size: 8,
  });
  await storage.saveWhiteboard(withAsset);

  const record = await readRow<StoredRecord>(DOCUMENTS_STORE, UUID);

  assert.deepEqual(record?.pdfAssetIds, ['asset-1'], 'the record names its assets so the diff reads no pages');
  assert.ok(await storage.loadPdfAsset('asset-1'));

  // The page loses its background. Only that page is declared — the diff must still notice that
  // nothing references the asset any more.
  await storage.saveWhiteboard(
    { ...withAsset, pages: [doc.pages[0], doc.pages[1], doc.pages[2]], updatedAt: 3_000 },
    { changedPageIds: [doc.pages[2].id] },
  );

  assert.equal(await storage.loadPdfAsset('asset-1'), null, 'an unreferenced asset is cascaded away');

  const after = await readRow<StoredRecord>(DOCUMENTS_STORE, UUID);

  assert.deepEqual(after?.pdfAssetIds, []);
  storage.close();
});

test('a legacy v6 board with inline pages and a journal row is merged, then split, on first load', async () => {
  await deleteDb();

  const legacy = await openAtV6();
  const doc = makeBoard(UUID, 3, 1_000);

  await putRaw(legacy, DOCUMENTS_STORE, doc);
  await putRaw(legacy, JOURNAL_STORE, {
    key: `${UUID} ${doc.pages[1].id}`,
    documentId: UUID,
    pageId: doc.pages[1].id,
    page: inked(doc.pages[1], 'JOURNALED'),
    updatedAt: 4_000,
  });
  legacy.close();

  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const loaded = await storage.loadWhiteboard(UUID);

  assert.ok(loaded?.pages[1].canvasJSON.includes('JOURNALED'), 'journaled ink survives the upgrade');
  assert.equal(loaded?.pages[0].canvasJSON, doc.pages[0].canvasJSON);
  assert.deepEqual(
    loaded?.pages.map((page) => page.id),
    ids(doc),
  );

  // The split happened in place, exactly once.
  const record = await readRow<StoredRecord>(DOCUMENTS_STORE, UUID);

  assert.equal(record?.pages, undefined, 'the inline pages are gone from the record');
  assert.deepEqual(record?.pageIds, ids(doc));
  assert.equal(await readPageRowCount(UUID), 3);
  assert.deepEqual(await readAll<PageRow>(JOURNAL_STORE), [], 'the folded journal rows are dropped');

  const reloaded = await storage.loadWhiteboard(UUID);

  assert.ok(reloaded?.pages[1].canvasJSON.includes('JOURNALED'), 'the second load reads the same board');
  assert.deepEqual(
    reloaded?.pages.map((page) => page.id),
    ids(doc),
  );
  storage.close();
});

test('a v5 database upgrades to v7, gains the page store, and keeps its boards', async () => {
  await deleteDb();

  const legacy = await openAtV5();

  assert.ok(!legacy.objectStoreNames.contains(PAGES_STORE), 'v5 has no page store');
  await putRaw(legacy, DOCUMENTS_STORE, makeBoard(UUID, 2, 1_234));
  legacy.close();

  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const storeNames = await readStoreNames();

  assert.ok(storeNames.includes(PAGES_STORE), 'the upgrade adds the page store');
  assert.ok(storeNames.includes(SUMMARIES_STORE), 'and keeps every v5 store');
  assert.ok(storeNames.includes('whiteboard-outbox-payloads'));
  assert.ok(!storeNames.includes(JOURNAL_STORE), 'the superseded v6 journal is never created');

  const survivor = await storage.loadWhiteboard(UUID);

  assert.ok(survivor, 'the pre-upgrade board survives');
  assert.equal(survivor.pages.length, 2);
  assert.equal(await readPageRowCount(UUID), 2, 'and is split on that first load');

  // And the new path works immediately on the upgraded DB.
  await storage.savePageSnapshot(UUID, inked(survivor.pages[0], 'AFTER-UPGRADE'), 4_321);

  const reloaded = await storage.loadWhiteboard(UUID);

  assert.ok(reloaded?.pages[0].canvasJSON.includes('AFTER-UPGRADE'));
  storage.close();
});

test('listWhiteboards assembles a split board and a legacy one, writing neither', async () => {
  await deleteDb();

  const legacy = await openAtV6();
  const older = makeBoard(OID, 2, 500);

  await putRaw(legacy, DOCUMENTS_STORE, older);
  await putRaw(legacy, JOURNAL_STORE, {
    key: `${OID} ${older.pages[0].id}`,
    documentId: OID,
    pageId: older.pages[0].id,
    page: inked(older.pages[0], 'PENDING'),
    updatedAt: 600,
  });
  legacy.close();

  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  const split = makeBoard(UUID, 3, 1_000);

  await storage.saveWhiteboard(split);
  await storage.savePageSnapshot(UUID, inked(split.pages[2], 'LISTED'), 9_900);

  const listed = await storage.listWhiteboards();

  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((board) => board.id),
    [UUID, OID],
    'newest first',
  );
  assert.deepEqual(
    listed[0].pages.map((page) => page.id),
    ids(split),
    'the split board is assembled in order',
  );
  assert.ok(listed[0].pages[2].canvasJSON.includes('LISTED'));
  assert.equal(listed[0].updatedAt, 9_900);
  assert.ok(listed[1].pages[0].canvasJSON.includes('PENDING'), 'the legacy board still merges its journal');
  assert.equal(listed[1].pages.length, 2);

  // A list never splits, never consolidates, never rewrites.
  const untouched = await readRow<StoredRecord>(DOCUMENTS_STORE, OID);

  assert.equal(untouched?.pages?.length, 2, 'the legacy record keeps its inline pages');
  assert.equal((await readAll<PageRow>(JOURNAL_STORE)).length, 1, 'and its journal row');
  assert.equal(await readPageRowCount(OID), 0, 'the list writes no page rows');
  assert.equal((await readRow<StoredRecord>(DOCUMENTS_STORE, UUID))?.updatedAt, 1_000);
  storage.close();
});

test('listWhiteboardSummaries reports the page count without reading a page', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await storage.saveWhiteboard(makeBoard(UUID, 4, 2_000));
  await storage.saveWhiteboard(makeBoard(OID, 2, 1_000));

  const summaries = await storage.listWhiteboardSummaries();

  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.pageCount]),
    [
      [UUID, 4],
      [OID, 2],
    ],
  );
  assert.equal(summaries[0].title, 'Algebra board');
  storage.close();
});
