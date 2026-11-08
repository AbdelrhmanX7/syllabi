import test from 'node:test';
import assert from 'node:assert/strict';

import { BACKOFF_BASE_MS, BACKOFF_FACTOR, BACKOFF_MAX_MS, backoffDelayMs, createOutbox } from '../src/sync/outbox';

import type { OutboxEnqueueInput, OutboxEntry, OutboxStore } from '../src/sync/outbox';

function createMemoryStore(): OutboxStore & { snapshot: () => OutboxEntry[] } {
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
    snapshot: () => Array.from(map.values(), (entry) => ({ ...entry })),
  };
}

function makeClock(start = 1_000): {
  now: () => number;
  set: (value: number) => void;
  advance: (delta: number) => void;
} {
  let current = start;

  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (delta) => {
      current += delta;
    },
  };
}

function baseInput(overrides: Partial<OutboxEnqueueInput> = {}): OutboxEnqueueInput {
  return {
    documentId: 'doc-1',
    deviceId: 'device-a',
    baseSeq: null,
    pageCount: 1,
    title: 'Untitled',
    thumbnail: null,
    fileSize: 100,
    rawDataKey: 'raw/key',
    ...overrides,
  };
}

test('enqueue assigns a strictly increasing localSeq per document', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store);

  const first = await outbox.enqueue(baseInput());
  const second = await outbox.enqueue(baseInput());
  const third = await outbox.enqueue(baseInput());

  assert.equal(first.localSeq, 1);
  assert.equal(second.localSeq, 2);
  assert.equal(third.localSeq, 3);
  assert.equal(first.status, 'pending');
  assert.equal(first.attempts, 0);
});

test('localSeq is isolated per document', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store);

  const docA1 = await outbox.enqueue(baseInput({ documentId: 'A' }));
  const docB1 = await outbox.enqueue(baseInput({ documentId: 'B' }));
  const docA2 = await outbox.enqueue(baseInput({ documentId: 'A' }));
  const docB2 = await outbox.enqueue(baseInput({ documentId: 'B' }));

  assert.equal(docA1.localSeq, 1);
  assert.equal(docA2.localSeq, 2);
  assert.equal(docB1.localSeq, 1);
  assert.equal(docB2.localSeq, 2);
});

test('enqueue persists the raw-data pointer and metadata', async () => {
  const store = createMemoryStore();
  const clock = makeClock(5_000);
  const outbox = createOutbox(store, { now: clock.now });

  const entry = await outbox.enqueue(
    baseInput({ rawDataKey: 'blobs/abc', pageCount: 7, title: 'Lesson 3', thumbnail: 'data:thumb', fileSize: 4096 }),
  );

  assert.equal(entry.rawDataKey, 'blobs/abc');
  assert.equal(entry.pageCount, 7);
  assert.equal(entry.title, 'Lesson 3');
  assert.equal(entry.thumbnail, 'data:thumb');
  assert.equal(entry.fileSize, 4096);
  assert.equal(entry.createdAt, 5_000);
  assert.equal(entry.updatedAt, 5_000);
  assert.equal(entry.nextAttemptAt, 5_000);
});

test('listDue returns pending entries that are due, oldest-first per document', async () => {
  const store = createMemoryStore();
  const clock = makeClock(1_000);
  const outbox = createOutbox(store, { now: clock.now });

  await outbox.enqueue(baseInput({ documentId: 'A' }));
  await outbox.enqueue(baseInput({ documentId: 'A' }));
  await outbox.enqueue(baseInput({ documentId: 'B' }));

  const due = await outbox.listDue(clock.now());
  const docADue = due.filter((entry) => entry.documentId === 'A');

  assert.equal(due.length, 3);
  assert.deepEqual(
    docADue.map((entry) => entry.localSeq),
    [1, 2],
  );
});

