import test from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyMongoObjectId } from '../src/id';
import { WhiteboardApiError } from '../src/remote/client';
import { createOutbox } from '../src/sync/outbox';
import {
  createSnapshotSyncer,
  isSnapshotEndpointMissing,
  serializedSnapshotMetaFromDocument,
} from '../src/sync/snapshot-syncer';

import type {
  WhiteboardApiAppendDraftSnapshotInput,
  WhiteboardApiAppendDraftSnapshotResponse,
  WhiteboardApiDraftSnapshotUploadUrlResponse,
  WhiteboardApiListDraftSnapshotsResponse,
  WhiteboardApiSyncDraftInput,
  WhiteboardApiSyncDraftResponse,
  WhiteboardApiUploadUrl,
  WhiteboardApiGetUploadUrlParams,
} from '../src/remote/types';
import type { ServerSeqStore, SnapshotPayloadStore } from '../src/storage/indexeddb';
import type { Outbox, OutboxEntry, OutboxStore } from '../src/sync/outbox';
import type {
  SnapshotDivergenceEvent,
  SnapshotSyncerClient,
  SnapshotSyncerDeps,
  SnapshotSyncerEvents,
  SyncerStatus,
} from '../src/sync/snapshot-syncer';
import type { WhiteboardDocument } from '../src/types';

// --- fakes -----------------------------------------------------------------------------------

function createMemoryOutboxStore(): OutboxStore {
  const map = new Map<string, OutboxEntry>();

  return {
    get: async (key) => map.get(key) ?? null,
    put: async (entry) => {
      map.set(entry.id, { ...entry });
    },
    delete: async (key) => {
      map.delete(key);
    },
    list: async () => Array.from(map.values(), (entry) => ({ ...entry })),
  };
}

function createMemoryPayloadStore(): SnapshotPayloadStore & { snapshot: () => string[] } {
  const map = new Map<string, Blob>();

  return {
    get: async (id) => map.get(id) ?? null,
    put: async (id, blob) => {
      map.set(id, blob);
    },
    delete: async (id) => {
      map.delete(id);
    },
    snapshot: () => Array.from(map.keys()),
  };
}

function createMemoryCursorStore(): ServerSeqStore {
  const seq = new Map<string, number>();
  const at = new Map<string, number>();

  return {
    get: async (documentId) => (seq.has(documentId) ? (seq.get(documentId) as number) : null),
    set: async (documentId, value, syncedAt) => {
      seq.set(documentId, value);
      at.set(documentId, syncedAt ?? Date.now());
    },
    getLastSyncedAt: async (documentId) => (at.has(documentId) ? (at.get(documentId) as number) : null),
  };
}

type CallLog = string[];

interface FakeClientOptions {
  appendResponse?:
    | WhiteboardApiAppendDraftSnapshotResponse
    | ((input: WhiteboardApiAppendDraftSnapshotInput) => WhiteboardApiAppendDraftSnapshotResponse);
  appendError?: () => Error;
  uploadUrlError?: () => Error;
  uploadUrlResponse?: WhiteboardApiDraftSnapshotUploadUrlResponse;
  syncDraftResponse?: WhiteboardApiSyncDraftResponse;
}

interface FakeClient extends SnapshotSyncerClient {
  log: CallLog;
  appendInputs: WhiteboardApiAppendDraftSnapshotInput[];
  syncDraftInputs: WhiteboardApiSyncDraftInput[];
  getUploadUrlParams: (WhiteboardApiGetUploadUrlParams | undefined)[];
}

