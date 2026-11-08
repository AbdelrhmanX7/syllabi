import { isLikelyMongoObjectId } from '../id';
import { WhiteboardApiError } from '../remote/client';
import { createWhiteboardRawDataBlob } from '../remote/raw-data';

import type {
  WhiteboardApiAppendDraftSnapshotInput,
  WhiteboardApiAppendDraftSnapshotResponse,
  WhiteboardApiDraftSnapshotBranch,
  WhiteboardApiDraftSnapshotUploadUrlResponse,
  WhiteboardApiListDraftSnapshotsParams,
  WhiteboardApiListDraftSnapshotsResponse,
  WhiteboardApiSyncDraftInput,
  WhiteboardApiSyncDraftResponse,
  WhiteboardApiUploadUrl,
  WhiteboardApiGetUploadUrlParams,
} from '../remote/types';
import type { SnapshotPayloadStore, ServerSeqStore } from '../storage/indexeddb';
import type { WhiteboardDocument } from '../types';
import type { Outbox, OutboxEntry } from './outbox';

/**
 * Snapshot syncer (FE-3a) — the heart of lossless cloud sync.
 *
 * Framework-agnostic engine that drains the durable {@link Outbox} into the cloud with the
 * write-confirm-then-advance invariant: a local snapshot is only marked `synced` (and its
 * blob deleted, and the seq cursor advanced) AFTER the server confirms the append. Nothing
 * local is advanced before the cloud has it — so a stuck sync, a crash mid-upload, or a
 * second device never silently loses work.
 *
 * Pure of React/IndexedDB specifics: everything is injected via {@link SnapshotSyncerDeps}
 * so the whole drain state machine is unit-testable with in-memory fakes (no live backend).
 */

/** Status the engine emits as it works. Mirrors the spec's status union. */
export type SyncerStatus = 'idle' | 'syncing' | 'synced' | 'pending' | 'offline' | 'retrying' | 'diverged';

/** Reason a drain was triggered (for diagnostics / future tracing). */
export type SyncerDrainReason = 'change' | 'manual' | 'interval' | 'online' | 'visibility' | 'focus' | 'startup';

/**
 * The exact subset of {@link import('../remote/client').WhiteboardApiClient} the syncer needs.
 * Structural so a test fake (or a future client) satisfies it without inheriting the class.
 */
export interface SnapshotSyncerClient {
  requestDraftSnapshotUploadUrl(documentId: string): Promise<WhiteboardApiDraftSnapshotUploadUrlResponse>;
  appendDraftSnapshot(
    documentId: string,
    input: WhiteboardApiAppendDraftSnapshotInput,
  ): Promise<WhiteboardApiAppendDraftSnapshotResponse>;
  listDraftSnapshots(
    documentId: string,
    params?: WhiteboardApiListDraftSnapshotsParams,
  ): Promise<WhiteboardApiListDraftSnapshotsResponse>;
  getUploadUrl(documentId: string, params?: WhiteboardApiGetUploadUrlParams): Promise<WhiteboardApiUploadUrl>;
  syncDraft(documentId: string, input: WhiteboardApiSyncDraftInput): Promise<WhiteboardApiSyncDraftResponse>;
}

/** Divergence event payload: our branch is kept AND the other branch is recoverable. */
export interface SnapshotDivergenceEvent {
  documentId: string;
  /** The local seq we just advanced to (server-assigned for our append). */
  localSeq: number;
  /** The server's latest seq after our append. */
  serverSeq: number;
  /** The other device's branch metadata, when the server reported one. */
  otherBranch?: WhiteboardApiDraftSnapshotBranch;
}

/** Engine event hooks. All optional so the engine runs headless in tests. */
export interface SnapshotSyncerEvents {
  onStatus?: (status: SyncerStatus, documentId: string) => void;
  onDiverged?: (event: SnapshotDivergenceEvent) => void;
  onLegacyFallback?: () => void;
}

/** Acquire a client and run one call against it. Re-acquired per call, never held. */
export type RunWithSnapshotSyncerClient = <T>(fn: (client: SnapshotSyncerClient) => Promise<T>) => Promise<T>;

/**
 * Everything the engine needs, injected. `runWithClient` re-acquires the client (it re-auths
 * on 401 in the real wiring) so the engine never holds a stale client. `serialize` produces
 * the gzipped blob (= `createWhiteboardRawDataBlob(doc, { gzip: true })`); `getLatestDocSnapshot`
 * is the doc-store fallback (= `loadWhiteboard`). `uploadBlob` is `uploadToWhiteboardPresignedUrl`.
 */
