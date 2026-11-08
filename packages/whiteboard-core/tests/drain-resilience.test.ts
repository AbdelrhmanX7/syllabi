import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutbox } from '../src/sync/outbox';
import { createSnapshotSyncer, INFLIGHT_STALE_MS } from '../src/sync/snapshot-syncer';

import type {
  WhiteboardApiAppendDraftSnapshotResponse,
  WhiteboardApiDraftSnapshotUploadUrlResponse,
  WhiteboardApiListDraftSnapshotsResponse,
  WhiteboardApiSyncDraftResponse,
  WhiteboardApiUploadUrl,
} from '../src/remote/types';
import type { ServerSeqStore, SnapshotPayloadStore } from '../src/storage/indexeddb';
import type { Outbox, OutboxEntry, OutboxStore } from '../src/sync/outbox';
import type { SnapshotSyncerClient, SnapshotSyncerDeps, SyncerDrainReason, SyncerStatus } from '../src/sync/snapshot-syncer';
import type { WhiteboardDocument } from '../src/types';

/**
 * What a drain must survive, and what it must never do to the rest of the device.
 *
 * Four failures live here, and every one of them is silent in production:
 *
 *  - a per-entry throw OUTSIDE the try (`loadEntryBlob`/`serialize`) escaped `drain`, left the
 *    entry `inflight` forever and — because `flush()` is `drain()` — made the board's back button
 *    do nothing at all;
 *  - a stranded `inflight` entry was unrecoverable for the whole session, because the reclaim was
 *    latched to run once per engine lifetime and the worker's engine never restarts;
 *  - "one upload in flight per device" was really "per engine", so three subsystems saturated one
 *    uplink together;
 *  - the cloud plane kept uploading through a lesson, which on these boards shows up as the pen
 *    stuttering mid-stroke.
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

function memoryPayloadStore(): SnapshotPayloadStore {
  const map = new Map<string, Blob>();

  return {
    get: async (id) => map.get(id) ?? null,
    put: async (id, blob) => {
      map.set(id, blob);
    },
    delete: async (id) => {
      map.delete(id);
    },
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

function okClient(onAppend?: () => Promise<void>): SnapshotSyncerClient {
  return {
    requestDraftSnapshotUploadUrl: async (documentId): Promise<WhiteboardApiDraftSnapshotUploadUrlResponse> => ({
      uploadUrl: `https://b2.example.com/${documentId}`,
      storageKey: `snapshots/${documentId}.json.gz`,
      publicUrl: `https://cdn.example.com/${documentId}.json.gz`,
    }),
    appendDraftSnapshot: async (): Promise<WhiteboardApiAppendDraftSnapshotResponse> => {
      await onAppend?.();

      return { seq: 1, latestSeq: 1, diverged: false };
    },
    listDraftSnapshots: async (): Promise<WhiteboardApiListDraftSnapshotsResponse> => ({ snapshots: [] }),
    getUploadUrl: async (): Promise<WhiteboardApiUploadUrl> => ({
      uploadUrl: 'https://b2.example.com/legacy',
      publicUrl: 'https://cdn.example.com/legacy',
    }),
    syncDraft: async (): Promise<WhiteboardApiSyncDraftResponse> => ({
      synced: true,
      draftUpdatedAt: '2026-08-21T10:00:00.000Z',
    }),
  };
}

const DOC = 'a1b2c3d4e5f60718293a4b5c';
const START_MS = 1_755_000_000_000;

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

function makeDoc(id: string): WhiteboardDocument {
  return {
    id,
    title: 'Board',
    pages: [{ id: 'page-1', canvasJSON: '{}', thumbnail: '', backgroundType: 'blank' }],
    currentPageIndex: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    thumbnail: '',
  };
}

interface Harness {
  syncer: ReturnType<typeof createSnapshotSyncer>;
  outbox: Outbox;
  payloads: SnapshotPayloadStore;
  statuses: { status: SyncerStatus; documentId: string }[];
  advance: (ms: number) => void;
  now: () => number;
}

function createHarness(overrides: Partial<SnapshotSyncerDeps> = {}): Harness {
  let clock = START_MS;
  const now = (): number => clock;
  const outbox = overrides.outbox ?? createOutbox(memoryOutboxStore(), { now });
  const payloads = overrides.payloads ?? memoryPayloadStore();
  const statuses: { status: SyncerStatus; documentId: string }[] = [];

  const deps: SnapshotSyncerDeps = {
    runWithClient: (fn) => fn(okClient()),
    documentId: DOC,
    outbox,
    payloads,
    cursor: memoryCursorStore(),
    uploadBlob: async () => {},
    getLatestDocSnapshot: async (id) => makeDoc(id),
    serialize: async () => ({ blob: new Blob(['snapshot']), contentType: 'application/octet-stream', fileSize: 8 }),
    deviceId: 'device-a',
    now,
    ...overrides,
  };

  const syncer = createSnapshotSyncer(deps, {
    onStatus: (status, documentId) => {
      statuses.push({ status, documentId });
    },
  });

  return {
    syncer,
    outbox,
    payloads,
    statuses,
    advance: (ms) => {
      clock += ms;
    },
    now,
  };
}

/* ------------------------------------------------------------------ D4: drain never rejects */