function createFakeClient(options: FakeClientOptions = {}): FakeClient {
  const log: CallLog = [];
  const appendInputs: WhiteboardApiAppendDraftSnapshotInput[] = [];
  const syncDraftInputs: WhiteboardApiSyncDraftInput[] = [];
  const getUploadUrlParams: (WhiteboardApiGetUploadUrlParams | undefined)[] = [];

  return {
    log,
    appendInputs,
    syncDraftInputs,
    getUploadUrlParams,
    requestDraftSnapshotUploadUrl: async (): Promise<WhiteboardApiDraftSnapshotUploadUrlResponse> => {
      log.push('requestDraftSnapshotUploadUrl');

      if (options.uploadUrlError) {
        throw options.uploadUrlError();
      }

      return (
        options.uploadUrlResponse ?? {
          uploadUrl: 'https://b2.example.com/upload/snap',
          storageKey: 'snapshots/doc-1/snap.json.gz',
          publicUrl: 'https://cdn.example.com/snapshots/doc-1/snap.json.gz',
        }
      );
    },
    appendDraftSnapshot: async (_documentId, input): Promise<WhiteboardApiAppendDraftSnapshotResponse> => {
      log.push('appendDraftSnapshot');
      appendInputs.push(input);

      if (options.appendError) {
        throw options.appendError();
      }

      if (typeof options.appendResponse === 'function') {
        return options.appendResponse(input);
      }

      return options.appendResponse ?? { seq: 1, latestSeq: 1, diverged: false };
    },
    listDraftSnapshots: async (): Promise<WhiteboardApiListDraftSnapshotsResponse> => {
      log.push('listDraftSnapshots');

      return { snapshots: [] };
    },
    getUploadUrl: async (_documentId, params): Promise<WhiteboardApiUploadUrl> => {
      log.push('getUploadUrl');
      getUploadUrlParams.push(params);

      return {
        uploadUrl: 'https://b2.example.com/upload/legacy',
        publicUrl: 'https://cdn.example.com/legacy/draft.json.gz',
      };
    },
    syncDraft: async (_documentId, input): Promise<WhiteboardApiSyncDraftResponse> => {
      log.push('syncDraft');
      syncDraftInputs.push(input);

      return options.syncDraftResponse ?? { synced: true, draftUpdatedAt: '2026-06-14T10:00:00.000Z' };
    },
  };
}

// A realistic Mongo _id (24 hex chars) so the syncer treats the doc as cloud-syncable. The new
// non-ObjectId guard would skip a plain id like 'doc-1', so the whole suite uses a real ObjectId.
const DOC_ID = 'a1b2c3d4e5f60718293a4b5c';

function makeDoc(overrides: Partial<WhiteboardDocument> = {}): WhiteboardDocument {
  return {
    id: DOC_ID,
    title: 'My Board',
    pages: [
      {
        id: 'page-1',
        canvasJSON: '{}',
        thumbnail: '',
        backgroundType: 'blank',
      },
    ],
    currentPageIndex: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    thumbnail: 'data:thumb',
    ...overrides,
  };
}

interface Harness {
  syncer: ReturnType<typeof createSnapshotSyncer>;
  outbox: Outbox;
  payloads: SnapshotPayloadStore & { snapshot: () => string[] };
  cursor: ServerSeqStore;
  client: FakeClient;
  uploadCalls: { uploadUrl: string; contentType: string }[];
  statuses: SyncerStatus[];
  diverged: SnapshotDivergenceEvent[];
  legacyFallbacks: number;
}

function createHarness(
  client: FakeClient,
  opts: {
    serialize?: SnapshotSyncerDeps['serialize'];
    getLatestDocSnapshot?: SnapshotSyncerDeps['getLatestDocSnapshot'];
    now?: () => number;
    /** Bind the engine to one board (the editor's shape). Unbound by default. */
    documentId?: string;
  } = {},
): Harness {
  const outbox = createOutbox(createMemoryOutboxStore(), { now: opts.now });
  const payloads = createMemoryPayloadStore();
  const cursor = createMemoryCursorStore();
  const uploadCalls: { uploadUrl: string; contentType: string }[] = [];
  const statuses: SyncerStatus[] = [];
  const diverged: SnapshotDivergenceEvent[] = [];
  let legacyFallbacks = 0;

  const events: SnapshotSyncerEvents = {
    onStatus: (status) => {
      statuses.push(status);
    },
    onDiverged: (event) => {
      diverged.push(event);
    },
    onLegacyFallback: () => {
      legacyFallbacks += 1;
    },
  };

  const serialize: SnapshotSyncerDeps['serialize'] =
    opts.serialize ??
    (async () => ({ blob: new Blob(['serialized']), contentType: 'application/octet-stream', fileSize: 10 }));

  const deps: SnapshotSyncerDeps = {
    runWithClient: (fn) => fn(client),
    outbox,
    payloads,
    cursor,
    uploadBlob: async (uploadUrl, _blob, contentType) => {
      uploadCalls.push({ uploadUrl, contentType });
    },
    getLatestDocSnapshot: opts.getLatestDocSnapshot ?? (async () => null),
    serialize,
    deviceId: 'device-a',
    now: opts.now,
    documentId: opts.documentId,
  };

  const syncer = createSnapshotSyncer(deps, events);

  return {
    syncer,
    outbox,
    payloads,
    cursor,
    client,
    uploadCalls,
    statuses,
    diverged,
    get legacyFallbacks() {
      return legacyFallbacks;
    },
  } as Harness;
}

