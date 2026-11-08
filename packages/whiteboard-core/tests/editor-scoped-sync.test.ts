import test from 'node:test';
import assert from 'node:assert/strict';

import { WhiteboardApiError } from '../src/remote/client';
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
import type { SnapshotSyncerClient, SnapshotSyncerDeps, SyncerStatus } from '../src/sync/snapshot-syncer';
import type { WhiteboardDocument } from '../src/types';

/**
 * The BOUND (document-scoped) engine — the one the open board's editor runs.
 *
 * Its stores are device-wide and shared with the app-wide auto-upload worker, but its client is
 * the SELECTED teacher's and its status chip speaks for ONE board. Three failures follow from
 * forgetting that, and every one of them looks like success from the outside:
 *
 *  - the whole-store drain POSTs another teacher's due entry under the selected teacher's key
 *    (4xx → markFailed → `break`), so the open board's own entry never goes out at all;
 *  - the unscoped cold-start reclaim flips the WORKER's genuinely in-flight upload back to due,
 *    and that snapshot is appended to the server twice;
 *  - a foreign board's failure paints «Error» on the open board's chip.
 *
 * Each test below therefore asserts an IDENTITY (which document was uploaded, under which client,
 * whose status was emitted) rather than "it did not throw". The unbound control tests exist so a
 * future refactor that quietly un-scopes the editor fails HERE rather than in production.
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

/**
 * The editor's ambient client: ONE teacher's key, exactly as `useSnapshotSyncer` injects it.
 *
 * It records every documentId it was asked to append — which is the whole question. `rejectFor`
 * makes one document 4xx the way the backend does when a key is not entitled to that board.
 */
interface AmbientClient extends SnapshotSyncerClient {
  appended: string[];
  attempted: string[];
  rejectFor: Set<string>;
}

function ambientClient(rejectFor: string[] = []): AmbientClient {
  const appended: string[] = [];
  const attempted: string[] = [];
  const rejects = new Set(rejectFor);

  return {
    appended,
    attempted,
    rejectFor: rejects,
    requestDraftSnapshotUploadUrl: async (documentId): Promise<WhiteboardApiDraftSnapshotUploadUrlResponse> => {
      attempted.push(documentId);

      if (rejects.has(documentId)) {
        throw new WhiteboardApiError('this device key does not own that board', 403, null);
      }

      return {
        uploadUrl: `https://b2.example.com/${documentId}`,
        storageKey: `snapshots/${documentId}.json.gz`,
        publicUrl: `https://cdn.example.com/${documentId}.json.gz`,
      };
    },
    appendDraftSnapshot: async (documentId): Promise<WhiteboardApiAppendDraftSnapshotResponse> => {
      appended.push(documentId);

      return { seq: appended.length, latestSeq: appended.length, diverged: false };
    },
    listDraftSnapshots: async (): Promise<WhiteboardApiListDraftSnapshotsResponse> => ({ snapshots: [] }),
    getUploadUrl: async (documentId): Promise<WhiteboardApiUploadUrl> => {
      attempted.push(`${documentId}:legacy`);

      if (rejects.has(documentId)) {
        throw new WhiteboardApiError('this device key does not own that board', 403, null);
      }

      return {
        uploadUrl: `https://b2.example.com/${documentId}/legacy`,
        publicUrl: `https://cdn.example.com/${documentId}/legacy.json.gz`,
      };
    },
    syncDraft: async (): Promise<WhiteboardApiSyncDraftResponse> => ({
      synced: true,
      draftUpdatedAt: '2026-08-21T10:00:00.000Z',
    }),
  };
}

// Two real 24-hex ObjectIds. MINE is the open board; THEIRS belongs to another teacher and shares
// the same device-wide outbox. A non-ObjectId would be skipped by the engine's own guard and every
// assertion below would pass vacuously.
const MINE = 'a1b2c3d4e5f60718293a4b5c';
const THEIRS = 'b1b2c3d4e5f60718293a4b5c';

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

interface Harness {
  syncer: ReturnType<typeof createSnapshotSyncer>;
  outbox: Outbox;
  payloads: ReturnType<typeof memoryPayloadStore>;
  client: AmbientClient;
  /** Every `onStatus` call, with the documentId it was attributed to. */
  statuses: { status: SyncerStatus; documentId: string }[];
}

