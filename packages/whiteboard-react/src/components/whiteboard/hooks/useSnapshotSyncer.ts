import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createSnapshotSyncer,
  createWhiteboardRawDataBlob,
  isLikelyMongoObjectId,
  openWhiteboardSyncEnvironment,
  uploadToWhiteboardPresignedUrl,
} from '@repo/whiteboard-core';

import { WHITEBOARD_STORAGE_UPDATED_EVENT, type WhiteboardStorageUpdatedEventDetail } from './useWhiteboardStorage';

import type {
  SnapshotDivergenceEvent,
  SnapshotSyncer,
  SnapshotSyncerClient,
  SnapshotSyncerEvents,
  SyncerDrainReason,
  SyncerStatus,
  WhiteboardDocument,
} from '@repo/whiteboard-core';
import { isPointerDown, millisecondsSinceLastInput } from '../utils/inputActivity';
import { scheduleQuietIdleWork, type QuietIdleHandle } from '../utils/idleWork';

import type { CaptureDocument } from '../utils/documentCaptureWorker';

/** The shared sync-environment handle (outbox + payload + cursor stores over one IDB connection). */
export type SyncEnvironment = Awaited<ReturnType<typeof openWhiteboardSyncEnvironment>>;

/**
 * The single private seam tests use to inject a fake syncer. Production never passes it, so the
 * hook builds the real engine via {@link createSnapshotSyncer}. Mirrors that factory's signature.
 */
export type SnapshotSyncerFactory = (
  deps: Parameters<typeof createSnapshotSyncer>[0],
  events: SnapshotSyncerEvents,
) => SnapshotSyncer;

export interface UseSnapshotSyncerOptions {
  /** The board being edited. `null` (no board yet) disables the syncer. */
  documentId: string | null;
  /** Stable per-device identity used to attribute snapshots + detect divergence. */
  deviceId: string;
  /** Master switch; `false` keeps the engine torn down. Defaults to `true`. */
  enabled?: boolean;
  /** Re-acquires the API client (re-auths on 401) so the engine never holds a stale client. */
  runWithClient: <T>(fn: (client: SnapshotSyncerClient) => Promise<T>) => Promise<T>;
  /**
   * Loads the freshest local document. The board page passes its existing `storage.loadWhiteboard`
   * so the hook NEVER opens a second whiteboards DB connection — it only owns the sync-env handle.
   */
  loadDocument: (documentId: string) => Promise<WhiteboardDocument | null>;
  /**
   * Off-thread capture: reads the board from IndexedDB and serialises it INSIDE A WEB WORKER, so
   * the enqueue costs the drawing thread nothing but the finished gzip Blob.
   *
   * Optional, and deliberately so. Absent (SSR, an old WebView, `Worker` missing) the hook keeps
   * using `loadDocument` + `enqueueFromDocument` exactly as before, and a capture that THROWS
   * falls back to that same path for that one enqueue — a broken worker must degrade to today's
   * behaviour, never to a lost sync.
   *
   * Build one with `createWorkerDocumentCapture()`; it returns `null` where workers do not exist,
   * which is exactly what this option accepts.
   */
  captureDocument?: CaptureDocument;
  /** Debounce window coalescing rapid editor autosaves into one enqueue. Defaults to `1500`ms. */
  debounceMs?: number;
  /**
   * The DEVICE-wide upload slot (`apps/whiteboard/lib/cloud-sync/upload-slot.ts`), passed straight
   * through to the engine.
   *
   * This hook's engine is one of THREE uploaders on the device — the app-wide board worker and the
   * source-PDF queue are the others, and all three wake on `online`. Each had its own private
   * concurrency latch and none of them was device-wide, so "one upload in flight" was true of each
   * subsystem and false of the machine. Injected rather than imported because this package has no
   * app to import from.
   */
  acquireUploadSlot?: () => Promise<() => void>;
  /**
   * The recording gate, passed straight through to the engine: `true` holds the UPLOAD back while
   * a lesson is being filmed. Capture and enqueue are untouched, so nothing is lost — and a
   * `'manual'` drain (the sync-now button, the back-button flush) is never held back at all.
   *
   * Fails open inside the engine; see `SnapshotSyncerDeps.shouldDeferUpload`.
   */
  shouldDeferUpload?: (reason: SyncerDrainReason) => boolean | Promise<boolean>;
  /** Test seam: opens the outbox/payload/cursor stores. Defaults to `openWhiteboardSyncEnvironment`. */
  createEnvironment?: () => Promise<SyncEnvironment>;
  /** Private test seam: builds the syncer. Defaults to `createSnapshotSyncer`. */
  createSyncer?: SnapshotSyncerFactory;
}