async function pendingEntry(outbox: Outbox, documentId = DOC_ID): Promise<OutboxEntry | null> {
  return outbox.latest(documentId);
}

// --- navigator helpers -----------------------------------------------------------------------

function withOnline(value: boolean, fn: () => Promise<void>): Promise<void> {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'navigator');
  const previous = (globalThis as { navigator?: unknown }).navigator;

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: value },
    writable: true,
  });

  const restore = (): void => {
    if (had) {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previous,
        writable: true,
      });
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  };

  return fn().finally(restore);
}

// --- tests -----------------------------------------------------------------------------------

test('isSnapshotEndpointMissing detects 404 and 405 WhiteboardApiError only', () => {
  assert.equal(isSnapshotEndpointMissing(new WhiteboardApiError('x', 404, null)), true);
  assert.equal(isSnapshotEndpointMissing(new WhiteboardApiError('x', 405, null)), true);
  assert.equal(isSnapshotEndpointMissing(new WhiteboardApiError('x', 500, null)), false);
  assert.equal(isSnapshotEndpointMissing(new Error('x')), false);
});

test('happy path: cursor + markSynced advance ONLY after append resolves; payload deleted', async () => {
  const client = createFakeClient({ appendResponse: { seq: 5, latestSeq: 5, diverged: false } });
  const h = createHarness(client);

  await h.syncer.enqueueFromDocument(makeDoc());

  // Order: upload-url -> append must precede markSynced. We assert append is logged before any
  // local advance by checking the client call order AND the final state.
  assert.deepEqual(client.log, ['requestDraftSnapshotUploadUrl', 'appendDraftSnapshot']);
  assert.equal(client.appendInputs.length, 1);

  const entry = await pendingEntry(h.outbox);

  assert.ok(entry);
  assert.equal(entry?.status, 'synced');
  assert.equal(entry?.serverSeq, 5);
  assert.equal(await h.cursor.get(DOC_ID), 5);
  assert.deepEqual(h.payloads.snapshot(), []);
  assert.ok(h.statuses.includes('syncing'));
  assert.ok(h.statuses.includes('synced'));
  // first sync sends baseSeq null and the publicUrl-derived rawDataUrl
  assert.equal(client.appendInputs[0]?.baseSeq, null);
  assert.equal(client.appendInputs[0]?.rawDataUrl, 'https://cdn.example.com/snapshots/doc-1/snap.json.gz');
  assert.equal(client.appendInputs[0]?.fileSize, 10);
});

test('append called BEFORE markSynced (ordering captured via cursor-read side effect)', async () => {
  const order: string[] = [];
  const client = createFakeClient();

  client.appendDraftSnapshot = async (_documentId, input) => {
    order.push('append');
    client.appendInputs.push(input);

    return { seq: 2, latestSeq: 2, diverged: false };
  };

  const h = createHarness(client);
  const baseCursorSet = h.cursor.set.bind(h.cursor);

  h.cursor.set = async (documentId, seq, syncedAt) => {
    order.push('cursor.set');

    return baseCursorSet(documentId, seq, syncedAt);
  };

  const baseMarkSynced = h.outbox.markSynced.bind(h.outbox);

  h.outbox.markSynced = async (id, seq) => {
    order.push('markSynced');

    return baseMarkSynced(id, seq);
  };

  await h.syncer.enqueueFromDocument(makeDoc());

  assert.deepEqual(order, ['append', 'cursor.set', 'markSynced']);
});