test('listDue respects backoff timing — failed entries are skipped until nextAttemptAt', async () => {
  const store = createMemoryStore();
  const clock = makeClock(1_000);
  const outbox = createOutbox(store, { now: clock.now });

  const entry = await outbox.enqueue(baseInput());

  await outbox.markInflight(entry.id);
  const failed = await outbox.markFailed(entry.id);

  // First failure → 5s backoff.
  assert.equal(failed.nextAttemptAt, 1_000 + BACKOFF_BASE_MS);
  assert.equal(failed.status, 'failed');

  // Still inside the backoff window → not due.
  clock.advance(BACKOFF_BASE_MS - 1);
  assert.deepEqual(await outbox.listDue(clock.now()), []);

  // Once nextAttemptAt is reached → due again (self-healing).
  clock.advance(1);
  const dueAgain = await outbox.listDue(clock.now());

  assert.equal(dueAgain.length, 1);
  assert.equal(dueAgain[0].id, entry.id);
});

test('listDue never returns inflight or synced entries', async () => {
  const store = createMemoryStore();
  const clock = makeClock(1_000);
  const outbox = createOutbox(store, { now: clock.now });

  const a = await outbox.enqueue(baseInput({ documentId: 'A' }));
  const b = await outbox.enqueue(baseInput({ documentId: 'B' }));

  await outbox.markInflight(a.id);
  await outbox.markSynced(b.id, 42);

  assert.deepEqual(await outbox.listDue(clock.now()), []);
});

test('markSynced records the server seq and advances state only after confirmation', async () => {
  const store = createMemoryStore();
  const clock = makeClock(1_000);
  const outbox = createOutbox(store, { now: clock.now });

  const entry = await outbox.enqueue(baseInput());

  await outbox.markInflight(entry.id);
  // Before confirmation it is still unsynced (counts as pending work).
  assert.equal(await outbox.pendingCount('doc-1'), 1);

  clock.advance(50);
  const synced = await outbox.markSynced(entry.id, 17);

  assert.equal(synced.status, 'synced');
  assert.equal(synced.serverSeq, 17);
  assert.equal(synced.updatedAt, 1_050);
  assert.equal(await outbox.pendingCount('doc-1'), 0);
});

test('eviction drops only the OLDEST synced entries when over the cap', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store, { maxEntriesPerDocument: 3 });

  // Enqueue 5 and sync all → over the cap of 3, oldest 2 synced should be evicted.
  const entries: OutboxEntry[] = [];

  for (let i = 0; i < 5; i += 1) {
    const entry = await outbox.enqueue(baseInput());

    entries.push(entry);
    await outbox.markSynced(entry.id, i + 1);
  }

  const remaining = await store.list();
  const remainingSeqs = remaining.map((entry) => entry.localSeq).sort((a, b) => a - b);

  assert.equal(remaining.length, 3);
  // The two oldest (localSeq 1, 2) are gone; the three newest survive.
  assert.deepEqual(remainingSeqs, [3, 4, 5]);
  assert.ok(remaining.every((entry) => entry.status === 'synced'));
});

test('eviction never drops the newest unsynced state even past the cap', async () => {
  const store = createMemoryStore();
  const clock = makeClock(1_000);
  const outbox = createOutbox(store, { maxEntriesPerDocument: 3, now: clock.now });

  // 10 unsynced entries with a cap of 3 — durability beats the cap, keep them all.
  for (let i = 0; i < 10; i += 1) {
    await outbox.enqueue(baseInput());
  }

  const all = await store.list();

  assert.equal(all.length, 10);
  assert.ok(all.every((entry) => entry.status === 'pending'));

  // The newest unsynced entry must always be present.
  const newest = await outbox.latest('doc-1');

  assert.ok(newest);
  assert.equal(newest?.localSeq, 10);
  assert.ok(all.some((entry) => entry.id === newest?.id));
});