export interface UseSnapshotSyncerResult {
  status: SyncerStatus;
  pendingCount: number;
  lastSyncedAt: number | null;
  divergence: SnapshotDivergenceEvent | null;
  dismissDivergence: () => void;
  legacyMode: boolean;
  /** Fire-and-forget manual drain (the "sync now" button). */
  syncNow: () => void;
  /** Awaitable final drain for `handleBack` / `beforeunload` — flush before navigating away. */
  flush: () => Promise<void>;
  /**
   * Fire-and-forget cursor seed for the open board (the page passes `latestSnapshotSeq` from
   * `GET /documents/:id`). Once the sync env is ready, sets the cursor for `documentId` to
   * `max(current ?? -1, seq)` so it NEVER regresses a higher local cursor. A call made before
   * the env resolves is buffered and applied on ready; a later call applies immediately.
   */
  seedServerSeq: (seq: number) => void;
}

/** A writer who never pauses still gets an enqueue at the next pen lift after this long. */
const ENQUEUE_MAX_DEFER_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 1500;
const SELF_HEAL_INTERVAL_MS = 45000;

export function useSnapshotSyncer(options: UseSnapshotSyncerOptions): UseSnapshotSyncerResult {
  const {
    documentId,
    deviceId,
    enabled = true,
    runWithClient,
    loadDocument,
    captureDocument,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    acquireUploadSlot,
    shouldDeferUpload,
    createEnvironment = openWhiteboardSyncEnvironment,
    createSyncer = createSnapshotSyncer,
  } = options;

  const [status, setStatus] = useState<SyncerStatus>('idle');
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [divergence, setDivergence] = useState<SnapshotDivergenceEvent | null>(null);
  const [legacyMode, setLegacyMode] = useState(false);

  // Latest values mirrored into refs so the long-lived listeners/timers read fresh callbacks
  // without re-subscribing every render.
  const runWithClientRef = useRef(runWithClient);
  const loadDocumentRef = useRef(loadDocument);
  // Mirrored like `loadDocument`: swapping the capture strategy between renders must not tear the
  // engine down mid-upload, and the worker singleton lives outside this hook anyway.
  const captureDocumentRef = useRef(captureDocument);
  // Mirrored, not listed in the effect's deps: the engine must NOT be torn down and rebuilt because
  // the board page re-rendered with a fresh closure. A rebuild mid-upload is the thing this whole
  // area of the code keeps paying for.
  const acquireUploadSlotRef = useRef(acquireUploadSlot);
  const shouldDeferUploadRef = useRef(shouldDeferUpload);

  runWithClientRef.current = runWithClient;
  loadDocumentRef.current = loadDocument;
  captureDocumentRef.current = captureDocument;
  acquireUploadSlotRef.current = acquireUploadSlot;
  shouldDeferUploadRef.current = shouldDeferUpload;

  // The live syncer for the current document, exposed to the imperative callbacks below. Reset to
  // null whenever the engine is torn down (disable, unmount, document change) so a late "sync now"
  // is a safe no-op.
  const syncerRef = useRef<SnapshotSyncer | null>(null);
  // The live sync environment for the current document, used by `seedServerSeq` so it can write
  // the cursor without re-opening a DB connection. Null while the engine is torn down.
  const environmentRef = useRef<SyncEnvironment | null>(null);
  // The current document's id, mirrored into a ref so `seedServerSeq` always seeds the right board.
  const documentIdRef = useRef(documentId);
  // Buffers the newest seed requested before the env is ready (the page usually calls seedServerSeq
  // from its bootstrap `getDocument`, which can resolve before `createEnvironment`). Applied once on
  // ready. We keep the MAX requested seed so an out-of-order pair of calls still seeds the highest.
  const pendingSeedRef = useRef<number | null>(null);

  documentIdRef.current = documentId;

  // Write `max(current ?? -1, seq)` into the cursor for `targetId` — never regressing a higher local
  // cursor. Best-effort: a failed read/write must never crash the syncer.
  const applyServerSeqSeed = useCallback((environment: SyncEnvironment, targetId: string, seq: number): void => {
    void (async () => {
      try {
        const current = await environment.cursor.get(targetId);

        if (current !== null && current >= seq) {
          return;
        }

        // Seed the SEQ but pass the sentinel `0` for `syncedAt`: this board's content is in the
        // cloud, but THIS device has never uploaded to it, so it has NO real "last synced" time.
        // Passing `0` (not nullish) makes the store write `lastSyncedAt = 0` instead of `Date.now()`,
        // so a freshly cloud-loaded board never claims a sync that never happened. The seq still
        // seeds correctly, keeping first-append divergence detection accurate.
        await environment.cursor.set(targetId, seq, 0);
      } catch {
        // Seeding the cursor is best-effort: a failure just defers accurate divergence to the
        // first real append, it never blocks editing or syncing.
      }
    })();
  }, []);

  const dismissDivergence = useCallback(() => {
    setDivergence(null);
  }, []);

  const syncNow = useCallback(() => {
    void syncerRef.current?.drain('manual');
  }, []);

  const flush = useCallback(async () => {
    await syncerRef.current?.drain('manual');
  }, []);

  const seedServerSeq = useCallback(
    (seq: number) => {
      if (!Number.isFinite(seq)) {
        return;
      }

      const environment = environmentRef.current;

      if (environment && documentIdRef.current) {
        applyServerSeqSeed(environment, documentIdRef.current, seq);

        return;
      }

      // Env not ready yet → buffer the highest seed seen so the on-ready apply uses it.
      pendingSeedRef.current = Math.max(pendingSeedRef.current ?? -1, seq);
    },
    [applyServerSeqSeed],
  );

  useEffect(() => {
    if (enabled === false || !documentId || !deviceId) {
      return undefined;
    }

    // Local-only / imported board: its documentId is a client UUID (from createWhiteboardId), not a
    // Mongo _id, so it is not cloud-syncable yet. Don't open a sync env, build an engine, enqueue,
    // or drain for it — and present a BENIGN, non-error UI ('idle', nothing pending, no divergence)
    // so a local board never shows a phantom sync error for content the backend doesn't track. Once
    // Tier 2 reconciliation links it to a real _id, this effect re-runs with the ObjectId and the
    // full engine spins up normally. (The previous effect's teardown already nulled the refs/closed
    // the env, so there is nothing live to tear down here.)
    if (!isLikelyMongoObjectId(documentId)) {
      setStatus('idle');
      setPendingCount(0);
      setLastSyncedAt(null);
      setDivergence(null);
      setLegacyMode(false);
      pendingSeedRef.current = null;

      return undefined;
    }

    // Fresh document → fresh UI. Without this, a documentId change (board A → board B in the same
    // mount) bleeds A's divergence banner, legacy flag, status, lastSyncedAt and pending badge onto
    // B until B happens to emit its own events — and a sticky divergence/legacy state may never
    // clear. The cursor seed + first status/startup drain below repopulate B's real values.
    setStatus('idle');
    setPendingCount(0);
    setLastSyncedAt(null);
    setDivergence(null);
    setLegacyMode(false);

    // A stale seed buffered for the previous board must never leak onto this one.
    pendingSeedRef.current = null;

    // Generation token: guards against React StrictMode's double-invoke and a documentId change
    // landing mid-setup. If this effect is cleaned up before `createEnvironment` resolves, we stop
    // the just-built syncer and never touch state.
    let active = true;
    let syncer: SnapshotSyncer | null = null;
    let environment: SyncEnvironment | null = null;
    let quietWork: QuietIdleHandle | null = null;
    let intervalTimer: ReturnType<typeof setInterval> | null = null;

    const refreshPending = (env: SyncEnvironment): void => {
      void env.outbox
        .pendingCount(documentId)
        .then((count) => {
          if (active) {
            setPendingCount(count);
          }
        })
        .catch(() => {
          // Counting is best-effort UI sugar — a failed read must never crash the syncer.
        });
    };

    const events: SnapshotSyncerEvents = {
      onStatus: (next, statusDocumentId) => {
        if (!active) {
          return;
        }

        // The chip is a claim about THIS board. The engine is bound to `documentId` so it only
        // ever reports on this board, but the second argument exists precisely so a listener can
        // tell — read it rather than trusting the caller. An empty id is the engine's
        // document-agnostic signal (offline), which does apply here.
        if (statusDocumentId && statusDocumentId !== documentId) {
          return;
        }

        setStatus(next);

        if (next === 'synced' || next === 'diverged') {
          setLastSyncedAt(Date.now());
        }

        if (environment) {
          refreshPending(environment);
        }
      },
      onDiverged: (event) => {
        if (active) {
          setDivergence(event);
        }
      },
      onLegacyFallback: () => {
        if (active) {
          setLegacyMode(true);
        }
      },
    };

    const teardown = (): void => {
      active = false;

      quietWork?.cancel();
      quietWork = null;

      if (intervalTimer !== null) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }

      window.removeEventListener(WHITEBOARD_STORAGE_UPDATED_EVENT, handleStorageUpdated as EventListener);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      syncer?.stop();
      syncer = null;
      syncerRef.current = null;
      // Close the sync-env DB handle we opened (the whiteboards-store handle is the caller's).
      environment?.db.close();
      environment = null;
      environmentRef.current = null;
    };

    /** The original path: read + serialise on THIS thread, then enqueue. */
    const enqueueOnMainThread = async (): Promise<void> => {
      const doc = await loadDocumentRef.current(documentId);

      if (active && doc && syncer) {
        // enqueueFromDocument persists the blob + triggers its own drain internally.
        await syncer.enqueueFromDocument(doc);
      }
    };

    const enqueueLatest = (): void => {
      void (async () => {
        const capture = captureDocumentRef.current;

        if (capture) {
          try {
            // The 54 MB read, the JSON.stringify and the gzip all happen in the worker; only the
            // finished Blob and a handful of scalars come back.
            const captured = await capture(documentId);

            // `null` = the board is gone locally. That is an ANSWER, not a failure — the
            // main-thread path would do nothing with it either, so don't re-read it there.
            if (captured && active && syncer) {
              await syncer.enqueueSerialized(captured.meta, captured.serialized);
            }

            return;
          } catch (error) {
            // A dead worker must cost a little lag, never a snapshot. One fallback for THIS
            // enqueue; the next one tries the worker again (it was dropped, so it is rebuilt).
            console.warn('[whiteboard] off-thread capture failed, falling back to the main thread.', error);
          }
        }

        await enqueueOnMainThread();
      })();
    };

    const handleStorageUpdated = (event: CustomEvent<WhiteboardStorageUpdatedEventDetail>): void => {
      // Only react to edits of the board this hook owns.
      if (!active || event.detail?.id !== documentId) {
        return;
      }

      // The enqueue re-reads the whole board from IndexedDB and JSON-serializes it on the main
      // thread (a 100-page PDF board is megabytes). A plain debounce fired that in the middle of
      // the NEXT stroke — the ViewSonic's "lags, then smooths" on PDF boards (2026-09-13). So it
      // waits like the other heavy off-input work: never while a contact is down, only after
      // `debounceMs` of input quiet, with a ceiling so a teacher who never pauses still syncs at
      // the next pen lift.
      if (quietWork && quietWork.isPending()) {
        quietWork.reschedule(enqueueLatest);

        return;
      }

      quietWork = scheduleQuietIdleWork(enqueueLatest, {
        isBusy: isPointerDown,
        maxDeferMs: ENQUEUE_MAX_DEFER_MS,
        msSinceInput: millisecondsSinceLastInput,
        quietMs: debounceMs,
      });
    };

    const handleOnline = (): void => {
      void syncer?.drain('online');
    };

    const handleFocus = (): void => {
      void syncer?.drain('focus');
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void syncer?.drain('visibility');
      }
    };

    void (async () => {
      const env = await createEnvironment();

      // A teardown (unmount / document change / StrictMode) raced ahead of us → discard this env.
      if (!active) {
        env.db.close();

        return;
      }

      environment = env;
      environmentRef.current = env;

      // Apply any seed the page requested before the env was ready (its bootstrap getDocument can
      // resolve first). max-merge already happened in the buffer, so this writes the highest seed.
      if (pendingSeedRef.current !== null) {
        applyServerSeqSeed(env, documentId, pendingSeedRef.current);
        pendingSeedRef.current = null;
      }

      syncer = createSyncer(
        {
          runWithClient: (fn) => runWithClientRef.current(fn),
          // BIND the engine to this board. The outbox/payload/cursor stores are device-wide and
          // shared with the app-wide auto-upload worker, while `runWithClient` above is the
          // SELECTED teacher's client and `events.onStatus` below paints THIS board's chip.
          // Unbound, the engine's whole-store drain would POST another teacher's due entry under
          // the selected teacher's key — 4xx, markFailed, cycle broken before this board's own
          // entry ever went out, and «Error» on this board's chip for someone else's failure — and
          // its cold-start reclaim would flip the worker's in-flight upload back to due, appending
          // that snapshot twice. Bound, none of those paths exist.
          documentId,
          outbox: env.outbox,
          payloads: env.payloads,
          cursor: env.cursor,
          uploadBlob: (uploadUrl, blob, contentType) =>
            uploadToWhiteboardPresignedUrl({ uploadUrl, body: blob, contentType }),
          getLatestDocSnapshot: (id) => loadDocumentRef.current(id),
          serialize: (doc) => createWhiteboardRawDataBlob(doc, { gzip: true }),
          deviceId,
          // Both optional and both read through a ref, so a caller that supplies neither gets the
          // old behaviour exactly and a caller that supplies them can change its mind per render.
          acquireUploadSlot: acquireUploadSlotRef.current
            ? () => (acquireUploadSlotRef.current as () => Promise<() => void>)()
            : undefined,
          shouldDeferUpload: (reason) => shouldDeferUploadRef.current?.(reason) ?? false,
        },
        events,
      );
      syncerRef.current = syncer;

      window.addEventListener(WHITEBOARD_STORAGE_UPDATED_EVENT, handleStorageUpdated as EventListener);
      window.addEventListener('online', handleOnline);
      window.addEventListener('focus', handleFocus);
      document.addEventListener('visibilitychange', handleVisibilityChange);

      intervalTimer = setInterval(() => {
        void syncer?.drain('interval');
      }, SELF_HEAL_INTERVAL_MS);

      // Seed the seq cursor's last-synced time + pending badge from what a previous session left.
      // A stored value <= 0 is the seed sentinel (a cloud-loaded board this device never uploaded
      // to): treat it as "no real sync" → null, so the status never claims a fabricated upload time.
      // A genuine upload writes a real Date.now() time, which surfaces unchanged.
      void env.cursor
        .getLastSyncedAt(documentId)
        .then((at) => {
          if (active && at !== null && at > 0) {
            setLastSyncedAt(at);
          }
        })
        .catch(() => {
          // Best-effort seed.
        });
      refreshPending(env);

      // Cold start: flush anything stranded in the outbox from a previous session right away. The
      // engine's reclaimInflight sweeps crash-stranded inflight entries on this first drain.
      void syncer.drain('startup');
    })();

    return teardown;
  }, [applyServerSeqSeed, createEnvironment, createSyncer, debounceMs, deviceId, documentId, enabled]);

  return {
    status,
    pendingCount,
    lastSyncedAt,
    divergence,
    dismissDivergence,
    legacyMode,
    syncNow,
    flush,
    seedServerSeq,
  };
}