test('omits rawDataUrl when upload-url response has no publicUrl (server derives it)', async () => {
  const client = createFakeClient({
    uploadUrlResponse: { uploadUrl: 'https://b2.example.com/u', storageKey: 'snapshots/doc-1/k.json.gz' },
  });
  const h = createHarness(client);

  await h.syncer.enqueueFromDocument(makeDoc());

  assert.equal('rawDataUrl' in (client.appendInputs[0] ?? {}), false);
  assert.equal(client.appendInputs[0]?.storageKey, 'snapshots/doc-1/k.json.gz');
});

test('thrown append => markFailed, NOT markSynced; payload retained; cursor not advanced', async () => {
  const client = createFakeClient({ appendError: () => new WhiteboardApiError('boom', 500, null) });
  const h = createHarness(client);

  await h.syncer.enqueueFromDocument(makeDoc());

  const entry = await pendingEntry(h.outbox);

  assert.ok(entry);
  assert.equal(entry?.status, 'failed');
  assert.equal(entry?.attempts, 1);
  assert.equal(entry?.serverSeq, undefined);
  assert.equal(await h.cursor.get(DOC_ID), null);
  // payload retained (keyed by entry.id) for the retry
  assert.deepEqual(h.payloads.snapshot(), [entry?.id]);
  assert.ok(h.statuses.includes('retrying'));
  assert.equal(h.statuses.includes('synced'), false);
});

test('diverged:true => onDiverged fired AND still markSynced (keep both)', async () => {
  const client = createFakeClient({
    appendResponse: {
      seq: 9,
      latestSeq: 9,
      diverged: true,
      otherBranch: { seq: 8, deviceId: 'device-b', createdAt: '2026-06-14T09:00:00.000Z' },
    },
  });
  const h = createHarness(client);

  await h.syncer.enqueueFromDocument(makeDoc());

  const entry = await pendingEntry(h.outbox);

  assert.equal(entry?.status, 'synced');
  assert.equal(entry?.serverSeq, 9);
  assert.equal(await h.cursor.get(DOC_ID), 9);
  assert.equal(h.diverged.length, 1);
  assert.equal(h.diverged[0]?.documentId, DOC_ID);
  assert.equal(h.diverged[0]?.serverSeq, 9);
  assert.deepEqual(h.diverged[0]?.otherBranch, {
    seq: 8,
    deviceId: 'device-b',
    createdAt: '2026-06-14T09:00:00.000Z',
  });
  assert.ok(h.statuses.includes('diverged'));
  // nothing discarded — payload deleted only because the append CONFIRMED
  assert.deepEqual(h.payloads.snapshot(), []);
});

test('404 on append => onLegacyFallback fired once + syncDraft path used + markSynced', async () => {
  const client = createFakeClient({
    appendError: () => new WhiteboardApiError('Not Found', 404, { message: 'Not Found' }),
  });
  const h = createHarness(client);

  await h.syncer.enqueueFromDocument(makeDoc());

  // New path attempted, 404, then legacy path: getUploadUrl(type:draft) -> upload -> syncDraft.
  assert.deepEqual(client.log, ['requestDraftSnapshotUploadUrl', 'appendDraftSnapshot', 'getUploadUrl', 'syncDraft']);
  assert.equal(h.legacyFallbacks, 1);
  assert.deepEqual(client.getUploadUrlParams[0], { type: 'draft' });

  const entry = await pendingEntry(h.outbox);

  assert.equal(entry?.status, 'synced');
  // synthetic seq = entry.localSeq (legacy is seq-less). cursor NOT advanced.
  assert.equal(entry?.serverSeq, entry?.localSeq);
  assert.equal(await h.cursor.get(DOC_ID), null);
  assert.deepEqual(h.payloads.snapshot(), []);

  // A subsequent enqueue routes straight to legacy (no append retry, no second fallback event).
  await h.syncer.enqueueFromDocument(makeDoc({ title: 'Second' }));

  assert.equal(h.legacyFallbacks, 1);
  assert.equal(client.log.filter((c) => c === 'appendDraftSnapshot').length, 1);
  assert.equal(client.log.filter((c) => c === 'syncDraft').length, 2);
});

