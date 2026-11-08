import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutbox } from '../src/sync/outbox';
import { createSnapshotSyncer } from '../src/sync/snapshot-syncer';

import type {
  WhiteboardApiAppendDraftSnapshotResponse,
  WhiteboardApiDraftSnapshotUploadUrlResponse,
  WhiteboardApiListDraftSnapshotsResponse,
  WhiteboardApiSyncDraftResponse,
  WhiteboardApiUploadUrl,
} from '../src/remote/types';
import type { ServerSeqStore, SnapshotPayloadStore } from '../src/storage/indexeddb';
import type { Outbox, OutboxEntry, OutboxStore } from '../src/sync/outbox';
import type { SnapshotSyncerClient, SnapshotSyncerDeps } from '../src/sync/snapshot-syncer';
import type { WhiteboardDocument } from '../src/types';

/**
 * The document-scoped half of the sync engine — the API the app-wide auto-upload worker runs on.
 *
 * Every case here asserts an IDENTITY or a COUNT, never just "it did not throw": the failure this
 * whole feature class produces is a board that uploads under the WRONG teacher's key, or a second
 * copy of a snapshot that was already in flight. Both look like success from the outside.
 */

/* ------------------------------------------------------------------ fakes */

function memoryOutboxStore(): OutboxStore {
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

function memoryPayloadStore(): SnapshotPayloadStore & { keys: () => string[] } {
  const map = new Map<string, Blob>();

  return {
    get: async (id) => map.get(id) ?? null,
    put: async (id, blob) => {
      map.set(id, blob);
    },
    delete: async (id) => {
      map.delete(id);
    },
    keys: () => Array.from(map.keys()),
  };
}

function memoryCursorStore(): ServerSeqStore {
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

/** A client that remembers which documents IT was asked to upload — the identity under test. */
interface LabelledClient extends SnapshotSyncerClient {
  label: string;
  appended: string[];
}

function labelledClient(label: string): LabelledClient {
  const appended: string[] = [];

  return {
    label,
    appended,
    requestDraftSnapshotUploadUrl: async (): Promise<WhiteboardApiDraftSnapshotUploadUrlResponse> => ({
      uploadUrl: `https://b2.example.com/${label}`,
      storageKey: `snapshots/${label}.json.gz`,
      publicUrl: `https://cdn.example.com/${label}.json.gz`,
    }),
    appendDraftSnapshot: async (documentId): Promise<WhiteboardApiAppendDraftSnapshotResponse> => {
      appended.push(documentId);

      return { seq: appended.length, latestSeq: appended.length, diverged: false };
    },
    listDraftSnapshots: async (): Promise<WhiteboardApiListDraftSnapshotsResponse> => ({ snapshots: [] }),
    getUploadUrl: async (): Promise<WhiteboardApiUploadUrl> => ({
      uploadUrl: `https://b2.example.com/${label}/legacy`,
      publicUrl: `https://cdn.example.com/${label}/legacy.json.gz`,
    }),
    syncDraft: async (): Promise<WhiteboardApiSyncDraftResponse> => ({
      synced: true,
      draftUpdatedAt: '2026-08-20T10:00:00.000Z',
    }),
  };
}

// Two real 24-hex ObjectIds: the engine refuses anything else, so a fake id would silently skip
// every assertion below.
const DOC_A = 'a1b2c3d4e5f60718293a4b5c';
const DOC_B = 'b1b2c3d4e5f60718293a4b5c';

function makeDoc(id: string, overrides: Partial<WhiteboardDocument> = {}): WhiteboardDocument {
  return {
    id,
    title: `Board ${id.slice(0, 4)}`,
    pages: [{ id: 'page-1', canvasJSON: '{}', thumbnail: '', backgroundType: 'blank' }],
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
  payloads: ReturnType<typeof memoryPayloadStore>;
  clientsFor: string[];
}

function createHarness(
  clientForDocument: (documentId: string) => LabelledClient,
  opts: { now?: () => number } = {},
): Harness {
  const outbox = createOutbox(memoryOutboxStore(), { now: opts.now });
  const payloads = memoryPayloadStore();
  const clientsFor: string[] = [];

  const deps: SnapshotSyncerDeps = {
    // Deliberately explosive: the worker path must NEVER fall back to a single ambient client,
    // and a test that silently did would otherwise pass.
    runWithClient: () => Promise.reject(new Error('the document-scoped engine must resolve a client per document')),
    runWithClientForDocument: (documentId) => {
      clientsFor.push(documentId);
      const client = clientForDocument(documentId);

      return (fn) => fn(client);
    },
    outbox,
    payloads,
    cursor: memoryCursorStore(),
    uploadBlob: async () => {},
    getLatestDocSnapshot: async () => null,
    serialize: async () => ({ blob: new Blob(['snapshot']), contentType: 'application/octet-stream', fileSize: 8 }),
    deviceId: 'device-a',
    now: opts.now,
  };

  return { syncer: createSnapshotSyncer(deps, {}), outbox, payloads, clientsFor };
}

/* ------------------------------------------------------------------ outbox: listDueForDocument */

test('listDueForDocument returns only that document, oldest edit first', async () => {
  const outbox = createOutbox(memoryOutboxStore(), { now: () => 1_000 });

  const a1 = await outbox.enqueue(entryInput(DOC_A));
  const a2 = await outbox.enqueue(entryInput(DOC_A));

  await outbox.enqueue(entryInput(DOC_B));

  const due = await outbox.listDueForDocument(DOC_A, 1_000);

  assert.deepEqual(
    due.map((entry) => entry.id),
    [a1.id, a2.id],
  );
  assert.equal(due.length, 2, 'the other document must not leak into a scoped due set');
});

test('listDueForDocument honours the backoff schedule', async () => {
  let now = 1_000;
  const outbox = createOutbox(memoryOutboxStore(), { now: () => now });
  const entry = await outbox.enqueue(entryInput(DOC_A));

  await outbox.markFailed(entry.id);

  assert.equal((await outbox.listDueForDocument(DOC_A, now)).length, 0, 'a backed-off entry is not due yet');

  now += 5_000;

  assert.equal((await outbox.listDueForDocument(DOC_A, now)).length, 1, 'and is due once the backoff elapses');
});

test('reclaimInflight(documentId) never touches another document', async () => {
  const outbox = createOutbox(memoryOutboxStore(), { now: () => 1_000 });
  const mine = await outbox.enqueue(entryInput(DOC_A));
  const theirs = await outbox.enqueue(entryInput(DOC_B));

  await outbox.markInflight(mine.id);
  await outbox.markInflight(theirs.id);

  const reclaimed = await outbox.reclaimInflight(DOC_A);

  assert.equal(reclaimed, 1);
  assert.equal((await outbox.latest(DOC_A))?.status, 'failed');
  assert.equal(
    (await outbox.latest(DOC_B))?.status,
    'inflight',
    "the other engine's in-flight upload must stay in flight — reclaiming it would queue a duplicate append",
  );
});

test('reclaimInflight() with no document keeps its whole-store behaviour', async () => {
  const outbox = createOutbox(memoryOutboxStore(), { now: () => 1_000 });
  const mine = await outbox.enqueue(entryInput(DOC_A));
  const theirs = await outbox.enqueue(entryInput(DOC_B));

  await outbox.markInflight(mine.id);
  await outbox.markInflight(theirs.id);

  assert.equal(await outbox.reclaimInflight(), 2);
});

/* ------------------------------------------------------------------ syncer: capture + drainDocument */

test('captureFromDocument enqueues without draining', async () => {
  const client = labelledClient('teacher-a');
  const harness = createHarness(() => client);

  await harness.syncer.captureFromDocument(makeDoc(DOC_A));

  assert.equal((await harness.outbox.latest(DOC_A))?.status, 'pending', 'the entry is queued…');
  assert.deepEqual(client.appended, [], '…and nothing was uploaded — the worker decides when to drain');
  assert.equal(harness.payloads.keys().length, 1, 'the frozen blob is written at capture time');
});

test('drainDocument uploads only its own document and leaves the others pending', async () => {
  const clientA = labelledClient('teacher-a');
  const clientB = labelledClient('teacher-b');
  const harness = createHarness((documentId) => (documentId === DOC_A ? clientA : clientB));

  await harness.syncer.captureFromDocument(makeDoc(DOC_A));
  await harness.syncer.captureFromDocument(makeDoc(DOC_B));

  await harness.syncer.drainDocument(DOC_A, 'interval');

  assert.deepEqual(clientA.appended, [DOC_A]);
  assert.deepEqual(clientB.appended, [], 'the untouched document must not have been drained');
  assert.equal((await harness.outbox.latest(DOC_A))?.status, 'synced');
  assert.equal((await harness.outbox.latest(DOC_B))?.status, 'pending');
});

test('each document uploads under ITS OWN client, never the previous one', async () => {
  const clientA = labelledClient('teacher-a');
  const clientB = labelledClient('teacher-b');
  const harness = createHarness((documentId) => (documentId === DOC_A ? clientA : clientB));

  await harness.syncer.captureFromDocument(makeDoc(DOC_A));
  await harness.syncer.captureFromDocument(makeDoc(DOC_B));

  await harness.syncer.drainDocument(DOC_A, 'interval');
  await harness.syncer.drainDocument(DOC_B, 'interval');

  assert.deepEqual(clientA.appended, [DOC_A], "teacher A's key uploaded exactly her own board");
  assert.deepEqual(clientB.appended, [DOC_B], "teacher B's key uploaded exactly his own board");
  assert.deepEqual(harness.clientsFor, [DOC_A, DOC_B], 'the client was resolved once per drained document');
});

test('drainDocument refuses a client-UUID board without touching the network', async () => {
  const client = labelledClient('teacher-a');
  const harness = createHarness(() => client);

  await harness.syncer.drainDocument('7c1a0f4e-1d2b-4f3a-9c8d-0e1f2a3b4c5d', 'startup');

  assert.deepEqual(harness.clientsFor, [], 'a board with no server _id must not even resolve a client');
});

test('a failing document backs off without wedging the next one', async () => {
  const clientA = labelledClient('teacher-a');
  const clientB = labelledClient('teacher-b');

  clientA.appendDraftSnapshot = async () => {
    throw new Error('boom');
  };

  const harness = createHarness((documentId) => (documentId === DOC_A ? clientA : clientB));

  await harness.syncer.captureFromDocument(makeDoc(DOC_A));
  await harness.syncer.captureFromDocument(makeDoc(DOC_B));

  await harness.syncer.drainDocument(DOC_A, 'interval');
  await harness.syncer.drainDocument(DOC_B, 'interval');

  assert.equal((await harness.outbox.latest(DOC_A))?.status, 'failed', 'the broken board is retried later…');
  assert.deepEqual(clientB.appended, [DOC_B], '…and the next board still uploads in the same pass');
});

test('a re-entrant drain is dropped — one upload is in flight per engine', async () => {
  const client = labelledClient('teacher-a');
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let concurrent = 0;
  let maxConcurrent = 0;

  client.appendDraftSnapshot = async (documentId) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await gate;
    concurrent -= 1;
    client.appended.push(documentId);

    return { seq: 1, latestSeq: 1, diverged: false };
  };

  const harness = createHarness(() => client);

  await harness.syncer.captureFromDocument(makeDoc(DOC_A));
  await harness.syncer.captureFromDocument(makeDoc(DOC_B));

  const first = harness.syncer.drainDocument(DOC_A, 'interval');
  const second = harness.syncer.drainDocument(DOC_B, 'interval');

  release?.();
  await Promise.all([first, second]);

  assert.equal(maxConcurrent, 1, 'the backend has no rate limiter — two uploads must never overlap');
  assert.equal((await harness.outbox.latest(DOC_B))?.status, 'pending', 'the dropped drain rides the next tick');
});

/* ------------------------------------------------------------------ helpers */

function entryInput(documentId: string) {
  return {
    documentId,
    deviceId: 'device-a',
    baseSeq: null,
    pageCount: 1,
    title: 'Board',
    fileSize: 8,
  };
}
