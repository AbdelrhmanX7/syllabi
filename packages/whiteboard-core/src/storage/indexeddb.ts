import { normalizeWhiteboardDocument, toWhiteboardSummary } from '../defaults';
import { migrateWhiteboardDocument } from '../migrations';
import { createOutbox } from '../sync/outbox';

import type {
  WhiteboardDocument,
  WhiteboardPage,
  WhiteboardPdfAsset,
  WhiteboardStorage,
  WhiteboardSummary,
} from '../types';
import { WHITEBOARD_SCHEMA_VERSION } from '../types';
import type { Outbox, OutboxEntry, OutboxOptions, OutboxStore } from '../sync/outbox';

const DB_NAME = 'whiteboard-store';
// Bumped 4 -> 5 to ADD the list-summaries store (see SUMMARIES_STORE_NAME). Like every prior bump
// the upgrade is additive only: every existing store (whiteboards, pdfAssets, whiteboard-outbox,
// whiteboard-outbox-payloads, whiteboard-sync-cursor) and its data are never deleted, recreated, or
// cleared. Each store is `contains()`-guarded, so opening at v5 is safe from a fresh DB or from any
// of v2/v3/v4. It is also backward-compatible: an OLDER build that opens this DB hits VersionError,
// falls back to opening at the on-disk version (see openDB), and simply ignores the extra store —
// its EXPECTED_STORE_NAMES self-heal only ADDS missing stores, it never deletes unknown ones.
// Bumped 5 -> 6 to ADD the per-page save journal (see PAGE_JOURNAL_STORE_NAME). Additive and
// `contains()`-guarded like every prior bump, and backward-compatible the same way: an older build
// that opens this DB hits VersionError, falls back to the on-disk version, and simply ignores the
// extra store — its journal entries are then invisible to it, which is why a full save always
// rewrites the whole document and clears the journal with it.
// Bumped 6 -> 7 to ADD the page store (see PAGES_STORE_NAME), which SPLITS page content out of the
// document record. The store creation is additive and `contains()`-guarded like every prior bump,
// and NOTHING is migrated inside the version-change transaction — a 54 MB record read there would
// block every connection and roll the whole upgrade back if it aborted. Each board is split lazily,
// once, the first time it is loaded (see `loadWhiteboard`) or fully saved.
//
// This bump is the one that is NOT backward-compatible in the value shape: a split record has no
// inline `pages`, so an OLDER build that opens this DB (VersionError -> on-disk version) would read
// a board as page-less. That is accepted — the desktop app self-updates and never runs two channels
// against one profile — and it is why the split is deliberately lazy: a board that is never opened
// by this build is never split, and keeps its legacy inline shape.
const DB_VERSION = 7;
const DOCUMENTS_STORE_NAME = 'whiteboards';
const PDF_ASSETS_STORE_NAME = 'pdfAssets';
const OUTBOX_STORE_NAME = 'whiteboard-outbox';
const OUTBOX_DOCUMENT_INDEX = 'documentId';
// Additive (v4): durable gzipped snapshot blobs keyed by outbox entry id, and the per-document
// last-synced server seq cursor that feeds baseSeq + divergence detection.
const OUTBOX_PAYLOADS_STORE_NAME = 'whiteboard-outbox-payloads';
const SYNC_CURSOR_STORE_NAME = 'whiteboard-sync-cursor';
// Additive (v5): one tiny row per board holding ONLY what the home library list renders (title,
// timestamps, cover thumbnail, teacher tag, page COUNT). Boards run 100–286 pages, each page a full
// Fabric `canvasJSON` plus a base64 thumbnail, so listing whole documents structured-clones
// tens-to-hundreds of MB on the main thread for a list that shows none of it. Every writer of the
// documents store maintains this store IN THE SAME TRANSACTION, so the two can never desync.
const SUMMARIES_STORE_NAME = 'whiteboardSummaries';
// Additive (v6): the per-page write-behind journal. `saveWhiteboard` rewrites the WHOLE document,
// and a real 109-page exam board is a ~54 MB record (48 MB of `canvasJSON`), so an autosave every
// 2 s while the teacher writes costs a 54 MB structured clone + put — hundreds of ms of frozen pen —
// to persist the ONE page that changed. A page save instead writes a single small row here, and
// every reader of the documents store overlays these rows so no reader ever sees ink older than the
// last page save. Readers only MERGE — they never write the merged record back, because the sync
// layer loads the document after every quiet period and consolidating there would re-issue the very
// put this store removes. Entries are cleared by the writers that supersede them: a full
// `saveWhiteboard`, a `deleteWhiteboard`, or a `rekeyWhiteboard`. The on-disk document format is
// completely unchanged.
const PAGE_JOURNAL_STORE_NAME = 'whiteboardPageJournal';
const PAGE_JOURNAL_DOCUMENT_INDEX = 'documentId';
// Additive (v7): the page store, which SUPERSEDES the v6 journal. The journal made a page SAVE
// cheap but left every full save O(N): `saveWhiteboard` still read the old 54 MB record (to diff
// PDF asset ids) and put a new one, so a 109-page board froze the main thread for ~1.5 s — once
// every 45 s while the teacher writes, and on every page add. Here page content lives in its own
// rows, one per page, and the `whiteboards` record keeps only the meta plus `pageIds` (order) and
// `pdfAssetIds` (so the asset diff needs no page content at all). A full save with `changedPageIds`
// is then O(k): one small meta put plus k page puts, whatever N is.
//
// The journal is NOT read by anything except the lazy migration that folds it into these rows, and
// it is no longer created on a fresh database.
const PAGES_STORE_NAME = 'whiteboardPages';
const PAGES_DOCUMENT_INDEX = 'documentId';

/** Stored shape of one journaled page (keyPath `key`). v6 only — read solely by the migration. */
interface PageJournalRecord {
  key: string;
  documentId: string;
  pageId: string;
  page: WhiteboardPage;
  updatedAt: number;
}

/** Stored shape of one page row in {@link PAGES_STORE_NAME} (keyPath `key`). */
interface StoredPageRecord {
  key: string;
  documentId: string;
  pageId: string;
  page: WhiteboardPage;
  updatedAt: number;
}

/**
 * The on-disk document record from v7 on: a {@link WhiteboardDocument} with its `pages` REMOVED and
 * replaced by the page order plus the set of PDF assets those pages reference. The in-memory
 * document type is untouched — pages are assembled on read and split on write, and every reader in
 * this file goes through {@link assembleStoredRecord} / {@link splitDocument}.
 */
interface StoredWhiteboardRecord extends Omit<WhiteboardDocument, 'pages'> {
  pageIds: string[];
  pdfAssetIds: string[];
}