test('offline => emits "offline" and touches no network', async () => {
  await withOnline(false, async () => {
    const client = createFakeClient();
    const h = createHarness(client);

    await h.syncer.enqueueFromDocument(makeDoc());

    assert.deepEqual(client.log, []);
    assert.deepEqual(h.uploadCalls, []);
    assert.ok(h.statuses.includes('offline'));

    // The entry is captured locally (durability) and its payload persisted, ready for re-drain.
    const entry = await pendingEntry(h.outbox);

    assert.equal(entry?.status, 'pending');
    assert.deepEqual(h.payloads.snapshot(), [entry?.id]);

    // Back online → a drain flushes it.
    await withOnline(true, async () => {
      await h.syncer.drain('online');
    });

    const flushed = await pendingEntry(h.outbox);

    assert.equal(flushed?.status, 'synced');
  });
});

test('coalesced enqueue (two before drain) => one upload of the latest title', async () => {
  let serializeCount = 0;
  const client = createFakeClient();
  const h = createHarness(client, {
    serialize: async () => {
      serializeCount += 1;

      return { blob: new Blob([`s${serializeCount}`]), contentType: 'application/octet-stream', fileSize: 5 };
    },
  });

  // Fire two enqueues "simultaneously" — the outbox serializes upsertPending so the second
  // coalesces onto the first pending entry; the in-flight drain guard collapses to one cycle.
  const first = h.syncer.enqueueFromDocument(makeDoc({ title: 'First' }));
  const second = h.syncer.enqueueFromDocument(makeDoc({ title: 'Second' }));

  await Promise.all([first, second]);

  // Exactly one document-state reached the cloud (one append), carrying the LATEST title.
  const appends = client.log.filter((c) => c === 'appendDraftSnapshot').length;

  assert.equal(appends, 1);
  assert.equal(client.appendInputs[0]?.title, 'Second');

  const entry = await pendingEntry(h.outbox);

  assert.equal(entry?.status, 'synced');
  // Only one outbox entry exists for the doc (coalesced, not two).
  const all = await h.outbox.pendingCount(DOC_ID);

  assert.equal(all, 0);
});

test('reclaimInflight runs on cold start (stranded inflight re-drains)', async () => {
  const client = createFakeClient({ appendResponse: { seq: 3, latestSeq: 3, diverged: false } });
  const h = createHarness(client);

  // Simulate a crash: an entry stranded `inflight` (its blob still on disk).
  const stranded = await h.outbox.enqueue({
    documentId: DOC_ID,
    deviceId: 'device-a',
    baseSeq: null,
    pageCount: 1,
    title: 'Crashed',
    thumbnail: null,
    fileSize: 7,
  });

  await h.outbox.markInflight(stranded.id);
  await h.payloads.put(stranded.id, new Blob(['stranded-bytes']));

  // Cold start drain: reclaimInflight flips it back to failed (=> due) and it syncs.
  await h.syncer.drain('startup');

  const entry = await pendingEntry(h.outbox);

  assert.equal(entry?.id, stranded.id);
  assert.equal(entry?.status, 'synced');
  assert.equal(entry?.serverSeq, 3);
  assert.equal(client.log.filter((c) => c === 'appendDraftSnapshot').length, 1);
});