test('eviction with a mix keeps unsynced and only trims oldest synced', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store, { maxEntriesPerDocument: 4 });

  // 3 synced (oldest), then 4 pending → 7 total, cap 4. Only synced may go,
  // and we can drop at most enough synced to reach the cap. We have 4 pending
  // that are NOT evictable, so we can only trim down to 4 by removing 3 synced.
  const synced: OutboxEntry[] = [];

  for (let i = 0; i < 3; i += 1) {
    const entry = await outbox.enqueue(baseInput());

    synced.push(entry);
    await outbox.markSynced(entry.id, i + 1);
  }

  for (let i = 0; i < 4; i += 1) {
    await outbox.enqueue(baseInput());
  }

  const remaining = await store.list();
  const statuses = remaining.map((entry) => entry.status).sort();

  // 4 pending must all survive (unsynced are never dropped); synced trimmed to fit.
  assert.equal(remaining.filter((entry) => entry.status === 'pending').length, 4);
  // Cap is 4 but pending alone fills it, so all 3 synced are evicted.
  assert.equal(remaining.filter((entry) => entry.status === 'synced').length, 0);
  assert.deepEqual(statuses, ['pending', 'pending', 'pending', 'pending']);
});

test('concurrent enqueues to the same document never collide on localSeq', async () => {
  // A store with an async gap between read and write would let overlapping
  // enqueues read the same max localSeq and assign duplicates. Enqueue must
  // serialize its read-modify-write so localSeq stays strictly increasing.
  const map = new Map<string, OutboxEntry>();
  const laggyStore: OutboxStore = {
    get: async (key) => map.get(key) ?? null,
    put: async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      map.set(entry.id, { ...entry });
    },
    delete: async (key) => {
      map.delete(key);
    },
    list: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));

      return Array.from(map.values(), (entry) => ({ ...entry }));
    },
  };
  const outbox = createOutbox(laggyStore);

  const results = await Promise.all([
    outbox.enqueue(baseInput()),
    outbox.enqueue(baseInput()),
    outbox.enqueue(baseInput()),
    outbox.enqueue(baseInput()),
    outbox.enqueue(baseInput()),
  ]);
  const seqs = results.map((entry) => entry.localSeq).sort((a, b) => a - b);

  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal(new Set(seqs).size, 5);
});

test('eviction never drops the newest entry even when it is synced and older unsynced fill the cap', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store, { maxEntriesPerDocument: 2 });

  // localSeq 1,2,3 are pending (older, stuck unsynced); localSeq 4 is the newest
  // state and gets confirmed by the cloud. The cap (2) is already exceeded by the
  // pending entries, so the ONLY synced entry is also the newest overall — it must
  // NOT be evicted, or latest()/resume would fall back to a stale older snapshot.
  await outbox.enqueue(baseInput());
  await outbox.enqueue(baseInput());
  await outbox.enqueue(baseInput());
  const newest = await outbox.enqueue(baseInput());

  await outbox.markSynced(newest.id, 99);

  const all = await store.list();
  const latest = await outbox.latest('doc-1');

  assert.ok(
    all.some((entry) => entry.id === newest.id),
    'newest entry must survive eviction',
  );
  assert.equal(latest?.localSeq, 4);
  assert.equal(latest?.status, 'synced');
  // The three older pending entries are unsynced and also untouchable, so nothing
  // could be evicted at all here — durability strictly beats the cap.
  assert.equal(all.length, 4);
});

test('markFailed backoff schedule is bounded and never dead-letters', async () => {
  const store = createMemoryStore();
  const clock = makeClock(0);
  const outbox = createOutbox(store, { now: clock.now });

  const entry = await outbox.enqueue(baseInput());

  const expectedDelays = [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000, 120_000, 120_000];

  for (let attempt = 0; attempt < expectedDelays.length; attempt += 1) {
    clock.set(1_000_000); // fixed reference time for each failure
    const failed = await outbox.markFailed(entry.id);

    assert.equal(failed.attempts, attempt + 1);
    assert.equal(failed.status, 'failed', 'failed entries never become a terminal dead-letter state');
    assert.equal(failed.nextAttemptAt - 1_000_000, expectedDelays[attempt]);
  }

  // After many failures the entry is STILL retryable (no permanent dead-letter).
  clock.set(1_000_000 + BACKOFF_MAX_MS);
  const due = await outbox.listDue(clock.now());

  assert.equal(due.length, 1);
  assert.equal(due[0].id, entry.id);
});

