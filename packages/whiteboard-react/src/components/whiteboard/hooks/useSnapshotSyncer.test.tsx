import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React from 'react';

import { WHITEBOARD_STORAGE_UPDATED_EVENT } from './useWhiteboardStorage';

import type {
  SnapshotDivergenceEvent,
  SerializedSnapshotMeta,
  SnapshotSyncer,
  SnapshotSyncerEvents,
  SyncerDrainReason,
  WhiteboardDocument,
} from '@repo/whiteboard-core';
import type { SyncEnvironment, UseSnapshotSyncerOptions, UseSnapshotSyncerResult } from './useSnapshotSyncer';

// jsdom global setup mirrors WhiteboardErrorBoundary.test.tsx: client-render needs a real DOM, and
// the listeners/timers in the hook only exist with window/document present.
before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const domGlobals = globalThis as unknown as {
    window?: unknown;
    document?: unknown;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  domGlobals.window = dom.window;
  domGlobals.document = dom.window.document;
  domGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
});

// Real Mongo ObjectIds: the hook never builds an engine for a local (non-ObjectId) board.
const DOCUMENT_ID = '64b7f0c2a1d3e4f5a6b7c8d1';
const SECOND_DOCUMENT_ID = '64b7f0c2a1d3e4f5a6b7c8d2';
const DEBOUNCE_MS = 1500;

function makeDocument(id: string): WhiteboardDocument {
  return {
    id,
    title: 'Board',
    pages: [],
    currentPageIndex: 0,
    createdAt: 0,
    updatedAt: 0,
    thumbnail: '',
  };
}

/** A fake syncer recording every interaction, plus captured engine event hooks to fire by hand. */
interface FakeSyncer extends SnapshotSyncer {
  enqueueCalls: WhiteboardDocument[];
  /** Every `enqueueSerialized` (the off-thread capture path), in order. */
  serializedEnqueueCalls: SerializedSnapshotMeta[];
  drainReasons: SyncerDrainReason[];
  stopCount: number;
  events: SnapshotSyncerEvents;
}

function makeFakeSyncer(events: SnapshotSyncerEvents): FakeSyncer {
  const fake: FakeSyncer = {
    enqueueCalls: [],
    serializedEnqueueCalls: [],
    drainReasons: [],
    stopCount: 0,
    events,
    enqueueFromDocument: async (doc) => {
      fake.enqueueCalls.push(doc);
    },
    enqueueSerialized: async (meta) => {
      fake.serializedEnqueueCalls.push(meta);
    },
    drain: async (reason) => {
      fake.drainReasons.push(reason);
    },
    stop: () => {
      fake.stopCount += 1;
    },
  };

  return fake;
}

/** A captured `cursor.set` call, so seed tests can assert what was written (incl. `syncedAt`). */
interface CursorSetCall {
  documentId: string;
  seq: number;
  syncedAt?: number;
}

interface FakeEnvironmentExtras {
  dbCloseCount: number;
  cursorSetCalls: CursorSetCall[];
  cursorSeq: number | null;
  /** The `lastSyncedAt` a previous session left, returned by `getLastSyncedAt`. Mirrors the real
   *  store: `set` with a non-nullish `syncedAt` (incl. the `0` seed sentinel) records it verbatim. */
  cursorSyncedAt: number | null;
}

/** A minimal in-memory sync environment: only the members the hook touches need to resolve. */
function makeFakeEnvironment(
  initialCursorSeq: number | null = null,
  initialCursorSyncedAt: number | null = null,
): SyncEnvironment & FakeEnvironmentExtras {
  const env = {
    dbCloseCount: 0,
    cursorSetCalls: [] as CursorSetCall[],
    cursorSeq: initialCursorSeq,
    cursorSyncedAt: initialCursorSyncedAt,
    db: {
      close: () => {
        env.dbCloseCount += 1;
      },
    },
    outbox: {
      pendingCount: async () => 0,
    },
    payloads: {},
    cursor: {
      getLastSyncedAt: async () => env.cursorSyncedAt,
      get: async () => env.cursorSeq,
      set: async (documentId: string, seq: number, syncedAt?: number) => {
        env.cursorSeq = seq;
        // Mirror ServerSeqStore.set: a non-nullish `syncedAt` (so `0` too, since 0 is not nullish)
        // is recorded verbatim; omitting it keeps the existing time (or stamps now in the real store).
        if (syncedAt !== undefined) {
          env.cursorSyncedAt = syncedAt;
        }
        env.cursorSetCalls.push({ documentId, seq, syncedAt });
      },
    },
  } as unknown as SyncEnvironment & FakeEnvironmentExtras;

  return env;
}

type FakeEnvironment = ReturnType<typeof makeFakeEnvironment>;