test('fallback re-serialize is used when the payload blob is missing', async () => {
  const client = createFakeClient({ appendResponse: { seq: 1, latestSeq: 1, diverged: false } });
  const h = createHarness(client, {
    getLatestDocSnapshot: async () => makeDoc({ title: 'FromDocStore' }),
  });

  // Enqueue, then wipe the payload before drain to force the fallback path.
  const entry = await h.outbox.enqueue({
    documentId: DOC_ID,
    deviceId: 'device-a',
    baseSeq: null,
    pageCount: 1,
    title: 'X',
    thumbnail: null,
    fileSize: 3,
  });

  // No payload stored at all → loadEntryBlob falls back to getLatestDocSnapshot + serialize.
  await h.syncer.drain('manual');

  const after = await h.outbox.latest(DOC_ID);

  assert.equal(after?.status, 'synced');
  assert.equal(after?.id, entry.id);
  assert.equal(h.uploadCalls.length, 1);
});

test('baseSeq is read from the freshest cursor at drain time (second sync sends prior seq)', async () => {
  const client = createFakeClient({
    appendResponse: (input) => ({ seq: input.baseSeq === null ? 4 : 7, latestSeq: 7, diverged: false }),
  });
  const h = createHarness(client);

  await h.syncer.enqueueFromDocument(makeDoc({ title: 'one' }));

  assert.equal(client.appendInputs[0]?.baseSeq, null);
  assert.equal(await h.cursor.get(DOC_ID), 4);

  await h.syncer.enqueueFromDocument(makeDoc({ title: 'two' }));

  assert.equal(client.appendInputs[1]?.baseSeq, 4);
  assert.equal(await h.cursor.get(DOC_ID), 7);
});

test('stop() prevents further drains', async () => {
  const client = createFakeClient();
  const h = createHarness(client);

  h.syncer.stop();
  await h.syncer.enqueueFromDocument(makeDoc());

  assert.deepEqual(client.log, []);
  assert.deepEqual(h.uploadCalls, []);
});

// --- non-ObjectId guard (orphaned local/imported boards) -------------------------------------

test('isLikelyMongoObjectId accepts 24-hex ids and rejects UUIDs / other strings', () => {
  // 24 hex chars (a real Mongo _id) — true, case-insensitive.
  assert.equal(isLikelyMongoObjectId('a1b2c3d4e5f60718293a4b5c'), true);
  assert.equal(isLikelyMongoObjectId('A1B2C3D4E5F60718293A4B5C'), true);
  assert.equal(isLikelyMongoObjectId('507f1f77bcf86cd799439011'), true);
  // Client UUID (createWhiteboardId output) — false.
  assert.equal(isLikelyMongoObjectId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), false);
  // Wrong length (too short / too long).
  assert.equal(isLikelyMongoObjectId('a1b2c3'), false);
  assert.equal(isLikelyMongoObjectId('a1b2c3d4e5f60718293a4b5c7'), false);
  // Non-hex character present.
  assert.equal(isLikelyMongoObjectId('g1b2c3d4e5f60718293a4b5c'), false);
  // Other placeholder-ish strings.
  assert.equal(isLikelyMongoObjectId('doc-1'), false);
  assert.equal(isLikelyMongoObjectId(''), false);
});

test('drain SKIPS a non-ObjectId entry: no client calls, entry + payload untouched, no error status', async () => {
  const client = createFakeClient();
  const h = createHarness(client);
  const localId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'; // client UUID, not a Mongo _id

  // Enqueue directly into the outbox (enqueueFromDocument itself early-returns for a UUID, so we
  // seed an orphaned entry the way a pre-fix session could have left one in the durable outbox).
  const entry = await h.outbox.enqueue({
    documentId: localId,
    deviceId: 'device-a',
    baseSeq: null,
    pageCount: 1,
    title: 'Local board',
    thumbnail: null,
    fileSize: 4,
  });

  await h.payloads.put(entry.id, new Blob(['local-bytes']));

  await h.syncer.drain('manual');

  // No network whatsoever — no upload-url / append / getUploadUrl / syncDraft, no blob upload.
  assert.deepEqual(client.log, []);
  assert.deepEqual(h.uploadCalls, []);

  // Entry left exactly as it was (still pending, never failed) and its blob retained → no data loss.
  const after = await h.outbox.latest(localId);

  assert.equal(after?.status, 'pending');
  assert.equal(after?.attempts, 0);
  assert.deepEqual(h.payloads.snapshot(), [entry.id]);

  // The skip must NOT drive an error/diverged/syncing status (never pollutes the open board's UI).
  assert.equal(h.statuses.includes('syncing'), false);
  assert.equal(h.statuses.includes('retrying'), false);
  assert.equal(h.statuses.includes('diverged'), false);
});