/**
 * `documentId` set → the editor's engine (bound). Omitted → the app-wide worker's engine (unbound),
 * used as the control in the "and the old behaviour really was different" pairs below.
 */
function createHarness(
  opts: {
    documentId?: string;
    client?: AmbientClient;
    outbox?: Outbox;
    now?: () => number;
  } = {},
): Harness {
  const outbox = opts.outbox ?? createOutbox(memoryOutboxStore(), { now: opts.now });
  const payloads = memoryPayloadStore();
  const client = opts.client ?? ambientClient();
  const statuses: { status: SyncerStatus; documentId: string }[] = [];

  const deps: SnapshotSyncerDeps = {
    runWithClient: (fn) => fn(client),
    documentId: opts.documentId,
    outbox,
    payloads,
    cursor: memoryCursorStore(),
    uploadBlob: async () => {},
    getLatestDocSnapshot: async () => null,
    serialize: async () => ({ blob: new Blob(['snapshot']), contentType: 'application/octet-stream', fileSize: 8 }),
    deviceId: 'device-a',
    now: opts.now,
  };

  const syncer = createSnapshotSyncer(deps, {
    onStatus: (status, documentId) => {
      statuses.push({ status, documentId });
    },
  });

  return { syncer, outbox, payloads, client, statuses };
}

/** Queue a payload-backed entry directly, so a test can control ORDER and STATUS precisely. */
async function seedEntry(harness: Harness, documentId: string): Promise<OutboxEntry> {
  const entry = await harness.outbox.enqueue(entryInput(documentId));

  await harness.payloads.put(entry.id, new Blob(['snapshot']));

  return entry;
}

/* ------------------------------------------------------------------ drain scoping */

test('a bound engine drains ONLY its own document, even when another board is due first', async () => {
  const harness = createHarness({ documentId: MINE });

  // Theirs first: an unscoped `listDue` hands entries back in store order, so this is the entry a
  // whole-store drain would reach BEFORE the open board's own.
  await seedEntry(harness, THEIRS);
  await seedEntry(harness, MINE);

  await harness.syncer.drain('startup');

  assert.deepEqual(harness.client.appended, [MINE], "the open board's entry, and nothing else, was uploaded");
  assert.deepEqual(
    harness.client.attempted,
    [MINE],
    "the other teacher's board must not even reach the network under this key",
  );
  assert.equal((await harness.outbox.latest(MINE))?.status, 'synced');

  const theirs = await harness.outbox.latest(THEIRS);

  assert.equal(theirs?.status, 'pending', "the other board is left exactly as found — it is the worker's to send");
  assert.equal(theirs?.attempts, 0, 'and it carries no failure this engine invented for it');
});

test('the UNBOUND engine still drains the whole store — the worker path is untouched', async () => {
  const harness = createHarness();

  await seedEntry(harness, THEIRS);
  await seedEntry(harness, MINE);

  await harness.syncer.drain('startup');

  assert.deepEqual(
    harness.client.appended.slice().sort(),
    [MINE, THEIRS].sort(),
    'an engine that owns every board drains every board',
  );
});

test('a bound engine ignores its own foreign drainDocument call', async () => {
  const harness = createHarness({ documentId: MINE });

  await seedEntry(harness, THEIRS);

  await harness.syncer.drainDocument(THEIRS, 'interval');

  assert.deepEqual(harness.client.attempted, [], 'a bound engine has no way to reach another board at all');
  assert.equal((await harness.outbox.latest(THEIRS))?.status, 'pending');
});

test('a bound engine refuses to capture a foreign document', async () => {
  const harness = createHarness({ documentId: MINE });

  await harness.syncer.captureFromDocument(makeDoc(THEIRS));

  assert.equal(await harness.outbox.latest(THEIRS), null, 'nothing this engine cannot send may be queued by it');
  assert.deepEqual(harness.payloads.keys(), [], 'and no blob was written for it');
});

test('enqueueFromDocument on a bound engine uploads only the open board', async () => {
  const harness = createHarness({ documentId: MINE });

  await seedEntry(harness, THEIRS);

  await harness.syncer.enqueueFromDocument(makeDoc(MINE));

  assert.deepEqual(harness.client.appended, [MINE]);
  assert.equal((await harness.outbox.latest(THEIRS))?.status, 'pending');
});

/* ------------------------------------------------------------------ reclaim scoping */