test('a serializer that throws fails the ENTRY, not the drain', async () => {
  const harness = createHarness({
    // No stored payload for the entry → `loadEntryBlob` falls back to re-serializing the doc, and
    // THAT is the call that used to throw outside the try.
    serialize: async () => {
      throw new Error('gzip blew up on a 300-page board');
    },
  });

  await harness.outbox.enqueue(entryInput(DOC));

  await assert.doesNotReject(() => harness.syncer.drain('startup'), 'drain() must never reject — flush() is drain()');

  assert.equal(
    (await harness.outbox.latest(DOC))?.status,
    'failed',
    'the entry backs off and retries; leaving it `inflight` would strand it outside the due set forever',
  );
  assert.deepEqual(
    harness.statuses.map((entryStatus) => entryStatus.status),
    ['syncing', 'retrying'],
    'and the chip says retrying rather than nothing at all',
  );
});

test('flush() resolves even when every layer under it is broken', async () => {
  const harness = createHarness({
    serialize: async () => {
      throw new Error('nope');
    },
    outbox: {
      ...createOutbox(memoryOutboxStore(), { now: () => START_MS }),
      // The last write standing between "backs off" and "inflight forever" also fails.
      markFailed: async () => {
        throw new Error('IndexedDB is gone');
      },
    } as Outbox,
  });

  await harness.outbox.enqueue(entryInput(DOC));

  // `flush()` in the hook is exactly this call, and the board's back button awaits it. A rejection
  // here is a teacher who presses «Back» and stays on the board with no error and no explanation.
  await assert.doesNotReject(() => harness.syncer.drain('manual'));
});

test('a store whose due-set read throws still resolves the drain', async () => {
  const base = createOutbox(memoryOutboxStore(), { now: () => START_MS });
  const harness = createHarness({
    outbox: {
      ...base,
      listDueForDocument: async () => {
        throw new Error('IndexedDB transaction aborted');
      },
    } as Outbox,
  });

  await assert.doesNotReject(() => harness.syncer.drain('startup'));
});

/* ------------------------------------------------------------------ D3: strands recover */

test('an inflight entry no engine is uploading recovers on the NEXT drain — no restart', async () => {
  const harness = createHarness();
  const entry = await harness.outbox.enqueue(entryInput(DOC));

  await harness.payloads.put(entry.id, new Blob(['snapshot']));
  // The strand: something marked it inflight and then died without failing it. Note this happens
  // AFTER the engine's first drain, which is precisely the case the old once-per-lifetime latch
  // could never recover — the app-wide worker's engine never restarts.
  await harness.syncer.drain('startup');
  await harness.outbox.markInflight(entry.id);

  assert.equal((await harness.outbox.latest(DOC))?.status, 'inflight');

  await harness.syncer.drain('interval');

  assert.equal(
    (await harness.outbox.latest(DOC))?.status,
    'synced',
    'the same long-lived engine reclaimed and uploaded it',
  );
});

test('an entry that is genuinely on the wire is NOT reclaimed out from under its upload', async () => {
  let releaseAppend!: () => void;
  let announceReached!: () => void;
  const appendGate = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  const reachedAppend = new Promise<void>((resolve) => {
    announceReached = resolve;
  });
  const outbox = createOutbox(memoryOutboxStore(), { now: () => START_MS });
  // Engine A: the app-wide worker, holding an upload open on the wire.
  const worker = createSnapshotSyncer({
    runWithClient: (fn) =>
      fn(
        okClient(() => {
          announceReached();

          return appendGate;
        }),
      ),
    outbox,
    payloads: memoryPayloadStore(),
    cursor: memoryCursorStore(),
    uploadBlob: async () => {},
    getLatestDocSnapshot: async (id) => makeDoc(id),
    serialize: async () => ({ blob: new Blob(['snapshot']), contentType: 'application/octet-stream', fileSize: 8 }),
    deviceId: 'device-a',
    now: () => START_MS,
  });
  // Engine B: the open board's editor, cold-starting on the SAME document.
  const editor = createSnapshotSyncer({
    runWithClient: (fn) => fn(okClient()),
    documentId: DOC,
    outbox,
    payloads: memoryPayloadStore(),
    cursor: memoryCursorStore(),
    uploadBlob: async () => {},
    getLatestDocSnapshot: async (id) => makeDoc(id),
    serialize: async () => ({ blob: new Blob(['snapshot']), contentType: 'application/octet-stream', fileSize: 8 }),
    deviceId: 'device-a',
    now: () => START_MS,
  });

  await outbox.enqueue(entryInput(DOC));

  const workerDrain = worker.drain('interval');

  // Park the worker inside the append, deterministically.
  await reachedAppend;

  assert.equal((await outbox.latest(DOC))?.status, 'inflight', 'sanity: the worker has it on the wire');

  await editor.drain('startup');

  assert.equal(
    (await outbox.latest(DOC))?.status,
    'inflight',
    'the editor must not flip a live upload back to due — that is a duplicate append on the server',
  );

  releaseAppend();
  await workerDrain;

  assert.equal((await outbox.latest(DOC))?.status, 'synced');
});