test('drain DOES call the client for a 24-hex ObjectId entry', async () => {
  const client = createFakeClient({ appendResponse: { seq: 1, latestSeq: 1, diverged: false } });
  const h = createHarness(client);

  // makeDoc()'s id is a valid ObjectId (DOC_ID) → it enqueues and the drain hits the client.
  await h.syncer.enqueueFromDocument(makeDoc());

  assert.deepEqual(client.log, ['requestDraftSnapshotUploadUrl', 'appendDraftSnapshot']);

  const entry = await pendingEntry(h.outbox);

  assert.equal(entry?.status, 'synced');
});

test('enqueueFromDocument SKIPS a non-ObjectId doc: nothing enqueued, no network', async () => {
  const client = createFakeClient();
  const h = createHarness(client);

  await h.syncer.enqueueFromDocument(makeDoc({ id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }));

  assert.deepEqual(client.log, []);
  assert.deepEqual(h.uploadCalls, []);
  assert.deepEqual(h.payloads.snapshot(), []);
  assert.equal(await h.outbox.pendingCount(), 0);
});

test('drain processes the healthy ObjectId board even when an orphaned UUID entry is also due', async () => {
  const client = createFakeClient({ appendResponse: { seq: 2, latestSeq: 2, diverged: false } });
  const h = createHarness(client);
  const localId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  // An orphaned local entry sitting in the outbox alongside the healthy board's edits.
  const orphan = await h.outbox.enqueue({
    documentId: localId,
    deviceId: 'device-a',
    baseSeq: null,
    pageCount: 1,
    title: 'Local board',
    thumbnail: null,
    fileSize: 4,
  });

  await h.payloads.put(orphan.id, new Blob(['local-bytes']));

  // Healthy ObjectId board enqueues + drains; the orphan must not block or error it.
  await h.syncer.enqueueFromDocument(makeDoc());

  // Exactly one append (the healthy board); the orphan generated zero network calls.
  assert.equal(client.log.filter((c) => c === 'appendDraftSnapshot').length, 1);

  const healthy = await pendingEntry(h.outbox);

  assert.equal(healthy?.status, 'synced');
  assert.ok(h.statuses.includes('synced'));

  // Orphan still untouched, no error status raised by it.
  const orphanAfter = await h.outbox.latest(localId);

  assert.equal(orphanAfter?.status, 'pending');
  assert.equal(h.statuses.includes('retrying'), false);
});


// --- off-thread capture (enqueueSerialized / captureSerialized) --------------------------------

test('serializedSnapshotMetaFromDocument projects exactly the outbox fields', () => {
  const meta = serializedSnapshotMetaFromDocument(makeDoc({ title: 'Board', thumbnail: '' }));

  assert.deepEqual(meta, {
    id: DOC_ID,
    pageCount: 1,
    title: 'Board',
    // An empty thumbnail normalizes to null, exactly as captureFromDocument always wrote it.
    thumbnail: null,
    updatedAt: 2_000,
  });
});