test('backoffDelayMs is a bounded exponential capped at the max', () => {
  assert.equal(backoffDelayMs(0), BACKOFF_BASE_MS);
  assert.equal(backoffDelayMs(1), BACKOFF_BASE_MS);
  assert.equal(backoffDelayMs(2), BACKOFF_BASE_MS * BACKOFF_FACTOR);
  assert.equal(backoffDelayMs(3), BACKOFF_BASE_MS * BACKOFF_FACTOR ** 2);
  assert.equal(backoffDelayMs(100), BACKOFF_MAX_MS);
  assert.ok(backoffDelayMs(100) <= BACKOFF_MAX_MS);
});

test('pendingCount counts every unsynced status and respects the documentId filter', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store);

  const a1 = await outbox.enqueue(baseInput({ documentId: 'A' }));
  const a2 = await outbox.enqueue(baseInput({ documentId: 'A' }));
  const b1 = await outbox.enqueue(baseInput({ documentId: 'B' }));

  await outbox.markInflight(a1.id); // inflight counts as pending work
  await outbox.markFailed(a2.id); // failed counts as pending work

  assert.equal(await outbox.pendingCount(), 3);
  assert.equal(await outbox.pendingCount('A'), 2);
  assert.equal(await outbox.pendingCount('B'), 1);

  await outbox.markSynced(b1.id, 1);

  assert.equal(await outbox.pendingCount(), 2);
  assert.equal(await outbox.pendingCount('B'), 0);
});

test('latest returns the highest localSeq entry for a document, or null when empty', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store);

  assert.equal(await outbox.latest('doc-1'), null);

  await outbox.enqueue(baseInput({ documentId: 'doc-1' }));
  const newest = await outbox.enqueue(baseInput({ documentId: 'doc-1' }));

  await outbox.enqueue(baseInput({ documentId: 'other' }));

  const latest = await outbox.latest('doc-1');

  assert.equal(latest?.id, newest.id);
  assert.equal(latest?.localSeq, 2);
});

test('upsertPending coalesces onto the newest pending entry without flooding the ring', async () => {
  const store = createMemoryStore();
  const clock = makeClock(1_000);
  const outbox = createOutbox(store, { now: clock.now });

  const first = await outbox.upsertPending(baseInput({ title: 'v1', pageCount: 1, baseSeq: null }));

  clock.advance(2_000);
  const coalesced = await outbox.upsertPending(
    baseInput({ title: 'v2', pageCount: 3, baseSeq: 9, fileSize: 200, rawDataKey: 'raw/v2', thumbnail: 'thumb-v2' }),
  );

  // Same physical entry: id + localSeq preserved, only mutated in place.
  assert.equal(coalesced.id, first.id);
  assert.equal(coalesced.localSeq, first.localSeq);
  assert.equal(coalesced.status, 'pending');
  assert.equal(coalesced.attempts, 0);
  assert.equal(coalesced.createdAt, 1_000, 'createdAt is preserved on coalesce');

  // Overwritten fields reflect the latest input.
  assert.equal(coalesced.title, 'v2');
  assert.equal(coalesced.pageCount, 3);
  assert.equal(coalesced.baseSeq, 9);
  assert.equal(coalesced.fileSize, 200);
  assert.equal(coalesced.rawDataKey, 'raw/v2');
  assert.equal(coalesced.thumbnail, 'thumb-v2');
  assert.equal(coalesced.updatedAt, 3_000);
  assert.equal(coalesced.nextAttemptAt, 3_000, 'nextAttemptAt reset to now');

  // Still exactly one entry for the document — the ring did not grow.
  const all = await store.list();

  assert.equal(all.length, 1);
});