test("a bound engine's cold start never reclaims another engine's in-flight upload", async () => {
  const harness = createHarness({ documentId: MINE });
  const theirs = await seedEntry(harness, THEIRS);

  await seedEntry(harness, MINE);
  // The app-wide worker is mid-upload of THEIRS right now. Reclaiming it would put the same
  // snapshot back in the due set and append it to the server a second time.
  await harness.outbox.markInflight(theirs.id);

  await harness.syncer.drain('startup');

  assert.equal(
    (await harness.outbox.latest(THEIRS))?.status,
    'inflight',
    'the other engine keeps its upload — a reclaim here would duplicate that snapshot in the cloud',
  );
  assert.equal((await harness.outbox.latest(MINE))?.status, 'synced', "…while the open board's own entry still went");
});

test("a bound engine DOES reclaim its own crash-stranded entry", async () => {
  const harness = createHarness({ documentId: MINE });
  const mine = await seedEntry(harness, MINE);

  // Last session died mid-upload: the entry is stuck `inflight`, which is outside the due set.
  await harness.outbox.markInflight(mine.id);

  await harness.syncer.drain('startup');

  assert.deepEqual(harness.client.appended, [MINE], 'the stranded entry re-entered the due set and was sent');
  assert.equal((await harness.outbox.latest(MINE))?.status, 'synced');
});

test('the UNBOUND engine still sweeps the whole store on cold start', async () => {
  const harness = createHarness();
  const theirs = await seedEntry(harness, THEIRS);

  await harness.outbox.markInflight(theirs.id);

  await harness.syncer.drain('startup');

  assert.deepEqual(harness.client.appended, [THEIRS], 'the single-engine cold start is unchanged');
});

/* ------------------------------------------------------------------ a foreign failure is not ours */

test('a foreign 4xx can neither abort the open board nor discolour its chip', async () => {
  // The selected teacher's key is not entitled to THEIRS — the backend says 403.
  const client = ambientClient([THEIRS]);
  const harness = createHarness({ documentId: MINE, client });

  await seedEntry(harness, THEIRS);
  await seedEntry(harness, MINE);

  await harness.syncer.drain('startup');

  assert.deepEqual(client.appended, [MINE], "the open board's snapshot went out despite the foreign entry sitting there");
  assert.equal(
    harness.statuses.at(-1)?.status,
    'synced',
    'the chip settles on synced — the last word belongs to this board',
  );
  assert.equal(
    harness.statuses.some((event) => event.status === 'retrying'),
    false,
    "«Error» for someone else's board is a lie about this board's bytes",
  );
  assert.deepEqual(
    harness.statuses.map((event) => event.documentId),
    harness.statuses.map(() => MINE),
    'every status this engine emitted was attributed to its own document',
  );
});

test('the same foreign 4xx really does wreck an UNBOUND engine — the control', async () => {
  const client = ambientClient([THEIRS]);
  const harness = createHarness({ client });

  await seedEntry(harness, THEIRS);
  await seedEntry(harness, MINE);

  await harness.syncer.drain('startup');

  assert.deepEqual(client.appended, [], 'the foreign 403 broke the cycle before the open board was reached');
  assert.equal(
    harness.statuses.some((event) => event.status === 'retrying' && event.documentId === THEIRS),
    true,
    "…and it is exactly this 'retrying' that used to reach the open board's chip",
  );
});

/* ------------------------------------------------------------------ defence in depth */

test('a leaked foreign entry is refused at the upload itself, not merely unselected', async () => {
  // A hostile store: `listDueForDocument` answers with SOMEONE ELSE's entry. Nothing in production
  // does this today — the point is that the engine's correctness must not rest on the store, or on
  // the caller, keeping its promise about scope.
  const base = createOutbox(memoryOutboxStore(), { now: () => 1_000 });
  const leaky: Outbox = {
    ...base,
    listDueForDocument: async (_documentId, currentTime) => base.listDue(currentTime),
  };
  const harness = createHarness({ documentId: MINE, outbox: leaky });

  await seedEntry(harness, THEIRS);

  await harness.syncer.drain('startup');

  assert.deepEqual(harness.client.attempted, [], 'the foreign entry was never sent under this teacher’s key');
  assert.equal(
    (await harness.outbox.latest(THEIRS))?.status,
    'pending',
    'and it was neither marked inflight nor failed by an engine that has no business touching it',
  );
  assert.deepEqual(harness.statuses, [], 'and no status was emitted for a board this chip does not speak for');
});