/** Primary key of a page row (and of a v6 journal row). One row per page per document. */
function pageRowKey(documentId: string, pageId: string): string {
  return `${documentId} ${pageId}`;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a persisted record still carries its pages INLINE — i.e. it was written by a build older
 * than v7 (or by the degraded path below, when the page store could not be created). A v7 record
 * never has a `pages` key at all, so the check is unambiguous even for a board with no pages.
 */
function hasInlinePages(raw: unknown): boolean {
  return isRecordLike(raw) && Array.isArray(raw.pages);
}

function storedStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Split an in-memory document into the record that goes in `whiteboards` and its page rows. */
function splitDocument(doc: WhiteboardDocument): { record: StoredWhiteboardRecord; rows: StoredPageRecord[] } {
  const { pages, ...rest } = doc;
  const pdfAssetIds = new Set<string>();

  for (const page of pages) {
    if (typeof page.pdfAssetId === 'string' && page.pdfAssetId.length > 0) {
      pdfAssetIds.add(page.pdfAssetId);
    }
  }

  return {
    record: { ...rest, pageIds: pages.map((page) => page.id), pdfAssetIds: Array.from(pdfAssetIds) },
    rows: pages.map((page) => ({
      key: pageRowKey(doc.id, page.id),
      documentId: doc.id,
      pageId: page.id,
      page,
      updatedAt: doc.updatedAt,
    })),
  };
}

/**
 * Rebuild the raw document shape the migration layer expects from a v7 record and its page rows.
 *
 * Order comes from `pageIds`. A `pageIds` entry with no row is skipped (nothing to render), and a
 * row that no `pageIds` entry names is APPENDED rather than dropped — a page save can legitimately
 * land before the full save that records the new order, and silently discarding a teacher's page is
 * the one outcome this whole store exists to prevent. `updatedAt` advances to the newest page row,
 * exactly as the v6 journal overlay did, so a caller never sees ink newer than the timestamp on it.
 *
 * The stored-only keys are stripped, so the assembled value is byte-identical to what a pre-split
 * build would have read — which keeps `migrateWhiteboardDocument`'s `changed` flag honest and stops
 * a load from resaving a board for no reason.
 */
function assembleStoredRecord(raw: Record<string, unknown>, rows: StoredPageRecord[]): Record<string, unknown> {
  const { pages: _inline, pageIds: rawPageIds, pdfAssetIds: _assetIds, ...rest } = raw;
  const byPageId = new Map<string, StoredPageRecord>();

  for (const row of rows) {
    if (row && typeof row.pageId === 'string' && row.page) {
      byPageId.set(row.pageId, row);
    }
  }

  const ordered: WhiteboardPage[] = [];
  const used = new Set<string>();
  let updatedAt = typeof rest.updatedAt === 'number' && Number.isFinite(rest.updatedAt) ? rest.updatedAt : 0;

  const take = (row: StoredPageRecord) => {
    used.add(row.pageId);
    ordered.push(row.page);

    if (Number.isFinite(row.updatedAt) && row.updatedAt > updatedAt) {
      updatedAt = row.updatedAt;
    }
  };

  for (const pageId of storedStringArray(rawPageIds)) {
    const row = byPageId.get(pageId);

    if (row && !used.has(pageId)) {
      take(row);
    }
  }

  for (const row of rows) {
    if (row && typeof row.pageId === 'string' && row.page && !used.has(row.pageId)) {
      take(row);
    }
  }

  return { ...rest, pages: ordered, updatedAt };
}

/**
 * Overlay per-page rows onto a LEGACY inline-pages document, in place of the matching pages.
 *
 * Only the legacy paths need this: once a board is split, the rows ARE the pages. An entry whose
 * page id is not in the document is dropped (the page was deleted after the row was written), and
 * `updatedAt` advances to the newest entry actually applied.
 */
function applyPageOverlay(document: WhiteboardDocument, entries: StoredPageRecord[]): WhiteboardDocument {
  if (entries.length === 0) {
    return document;
  }

  const byPageId = new Map<string, StoredPageRecord>();

  for (const entry of entries) {
    if (entry && typeof entry.pageId === 'string' && entry.page) {
      byPageId.set(entry.pageId, entry);
    }
  }

  let applied = false;
  let updatedAt = document.updatedAt;
  const pages = document.pages.map((page) => {
    const entry = byPageId.get(page.id);

    if (!entry) {
      return page;
    }

    applied = true;

    if (Number.isFinite(entry.updatedAt) && entry.updatedAt > updatedAt) {
      updatedAt = entry.updatedAt;
    }

    return entry.page;
  });

  return applied ? { ...document, pages, updatedAt } : document;
}

function collectPdfAssetIds(document: WhiteboardDocument | null | undefined): Set<string> {
  return new Set(
    (document?.pages ?? [])
      .map((page) => page.pdfAssetId)
      .filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0),
  );
}

/**
 * The PDF assets a persisted record references, WITHOUT reading a single page: a v7 record carries
 * them in `pdfAssetIds`. Only a legacy inline record has to be walked page by page — and that walk
 * is over a value the caller had to read anyway.
 */
function storedPdfAssetIds(raw: unknown): Set<string> {
  if (!isRecordLike(raw)) {
    return new Set<string>();
  }

  if (hasInlinePages(raw)) {
    return collectPdfAssetIds(normalizeWhiteboardDocument(raw as unknown as WhiteboardDocument));
  }

  return new Set(storedStringArray(raw.pdfAssetIds));
}

/**
 * Build a library-list row from a persisted record WITHOUT deserializing page content: a v7 record
 * knows its page count from `pageIds` alone. A legacy inline record goes through the migration
 * layer, exactly as it did before the split.
 */
function summaryFromStoredRecord(raw: unknown, id: string): WhiteboardSummary | null {
  if (!isRecordLike(raw)) {
    return null;
  }

  if (hasInlinePages(raw)) {
    const migrated = migrateLoadedRecord(raw);

    return migrated ? { ...toWhiteboardSummary(migrated.document), id } : null;
  }

  const pageCount = storedStringArray(raw.pageIds).length;
  // `toWhiteboardSummary` reads nothing from `pages` but its LENGTH, so a placeholder of the right
  // size is exactly as accurate as the real pages and costs nothing to build.
  const projected = { ...raw, pages: new Array<WhiteboardPage>(pageCount) } as unknown as WhiteboardDocument;

  return { ...toWhiteboardSummary(projected), id };
}

/**
 * Run the schema-migration layer on a single persisted record (§2.5: migrate runs on
 * EVERY load). Returns `null` for a missing record (matching the old normalize null
 * contract) and the migrated document plus whether migration changed it otherwise.
 * Garbage that cannot be repaired throws inside {@link migrateWhiteboardDocument}; here
 * we fall back to {@link normalizeWhiteboardDocument} so a single corrupt record never
 * takes down a whole `listWhiteboards`.
 */
function migrateLoadedRecord(raw: unknown): { document: WhiteboardDocument; changed: boolean } | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  try {
    const { document, changed } = migrateWhiteboardDocument(raw);

    return { document, changed };
  } catch {
    const normalized = normalizeWhiteboardDocument(raw as WhiteboardDocument | null | undefined);

    return normalized ? { document: normalized, changed: false } : null;
  }
}

// Every object store the current build expects to exist. Used by the self-heal check below so
// a DB stamped at the right version but missing a store (interrupted/partial upgrade) is repaired.
const EXPECTED_STORE_NAMES = [
  DOCUMENTS_STORE_NAME,
  PDF_ASSETS_STORE_NAME,
  OUTBOX_STORE_NAME,
  OUTBOX_PAYLOADS_STORE_NAME,
  SYNC_CURSOR_STORE_NAME,
  SUMMARIES_STORE_NAME,
  // NOT PAGE_JOURNAL_STORE_NAME: the v6 journal is superseded by the page store and is never
  // created again. A v6 database still has it (and the lazy migration folds it away); a fresh v7
  // database simply never gets one, which is why every journal access below is guarded.
  PAGES_STORE_NAME,
] as const;

/**
 * Whether THIS connection actually has the summaries store. Almost always true — {@link openDB}'s
 * self-heal creates every {@link EXPECTED_STORE_NAMES} store — but that self-heal is deliberately
 * allowed to FAIL and carry on so boards keep saving. Every summary read/write is therefore gated on
 * this check and the store is only named in a transaction when it exists: a missing summaries store
 * must degrade the LIST (falling back to reading full documents), never break saving handwriting.
 */
function hasSummaryStore(db: IDBDatabase): boolean {
  return db.objectStoreNames.contains(SUMMARIES_STORE_NAME);
}

/**
 * Whether THIS connection still has the v6 page journal. Only the lazy migration reads it — on a
 * fresh v7 database it does not exist at all, and after a board is split its rows are gone.
 */
function hasPageJournalStore(db: IDBDatabase): boolean {
  return db.objectStoreNames.contains(PAGE_JOURNAL_STORE_NAME);
}

/**
 * Whether THIS connection actually has the page store. Same contract as {@link hasSummaryStore}:
 * {@link openDB}'s self-heal is allowed to fail and carry on, so the store is only ever named in a
 * transaction when it exists. A missing page store must never break saving handwriting — every
 * path below degrades to the pre-split behaviour (pages written INLINE in the document record),
 * which the readers still understand, so the next open that creates the store repairs itself.
 */
function hasPagesStore(db: IDBDatabase): boolean {
  return db.objectStoreNames.contains(PAGES_STORE_NAME);
}

/**
 * Delete every row of one document out of a `documentId`-indexed store, inside a transaction the
 * caller already owns. A KEY cursor, so a 54 MB board's pages are deleted without one of them being
 * structured-cloned into memory.
 */
function clearRowsFor(store: IDBObjectStore | null, indexName: string, documentId: string): void {
  if (!store) {
    return;
  }

  const request = store.index(indexName).openKeyCursor(IDBKeyRange.only(documentId));

  request.onsuccess = () => {
    const cursor = request.result;

    if (!cursor) {
      return;
    }

    store.delete(cursor.primaryKey);
    cursor.continue();
  };
}