test('INFLIGHT_STALE_MS backstops an upload that never settles', async () => {
  const outbox = createOutbox(memoryOutboxStore(), { now: () => START_MS });
  const entry = await outbox.enqueue(entryInput(DOC));

  await outbox.markInflight(entry.id);

  // Fresh, and claimed live by a caller that never returns → protected.
  assert.equal(await outbox.reclaimInflight(DOC, (row) => row.updatedAt <= START_MS - INFLIGHT_STALE_MS), 0);
  // Past the backstop → taken back regardless.
  assert.equal(
    await outbox.reclaimInflight(DOC, (row) => row.updatedAt <= START_MS + INFLIGHT_STALE_MS + 1),
    1,
  );
});

/* ------------------------------------------------------------------ D5: the device-wide slot */

test('the drain takes the injected upload slot around each entry, and always gives it back', async () => {
  const events: string[] = [];
  let held = 0;
  const harness = createHarness({
    acquireUploadSlot: async () => {
      held += 1;
      events.push(`acquire:${held}`);

      return () => {
        held -= 1;
        events.push('release');
      };
    },
    runWithClient: (fn) =>
      fn(
        okClient(async () => {
          assert.equal(held, 1, 'the upload runs while the slot is held');
        }),
      ),
  });
  const entry = await harness.outbox.enqueue(entryInput(DOC));

  await harness.payloads.put(entry.id, new Blob(['snapshot']));
  await harness.syncer.drain('startup');

  assert.deepEqual(events, ['acquire:1', 'release']);
  assert.equal(held, 0, 'a slot stranded by a throw would deadlock every other uploader on the device');
});

test('a failing upload still releases the slot', async () => {
  let held = 0;
  const harness = createHarness({
    acquireUploadSlot: async () => {
      held += 1;

      return () => {
        held -= 1;
      };
    },
    uploadBlob: async () => {
      throw new Error('uplink died mid-PUT');
    },
  });
  const entry = await harness.outbox.enqueue(entryInput(DOC));

  await harness.payloads.put(entry.id, new Blob(['snapshot']));
  await harness.syncer.drain('startup');

  assert.equal(held, 0);
  assert.equal((await harness.outbox.latest(DOC))?.status, 'failed');
});

/* ------------------------------------------------------------------ D6: the recording gate */

test('a recording stands the automatic drains down — but the capture still happens', async () => {
  const asked: SyncerDrainReason[] = [];
  const harness = createHarness({
    shouldDeferUpload: (reason) => {
      asked.push(reason);

      return true;
    },
  });

  // The debounce path: capture into the durable outbox, then try to drain.
  await harness.syncer.enqueueFromDocument(makeDoc(DOC));

  const latest = await harness.outbox.latest(DOC);

  assert.equal(latest?.status, 'pending', 'the work is captured and durable — only the UPLOAD waits');
  assert.deepEqual(asked, ['change']);
  assert.deepEqual(harness.statuses, [], 'and no error is painted: waiting for a lesson is not a failure');

  for (const reason of ['interval', 'focus', 'online', 'startup', 'visibility'] as const) {
    await harness.syncer.drain(reason);
  }

  assert.equal((await harness.outbox.latest(DOC))?.status, 'pending');
});

test('a human pressing sync now is never held back by the gate', async () => {
  const harness = createHarness({ shouldDeferUpload: () => true });
  const entry = await harness.outbox.enqueue(entryInput(DOC));

  await harness.payloads.put(entry.id, new Blob(['snapshot']));
  await harness.syncer.drain('manual');

  assert.equal(
    (await harness.outbox.latest(DOC))?.status,
    'synced',
    'the sync-now button and the back-button flush are decisions, not background work',
  );
});

test('the gate FAILS OPEN — a predicate that throws never freezes uploads for the session', async () => {
  const harness = createHarness({
    shouldDeferUpload: () => {
      throw new Error('the IPC bridge is missing on the web build');
    },
  });
  const entry = await harness.outbox.enqueue(entryInput(DOC));

  await harness.payloads.put(entry.id, new Blob(['snapshot']));
  await harness.syncer.drain('interval');

  assert.equal((await harness.outbox.latest(DOC))?.status, 'synced');
});
