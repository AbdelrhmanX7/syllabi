import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlankWhiteboardDocument } from '../src/defaults';
import { createIndexedDbWhiteboardStorage } from '../src/storage/indexeddb';

import type { WhiteboardPdfAsset, WhiteboardStorage } from '../src/types';

const DB_NAME = 'whiteboard-store';
const CURSOR_STORE = 'whiteboard-sync-cursor';
const OUTBOX_STORE = 'whiteboard-outbox';
const OUTBOX_PAYLOADS_STORE = 'whiteboard-outbox-payloads';
const PDF_ASSETS_STORE = 'pdfAssets';
const DOCUMENTS_STORE = 'whiteboards';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const OID = 'a1b2c3d4e5f60718293a4b5c';
const ASSET_ID = 'asset-1';
const ENTRY_ID = 'outbox-entry-1';

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

function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();

    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

function makeAsset(): WhiteboardPdfAsset {
  return {
    id: ASSET_ID,
    blob: new Blob(['%PDF-1.4 fake']),
    createdAt: 1,
    fileName: 'src.pdf',
    fingerprint: 'fp-1',
    mimeType: 'application/pdf',
    pageCount: 1,
    size: 12,
  };
}

function makeOutboxEntry(documentId: string) {
  return {
    id: ENTRY_ID,
    documentId,
    localSeq: 1,
    baseSeq: null,
    deviceId: 'dev-1',
    rawDataKey: ENTRY_ID,
    pageCount: 1,
    title: 'doc',
    thumbnail: null,
    fileSize: 10,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function seedLocalBoard(storage: WhiteboardStorage, boardId: string): Promise<void> {
  const doc = createBlankWhiteboardDocument({ id: boardId, title: 'New document' });

  doc.pages[0].pdfAssetId = ASSET_ID;
  await storage.savePdfAsset(makeAsset());
  await storage.saveWhiteboard(doc);
}

test('rekeyWhiteboard moves the doc + cursor + outbox to _id and PRESERVES shared pdf assets (cascade-footgun guard)', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedLocalBoard(storage, UUID);

  // Seed sync-cursor + outbox + payload rows under the UUID (defensive/legacy path).
  let db = await openRaw();

  await putRaw(db, CURSOR_STORE, { documentId: UUID, lastSyncedSeq: 5 });
  await putRaw(db, OUTBOX_STORE, makeOutboxEntry(UUID));
  await putRaw(db, OUTBOX_PAYLOADS_STORE, { id: ENTRY_ID, blob: new Blob(['gz']) });
  db.close();

  await storage.rekeyWhiteboard(UUID, OID);

  db = await openRaw();

  // Document row moved UUID -> _id, with its page rows and their pdfAssetId intact. Pages live in
  // their own store from DB v7 on, so the record names them rather than carrying them.
  const movedDoc = await getRaw<{ id: string; pageIds: string[]; pdfAssetIds: string[] }>(db, DOCUMENTS_STORE, OID);
  const oldDoc = await getRaw(db, DOCUMENTS_STORE, UUID);
  const movedPages = await getAll<{ documentId: string; page: { pdfAssetId?: string } }>(db, 'whiteboardPages');

  assert.ok(movedDoc, '_id document should exist');
  assert.equal(movedDoc!.id, OID);
  assert.deepEqual(movedDoc!.pdfAssetIds, [ASSET_ID]);
  assert.equal(movedPages.length, 1, 'the page row moved with the record, it was not duplicated');
  assert.equal(movedPages[0].documentId, OID);
  assert.equal(movedPages[0].page.pdfAssetId, ASSET_ID);
  assert.equal(oldDoc, undefined, 'UUID document should be gone');

  // THE REGRESSION GUARD: shared pdf assets must NOT be cascade-deleted by the re-key.
  const assets = await getAll(db, PDF_ASSETS_STORE);

  assert.equal(assets.length, 1, 'pdf asset must survive the re-key');

  // Cursor moved to _id.
  const movedCursor = await getRaw<{ documentId: string }>(db, CURSOR_STORE, OID);
  const oldCursor = await getRaw(db, CURSOR_STORE, UUID);

  assert.ok(movedCursor, 'cursor should be re-keyed to _id');
  assert.equal(oldCursor, undefined);

  // Outbox entry: same entry id, documentId re-keyed; payload untouched.
  const outbox = await getAll<{ id: string; documentId: string }>(db, OUTBOX_STORE);

  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].id, ENTRY_ID);
  assert.equal(outbox[0].documentId, OID);

  const payload = await getRaw<{ id: string }>(db, OUTBOX_PAYLOADS_STORE, ENTRY_ID);

  assert.ok(payload, 'payload (entry-id keyed) rides along untouched');
  db.close();

  storage.close();
});

test('rekeyWhiteboard with an already-present _id drops the stale UUID row and keeps assets', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  await seedLocalBoard(storage, UUID);
  // Pre-seed the _id doc as if it already landed locally.
  const existing = createBlankWhiteboardDocument({ id: OID, title: 'existing' });

  existing.pages[0].pdfAssetId = ASSET_ID;
  await storage.saveWhiteboard(existing);

  await storage.rekeyWhiteboard(UUID, OID);

  const db = await openRaw();
  const movedDoc = await getRaw<{ title: string }>(db, DOCUMENTS_STORE, OID);
  const oldDoc = await getRaw(db, DOCUMENTS_STORE, UUID);
  const assets = await getAll(db, PDF_ASSETS_STORE);

  assert.ok(movedDoc);
  assert.equal(movedDoc!.title, 'existing', 'existing _id record must NOT be overwritten');
  assert.equal(oldDoc, undefined, 'stale UUID row dropped');
  assert.equal(assets.length, 1, 'assets preserved');
  db.close();

  storage.close();
});

test('rekeyWhiteboard is a no-op when the source is missing (and on equal ids)', async () => {
  await deleteDb();
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();

  await assert.doesNotReject(storage.rekeyWhiteboard('does-not-exist', OID));
  await assert.doesNotReject(storage.rekeyWhiteboard(OID, OID));

  const db = await openRaw();
  const docs = await getAll(db, DOCUMENTS_STORE);

  assert.equal(docs.length, 0, 'no documents created by a no-op re-key');
  db.close();

  storage.close();
});