test('enqueueSerialized stores the GIVEN blob, records its metadata, and drains', async () => {
  const client = createFakeClient();
  // The serializer must never run on this path: the worker already did it.
  let serializeCalls = 0;
  const h = createHarness(client, {
    serialize: async () => {
      serializeCalls += 1;

      return { blob: new Blob(['main-thread']), contentType: 'application/octet-stream' };
    },
  });

  const blob = new Blob(['worker-gzip-bytes']);

  await h.syncer.enqueueSerialized(
    { id: DOC_ID, pageCount: 7, title: 'From worker', thumbnail: 'data:thumb', updatedAt: 9_000 },
    { blob, contentType: 'application/octet-stream', fileSize: 4_242 },
  );

  assert.equal(serializeCalls, 0);

  const entry = await pendingEntry(h.outbox);

  assert.equal(entry?.status, 'synced');
  assert.equal(entry?.pageCount, 7);
  assert.equal(entry?.title, 'From worker');
  assert.equal(entry?.thumbnail, 'data:thumb');
  assert.equal(entry?.fileSize, 4_242);

  // Drained: one upload + one append, and the payload was deleted on confirm.
  assert.equal(h.uploadCalls.length, 1);
  assert.equal(client.log.filter((c) => c === 'appendDraftSnapshot').length, 1);
  assert.deepEqual(h.payloads.snapshot(), []);
  assert.equal(client.appendInputs[0]?.fileSize, 4_242);
});

test('enqueueSerialized falls back to blob.size when fileSize is absent', async () => {
  const client = createFakeClient();
  const h = createHarness(client);
  const blob = new Blob(['0123456789']);

  await h.syncer.enqueueSerialized(serializedSnapshotMetaFromDocument(makeDoc()), {
    blob,
    contentType: 'application/octet-stream',
  });

  assert.equal(client.appendInputs[0]?.fileSize, blob.size);
});

test('captureSerialized writes the outbox entry + payload WITHOUT draining', async () => {
  const client = createFakeClient();
  const h = createHarness(client);
  const blob = new Blob(['worker-gzip-bytes']);

  await h.syncer.captureSerialized(serializedSnapshotMetaFromDocument(makeDoc({ title: 'Captured' })), {
    blob,
    contentType: 'application/octet-stream',
  });

  const entry = await pendingEntry(h.outbox);

  assert.equal(entry?.status, 'pending');
  assert.equal(entry?.title, 'Captured');
  assert.deepEqual(h.payloads.snapshot(), [entry?.id]);
  // No drain was triggered: the multi-board worker owns when a board goes out.
  assert.deepEqual(client.log, []);
});

test('captureSerialized REFUSES a non-ObjectId id: nothing enqueued, nothing stored', async () => {
  const client = createFakeClient();
  const h = createHarness(client);
  const localId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  await h.syncer.captureSerialized(
    { id: localId, pageCount: 1, title: 'Local board', thumbnail: null, updatedAt: 1 },
    { blob: new Blob(['bytes']), contentType: 'application/octet-stream' },
  );

  assert.equal(await h.outbox.latest(localId), null);
  assert.deepEqual(h.payloads.snapshot(), []);
  assert.deepEqual(client.log, []);
});

test('captureSerialized REFUSES a foreign document on a bound engine', async () => {
  const client = createFakeClient();
  const otherDocId = 'b1b2c3d4e5f60718293a4b5c';
  const h = createHarness(client, { documentId: DOC_ID });

  await h.syncer.captureSerialized(
    { id: otherDocId, pageCount: 1, title: 'Another teacher', thumbnail: null, updatedAt: 1 },
    { blob: new Blob(['bytes']), contentType: 'application/octet-stream' },
  );

  assert.equal(await h.outbox.latest(otherDocId), null);
  assert.deepEqual(h.payloads.snapshot(), []);

  // The engine's OWN board still captures normally.
  await h.syncer.captureSerialized(serializedSnapshotMetaFromDocument(makeDoc()), {
    blob: new Blob(['bytes']),
    contentType: 'application/octet-stream',
  });

  assert.equal((await pendingEntry(h.outbox))?.status, 'pending');
});

test('stop() makes enqueueSerialized a no-op', async () => {
  const client = createFakeClient();
  const h = createHarness(client);

  h.syncer.stop();

  await h.syncer.enqueueSerialized(serializedSnapshotMetaFromDocument(makeDoc()), {
    blob: new Blob(['bytes']),
    contentType: 'application/octet-stream',
  });

  assert.equal(await pendingEntry(h.outbox), null);
  assert.deepEqual(client.log, []);
});