export interface SnapshotSyncerDeps {
  runWithClient: RunWithSnapshotSyncerClient;
  /**
   * Per-DOCUMENT client resolution, for an engine that spans boards belonging to different
   * teachers (the app-wide auto-upload worker).
   *
   * The device's API key is minted per teacher, and a document's owning teacher is a property of
   * the DOCUMENT — not of whoever is selected in the workspace picker at drain time. An engine
   * that resolved one client for the whole cycle would upload teacher A's snapshot under teacher
   * B's key and 4xx forever, which is exactly the defect this hook exists to make structurally
   * impossible: the key comes from the entry being sent, every time.
   *
   * Omitted (the open-board editor, which owns exactly one document) → every call falls back to
   * {@link runWithClient} and behaviour is unchanged.
   */
  runWithClientForDocument?: (documentId: string) => RunWithSnapshotSyncerClient;
  /**
   * BIND this engine to exactly one document (the open board's editor).
   *
   * The outbox, the payload store and the seq cursor are GLOBAL — every board on the device shares
   * them — while an editor engine holds exactly one teacher's client and speaks for exactly one
   * board's status chip. Left unbound, its whole-store `drain` would happily pick up another
   * teacher's due entry, POST it under the selected teacher's key (4xx), `markFailed` it and break
   * the cycle BEFORE the open board's own entry ever went out; its unscoped `reclaimInflight`
   * would sweep the app-wide worker's genuinely in-flight upload back to `failed` (→ a duplicate
   * append); and the foreign failure would paint «Error» on the open board's chip.
   *
   * Read the middle one precisely, because it is the one that is easy to overstate: binding fixes
   * the CROSS-document half of it and nothing more. Two engines pointed at the SAME document can
   * still reclaim each other's live entry, and no amount of scoping in this file can see that. The
   * app's active-document registry is what keeps them off the same board (the worker re-reads it
   * immediately before every board); {@link INFLIGHT_STALE_MS} is what makes a reclaim that lands
   * anyway harmless.
   *
   * Setting this makes all three structurally impossible rather than merely unlikely:
   * - `drain` runs the DOCUMENT-scoped cycle (scoped `listDueForDocument` + scoped
   *   `reclaimInflight(documentId, …)`) — the whole-store drain is simply not what runs,
   * - `drainDocument`/`captureFromDocument`/`enqueueFromDocument` refuse any other document,
   * - `onStatus` only ever fires for this document.
   *
   * Omitted (the app-wide auto-upload worker, which legitimately spans every board, and the
   * single-engine cold start) → whole-store behaviour, unchanged.
   */
  documentId?: string;
  outbox: Outbox;
  payloads: SnapshotPayloadStore;
  cursor: ServerSeqStore;
  uploadBlob: (uploadUrl: string, blob: Blob, contentType: string) => Promise<void>;
  getLatestDocSnapshot: (documentId: string) => Promise<WhiteboardDocument | null>;
  serialize: (doc: WhiteboardDocument) => Promise<{ blob: Blob; contentType: string; fileSize?: number }>;
  deviceId: string;
  /**
   * DEVICE-WIDE upload slot: acquire before a snapshot goes on the wire, call the returned
   * function to release it.
   *
   * "One upload in flight per device" is only true per-subsystem without this. The engine's own
   * `draining` latch serialises THIS engine; it says nothing about the other engine, and nothing
   * at all about the source-PDF upload queue, which fires its own jobs on the same `online` event.
   * Three subsystems, three private latches, one uplink — and on the studio's weak boards a
   * saturated uplink reads to the teacher as "the camera stopped".
   *
   * Injected rather than imported so this package stays framework- and app-free; the app wires
   * `lib/cloud-sync/upload-slot.ts` (a FIFO semaphore of width 1) into every one of the three.
   * Omitted → no slot, unchanged behaviour (the app-wide worker takes the slot around its own
   * per-board call instead, so it must NOT also pass this or it would wait on itself).
   */
  acquireUploadSlot?: () => Promise<() => void>;
  /**
   * Stand the NETWORK side down — the recording gate, as this engine sees it.
   *
   * Capture and enqueue stay live while a lesson is being filmed: the durable outbox is what makes
   * "nothing is lost" true, and refusing to record local work would be the one change that could
   * lose it. Only the upload waits. Asked per drain (not once per session) because a lesson can
   * start between two drains, and asked with the REASON so a human pressing «Sync now» is never
   * refused — that is a decision, not background work.
   *
   * **Fails open**: any throw is treated as "no reason to hold off", for the reason
   * `apps/whiteboard/lib/platform/recording-gate.ts` fails open — a status read that cannot answer
   * is not evidence of a lesson, and failing closed would freeze uploads for a whole session.
   */
  shouldDeferUpload?: (reason: SyncerDrainReason) => boolean | Promise<boolean>;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Backstop for an upload that is running but will never finish — a fetch that neither resolves nor
 * rejects. Past this age an `inflight` entry is reclaimed even though {@link liveUploadEntryIds}
 * still lists it. Ten minutes is comfortably longer than any real snapshot transfer (a few MB of
 * gzip, two round trips) on the worst studio uplink.
 */
export const INFLIGHT_STALE_MS = 10 * 60_000;

/**
 * Entry ids that some engine in THIS JS realm has on the wire right now.
 *
 * Module-level on purpose: the editor's engine and the app-wide worker's engine are two instances
 * built from one import, so this is the one thing they genuinely share besides the store — and it
 * answers the only question a reclaim actually needs to ask. "Is this entry stranded, or is it
 * being uploaded?" is not something the outbox can see (the store holds a status, not a promise)
 * and not something an engine can infer from its own state (the upload may be the other engine's).
 *
 * ## What this replaced, and why
 *
 * The guard used to be a per-engine-lifetime latch: reclaim a document once, ever. That protects a
 * fresh in-flight entry, but it also means a strand that happens AFTER the first drain is never
 * recovered — and the worker's engine lives for the whole session. An entry stranded by anything
 * other than a crash-at-launch (a `markSynced` write that failed, a tab killed mid-upload, an
 * exception between `markInflight` and the network) sat outside `DUE_STATUSES`, invisible to every
 * drain, unrecoverable until the app was restarted. Nothing in the UI said so; the board simply
 * stopped uploading.
 *
 * A liveness registry protects exactly what the latch was protecting and nothing else, and it stays
 * correct forever: an entry nobody is uploading is reclaimed on the very next drain, whatever its
 * age, so a cold start still sweeps everything a crash left behind (the set is empty in a fresh
 * process).
 */
const liveUploadEntryIds = new Set<string>();

/**
 * The document metadata an outbox entry needs — everything `captureFromDocument` used to read off
 * the live {@link WhiteboardDocument} — and NOTHING page-shaped.
 *
 * It exists so the serialisation can happen somewhere else (a Web Worker, off the main thread) and
 * still come back with what the outbox has to record. A 54 MB board must never cross a
 * `postMessage` boundary just to tell the outbox its page count.
 */
export interface SerializedSnapshotMeta {
  /** The document id. Same guards apply as a live doc's `id` (foreign / non-ObjectId are refused). */
  id: string;
  pageCount: number;
  title: string;
  thumbnail: string | null;
  updatedAt: number;
}

/** An already-serialised (and usually gzipped) board payload, ready to be stored + uploaded. */
export interface SerializedSnapshot {
  blob: Blob;
  contentType: string;
  fileSize?: number;
}

/**
 * The outbox-facing projection of a document. Pure — safe to call inside a worker, where the
 * document was just deserialised from IndexedDB and the engine does not exist.
 */
export function serializedSnapshotMetaFromDocument(doc: WhiteboardDocument): SerializedSnapshotMeta {
  return {
    id: doc.id,
    pageCount: doc.pages.length,
    title: doc.title,
    thumbnail: doc.thumbnail || null,
    updatedAt: doc.updatedAt,
  };
}

export interface SnapshotSyncer {
  /**
   * Capture the document's current state into the outbox (coalescing onto a pending entry) and
   * persist its blob, then trigger a drain. Debouncing is the HOOK's job, not the engine's.
   */
  enqueueFromDocument(doc: WhiteboardDocument): Promise<void>;
  /**
   * {@link SnapshotSyncer.enqueueFromDocument} for a board that was ALREADY read and serialised
   * elsewhere — the Web Worker that keeps the 54 MB read + `JSON.stringify` + gzip off the main
   * thread. Identical from the outbox's point of view: capture, then drain.
   *
   * Every guard `enqueueFromDocument` applies applies here too (stopped, foreign document,
   * non-ObjectId id), read off `meta.id`.
   */
  enqueueSerialized(meta: SerializedSnapshotMeta, serialized: SerializedSnapshot): Promise<void>;
  /**
   * Run one drain cycle. Safe to call concurrently — a re-entrant call is a no-op.
   *
   * Scope follows {@link SnapshotSyncerDeps.documentId}: an engine bound to a document drains
   * (and reclaims) only that document; an unbound engine drains the whole store.
   *
   * **NEVER rejects.** Every failure is recorded on the entry (`markFailed` → backoff) and
   * surfaced as a `'retrying'` status. `flush()` — which the board's back button awaits before
   * navigating — is this same call, so a rejection here is a teacher who cannot leave the board.
   */
  drain(reason: SyncerDrainReason): Promise<void>;
  /** Stop the engine: no further drains will run. */
  stop(): void;
}

/**
 * The engine {@link createSnapshotSyncer} actually returns: {@link SnapshotSyncer} plus the two
 * document-scoped operations an engine that spans MANY boards needs.
 *
 * Additive on purpose — {@link SnapshotSyncer} itself is unchanged, so every existing consumer
 * (and every test double typed as one) keeps compiling.
 */
export interface DocumentScopedSnapshotSyncer extends SnapshotSyncer {
  /**
   * {@link SnapshotSyncer.enqueueFromDocument} WITHOUT the trailing drain.
   *
   * The multi-board worker walks boards one at a time and drains each under its own teacher's
   * client; the whole-store drain that `enqueueFromDocument` fires would break that discipline
   * (it would touch other boards, including the one the editor currently owns) the moment a
   * capture happened.
   */
  captureFromDocument(doc: WhiteboardDocument): Promise<void>;
  /**
   * {@link DocumentScopedSnapshotSyncer.captureFromDocument} without the serialisation: the blob
   * and the metadata were produced off-thread. No trailing drain, same as `captureFromDocument`.
   */
  captureSerialized(meta: SerializedSnapshotMeta, serialized: SerializedSnapshot): Promise<void>;
  /**
   * Drain ONLY this document's due entries. Shares the engine's single in-flight guard with
   * {@link SnapshotSyncer.drain}, so a document drain can never overlap another drain on THIS
   * engine.
   *
   * That guard is per engine, not per device — it says nothing about the other engine or about the
   * source-PDF upload queue. Device-wide serialisation is {@link SnapshotSyncerDeps.acquireUploadSlot}.
   *
   * On an engine bound via {@link SnapshotSyncerDeps.documentId}, any other document is refused.
   */
  drainDocument(documentId: string, reason: SyncerDrainReason): Promise<void>;
}

/** A missing snapshot endpoint (BE-P1 not deployed yet) → fall back to legacy sync-draft. */
export function isSnapshotEndpointMissing(error: unknown): boolean {
  return error instanceof WhiteboardApiError && (error.status === 404 || error.status === 405);
}

function isOnline(): boolean {
  // navigator is undefined in non-DOM test envs → treat as online so unit tests can opt into
  // offline explicitly via a stubbed navigator.
  if (typeof navigator === 'undefined') {
    return true;
  }

  return navigator.onLine !== false;
}

export function createSnapshotSyncer(
  deps: SnapshotSyncerDeps,
  events: SnapshotSyncerEvents = {},
): DocumentScopedSnapshotSyncer {
  const now = deps.now ?? Date.now;

  // The one document this engine speaks for, or null when it legitimately spans the whole store
  // (the app-wide auto-upload worker). See `SnapshotSyncerDeps.documentId`.
  const boundDocumentId = deps.documentId ?? null;

  /** `true` for any document this engine is not entitled to touch. Always false when unbound. */
  const isForeignDocument = (documentId: string): boolean =>
    boundDocumentId !== null && documentId !== boundDocumentId;

  // Guard: only one drain cycle runs at a time. A second trigger while draining is dropped —
  // the in-flight cycle re-reads `listDue` and a follow-up drain re-runs any still-due entries.
  // `drainDocument` shares this flag, so per-document and whole-store cycles are mutually
  // exclusive: ONE upload is in flight per engine, ever.
  let draining = false;

  /**
   * Sweep entries that have been `inflight` longer than {@link INFLIGHT_STALE_MS} back into the due
   * set. Runs on EVERY cycle — there is no "already reclaimed" latch any more, because a latch that
   * outlives the strandings it is meant to recover from is how an entry becomes unrecoverable for a
   * whole session. See {@link INFLIGHT_STALE_MS}.
   *
   * Best-effort by design: a store read that fails must not take the drain down with it.
   */
  const reclaimStale = async (documentId?: string): Promise<void> => {
    const staleBefore = now() - INFLIGHT_STALE_MS;

    try {
      await deps.outbox.reclaimInflight(
        documentId,
        // Stranded = nobody in this realm is uploading it, OR it has been "uploading" for longer
        // than any transport could take.
        (entry) => !liveUploadEntryIds.has(entry.id) || entry.updatedAt <= staleBefore,
      );
    } catch {
      // The due-set read below still runs; a reclaim that could not happen costs at most one more
      // cycle before the entry comes back.
    }
  };

  /**
   * Whether this drain must stand down without touching the network. Fails OPEN — see
   * {@link SnapshotSyncerDeps.shouldDeferUpload}.
   */
  const isUploadDeferred = async (reason: SyncerDrainReason): Promise<boolean> => {
    // A human pressing «Sync now», or leaving the board (`flush`), is a decision. Only automatic
    // drains — the debounce, the self-heal interval, focus, online, startup — are held back.
    if (reason === 'manual' || !deps.shouldDeferUpload) {
      return false;
    }

    try {
      return await deps.shouldDeferUpload(reason);
    } catch {
      return false;
    }
  };

  /**
   * The client this entry must be sent with. Resolved from the DOCUMENT when the caller supplied
   * a resolver, so a multi-teacher engine can never send one teacher's snapshot under another's
   * key; otherwise the single injected client, unchanged.
   */
  const runForDocument = <T>(documentId: string, fn: (client: SnapshotSyncerClient) => Promise<T>): Promise<T> => {
    if (deps.runWithClientForDocument) {
      return deps.runWithClientForDocument(documentId)(fn);
    }

    return deps.runWithClient(fn);
  };
  // Per-instance legacy flag. Flips to true on the first 404/405 from a snapshot endpoint and
  // routes all subsequent drains through the legacy sync-draft path. Cutover back is automatic:
  // it is never reset, but a single instance only ever sees one backend topology per session.
  let legacyFallback = false;
  let stopped = false;

  const emitStatus = (status: SyncerStatus, documentId: string): void => {
    // A bound engine speaks for ONE board's chip. Even if a foreign entry somehow reached the
    // drain, its failure must never repaint the open board — the chip is a claim about THIS
    // document's bytes being in the cloud, and a claim about someone else's board is a lie.
    if (isForeignDocument(documentId)) {
      return;
    }

    events.onStatus?.(status, documentId);
  };

  /** Same rule as {@link emitStatus}: a bound engine never raises another board's divergence. */
  const emitDiverged = (event: SnapshotDivergenceEvent): void => {
    if (isForeignDocument(event.documentId)) {
      return;
    }

    events.onDiverged?.(event);
  };

  /**
   * Resolve the exact bytes to upload for an entry. Prefer the frozen per-entry blob (keyed by
   * `entry.id` — NOT `rawDataKey`); fall back to re-serializing the doc store only if the blob
   * is gone (e.g. evicted/cleared). The fallback is best-effort: the doc store holds only current
   * state, so it can drift from the entry's frozen base, but it beats dropping the change.
   */
  const loadEntryBlob = async (
    entryId: string,
    documentId: string,
  ): Promise<{ blob: Blob; contentType: string } | null> => {
    const stored = await deps.payloads.get(entryId);

    if (stored) {
      return { blob: stored, contentType: 'application/octet-stream' };
    }

    const doc = await deps.getLatestDocSnapshot(documentId);

    if (!doc) {
      return null;
    }

    const serialized = await deps.serialize(doc);

    return { blob: serialized.blob, contentType: serialized.contentType };
  };

  /** Legacy path (BE-P1 absent): upload via the old draft upload-url + sync-draft (seq-less). */
  const syncEntryLegacy = async (
    client: SnapshotSyncerClient,
    entry: {
      id: string;
      documentId: string;
      localSeq: number;
      pageCount: number;
      title: string;
      thumbnail: string | null;
    },
    blob: Blob,
    contentType: string,
  ): Promise<void> => {
    const uploadUrl = await client.getUploadUrl(entry.documentId, { type: 'draft' });

    await deps.uploadBlob(uploadUrl.uploadUrl, blob, contentType);
    await client.syncDraft(entry.documentId, {
      draftRawDataUrl: uploadUrl.publicUrl,
      pageCount: entry.pageCount,
      thumbnail: entry.thumbnail ?? undefined,
      title: entry.title,
    });

    // Synthetic seq: the legacy endpoint is seq-less, so advance on the entry's localSeq to keep
    // the outbox monotonic. The seq cursor is NOT touched (no server seq exists to record).
    await deps.outbox.markSynced(entry.id, entry.localSeq);
    await deps.payloads.delete(entry.id);
  };

  /** New path: upload-url → upload → append → (only on 2xx) advance cursor + markSynced + delete. */
  const syncEntrySnapshot = async (
    client: SnapshotSyncerClient,
    entry: {
      id: string;
      documentId: string;
      localSeq: number;
      pageCount: number;
      title: string;
      thumbnail: string | null;
      fileSize: number;
    },
    blob: Blob,
    contentType: string,
  ): Promise<void> => {
    // baseSeq is read from the FRESHEST cursor at drain time (monotonic across a cycle), NOT the
    // entry's frozen base. First sync → null.
    const baseSeq = await deps.cursor.get(entry.documentId);
    const uploadTarget = await client.requestDraftSnapshotUploadUrl(entry.documentId);

    await deps.uploadBlob(uploadTarget.uploadUrl, blob, contentType);

    const appendInput: WhiteboardApiAppendDraftSnapshotInput = {
      storageKey: uploadTarget.storageKey,
      pageCount: entry.pageCount,
      thumbnail: entry.thumbnail,
      title: entry.title,
      deviceId: deps.deviceId,
      baseSeq,
      fileSize: entry.fileSize,
    };

    // Robust to BOTH backend choices: send rawDataUrl only when the upload-url response carried a
    // publicUrl; otherwise omit it and let the server derive it from storageKey.
    if (uploadTarget.publicUrl) {
      appendInput.rawDataUrl = uploadTarget.publicUrl;
    }

    const response = await client.appendDraftSnapshot(entry.documentId, appendInput);

    // CONFIRMED (2xx). Only now does anything local advance — write-confirm-then-advance.
    await deps.cursor.set(entry.documentId, response.seq, now());
    await deps.outbox.markSynced(entry.id, response.seq);
    await deps.payloads.delete(entry.id);

    if (response.diverged) {
      // Keep both: our branch is advanced AND the other branch is surfaced for recovery.
      emitDiverged({
        documentId: entry.documentId,
        localSeq: response.seq,
        serverSeq: response.seq,
        otherBranch: response.otherBranch,
      });
      emitStatus('diverged', entry.documentId);
    } else {
      emitStatus('synced', entry.documentId);
    }
  };

  /**
   * `true` when this engine must not capture `documentId` at all.
   *
   * Shared by the live-document and the pre-serialised paths so the two can never disagree about
   * which boards are capturable:
   *
   * - A bound engine captures only its own board. Capturing a foreign one would queue an entry this
   *   engine's client is not entitled to send, which its own drain would then have to skip.
   * - Orphaned local/imported boards carry a client UUID (from createWhiteboardId) that was never
   *   linked to a Mongo _id. They are NOT cloud-syncable yet: enqueuing them would only accumulate
   *   outbox entries that the drain can never POST (the backend rejects a non-ObjectId id → 400).
   *   Skip enqueue entirely; Tier 2 reconciliation links the doc to a real _id later, after which
   *   its edits enqueue normally.
   */
  const isUncapturableDocument = (documentId: string): boolean =>
    isForeignDocument(documentId) || !isLikelyMongoObjectId(documentId);

  const captureSerialized = async (
    meta: SerializedSnapshotMeta,
    serialized: SerializedSnapshot,
  ): Promise<void> => {
    if (stopped || isUncapturableDocument(meta.id)) {
      return;
    }

    const fileSize = serialized.fileSize ?? serialized.blob.size;
    // baseSeq snapshot at enqueue time (best-effort metadata; the drain re-reads the freshest
    // cursor for the actual append). upsertPending coalesces onto a still-pending entry.
    const baseSeq = await deps.cursor.get(meta.id);
    const entry = await deps.outbox.upsertPending({
      documentId: meta.id,
      deviceId: deps.deviceId,
      baseSeq,
      pageCount: meta.pageCount,
      title: meta.title,
      thumbnail: meta.thumbnail,
      fileSize,
    });

    // KEY THE PAYLOAD BY entry.id (NOT rawDataKey). Written BEFORE the drain so the durable blob
    // always exists when the entry is picked up.
    await deps.payloads.put(entry.id, serialized.blob);
  };

  const captureFromDocument = async (doc: WhiteboardDocument): Promise<void> => {
    // Checked BEFORE `serialize`: gzipping a board this engine will refuse to enqueue is pure cost
    // (on a 100-page board, seconds of it).
    if (stopped || isUncapturableDocument(doc.id)) {
      return;
    }

    const serialized = await deps.serialize(doc);

    await captureSerialized(serializedSnapshotMetaFromDocument(doc), serialized);
  };

  const enqueueFromDocument = async (doc: WhiteboardDocument): Promise<void> => {
    await captureFromDocument(doc);

    if (stopped) {
      return;
    }

    await drain('change');
  };

  const enqueueSerialized = async (
    meta: SerializedSnapshotMeta,
    serialized: SerializedSnapshot,
  ): Promise<void> => {
    await captureSerialized(meta, serialized);

    if (stopped) {
      return;
    }

    await drain('change');
  };

  /**
   * `markFailed` that cannot itself take the drain down.
   *
   * Every path into it is already an error path, and the store write is the last thing standing
   * between "this entry backs off and retries" and "this entry is inflight forever". A throw here
   * would escape `drain`, which by contract never rejects.
   */
  const markFailedSafely = async (entryId: string): Promise<void> => {
    try {
      await deps.outbox.markFailed(entryId);
    } catch {
      // `reclaimStale` is the backstop: the entry stops being listed as live the moment this call
      // returns, so the next drain takes it back.
    }
  };

  /**
   * Upload one already-selected batch of due entries, oldest first.
   *
   * Shared by the whole-store {@link drain} and the per-document {@link drainDocument} so the two
   * can never disagree about the write-confirm-then-advance invariant, the legacy fallback, or the
   * "stop the cycle on the first failure" backoff discipline. The CALLER owns the concurrency
   * guard and decides which entries are in scope; this owns what happens to each one.
   */
  const drainEntries = async (due: OutboxEntry[]): Promise<void> => {
    for (const entry of due) {
      if (stopped) {
        return;
      }

      // Orphaned local/imported board: its documentId is a client UUID, not a Mongo _id, so the
      // backend would reject every snapshot POST with a 400. SKIP it completely — no network
      // (requestDraftSnapshotUploadUrl/appendDraftSnapshot/getUploadUrl/syncDraft), no markFailed
      // (that would drive an 'error'/'retrying' status), and no tight-loop. The entry + its blob
      // stay untouched in the outbox so nothing is lost; Tier 2 reconciliation links a real _id
      // later, after which the entry drains normally. Crucially this also means a single orphan
      // never flips the OPEN (healthy, ObjectId) board's status away from synced.
      if (!isLikelyMongoObjectId(entry.documentId)) {
        continue;
      }

      // Defence in depth for a bound engine: its callers already select entries per document, but
      // the failure this prevents is silent (another teacher's board POSTed under this teacher's
      // key, 4xx, markFailed, cycle broken before the open board's own entry) so the last word
      // belongs next to the upload, not to whoever built the list.
      if (isForeignDocument(entry.documentId)) {
        continue;
      }

      // Claim the entry as LIVE before it is written as `inflight`, and release it in the `finally`
      // below. That ordering closes the window in which the store reads `inflight` while no engine
      // in this realm would admit to uploading it — which is precisely what a reclaim looks for.
      liveUploadEntryIds.add(entry.id);

      // EVERYTHING for this entry, inside one try.
      //
      // The `markInflight` → `loadEntryBlob` pair used to sit outside it, and the gap was not
      // theoretical: `loadEntryBlob` re-serializes the document when the frozen blob is gone, and
      // `serialize` is a gzip over the whole board — an OOM, a corrupt page, a rejected
      // `payloads.get`, any of them throws. The entry was already `inflight` by then, so the throw
      // escaped `drain` (which promises it never rejects), left the entry inflight FOREVER, and,
      // because `flush()` is what the back button awaits, made «Back» silently do nothing.
      try {
        await deps.outbox.markInflight(entry.id);
        emitStatus('syncing', entry.documentId);

        const loaded = await loadEntryBlob(entry.id, entry.documentId);

        if (!loaded) {
          // No bytes anywhere (blob gone + doc gone). Treat as a transient failure so the outbox
          // backs it off rather than spinning; nothing is discarded.
          await markFailedSafely(entry.id);
          emitStatus('retrying', entry.documentId);
          break;
        }

        // ONE upload in flight per DEVICE, not per engine — see `deps.acquireUploadSlot`. Taken
        // per entry rather than per drain so a long queue cannot lock the other subsystems out for
        // the whole batch, and released in `finally` so a throw can never strand the slot.
        const release = deps.acquireUploadSlot ? await deps.acquireUploadSlot() : null;

        try {
          if (legacyFallback) {
            await runForDocument(entry.documentId, (client) =>
              syncEntryLegacy(client, entry, loaded.blob, loaded.contentType),
            );
          } else {
            await runForDocument(entry.documentId, (client) =>
              syncEntrySnapshot(client, entry, loaded.blob, loaded.contentType),
            );
          }
        } catch (error) {
          if (!legacyFallback && isSnapshotEndpointMissing(error)) {
            // First 404/405 from a snapshot endpoint → flip to legacy for the rest of the session.
            legacyFallback = true;
            events.onLegacyFallback?.();

            await runForDocument(entry.documentId, (client) =>
              syncEntryLegacy(client, entry, loaded.blob, loaded.contentType),
            );

            continue;
          }

          throw error;
        } finally {
          release?.();
        }
      } catch {
        // Any failure at all — the network, the store, the serializer: the outbox owns backoff.
        // Mark failed, signal retrying, stop the cycle; the next drain re-runs still-due entries.
        await markFailedSafely(entry.id);
        emitStatus('retrying', entry.documentId);
        break;
      } finally {
        // Whatever happened — synced, failed, `break`, `continue` — this entry is no longer being
        // uploaded by anyone, so a later reclaim is free to take it back.
        liveUploadEntryIds.delete(entry.id);
      }
    }
  };

  /**
   * One drain cycle over exactly ONE document: scoped reclaim, scoped due set.
   *
   * Both scoping halves matter and they fail differently. An unscoped due set sends another
   * teacher's board under this engine's key (4xx → markFailed → the cycle breaks before the open
   * board's own entry). An unscoped reclaim reaches into documents this engine is not draining at
   * all.
   *
   * Scoping is NOT, on its own, enough to protect a genuinely in-flight upload. Two engines share
   * these stores and only the per-instance `draining` latch is private, so if both ever worked the
   * SAME document at once, a scoped reclaim from one would still flip the other's live entry back
   * to due and that snapshot would be appended twice. What actually keeps them off each other's
   * board is the app's active-document registry (the worker re-reads it immediately before every
   * board); the age check in `reclaimStale` is the second line, and this scope is the third.
   */
  const drainScoped = async (documentId: string, reason: SyncerDrainReason): Promise<void> => {
    if (stopped) {
      return;
    }

    // A UUID board has nothing the backend can accept; `drainEntries` would skip every entry
    // anyway, so refuse before touching the store at all.
    if (!isLikelyMongoObjectId(documentId)) {
      return;
    }

    if (!isOnline()) {
      emitStatus('offline', documentId);

      return;
    }

    // The studio is filming: capture already happened, the upload waits. No status is emitted —
    // "waiting for the lesson to finish" is not an error and must not paint one.
    if (await isUploadDeferred(reason)) {
      return;
    }

    if (draining) {
      return;
    }

    draining = true;

    try {
      await reclaimStale(documentId);
      await drainEntries(await deps.outbox.listDueForDocument(documentId, now()));
    } catch {
      // `drain` never rejects — its callers include `flush()`, which the board's back button
      // awaits, and an unhandled rejection there strands the teacher on the board.
    } finally {
      draining = false;
    }
  };

  /**
   * The WHOLE-STORE cycle: every due entry on the device, plus the unscoped cold-start reclaim.
   *
   * Reachable only from an unbound engine — the app-wide auto-upload worker, which owns every
   * board and resolves a client per document. A bound engine's `drain` routes to
   * {@link drainScoped} instead, so this is never the code an open board's editor runs.
   */
  const drainStore = async (reason: SyncerDrainReason): Promise<void> => {
    if (stopped) {
      return;
    }

    // Offline → emit and bail. The hook's `online` listener re-drains. No network is touched.
    if (!isOnline()) {
      emitStatus('offline', '');

      return;
    }

    if (await isUploadDeferred(reason)) {
      return;
    }

    // Concurrency guard: never run two drains at once.
    if (draining) {
      return;
    }

    draining = true;

    try {
      await reclaimStale();
      await drainEntries(await deps.outbox.listDue(now()));
    } catch {
      // Same contract as `drainScoped`: a drain never rejects.
    } finally {
      draining = false;
    }
  };

  const drain = async (reason: SyncerDrainReason): Promise<void> => {
    // THE scoping decision, made once, in the one place every trigger funnels through: a bound
    // engine has no unscoped drain to reach — not "should not call", cannot.
    if (boundDocumentId !== null) {
      return drainScoped(boundDocumentId, reason);
    }

    return drainStore(reason);
  };

  const drainDocument = async (documentId: string, reason: SyncerDrainReason): Promise<void> => {
    // A bound engine drains its own board or nothing.
    if (isForeignDocument(documentId)) {
      return;
    }

    return drainScoped(documentId, reason);
  };

  const stop = (): void => {
    stopped = true;
  };

  return {
    captureFromDocument,
    captureSerialized,
    drain,
    drainDocument,
    enqueueFromDocument,
    enqueueSerialized,
    stop,
  };
}