test('upsertPending creates a NEW entry when the newest is inflight, leaving the inflight one untouched', async () => {
  const store = createMemoryStore();
  const clock = makeClock(1_000);
  const outbox = createOutbox(store, { now: clock.now });

  const first = await outbox.upsertPending(baseInput({ title: 'uploading' }));

  await outbox.markInflight(first.id);

  const second = await outbox.upsertPending(baseInput({ title: 'changed-mid-upload' }));

  assert.notEqual(second.id, first.id);
  assert.equal(second.localSeq, first.localSeq + 1, 'new entry gets a higher localSeq');
  assert.equal(second.status, 'pending');

  // The in-flight entry is byte-for-byte unchanged (its upload rides a consistent blob).
  const inflight = await store.get(first.id);

  assert.ok(inflight);
  assert.equal(inflight?.status, 'inflight');
  assert.equal(inflight?.title, 'uploading');

  const all = await store.list();

  assert.equal(all.length, 2);
});

test('upsertPending creates a NEW entry when the newest is synced', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store);

  const first = await outbox.upsertPending(baseInput());

  await outbox.markInflight(first.id);
  await outbox.markSynced(first.id, 7);

  const second = await outbox.upsertPending(baseInput({ title: 'next-edit' }));

  assert.notEqual(second.id, first.id);
  assert.equal(second.localSeq, first.localSeq + 1);
  assert.equal(second.status, 'pending');
  assert.equal(second.title, 'next-edit');

  const all = await store.list();

  assert.equal(all.length, 2);
});

test('upsertPending on a document with no entries behaves exactly like enqueue', async () => {
  const store = createMemoryStore();
  const clock = makeClock(2_000);
  const outbox = createOutbox(store, { now: clock.now });

  const entry = await outbox.upsertPending(baseInput({ rawDataKey: 'raw/first', pageCount: 4 }));

  assert.equal(entry.localSeq, 1);
  assert.equal(entry.status, 'pending');
  assert.equal(entry.attempts, 0);
  assert.equal(entry.createdAt, 2_000);
  assert.equal(entry.updatedAt, 2_000);
  assert.equal(entry.nextAttemptAt, 2_000);
  assert.equal(entry.rawDataKey, 'raw/first');
  assert.equal(entry.pageCount, 4);

  const all = await store.list();

  assert.equal(all.length, 1);
});

test('upsertPending preserves the strictly-increasing-localSeq invariant across coalesce and fallthrough', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store);

  // Coalesce twice (stays localSeq 1), then mark inflight so the next upsert falls through.
  const a = await outbox.upsertPending(baseInput());

  await outbox.upsertPending(baseInput());
  await outbox.upsertPending(baseInput());
  assert.equal(a.localSeq, 1);

  await outbox.markInflight(a.id);
  const b = await outbox.upsertPending(baseInput()); // new localSeq 2

  assert.equal(b.localSeq, 2);

  // Coalesce onto b a few times — still 2.
  await outbox.upsertPending(baseInput());
  await outbox.upsertPending(baseInput());

  await outbox.markInflight(b.id);
  const c = await outbox.upsertPending(baseInput()); // new localSeq 3

  assert.equal(c.localSeq, 3);

  const seqs = (await store.list()).map((entry) => entry.localSeq).sort((x, y) => x - y);

  assert.deepEqual(seqs, [1, 2, 3]);
  assert.equal(new Set(seqs).size, 3, 'localSeqs stay unique and strictly increasing');
});