/** Drop the v6 journal rows of one document — only ever alongside the write that supersedes them. */
function clearPageJournalFor(journalStore: IDBObjectStore | null, documentId: string): void {
  clearRowsFor(journalStore, PAGE_JOURNAL_DOCUMENT_INDEX, documentId);
}

/** Drop every page row of one document (delete, and the losing side of a re-key). */
function clearPageRowsFor(pagesStore: IDBObjectStore | null, documentId: string): void {
  clearRowsFor(pagesStore, PAGES_DOCUMENT_INDEX, documentId);
}

/**
 * Delete the rows a rewrite left behind: pages that were on disk but are not in the document any
 * more. Used by the write-on-load paths, which already hold every existing row in memory, so it
 * needs no extra read.
 */
function pruneStalePageRows(
  pagesStore: IDBObjectStore | null,
  existingRows: StoredPageRecord[],
  nextRows: StoredPageRecord[],
): void {
  if (!pagesStore) {
    return;
  }

  const liveKeys = new Set(nextRows.map((row) => row.key));

  for (const row of existingRows) {
    if (row && typeof row.key === 'string' && !liveKeys.has(row.key)) {
      pagesStore.delete(row.key);
    }
  }
}

/** Newest first, tie-broken by id descending — the exact order the `updatedAt` index cursor yields. */
function sortSummariesNewestFirst(summaries: WhiteboardSummary[]): WhiteboardSummary[] {
  return summaries.sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) {
      return b.updatedAt - a.updatedAt;
    }

    if (a.id === b.id) {
      return 0;
    }

    return a.id < b.id ? 1 : -1;
  });
}

/**
 * Create any object store that does not yet exist (additive + `contains()`-guarded, so it is
 * safe to run on EVERY upgrade — from a fresh DB or from any prior version). Never deletes,
 * recreates, or clears an existing store or its data.
 */
function createWhiteboardStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(DOCUMENTS_STORE_NAME)) {
    const documentStore = db.createObjectStore(DOCUMENTS_STORE_NAME, { keyPath: 'id' });

    documentStore.createIndex('updatedAt', 'updatedAt', { unique: false });
  }

  if (!db.objectStoreNames.contains(PDF_ASSETS_STORE_NAME)) {
    const assetStore = db.createObjectStore(PDF_ASSETS_STORE_NAME, { keyPath: 'id' });

    assetStore.createIndex('createdAt', 'createdAt', { unique: false });
  }

  // Additive (v3): the durable sync outbox.
  if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
    const outboxStore = db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'id' });

    outboxStore.createIndex(OUTBOX_DOCUMENT_INDEX, 'documentId', { unique: false });
  }

  // Additive (v4): the gzipped snapshot blob store keyed by outbox entry id.
  if (!db.objectStoreNames.contains(OUTBOX_PAYLOADS_STORE_NAME)) {
    db.createObjectStore(OUTBOX_PAYLOADS_STORE_NAME, { keyPath: 'id' });
  }

  // Additive (v4): the per-document last-synced server seq cursor.
  if (!db.objectStoreNames.contains(SYNC_CURSOR_STORE_NAME)) {
    db.createObjectStore(SYNC_CURSOR_STORE_NAME, { keyPath: 'documentId' });
  }

  // Additive (v5): the list-summaries store. Created EMPTY on purpose — the backfill from existing
  // documents happens lazily on the first `listWhiteboardSummaries()` instead of here, because a
  // versionchange transaction that reads every full document would (a) block the upgrade — and every
  // other connection — while it structured-clones hundreds of MB, and (b) roll the whole upgrade back
  // if it aborted, leaving the app in a re-upgrade loop it can never escape. The lazy reconcile also
  // covers drift a one-shot upgrade could not: rows written by an OLDER build that has no idea this
  // store exists.
  if (!db.objectStoreNames.contains(SUMMARIES_STORE_NAME)) {
    const summaryStore = db.createObjectStore(SUMMARIES_STORE_NAME, { keyPath: 'id' });

    summaryStore.createIndex('updatedAt', 'updatedAt', { unique: false });
  }

  // Additive (v7): the page store — one row per page, indexed by document so a load collects
  // exactly one board's pages. Created EMPTY on purpose, and NOTHING is migrated here: reading a
  // 54 MB document inside a versionchange transaction would block every other connection while it
  // structured-clones, and an abort would roll the upgrade back into a loop the app can never
  // escape (the same reasoning as the v5 summaries store above). Each board is split lazily, once,
  // on its first load — see `loadWhiteboard`.
  //
  // The v6 journal store is deliberately NOT created here. It is superseded by this store; a v6
  // database keeps its rows until the lazy migration folds them in, and a fresh database never
  // gets one.
  if (!db.objectStoreNames.contains(PAGES_STORE_NAME)) {
    const pagesStore = db.createObjectStore(PAGES_STORE_NAME, { keyPath: 'key' });

    pagesStore.createIndex(PAGES_DOCUMENT_INDEX, 'documentId', { unique: false });
  }
}

function openWhiteboardDatabaseAt(version: number | undefined): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);

    request.onupgradeneeded = () => createWhiteboardStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    // DO NOT reject on `blocked`. A version upgrade is blocked while ANOTHER connection to the same
    // DB is still open (the app opens this DB from more than one place at once, so on a first run that
    // upgrades an older on-disk DB this fires routinely). Those connections receive `onversionchange`
    // (set below) and close themselves, after which the upgrade proceeds and `onsuccess` fires.
    // Rejecting here used to leave the DB permanently un-upgraded → isReady never true → nothing saved.
    request.onblocked = () => {
      // eslint-disable-next-line no-console
      console.warn('[whiteboard-storage] upgrade blocked by another open connection; waiting for it to close…');
    };
  });
}

async function openDB(): Promise<IDBDatabase> {
  let db: IDBDatabase;

  try {
    db = await openWhiteboardDatabaseAt(DB_VERSION);
  } catch (error) {
    // The on-disk DB is already at a HIGHER version than this build expects (a newer client, or
    // a prior self-heal repair below). Open at its current version instead of failing outright.
    if (error instanceof DOMException && error.name === 'VersionError') {
      db = await openWhiteboardDatabaseAt(undefined);
    } else {
      throw error;
    }
  }

  // Self-heal: a DB stamped at a version that should already contain a store but is missing it
  // (an interrupted upgrade, or a dev/HMR partial version bump) would never re-run
  // onupgradeneeded and would break the syncer with "object store not found" forever. Detect a
  // missing store and force ONE additive upgrade at version+1 to create it — never deletes data.
  if (EXPECTED_STORE_NAMES.some((name) => !db.objectStoreNames.contains(name))) {
    const repairVersion = db.version + 1;

    db.close();
    try {
      db = await openWhiteboardDatabaseAt(repairVersion);
    } catch (repairError) {
      // The additive repair upgrade failed (e.g., still blocked, or interrupted). Re-open at the
      // EXISTING version and carry on rather than failing init outright — the documents store
      // (where handwriting lives) is created at v1, so save/load of boards still works even if a
      // later sync-only store is missing. Never delete data to "recover".
      // eslint-disable-next-line no-console
      console.warn('[whiteboard-storage] store self-heal failed; continuing with the existing DB:', repairError);
      db = await openWhiteboardDatabaseAt(undefined);
    }
  }

  db.onversionchange = () => {
    db.close();
  };

  return db;
}

/** What one reconcile pass found: the current rows, plus the ids that need repairing. */
interface SummaryReconcilePlan {
  /** Every summary row on disk, keyed by id. Mutated in place as ids are rebuilt/dropped. */
  summaries: Map<string, WhiteboardSummary>;
  /** Documents whose summary is missing or whose `updatedAt` disagrees — must be rebuilt from the record. */
  driftedIds: string[];
  /** Summaries whose document is gone. */
  orphanIds: string[];
}

/**
 * READ-ONLY pass that decides what (if anything) the summaries store needs. Deliberately touches no
 * document VALUE:
 * - `getAllKeys` on the documents store yields ids only;
 * - a KEY cursor over the `updatedAt` index yields (updatedAt, id) pairs — unlike a value cursor it
 *   never structured-clones a record, so the cost is independent of how many pages the boards hold;
 * - `getAll` on the summaries store returns the tiny list rows.
 *
 * In the steady state every summary is fresh, so a list is exactly this one read-only transaction —
 * it never takes a write lock away from the editor's autosave.
 */