interface Harness {
  result: () => UseSnapshotSyncerResult;
  fakeSyncer: () => FakeSyncer | null;
  environment: FakeEnvironment;
  rerender: (overrides: Partial<UseSnapshotSyncerOptions>) => Promise<void>;
  unmount: () => Promise<void>;
}

async function mountHook(
  overrides: Partial<UseSnapshotSyncerOptions> = {},
  environment: FakeEnvironment = makeFakeEnvironment(),
): Promise<Harness> {
  const { useSnapshotSyncer } = await import('./useSnapshotSyncer');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  let fake: FakeSyncer | null = null;
  let latest: UseSnapshotSyncerResult | null = null;

  const baseOptions: UseSnapshotSyncerOptions = {
    documentId: DOCUMENT_ID,
    deviceId: 'device-1',
    runWithClient: async (fn) => fn({} as never),
    loadDocument: async (id) => makeDocument(id),
    debounceMs: DEBOUNCE_MS,
    createEnvironment: async () => environment,
    createSyncer: (_deps, events) => {
      fake = makeFakeSyncer(events);

      return fake;
    },
    ...overrides,
  };

  let currentOptions = baseOptions;

  function Harnessed(): React.ReactElement | null {
    latest = useSnapshotSyncer(currentOptions);

    return null;
  }

  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(Harnessed));
  });
  // Let the async setup (createEnvironment → createSyncer) resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    result: () => {
      assert.ok(latest, 'hook did not render');

      return latest;
    },
    fakeSyncer: () => fake,
    environment,
    rerender: async (next) => {
      currentOptions = { ...currentOptions, ...next };

      await act(async () => {
        root.render(React.createElement(Harnessed));
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

function dispatchStorageUpdated(id: string): void {
  window.dispatchEvent(
    new window.CustomEvent(WHITEBOARD_STORAGE_UPDATED_EVENT, {
      detail: { id, pageCount: 1, title: 'Board', updatedAt: Date.now() },
    }),
  );
}

let restoreTimers: (() => void) | null = null;

beforeEach(() => {
  restoreTimers?.();
  restoreTimers = null;
});

/** Replace setTimeout/clearTimeout with a manual queue so the debounce is deterministic. */
function installManualTimers(): { flushTimers: () => void } {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextId = 1;
  const pending = new Map<number, () => void>();

  (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
    const id = nextId++;

    pending.set(id, fn);

    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  (globalThis as unknown as { clearTimeout: unknown }).clearTimeout = ((id: number) => {
    pending.delete(id);
  }) as typeof clearTimeout;

  restoreTimers = () => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  };

  return {
    flushTimers: () => {
      const fns = Array.from(pending.values());

      pending.clear();
      fns.forEach((fn) => fn());
    },
  };
}

test('a storage-updated event for THIS document enqueues only after the debounce', async () => {
  const { flushTimers } = installManualTimers();
  const { act } = await import('react');
  const harness = await mountHook();
  const fake = harness.fakeSyncer();

  assert.ok(fake, 'fake syncer should be built');

  dispatchStorageUpdated(DOCUMENT_ID);
  // Before the debounce fires, nothing is enqueued.
  assert.equal(fake!.enqueueCalls.length, 0, 'enqueue must wait for the debounce');

  await act(async () => {
    flushTimers();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(fake!.enqueueCalls.length, 1, 'enqueue should fire once after the debounce');
  assert.equal(fake!.enqueueCalls[0]?.id, DOCUMENT_ID);

  await harness.unmount();
});

test('a storage-updated event for a DIFFERENT document is ignored', async () => {
  const { flushTimers } = installManualTimers();
  const { act } = await import('react');
  const harness = await mountHook();
  const fake = harness.fakeSyncer();

  dispatchStorageUpdated('some-other-doc');

  await act(async () => {
    flushTimers();
    await Promise.resolve();
  });

  assert.equal(fake!.enqueueCalls.length, 0, 'a different document must not enqueue');

  await harness.unmount();
});

test('online and visibilitychange call drain', async () => {
  const harness = await mountHook();
  const fake = harness.fakeSyncer();
  const { act } = await import('react');

  // 'startup' drain already ran on setup.
  assert.ok(fake!.drainReasons.includes('startup'), 'a startup drain should run after setup');

  await act(async () => {
    window.dispatchEvent(new window.Event('online'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new window.Event('visibilitychange'));
    await Promise.resolve();
  });

  assert.ok(fake!.drainReasons.includes('online'), 'online should drain');
  assert.ok(fake!.drainReasons.includes('visibility'), 'visibilitychange (visible) should drain');

  await harness.unmount();
});

test('onStatus and onDiverged update the returned state', async () => {
  const harness = await mountHook();
  const fake = harness.fakeSyncer();
  const { act } = await import('react');

  await act(async () => {
    fake!.events.onStatus?.('syncing', DOCUMENT_ID);
    await Promise.resolve();
  });
  assert.equal(harness.result().status, 'syncing');

  const divergence: SnapshotDivergenceEvent = {
    documentId: DOCUMENT_ID,
    localSeq: 5,
    serverSeq: 5,
  };

  await act(async () => {
    fake!.events.onStatus?.('synced', DOCUMENT_ID);
    fake!.events.onDiverged?.(divergence);
    fake!.events.onLegacyFallback?.();
    await Promise.resolve();
  });

  assert.equal(harness.result().status, 'synced');
  assert.equal(harness.result().divergence?.localSeq, 5);
  assert.equal(harness.result().legacyMode, true);
  assert.notEqual(harness.result().lastSyncedAt, null);

  // dismissDivergence clears it.
  await act(async () => {
    harness.result().dismissDivergence();
    await Promise.resolve();
  });
  assert.equal(harness.result().divergence, null);

  await harness.unmount();
});

test('unmount stops the syncer and removes listeners (a later event does nothing)', async () => {
  const { flushTimers } = installManualTimers();
  const { act } = await import('react');
  const harness = await mountHook();
  const fake = harness.fakeSyncer();

  await harness.unmount();

  assert.equal(fake!.stopCount, 1, 'stop() should be called on unmount');
  assert.equal(harness.environment.dbCloseCount, 1, 'the sync-env db handle should be closed');

  const enqueueBefore = fake!.enqueueCalls.length;

  // A post-unmount storage event must be a no-op (listener removed).
  dispatchStorageUpdated(DOCUMENT_ID);
  await act(async () => {
    flushTimers();
    await Promise.resolve();
  });

  assert.equal(fake!.enqueueCalls.length, enqueueBefore, 'no enqueue after unmount');
});

test('changing documentId tears down the old syncer and builds a new one', async () => {
  const harness = await mountHook();
  const first = harness.fakeSyncer();

  await harness.rerender({ documentId: SECOND_DOCUMENT_ID });

  const second = harness.fakeSyncer();

  assert.equal(first!.stopCount, 1, 'the old syncer should be stopped on documentId change');
  assert.notEqual(first, second, 'a new syncer should be built for the new documentId');
  assert.equal(second!.stopCount, 0, 'the new syncer should still be live');

  await harness.unmount();
});

test('changing documentId resets divergence/legacy/status so state never bleeds across boards', async () => {
  const harness = await mountHook();
  const first = harness.fakeSyncer();
  const { act } = await import('react');

  // Drive board A into a diverged + legacy + non-idle state.
  await act(async () => {
    first!.events.onStatus?.('diverged', DOCUMENT_ID);
    first!.events.onDiverged?.({ documentId: DOCUMENT_ID, localSeq: 7, serverSeq: 7 });
    first!.events.onLegacyFallback?.();
    await Promise.resolve();
  });

  assert.equal(harness.result().status, 'diverged');
  assert.equal(harness.result().divergence?.localSeq, 7);
  assert.equal(harness.result().legacyMode, true);
  assert.notEqual(harness.result().lastSyncedAt, null);

  // Switch to board B — A's transient UI must NOT carry over.
  await harness.rerender({ documentId: SECOND_DOCUMENT_ID });

  assert.equal(harness.result().status, 'idle', 'status must reset for the new board');
  assert.equal(harness.result().divergence, null, 'divergence banner must not bleed onto the new board');
  assert.equal(harness.result().legacyMode, false, 'legacy flag must not bleed onto the new board');
  assert.equal(harness.result().lastSyncedAt, null, 'lastSyncedAt must reset (env reseeds the real value)');
  assert.equal(harness.result().pendingCount, 0, 'pending badge must reset for the new board');

  await harness.unmount();
});

test('seedServerSeq after env-ready advances the cursor when the seed is higher', async () => {
  const environment = makeFakeEnvironment(2);
  const harness = await mountHook({}, environment);
  const { act } = await import('react');

  await act(async () => {
    harness.result().seedServerSeq(5);
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.deepEqual(
    environment.cursorSetCalls,
    [{ documentId: DOCUMENT_ID, seq: 5, syncedAt: 0 }],
    'a higher seed should be written to the cursor with the no-fabricated-time sentinel (0)',
  );

  await harness.unmount();
});

test('seedServerSeq never regresses a higher local cursor', async () => {
  const environment = makeFakeEnvironment(9);
  const harness = await mountHook({}, environment);
  const { act } = await import('react');

  await act(async () => {
    harness.result().seedServerSeq(4);
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(environment.cursorSetCalls.length, 0, 'a lower seed must not overwrite a higher cursor');
  assert.equal(environment.cursorSeq, 9, 'the local cursor stays at its higher value');

  await harness.unmount();
});

test('seedServerSeq seeds the seq but never fabricates a lastSyncedAt (FE-5 status honesty)', async () => {
  // A FRESH cursor (no prior seq, no prior synced time) standing in for a board this device
  // loaded from the cloud but never uploaded to.
  const environment = makeFakeEnvironment(null, null);
  const harness = await mountHook({}, environment);
  const { act } = await import('react');

  await act(async () => {
    harness.result().seedServerSeq(5);
    await Promise.resolve();
    await Promise.resolve();
  });

  // The SEQ IS seeded (so first-append divergence stays correct)...
  assert.equal(environment.cursorSeq, 5, 'the seq must still be seeded so divergence detection works');
  assert.deepEqual(
    environment.cursorSetCalls,
    [{ documentId: DOCUMENT_ID, seq: 5, syncedAt: 0 }],
    'seeding must pass the 0 sentinel, never a fabricated Date.now()',
  );
  // ...but the hook must NOT surface a fabricated "backed up just now" time.
  assert.equal(
    harness.result().lastSyncedAt,
    null,
    'seeding must not fabricate a local last-synced time — status stays "no real sync"',
  );

  await harness.unmount();
});

test('a stored sentinel lastSyncedAt (0) is surfaced as null on startup', async () => {
  // A previous session seeded a cloud-loaded board: seq present, lastSyncedAt is the 0 sentinel.
  const environment = makeFakeEnvironment(5, 0);
  const harness = await mountHook({}, environment);

  assert.equal(
    harness.result().lastSyncedAt,
    null,
    'a <= 0 stored time is the seed sentinel and must surface as null, not "backed up just now"',
  );

  await harness.unmount();
});

test('a real stored lastSyncedAt from a genuine upload is surfaced on startup', async () => {
  // A previous session genuinely uploaded: a real wall-clock time is stored.
  const realSyncedAt = 1_700_000_000_000;
  const environment = makeFakeEnvironment(5, realSyncedAt);
  const harness = await mountHook({}, environment);

  assert.equal(harness.result().lastSyncedAt, realSyncedAt, 'a genuine upload time must surface unchanged on startup');

  await harness.unmount();
});

test('a real synced-status event still sets a real lastSyncedAt after a seed', async () => {
  // Seed a fresh cloud-loaded board (no real sync time yet)...
  const environment = makeFakeEnvironment(null, null);
  const harness = await mountHook({}, environment);
  const { act } = await import('react');

  await act(async () => {
    harness.result().seedServerSeq(5);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(harness.result().lastSyncedAt, null, 'seeding alone must not set a synced time');

  const fake = harness.fakeSyncer();
  const before = Date.now();

  // ...then a CONFIRMED append fires a real synced status: the real-sync path is unaffected.
  await act(async () => {
    fake!.events.onStatus?.('synced', DOCUMENT_ID);
    await Promise.resolve();
  });

  const at = harness.result().lastSyncedAt;

  assert.notEqual(at, null, 'a genuine synced status must set a real lastSyncedAt');
  assert.ok(at !== null && at >= before, 'the real lastSyncedAt should be a fresh wall-clock time');

  await harness.unmount();
});

test('a seedServerSeq requested before the env is ready is applied on ready', async () => {
  const environment = makeFakeEnvironment(0);
  const { useSnapshotSyncer } = await import('./useSnapshotSyncer');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  // Gate createEnvironment so we can call seedServerSeq while the env is still pending.
  let releaseEnv: (() => void) | null = null;
  const envReady = new Promise<void>((resolve) => {
    releaseEnv = resolve;
  });

  let latest: UseSnapshotSyncerResult | null = null;

  function Harnessed(): React.ReactElement | null {
    latest = useSnapshotSyncer({
      documentId: DOCUMENT_ID,
      deviceId: 'device-1',
      runWithClient: async (fn) => fn({} as never),
      loadDocument: async (id) => makeDocument(id),
      debounceMs: DEBOUNCE_MS,
      createEnvironment: async () => {
        await envReady;

        return environment;
      },
      createSyncer: (_deps, events) => makeFakeSyncer(events),
    });

    return null;
  }

  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(Harnessed));
  });

  // Env is still pending → this seed must be buffered, not written yet.
  await act(async () => {
    latest?.seedServerSeq(7);
    await Promise.resolve();
  });
  assert.equal(environment.cursorSetCalls.length, 0, 'the seed must buffer until the env is ready');

  // Release the env → the buffered seed applies.
  await act(async () => {
    releaseEnv?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.deepEqual(
    environment.cursorSetCalls,
    [{ documentId: DOCUMENT_ID, seq: 7, syncedAt: 0 }],
    'the buffered seed should write once the env is ready (with the no-fabricated-time sentinel)',
  );

  await act(async () => {
    root.unmount();
  });
});