test('reclaimInflight flips stranded inflight entries back to failed and makes them due again', async () => {
  const store = createMemoryStore();
  const clock = makeClock(1_000);
  const outbox = createOutbox(store, { now: clock.now });

  const a = await outbox.enqueue(baseInput({ documentId: 'A' }));
  const b = await outbox.enqueue(baseInput({ documentId: 'B' }));
  const c = await outbox.enqueue(baseInput({ documentId: 'C' }));

  // a + b crash mid-upload (inflight); c stays pending and must be left alone.
  await outbox.markInflight(a.id);
  await outbox.markInflight(b.id);

  // Inflight entries are NOT due before the sweep.
  const beforeDue = await outbox.listDue(clock.now());

  assert.deepEqual(beforeDue.map((entry) => entry.id).sort(), [c.id].sort());

  clock.advance(500);
  const reclaimed = await outbox.reclaimInflight();

  assert.equal(reclaimed, 2);

  const afterA = await store.get(a.id);
  const afterB = await store.get(b.id);
  const afterC = await store.get(c.id);

  assert.equal(afterA?.status, 'failed');
  assert.equal(afterB?.status, 'failed');
  assert.equal(afterA?.attempts, 0, 'attempts are preserved (not bumped) on reclaim');
  assert.equal(afterA?.nextAttemptAt, 1_500, 'nextAttemptAt set to now so it is immediately due');
  assert.equal(afterC?.status, 'pending', 'pending entries are untouched');

  // The reclaimed entries now appear in listDue.
  const due = await outbox.listDue(clock.now());

  assert.deepEqual(due.map((entry) => entry.id).sort(), [a.id, b.id, c.id].sort());

  // A no-op sweep with nothing inflight reclaims zero.
  assert.equal(await outbox.reclaimInflight(), 0);
});

test('concurrent upsertPending calls to one document do not collide on a laggy store', async () => {
  // With an async read→write gap, overlapping upserts could each see "no pending
  // newest" and append duplicate localSeqs. Serializing through the enqueue tail
  // must keep them coherent: a single coalesced pending entry, not five.
  const map = new Map<string, OutboxEntry>();
  const laggyStore: OutboxStore = {
    get: async (key) => map.get(key) ?? null,
    put: async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      map.set(entry.id, { ...entry });
    },
    delete: async (key) => {
      map.delete(key);
    },
    list: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));

      return Array.from(map.values(), (entry) => ({ ...entry }));
    },
  };
  const outbox = createOutbox(laggyStore);

  const results = await Promise.all([
    outbox.upsertPending(baseInput()),
    outbox.upsertPending(baseInput()),
    outbox.upsertPending(baseInput()),
    outbox.upsertPending(baseInput()),
    outbox.upsertPending(baseInput()),
  ]);

  // All five coalesce onto the same single pending entry (same id + localSeq 1).
  const ids = new Set(results.map((entry) => entry.id));

  assert.equal(ids.size, 1, 'all coalesced onto one entry');
  assert.ok(results.every((entry) => entry.localSeq === 1));

  const all = await outbox.listDue(Number.MAX_SAFE_INTEGER);

  assert.equal(all.length, 1, 'exactly one pending entry survives the race');
});

test('multiple documents stay isolated across enqueue, sync, and eviction', async () => {
  const store = createMemoryStore();
  const outbox = createOutbox(store, { maxEntriesPerDocument: 2 });

  // Doc A: 3 synced → evicts down to 2. Doc B: 3 pending → keeps all 3 (durability).
  for (let i = 0; i < 3; i += 1) {
    const entry = await outbox.enqueue(baseInput({ documentId: 'A' }));

    await outbox.markSynced(entry.id, i + 1);
  }

  for (let i = 0; i < 3; i += 1) {
    await outbox.enqueue(baseInput({ documentId: 'B' }));
  }

  const all = await store.list();
  const docA = all.filter((entry) => entry.documentId === 'A');
  const docB = all.filter((entry) => entry.documentId === 'B');

  assert.equal(docA.length, 2);
  assert.ok(docA.every((entry) => entry.status === 'synced'));
  assert.equal(docB.length, 3);
  assert.ok(docB.every((entry) => entry.status === 'pending'));
  assert.equal(await outbox.pendingCount('A'), 0);
  assert.equal(await outbox.pendingCount('B'), 3);
});