function planSummaryReconcile(db: IDBDatabase): Promise<SummaryReconcilePlan> {
  return new Promise<SummaryReconcilePlan>((resolve, reject) => {
    try {
      const transaction = db.transaction([DOCUMENTS_STORE_NAME, SUMMARIES_STORE_NAME], 'readonly');
      const documentStore = transaction.objectStore(DOCUMENTS_STORE_NAME);
      const summaryStore = transaction.objectStore(SUMMARIES_STORE_NAME);
      const summaries = new Map<string, WhiteboardSummary>();
      const documentUpdatedAt = new Map<string, number>();
      const driftedIds: string[] = [];
      const orphanIds: string[] = [];
      let documentIds: string[] = [];

      const summariesRequest = summaryStore.getAll() as IDBRequest<WhiteboardSummary[]>;

      summariesRequest.onsuccess = () => {
        for (const summary of summariesRequest.result ?? []) {
          if (summary && typeof summary.id === 'string') {
            summaries.set(summary.id, summary);
          }
        }
      };

      const keysRequest = documentStore.getAllKeys();

      keysRequest.onsuccess = () => {
        documentIds = (keysRequest.result ?? []).map((key) => String(key));
      };

      // Placed after the two requests above, and IndexedDB runs a transaction's requests in the order
      // they were made, so both have landed by the time this cursor is exhausted.
      const cursorRequest = documentStore.index('updatedAt').openKeyCursor();

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (cursor) {
          const updatedAt = Number(cursor.key);

          if (Number.isFinite(updatedAt)) {
            documentUpdatedAt.set(String(cursor.primaryKey), updatedAt);
          }

          cursor.continue();

          return;
        }

        const liveIds = new Set(documentIds);

        for (const id of documentIds) {
          const summary = summaries.get(id);
          const updatedAt = documentUpdatedAt.get(id);
          // An unknown `updatedAt` (a legacy row whose timestamp is missing/non-numeric, so it has no
          // index entry) cannot prove staleness — keep the summary we have rather than rebuilding it
          // on every single list call.
          const isFresh = summary !== undefined && (updatedAt === undefined || summary.updatedAt === updatedAt);

          if (!isFresh) {
            driftedIds.push(id);
          }
        }

        for (const id of Array.from(summaries.keys())) {
          if (!liveIds.has(id)) {
            orphanIds.push(id);
          }
        }
      };

      cursorRequest.onerror = () => reject(cursorRequest.error);
      transaction.oncomplete = () => resolve({ summaries, driftedIds, orphanIds });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Rebuild ONE document's summary, in its own short transaction, updating `summaries` to match.
 *
 * One document per transaction on purpose. This is the only place that reads a full record, and a
 * real board is tens of MB; batching them would keep every one of those requests (and its
 * deserialized pages) alive until the shared transaction committed, which on a first-run backfill of
 * a device full of 286-page boards is a memory spike big enough to matter. Short transactions also
 * hand the write lock back between documents, so a backfill never stalls the editor's autosave.
 */
function rebuildSummary(db: IDBDatabase, id: string, summaries: Map<string, WhiteboardSummary>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const transaction = db.transaction([DOCUMENTS_STORE_NAME, SUMMARIES_STORE_NAME], 'readwrite');
      const summaryStore = transaction.objectStore(SUMMARIES_STORE_NAME);
      const request = transaction.objectStore(DOCUMENTS_STORE_NAME).get(id);

      request.onsuccess = () => {
        // Forced to the STORE KEY, never the record's `id` field: a record whose id is missing gets
        // a fresh one from the migration, and writing the summary under that would strand it off-key
        // and re-drift on every future list.
        const rebuilt = summaryFromStoredRecord(request.result, id);

        if (!rebuilt) {
          // Gone, or unrepairable garbage that `listWhiteboards` skips too: make sure no stale summary
          // keeps advertising a board that can never be opened.
          summaries.delete(id);
          summaryStore.delete(id);

          return;
        }

        summaries.set(id, rebuilt);
        summaryStore.put(rebuilt);
      };

      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    } catch (error) {
      reject(error);
    }
  });
}

/** Drop summaries whose document is gone (deleted by a build that does not maintain this store). */
function dropOrphanSummaries(db: IDBDatabase, ids: string[], summaries: Map<string, WhiteboardSummary>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const transaction = db.transaction(SUMMARIES_STORE_NAME, 'readwrite');
      const summaryStore = transaction.objectStore(SUMMARIES_STORE_NAME);

      for (const id of ids) {
        summaries.delete(id);
        summaryStore.delete(id);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Read the library list out of the summaries store, reconciling it against the documents store first.
 *
 * The reconcile is what makes the store trustworthy without a schema-wide upgrade backfill: any id
 * missing from the summaries store, or whose summary's `updatedAt` disagrees with the document's, is
 * rebuilt from that document; any summary whose document is gone is dropped. On a v4 database that
 * rebuild covers every board, once — that IS the backfill — and afterwards it is normally zero
 * document reads.
 *
 * It also covers what a one-shot upgrade backfill could not: an OLDER build, which knows nothing
 * about this store, saving/renaming/deleting a board behind our back.
 */
async function listSummariesReconciled(db: IDBDatabase): Promise<WhiteboardSummary[]> {
  const { summaries, driftedIds, orphanIds } = await planSummaryReconcile(db);

  if (orphanIds.length > 0) {
    await dropOrphanSummaries(db, orphanIds, summaries);
  }

  for (const id of driftedIds) {
    await rebuildSummary(db, id, summaries);
  }

  return sortSummariesNewestFirst(Array.from(summaries.values()));
}

/**
 * DEGRADED list path, reached only when the summaries store could not be created (see
 * {@link hasSummaryStore}). It reads full documents — precisely the cost the summaries store exists
 * to avoid — but a slow library beats an empty one, and nothing here writes, so the next open that
 * successfully creates the store repairs itself.
 */
function listSummariesFromDocuments(db: IDBDatabase): Promise<WhiteboardSummary[]> {
  return new Promise<WhiteboardSummary[]>((resolve, reject) => {
    try {
      const transaction = db.transaction(DOCUMENTS_STORE_NAME, 'readonly');
      const request = transaction.objectStore(DOCUMENTS_STORE_NAME).index('updatedAt').openCursor(null, 'prev');
      const results: WhiteboardSummary[] = [];

      request.onsuccess = () => {
        const cursor = request.result;

        if (!cursor) {
          return;
        }

        const summary = summaryFromStoredRecord(cursor.value, String(cursor.primaryKey));

        if (summary) {
          results.push(summary);
        }

        cursor.continue();
      };

      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(results);
      transaction.onerror = () => reject(transaction.error);
    } catch (error) {
      reject(error);
    }
  });
}

export function createIndexedDbWhiteboardStorage(): WhiteboardStorage {
  let dbRef: IDBDatabase | null = null;
  let dbPromise: Promise<IDBDatabase> | null = null;

  const ensureDb = async () => {
    if (dbRef) {
      return dbRef;
    }

    if (!dbPromise) {
      dbPromise = openDB().then((db) => {
        dbRef = db;

        // When another connection requests a version upgrade, the browser asks this connection to
        // close (openDB sets db.onversionchange = close). Closing alone leaves this factory caching a
        // now-DEAD handle, so the next save/load would throw InvalidStateError forever. Override it to
        // ALSO drop the cache, so the next ensureDb() transparently reopens a fresh (upgraded)
        // connection instead of silently failing. (Overrides the close-only handler set in openDB.)
        db.onversionchange = () => {
          db.close();

          if (dbRef === db) {
            dbRef = null;
            dbPromise = null;
          }
        };

        return db;
      });
    }

    return dbPromise;
  };

  const storage: WhiteboardStorage = {
    ready: async () => {
      await ensureDb();
    },

    close: () => {
      dbRef?.close();
      dbRef = null;
      dbPromise = null;
    },

    saveWhiteboard: async (doc: WhiteboardDocument, options?: { changedPageIds?: string[] }) => {
      const db = await ensureDb();

      await new Promise<void>((resolve, reject) => {
        try {
          const withSummary = hasSummaryStore(db);
          const withPages = hasPagesStore(db);
          const withJournal = hasPageJournalStore(db);
          const storeNames = [DOCUMENTS_STORE_NAME, PDF_ASSETS_STORE_NAME];

          if (withSummary) {
            storeNames.push(SUMMARIES_STORE_NAME);
          }

          if (withPages) {
            storeNames.push(PAGES_STORE_NAME);
          }

          if (withJournal) {
            storeNames.push(PAGE_JOURNAL_STORE_NAME);
          }

          const transaction = db.transaction(storeNames, 'readwrite');
          const documentStore = transaction.objectStore(DOCUMENTS_STORE_NAME);
          const assetStore = transaction.objectStore(PDF_ASSETS_STORE_NAME);
          const summaryStore = withSummary ? transaction.objectStore(SUMMARIES_STORE_NAME) : null;
          const pagesStore = withPages ? transaction.objectStore(PAGES_STORE_NAME) : null;
          const journalStore = withJournal ? transaction.objectStore(PAGE_JOURNAL_STORE_NAME) : null;
          const payload: WhiteboardDocument = {
            ...doc,
            schemaVersion: doc.schemaVersion ?? WHITEBOARD_SCHEMA_VERSION,
          };
          const nextAssetIds = collectPdfAssetIds(payload);
          const { record, rows } = splitDocument(payload);
          const liveIds = new Set(payload.pages.map((page) => page.id));
          // A `changedPageIds` entry naming a page the document no longer has is ignored, not an
          // error: the caller may have deleted it between the edit and the save.
          const changedIds = options?.changedPageIds
            ? new Set(options.changedPageIds.filter((pageId) => liveIds.has(pageId)))
            : null;
          const getRequest = documentStore.get(payload.id);

          getRequest.onsuccess = () => {
            const previous = getRequest.result;
            // The asset diff is why a save used to read the whole 54 MB record. A v7 record carries
            // its asset ids directly, so the `get` above now returns a small meta row and the diff
            // costs nothing; only a legacy inline record is still walked page by page.
            const previousAssetIds = storedPdfAssetIds(previous);

            if (!pagesStore) {
              // DEGRADED: no page store on this connection. Write the pre-split inline shape so
              // handwriting still persists — every reader below still understands it.
              documentStore.put(payload);
              summaryStore?.put(toWhiteboardSummary(payload));
              clearPageJournalFor(journalStore, payload.id);

              for (const assetId of Array.from(previousAssetIds)) {
                if (!nextAssetIds.has(assetId)) {
                  assetStore.delete(assetId);
                }
              }

              return;
            }

            // `changedPageIds` is a PROMISE that every unlisted page is already on disk unchanged.
            // That promise cannot hold for a record that has never been split (its pages live
            // inline, so there are no rows yet) — writing only the listed page would lose the rest.
            const partial = changedIds !== null && previous !== undefined && !hasInlinePages(previous);

            documentStore.put(record);
            // SAME transaction as the document put, never a follow-up one: a crash (or an aborted tx)
            // between the two would leave the library showing a stale title/page-count forever.
            summaryStore?.put(toWhiteboardSummary(payload));
            // The page rows now hold (or deliberately supersede) every journaled page, so the v6
            // journal must go in this same commit — a surviving entry would resurrect older ink.
            clearPageJournalFor(journalStore, payload.id);

            for (const row of rows) {
              if (!partial || changedIds.has(row.pageId)) {
                pagesStore.put(row);
              }
            }

            // KEYS only — never the page values — so pruning deleted pages costs nothing on a
            // 109-page board. It doubles as the safety net for `changedPageIds`: a live page with
            // no row on disk is written even when the caller did not list it, so a missed id
            // degrades to a slower save, never to a lost page.
            const keysRequest = pagesStore.index(PAGES_DOCUMENT_INDEX).getAllKeys(IDBKeyRange.only(payload.id));

            keysRequest.onsuccess = () => {
              const existing = new Set<string>();

              for (const key of keysRequest.result ?? []) {
                const rowKey = String(key);
                const pageId = rowKey.slice(payload.id.length + 1);

                if (liveIds.has(pageId)) {
                  existing.add(pageId);
                } else {
                  pagesStore.delete(key);
                }
              }

              if (partial) {
                for (const row of rows) {
                  if (!changedIds.has(row.pageId) && !existing.has(row.pageId)) {
                    pagesStore.put(row);
                  }
                }
              }
            };

            keysRequest.onerror = () => reject(keysRequest.error);

            for (const assetId of Array.from(previousAssetIds)) {
              if (!nextAssetIds.has(assetId)) {
                assetStore.delete(assetId);
              }
            }
          };

          getRequest.onerror = () => reject(getRequest.error);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    savePageSnapshot: async (documentId: string, page: WhiteboardPage, updatedAt: number) => {
      const db = await ensureDb();

      // No page store on this connection (the self-heal could not create it): fall back to the
      // old full-document write so a page save still persists. Slow beats lost.
      if (!hasPagesStore(db)) {
        const existing = await storage.loadWhiteboard(documentId);

        if (!existing) {
          return;
        }

        const pages = existing.pages.map((candidate) => (candidate.id === page.id ? page : candidate));

        await storage.saveWhiteboard({ ...existing, pages, updatedAt: Math.max(existing.updatedAt, updatedAt) });

        return;
      }

      // Orphan protection, in its OWN readonly transaction and reading the KEY only. A readonly
      // read takes no write lock, so this never queues behind (or in front of) the editor's
      // autosave — whereas naming the documents store in the write transaction below would.
      const documentExists = await new Promise<boolean>((resolve, reject) => {
        try {
          const transaction = db.transaction(DOCUMENTS_STORE_NAME, 'readonly');
          const request = transaction.objectStore(DOCUMENTS_STORE_NAME).getKey(documentId);

          request.onsuccess = () => resolve(request.result !== undefined);
          request.onerror = () => reject(request.error);
        } catch (error) {
          reject(error);
        }
      });

      if (!documentExists) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        try {
          // ONE small readwrite transaction on the page store ALONE — it never takes the document
          // store's write lock, so an autosave mid-stroke cannot be queued behind (or block) a
          // full-document write.
          const transaction = db.transaction(PAGES_STORE_NAME, 'readwrite');
          const record: StoredPageRecord = {
            key: pageRowKey(documentId, page.id),
            documentId,
            pageId: page.id,
            page,
            updatedAt,
          };

          transaction.objectStore(PAGES_STORE_NAME).put(record);

          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    loadWhiteboard: async (id: string) => {
      const db = await ensureDb();

      // readwrite so a legacy record can be SPLIT in place, and a migrated one re-saved. These are
      // the two places a write-on-load is correct: the split happens once per board in its whole
      // life, and a stale on-disk schema is upgraded so the next resume reads a current board.
      return await new Promise<WhiteboardDocument | null>((resolve, reject) => {
        try {
          const withSummary = hasSummaryStore(db);
          const withPages = hasPagesStore(db);
          const withJournal = hasPageJournalStore(db);
          const storeNames = [DOCUMENTS_STORE_NAME];

          if (withSummary) {
            storeNames.push(SUMMARIES_STORE_NAME);
          }

          if (withPages) {
            storeNames.push(PAGES_STORE_NAME);
          }

          if (withJournal) {
            storeNames.push(PAGE_JOURNAL_STORE_NAME);
          }

          const transaction = db.transaction(storeNames, 'readwrite');
          const documentStore = transaction.objectStore(DOCUMENTS_STORE_NAME);
          const summaryStore = withSummary ? transaction.objectStore(SUMMARIES_STORE_NAME) : null;
          const pagesStore = withPages ? transaction.objectStore(PAGES_STORE_NAME) : null;
          const journalStore = withJournal ? transaction.objectStore(PAGE_JOURNAL_STORE_NAME) : null;
          let pageRows: StoredPageRecord[] = [];
          let journalEntries: PageJournalRecord[] = [];

          // Placed BEFORE the document read on purpose: IndexedDB runs a transaction's requests in
          // the order they were made, so both have landed by the time the record arrives.
          if (pagesStore) {
            const pagesRequest = pagesStore.index(PAGES_DOCUMENT_INDEX).getAll(IDBKeyRange.only(id)) as IDBRequest<
              StoredPageRecord[]
            >;

            pagesRequest.onsuccess = () => {
              pageRows = pagesRequest.result ?? [];
            };
            pagesRequest.onerror = () => reject(pagesRequest.error);
          }

          if (journalStore) {
            const journalRequest = journalStore
              .index(PAGE_JOURNAL_DOCUMENT_INDEX)
              .getAll(IDBKeyRange.only(id)) as IDBRequest<PageJournalRecord[]>;

            journalRequest.onsuccess = () => {
              journalEntries = journalRequest.result ?? [];
            };
            journalRequest.onerror = () => reject(journalRequest.error);
          }

          const request = documentStore.get(id);
          let result: WhiteboardDocument | null = null;

          request.onsuccess = () => {
            const raw = request.result;

            if (raw !== undefined && !hasInlinePages(raw) && pagesStore) {
              // The normal v7 path: assemble the pages from their rows, and write NOTHING unless a
              // schema migration genuinely changed the board.
              const migrated = migrateLoadedRecord(assembleStoredRecord(raw as Record<string, unknown>, pageRows));

              if (!migrated) {
                return;
              }

              result = migrated.document;

              // The summary describes the RECORD, not the assembled view, so it agrees with the
              // document's `updatedAt` index entry. A summary carrying a newer page row's timestamp
              // would read as drift and make every `listWhiteboardSummaries` "repair" it — the one
              // cost the summaries store was built to avoid. The library's timestamp therefore
              // tracks the last FULL save, as it did before pages were split out.
              const summary = summaryFromStoredRecord(raw, id);

              if (summary) {
                summaryStore?.put(summary);
              }

              if (migrated.changed) {
                const split = splitDocument({ ...migrated.document, id });

                documentStore.put(split.record);

                for (const row of split.rows) {
                  pagesStore.put(row);
                }

                pruneStalePageRows(pagesStore, pageRows, split.rows);
              }

              return;
            }

            // LEGACY (or degraded): pages are still inline. Overlay the v6 journal first, then any
            // page rows written since (a page save after the upgrade but before the first load),
            // newest wins.
            const migrated = migrateLoadedRecord(raw);

            if (!migrated) {
              // No document to merge into: any row for this id is orphaned ink from a board that is
              // gone or unrepairable. Drop it rather than leave it to haunt a future re-use of the id.
              clearPageJournalFor(journalStore, id);
              clearPageRowsFor(pagesStore, id);

              return;
            }

            const merged = applyPageOverlay(applyPageOverlay(migrated.document, journalEntries), pageRows);

            result = merged;

            if (!pagesStore) {
              // Degraded: nowhere to split to. Behave exactly as the pre-split build did.
              summaryStore?.put({ ...toWhiteboardSummary(migrated.document), id });

              if (migrated.changed) {
                documentStore.put(migrated.document);
              }

              return;
            }

            // THE ONE-TIME SPLIT. Every page becomes a row, the record loses its inline pages and
            // gains `pageIds` + `pdfAssetIds`, and the journal rows that were folded in are dropped
            // in the same commit. It costs one full-size write, once in a board's life; from here on
            // a save of this board is O(changed pages).
            const split = splitDocument({ ...merged, id });

            documentStore.put(split.record);

            for (const row of split.rows) {
              pagesStore.put(row);
            }

            pruneStalePageRows(pagesStore, pageRows, split.rows);
            clearPageJournalFor(journalStore, id);
            summaryStore?.put({ ...toWhiteboardSummary(merged), id });
          };

          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => resolve(result);
          transaction.onerror = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    listWhiteboards: async () => {
      const db = await ensureDb();

      // readwrite so a migrated record can be RE-SAVED in place via the cursor (local +
      // cheap). A row whose on-disk shape was older is upgraded so the next list/resume
      // reads a current-version board.
      return await new Promise<WhiteboardDocument[]>((resolve, reject) => {
        try {
          const withSummary = hasSummaryStore(db);
          const withPages = hasPagesStore(db);
          const withJournal = hasPageJournalStore(db);
          const storeNames = [DOCUMENTS_STORE_NAME];

          if (withSummary) {
            storeNames.push(SUMMARIES_STORE_NAME);
          }

          if (withPages) {
            storeNames.push(PAGES_STORE_NAME);
          }

          if (withJournal) {
            storeNames.push(PAGE_JOURNAL_STORE_NAME);
          }

          const transaction = db.transaction(storeNames, 'readwrite');
          const documentStore = transaction.objectStore(DOCUMENTS_STORE_NAME);
          const summaryStore = withSummary ? transaction.objectStore(SUMMARIES_STORE_NAME) : null;
          const pagesStore = withPages ? transaction.objectStore(PAGES_STORE_NAME) : null;
          const journalStore = withJournal ? transaction.objectStore(PAGE_JOURNAL_STORE_NAME) : null;
          const rowsByDocument = new Map<string, StoredPageRecord[]>();
          const journalByDocument = new Map<string, PageJournalRecord[]>();

          const groupByDocument = <T extends { documentId: string }>(entries: T[], into: Map<string, T[]>) => {
            for (const entry of entries) {
              if (!entry || typeof entry.documentId !== 'string') {
                continue;
              }

              const bucket = into.get(entry.documentId);

              if (bucket) {
                bucket.push(entry);
              } else {
                into.set(entry.documentId, [entry]);
              }
            }
          };

          // ONE read of every page row, grouped by document, placed before the cursor so it has
          // landed by the first record. This is the expensive read of the whole library and it is
          // unavoidable here — `listWhiteboards` is defined to return full documents. The library
          // UI does NOT use it; it calls `listWhiteboardSummaries`, which touches no page content.
          if (pagesStore) {
            const pagesRequest = pagesStore.getAll() as IDBRequest<StoredPageRecord[]>;

            pagesRequest.onsuccess = () => groupByDocument(pagesRequest.result ?? [], rowsByDocument);
            pagesRequest.onerror = () => reject(pagesRequest.error);
          }

          // The v6 journal, for boards that have not been split yet. Merging is mandatory — a list
          // must never hand back ink older than the last page save — but nothing here consolidates:
          // a list never splits a board. That happens on `loadWhiteboard`, once.
          if (journalStore) {
            const journalRequest = journalStore.getAll() as IDBRequest<PageJournalRecord[]>;

            journalRequest.onsuccess = () => groupByDocument(journalRequest.result ?? [], journalByDocument);
            journalRequest.onerror = () => reject(journalRequest.error);
          }

          const index = documentStore.index('updatedAt');
          const request = index.openCursor(null, 'prev');
          const results: WhiteboardDocument[] = [];

          request.onsuccess = () => {
            const cursor = request.result;

            if (!cursor) {
              return;
            }

            const documentId = String(cursor.primaryKey);
            const raw = cursor.value;
            const rows = rowsByDocument.get(documentId) ?? [];

            if (!hasInlinePages(raw) && pagesStore) {
              // Already split: assemble and hand back, writing nothing at all. A schema migration
              // that wants a resave gets it on the next `loadWhiteboard` of that board.
              const migrated = migrateLoadedRecord(assembleStoredRecord(raw as Record<string, unknown>, rows));

              if (migrated) {
                results.push(migrated.document);
              }

              cursor.continue();

              return;
            }

            const migrated = migrateLoadedRecord(raw);

            if (migrated) {
              const overlaid = applyPageOverlay(migrated.document, journalByDocument.get(documentId) ?? []);

              results.push(applyPageOverlay(overlaid, rows));

              // The migrate-and-resave writes the RECORD (unmerged, still inline), exactly as before
              // the split existed: merging is about what callers SEE, and a list never rewrites a
              // board's pages.
              if (migrated.changed) {
                cursor.update(migrated.document);
                // The record is being rewritten, so keep its summary in step in the SAME transaction.
                summaryStore?.put({ ...toWhiteboardSummary(migrated.document), id: documentId });
              }
            }

            cursor.continue();
          };

          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => resolve(results);
          transaction.onerror = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    listWhiteboardSummaries: async () => {
      const db = await ensureDb();

      return hasSummaryStore(db) ? await listSummariesReconciled(db) : await listSummariesFromDocuments(db);
    },

    deleteWhiteboard: async (id: string) => {
      const db = await ensureDb();

      await new Promise<void>((resolve, reject) => {
        try {
          const withSummary = hasSummaryStore(db);
          const withPages = hasPagesStore(db);
          const withJournal = hasPageJournalStore(db);
          const storeNames = [DOCUMENTS_STORE_NAME, PDF_ASSETS_STORE_NAME];

          if (withSummary) {
            storeNames.push(SUMMARIES_STORE_NAME);
          }

          if (withPages) {
            storeNames.push(PAGES_STORE_NAME);
          }

          if (withJournal) {
            storeNames.push(PAGE_JOURNAL_STORE_NAME);
          }

          const transaction = db.transaction(storeNames, 'readwrite');
          const documentStore = transaction.objectStore(DOCUMENTS_STORE_NAME);
          const assetStore = transaction.objectStore(PDF_ASSETS_STORE_NAME);
          const summaryStore = withSummary ? transaction.objectStore(SUMMARIES_STORE_NAME) : null;
          const pagesStore = withPages ? transaction.objectStore(PAGES_STORE_NAME) : null;
          const journalStore = withJournal ? transaction.objectStore(PAGE_JOURNAL_STORE_NAME) : null;
          const getRequest = documentStore.get(id);

          getRequest.onsuccess = () => {
            // A split record names its assets directly, so cascading the PDF blobs no longer costs
            // a read of the pages.
            const assetIds = storedPdfAssetIds(getRequest.result);

            documentStore.delete(id);
            // Same transaction as the document delete, so a deleted board can never linger in the list.
            summaryStore?.delete(id);
            clearPageRowsFor(pagesStore, id);
            clearPageJournalFor(journalStore, id);

            for (const assetId of Array.from(assetIds)) {
              assetStore.delete(assetId);
            }
          };

          getRequest.onerror = () => reject(getRequest.error);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    rekeyWhiteboard: async (oldId: string, newId: string) => {
      if (!oldId || !newId || oldId === newId) {
        return;
      }

      const db = await ensureDb();

      await new Promise<void>((resolve, reject) => {
        try {
          // ONE atomic transaction across every id-bearing store. pdfAssets (asset-id keyed) and
          // outbox-payloads (entry-id keyed) ride along with the moved doc/outbox rows untouched, so
          // they are intentionally NOT in the transaction. Abort-on-error leaves the old record fully
          // intact, so the board keeps working and the claim retries on next open.
          const withSummary = hasSummaryStore(db);
          const withPages = hasPagesStore(db);
          const withJournal = hasPageJournalStore(db);
          const storeNames = [DOCUMENTS_STORE_NAME, SYNC_CURSOR_STORE_NAME, OUTBOX_STORE_NAME];

          if (withSummary) {
            storeNames.push(SUMMARIES_STORE_NAME);
          }

          if (withPages) {
            storeNames.push(PAGES_STORE_NAME);
          }

          if (withJournal) {
            storeNames.push(PAGE_JOURNAL_STORE_NAME);
          }

          const transaction = db.transaction(storeNames, 'readwrite');
          const documentStore = transaction.objectStore(DOCUMENTS_STORE_NAME);
          const cursorStore = transaction.objectStore(SYNC_CURSOR_STORE_NAME);
          const outboxStore = transaction.objectStore(OUTBOX_STORE_NAME);
          const summaryStore = withSummary ? transaction.objectStore(SUMMARIES_STORE_NAME) : null;
          const pagesStore = withPages ? transaction.objectStore(PAGES_STORE_NAME) : null;
          const journalStore = withJournal ? transaction.objectStore(PAGE_JOURNAL_STORE_NAME) : null;
          let pageRows: StoredPageRecord[] = [];
          let journalEntries: PageJournalRecord[] = [];

          // Read the old id's rows BEFORE the record (request order = completion order), so the
          // pages can ride along into the new id instead of being stranded under a key nothing will
          // ever read again.
          if (pagesStore) {
            const pagesRequest = pagesStore.index(PAGES_DOCUMENT_INDEX).getAll(IDBKeyRange.only(oldId)) as IDBRequest<
              StoredPageRecord[]
            >;

            pagesRequest.onsuccess = () => {
              pageRows = pagesRequest.result ?? [];
            };
            pagesRequest.onerror = () => reject(pagesRequest.error);
          }

          if (journalStore) {
            const journalRequest = journalStore
              .index(PAGE_JOURNAL_DOCUMENT_INDEX)
              .getAll(IDBKeyRange.only(oldId)) as IDBRequest<PageJournalRecord[]>;

            journalRequest.onsuccess = () => {
              journalEntries = journalRequest.result ?? [];
            };
            journalRequest.onerror = () => reject(journalRequest.error);
          }

          const oldGet = documentStore.get(oldId);

          oldGet.onsuccess = () => {
            const oldRecord = oldGet.result as WhiteboardDocument | null | undefined;

            // Source already gone -> idempotent no-op (the tx completes with no writes).
            if (!oldRecord) {
              return;
            }

            // The old id is about to stop existing either way, so its journal must not outlive it.
            clearPageJournalFor(journalStore, oldId);

            const newGet = documentStore.get(newId);

            newGet.onsuccess = () => {
              // CRITICAL: re-key with RAW documentStore.delete, NEVER deleteWhiteboard() — that would
              // cascade-delete the shared pdfAssets that the just-written `newId` record still
              // references, orphaning imported-PDF blobs.
              if (newGet.result) {
                // `newId` already present (already-claimed / 200 path): just drop the stale old row
                // and the pages that belonged to it. Its summary was written alongside it, so only
                // the old summary needs dropping.
                documentStore.delete(oldId);
                clearPageRowsFor(pagesStore, oldId);
              } else if (pagesStore && !hasInlinePages(oldRecord)) {
                // Already split: move the META and re-key each page row. No page is deserialized
                // twice and the document record stays small.
                const movedRecord = { ...(oldRecord as unknown as StoredWhiteboardRecord), id: newId };

                documentStore.put(movedRecord);

                for (const row of pageRows) {
                  pagesStore.put({ ...row, key: pageRowKey(newId, row.pageId), documentId: newId });
                }

                // Queued AFTER the puts, and the index range is the OLD id, so the rows just written
                // under `newId` are not in its cursor's range.
                clearPageRowsFor(pagesStore, oldId);
                documentStore.delete(oldId);

                const movedSummary = summaryFromStoredRecord(movedRecord, newId);

                if (movedSummary) {
                  summaryStore?.put(movedSummary);
                }
              } else {
                // Legacy (or degraded): fold the pending page saves into the record as it moves, so
                // no stroke written since the last full save is lost by the claim. Splitting it at
                // the same time would be free here, but the claim path is the worst place to change
                // the shape of a board — the lazy split on the next load handles it.
                const normalizedOld = normalizeWhiteboardDocument(oldRecord);
                const overlaid = normalizedOld
                  ? applyPageOverlay(applyPageOverlay(normalizedOld, journalEntries), pageRows)
                  : oldRecord;
                const movedRecord = { ...overlaid, id: newId };

                documentStore.put(movedRecord);
                documentStore.delete(oldId);
                clearPageRowsFor(pagesStore, oldId);
                summaryStore?.put(toWhiteboardSummary(movedRecord));
              }

              summaryStore?.delete(oldId);
            };

            newGet.onerror = () => reject(newGet.error);

            // Migrate the per-document seq cursor (defensive: a never-synced UUID board has none, but
            // legacy/pre-guard rows might). Don't clobber an existing `newId` cursor.
            const cursorGet = cursorStore.get(oldId);

            cursorGet.onsuccess = () => {
              const oldCursor = cursorGet.result as { documentId?: string } | null | undefined;

              if (!oldCursor) {
                return;
              }

              const newCursorGet = cursorStore.get(newId);

              newCursorGet.onsuccess = () => {
                if (!newCursorGet.result) {
                  cursorStore.put({ ...oldCursor, documentId: newId });
                }

                cursorStore.delete(oldId);
              };

              newCursorGet.onerror = () => reject(newCursorGet.error);
            };

            cursorGet.onerror = () => reject(cursorGet.error);

            // Re-key the documentId field on any outbox entries (defensive; entry id + payload key
            // stay, so the entry-id-keyed payloads ride along with no migration).
            const outboxCursorRequest = outboxStore.index(OUTBOX_DOCUMENT_INDEX).openCursor(IDBKeyRange.only(oldId));

            outboxCursorRequest.onsuccess = () => {
              const cursor = outboxCursorRequest.result;

              if (!cursor) {
                return;
              }

              cursor.update({ ...(cursor.value as OutboxEntry), documentId: newId });
              cursor.continue();
            };

            outboxCursorRequest.onerror = () => reject(outboxCursorRequest.error);
          };

          oldGet.onerror = () => reject(oldGet.error);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    savePdfAsset: async (asset: WhiteboardPdfAsset) => {
      const db = await ensureDb();

      await new Promise<void>((resolve, reject) => {
        try {
          const transaction = db.transaction(PDF_ASSETS_STORE_NAME, 'readwrite');
          const assetStore = transaction.objectStore(PDF_ASSETS_STORE_NAME);

          assetStore.put(asset);

          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    loadPdfAsset: async (id: string) => {
      const db = await ensureDb();

      return await new Promise<WhiteboardPdfAsset | null>((resolve, reject) => {
        try {
          const transaction = db.transaction(PDF_ASSETS_STORE_NAME, 'readonly');
          const assetStore = transaction.objectStore(PDF_ASSETS_STORE_NAME);
          const request = assetStore.get(id);

          request.onsuccess = () => resolve((request.result as WhiteboardPdfAsset | null) ?? null);
          request.onerror = () => reject(request.error);
        } catch (error) {
          reject(error);
        }
      });
    },

    deletePdfAsset: async (id: string) => {
      const db = await ensureDb();

      await new Promise<void>((resolve, reject) => {
        try {
          const transaction = db.transaction(PDF_ASSETS_STORE_NAME, 'readwrite');
          const assetStore = transaction.objectStore(PDF_ASSETS_STORE_NAME);

          assetStore.delete(id);

          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      });
    },
  };

  return storage;
}

/**
 * Open (and migrate, via the shared {@link DB_VERSION} upgrade) the whiteboard IndexedDB
 * database. Use this to obtain an `IDBDatabase` for {@link createIndexedDbOutboxStore} when
 * sharing a single connection with {@link createIndexedDbWhiteboardStorage} is not needed.
 */
export function openWhiteboardDatabase(): Promise<IDBDatabase> {
  return openDB();
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * An {@link OutboxStore} backed by the `whiteboard-outbox` object store (added additively in
 * DB v3). Plugged into {@link createOutbox} this gives the pure durability queue real,
 * crash-surviving persistence. Each method runs in its own short transaction so callers do
 * not have to manage transaction lifetimes.
 */
export function createIndexedDbOutboxStore(db: IDBDatabase): OutboxStore {
  const tx = (mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(OUTBOX_STORE_NAME, mode).objectStore(OUTBOX_STORE_NAME);

  return {
    get: async (key: string): Promise<OutboxEntry | null> => {
      const result = await requestToPromise(tx('readonly').get(key) as IDBRequest<OutboxEntry | undefined>);

      return result ?? null;
    },

    put: async (entry: OutboxEntry): Promise<void> => {
      const store = tx('readwrite');

      store.put(entry);

      await transactionToPromise(store.transaction);
    },

    delete: async (key: string): Promise<void> => {
      const store = tx('readwrite');

      store.delete(key);

      await transactionToPromise(store.transaction);
    },

    list: async (): Promise<OutboxEntry[]> => {
      const result = await requestToPromise(tx('readonly').getAll() as IDBRequest<OutboxEntry[]>);

      return result;
    },
  };
}

/**
 * Convenience: open the whiteboard database and return a fully-wired {@link Outbox} over its
 * `whiteboard-outbox` store. The single most common way the syncer (FE-3) gets a durable outbox.
 */
export async function openWhiteboardOutbox(opts: OutboxOptions = {}): Promise<Outbox> {
  const db = await openWhiteboardDatabase();

  return createOutbox(createIndexedDbOutboxStore(db), opts);
}

/**
 * Durable store for the gzipped snapshot `Blob` of a single outbox entry (FE-3 §3). Keyed by
 * the entry id (= `entry.rawDataKey`). The blob is written BEFORE the entry is coalesced into
 * the outbox and deleted only after the cloud confirms the append (`markSynced`), so a crash
 * mid-sync never loses the exact bytes the entry points at. The doc store holds only current
 * state, so it cannot stand in for these frozen-per-entry payloads.
 */
export interface SnapshotPayloadStore {
  get(id: string): Promise<Blob | null>;
  put(id: string, blob: Blob): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Per-document cursor of the newest server seq this device has successfully synced (FE-3 §4).
 * Read at drain time to derive `baseSeq` (monotonic across a cycle, NOT the entry's frozen
 * base) and to power divergence detection + the "backed up at" status. First sync for a
 * document has no cursor → `get` returns `null` → `baseSeq: null`.
 */
export interface ServerSeqStore {
  get(documentId: string): Promise<number | null>;
  set(documentId: string, seq: number, syncedAt?: number): Promise<void>;
  getLastSyncedAt(documentId: string): Promise<number | null>;
}

/** Stored shape of a {@link SnapshotPayloadStore} record (keyPath `id`). */
interface SnapshotPayloadRecord {
  id: string;
  blob: Blob;
}

/** Stored shape of a {@link ServerSeqStore} record (keyPath `documentId`). */
interface SyncCursorRecord {
  documentId: string;
  lastSyncedServerSeq: number;
  lastSyncedAt: number;
}

/**
 * A {@link SnapshotPayloadStore} backed by the `whiteboard-outbox-payloads` object store (added
 * additively in DB v4). Blobs are stored natively — no base64 round-trip. Each method runs in
 * its own short transaction so callers do not manage transaction lifetimes.
 */
export function createIndexedDbPayloadStore(db: IDBDatabase): SnapshotPayloadStore {
  const tx = (mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(OUTBOX_PAYLOADS_STORE_NAME, mode).objectStore(OUTBOX_PAYLOADS_STORE_NAME);

  return {
    get: async (id: string): Promise<Blob | null> => {
      const result = await requestToPromise(tx('readonly').get(id) as IDBRequest<SnapshotPayloadRecord | undefined>);

      return result ? result.blob : null;
    },

    put: async (id: string, blob: Blob): Promise<void> => {
      const store = tx('readwrite');
      const record: SnapshotPayloadRecord = { id, blob };

      store.put(record);

      await transactionToPromise(store.transaction);
    },

    delete: async (id: string): Promise<void> => {
      const store = tx('readwrite');

      store.delete(id);

      await transactionToPromise(store.transaction);
    },
  };
}

/**
 * A {@link ServerSeqStore} backed by the `whiteboard-sync-cursor` object store (added additively
 * in DB v4). Each method runs in its own short transaction. `set` is a read-modify-write so a
 * caller that omits `syncedAt` does not clobber a previously recorded timestamp.
 */
export function createIndexedDbSyncCursorStore(db: IDBDatabase): ServerSeqStore {
  const tx = (mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(SYNC_CURSOR_STORE_NAME, mode).objectStore(SYNC_CURSOR_STORE_NAME);

  return {
    get: async (documentId: string): Promise<number | null> => {
      const result = await requestToPromise(tx('readonly').get(documentId) as IDBRequest<SyncCursorRecord | undefined>);

      return result ? result.lastSyncedServerSeq : null;
    },

    set: async (documentId: string, seq: number, syncedAt?: number): Promise<void> => {
      const store = tx('readwrite');
      const existing = await requestToPromise(store.get(documentId) as IDBRequest<SyncCursorRecord | undefined>);
      const record: SyncCursorRecord = {
        documentId,
        lastSyncedServerSeq: seq,
        lastSyncedAt: syncedAt ?? existing?.lastSyncedAt ?? Date.now(),
      };

      store.put(record);

      await transactionToPromise(store.transaction);
    },

    getLastSyncedAt: async (documentId: string): Promise<number | null> => {
      const result = await requestToPromise(tx('readonly').get(documentId) as IDBRequest<SyncCursorRecord | undefined>);

      return result ? result.lastSyncedAt : null;
    },
  };
}

/**
 * The single convenience the React syncer hook (FE-3) calls: open the whiteboard database once
 * (running the shared additive v4 upgrade) and return a fully-wired {@link Outbox} plus the
 * snapshot-payload and seq-cursor stores, all sharing that one connection. Mirrors
 * {@link openWhiteboardOutbox}.
 */
export async function openWhiteboardSyncEnvironment(opts: OutboxOptions = {}): Promise<{
  db: IDBDatabase;
  outbox: Outbox;
  payloads: SnapshotPayloadStore;
  cursor: ServerSeqStore;
}> {
  const db = await openWhiteboardDatabase();

  return {
    db,
    outbox: createOutbox(createIndexedDbOutboxStore(db), opts),
    payloads: createIndexedDbPayloadStore(db),
    cursor: createIndexedDbSyncCursorStore(db),
  };
}
