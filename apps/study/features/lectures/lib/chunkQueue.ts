/**
 * Durable upload queue for lecture audio. Every recorded chunk is written to the store BEFORE any
 * network call, so a crash, a kill or a dead Wi-Fi never loses audio: the next pump (app start, the
 * `online` event, a retry timer) picks up whatever is still on disk. Chunks upload in index order
 * (raw `PUT /lectures/:id/chunks/:index`, idempotent) and STAY on disk, marked uploaded, until the
 * backend accepts `finish` — a `409 CHUNKS_MISSING` re-uploads the indices it names from here.
 *
 * Errors are sorted three ways: transient (network, 5xx) → backoff and retry everything; permanent
 * for one lecture (400/413/415, `CHUNK_TYPE_MISMATCH`) → that session is parked with `error` until
 * the user retries or discards it, so it never blocks other lectures; "already done"
 * (`LECTURE_FINISHED`, `LECTURE_PROCESSING` on finish) → the lecture is dropped from the queue.
 *
 * Pure: storage, transport and timers are injected, so the logic is tested without a browser.
 */

export interface PendingChunk {
  lectureId: string;
  index: number;
  blob: Blob;
  size: number;
  mime: string;
  createdAt: number;
  /** The backend has it; kept until `finish` is accepted in case it reports it missing. */
  uploaded?: boolean;
}

export type SessionState = 'recording' | 'stopped';

/** One lecture's local bookkeeping, kept until the backend has accepted `finish`. */
export interface LectureSession {
  lectureId: string;
  classId: string;
  title: string;
  /** The notebook page written during the lecture (whiteboard document id). */
  pageId: string | null;
  pageVersion: number;
  pageUploaded: boolean;
  /** Pinned for the whole lecture: the backend rejects a lecture that mixes webm and mp4. */
  mime: string;
  startedAt: string;
  /** Next chunk index = number of chunks produced so far. */
  nextIndex: number;
  /** Recorded audio so far (pauses excluded). */
  durationMs: number;
  /** `recording` = still live, or the app died mid-lecture (resumable via {@link ChunkUploadQueue.stop}). */
  state: SessionState;
  /** A permanent upload failure: the session is skipped until {@link ChunkUploadQueue.retry}. */
  error?: { code: string; message: string } | null;
  /** `finish` answers that said chunks were missing — bounded so a broken backend can't loop forever. */
  missingRounds?: number;
  updatedAt: number;
}

export interface ChunkStore {
  putChunk(chunk: PendingChunk): Promise<void>;
  listChunks(): Promise<PendingChunk[]>;
  deleteChunk(lectureId: string, index: number): Promise<void>;
  putSession(session: LectureSession): Promise<void>;
  getSession(lectureId: string): Promise<LectureSession | null>;
  listSessions(): Promise<LectureSession[]>;
  deleteSession(lectureId: string): Promise<void>;
}

export interface UploadDeps {
  /** Raw `PUT /lectures/:id/chunks/:index` with the blob typed as `mime`. */
  putChunk(lectureId: string, index: number, blob: Blob, mime: string): Promise<void>;
  /** Upload the lecture's notebook page JSON; returns the new page version. */
  uploadPage?(session: LectureSession): Promise<number>;
  /** `POST /lectures/:id/finish {chunks,durationSec}`. */
  finish(lectureId: string, chunks: number, durationSec: number): Promise<void>;
}

export interface QueueStatus {
  /** Chunks not yet on the backend. */
  pendingChunks: number;
  uploading: boolean;
  /** Sessions still waiting for `finish` (incl. live and parked ones). */
  sessions: LectureSession[];
  lastError: string | null;
  /** When a retry is scheduled, its delay. */
  retryInMs: number | null;
}

export interface QueueOptions {
  schedule?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

type Listener = (status: QueueStatus) => void;

const MAX_MISSING_ROUNDS = 3;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `{ status, code }` as the study transport throws them (`StudyApiError` + body extras). */
function errorInfo(error: unknown): { status: number | null; code: string | null; missing: number[] | null } {
  const record = (error && typeof error === 'object' ? error : {}) as {
    status?: unknown;
    code?: unknown;
    missing?: unknown;
  };

  return {
    status: typeof record.status === 'number' ? record.status : null,
    code: typeof record.code === 'string' ? record.code : null,
    missing: Array.isArray(record.missing) ? record.missing.filter((n): n is number => typeof n === 'number') : null,
  };
}

/** A 4xx that retrying the same request will never fix (409s are handled by code first). */
function isPermanent(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** The two families the backend accepts; codec parameters other than opus are dropped. */
export function normalizeChunkMime(mime: string): string {
  const lower = mime.toLowerCase().replace(/[\s"']+/g, '');

  if (lower.startsWith('audio/webm')) return lower.includes('codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  if (lower.startsWith('audio/mp4') || lower.startsWith('audio/aac') || lower.startsWith('audio/m4a')) {
    return 'audio/mp4';
  }

  return lower || 'audio/webm';
}

export class ChunkUploadQueue {
  private readonly schedule: NonNullable<QueueOptions['schedule']>;
  private readonly now: () => number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private backoffMs: number;
  private cancelRetry: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private listeners = new Set<Listener>();
  private status: QueueStatus = { pendingChunks: 0, uploading: false, sessions: [], lastError: null, retryInMs: null };

  constructor(
    private readonly store: ChunkStore,
    private readonly deps: UploadDeps,
    options: QueueOptions = {},
  ) {
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);

        return () => clearTimeout(id);
      });
    this.now = options.now ?? Date.now;
    this.minBackoffMs = options.minBackoffMs ?? 2000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60000;
    this.backoffMs = this.minBackoffMs;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.status);

    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): QueueStatus {
    return this.status;
  }

  async startSession(session: Omit<LectureSession, 'updatedAt'>): Promise<void> {
    await this.store.putSession({ ...session, updatedAt: this.now() });
    await this.refresh();
  }

  /** Persist a recorded chunk (durably) and kick the uploader. */
  async enqueue(lectureId: string, blob: Blob, mime: string, durationMs: number): Promise<number> {
    const session = await this.store.getSession(lectureId);

    if (!session) throw new Error(`No local session for lecture ${lectureId}`);
    const index = session.nextIndex;

    await this.store.putChunk({ lectureId, index, blob, size: blob.size, mime, createdAt: this.now() });
    await this.store.putSession({ ...session, nextIndex: index + 1, durationMs, updatedAt: this.now() });
    void this.pump();

    return index;
  }

  /** Recording ended (or an interrupted one is being closed out): finish once everything is up. */
  async stop(lectureId: string, durationMs?: number): Promise<void> {
    const session = await this.store.getSession(lectureId);

    if (!session) return;
    await this.store.putSession({
      ...session,
      state: 'stopped',
      durationMs: durationMs ?? session.durationMs,
      updatedAt: this.now(),
    });
    // Durable from here on; the upload itself may take a while on lecture-hall Wi-Fi.
    void this.pump();
  }

  /** Un-park a session that hit a permanent error and try again. */
  async retry(lectureId: string): Promise<void> {
    const session = await this.store.getSession(lectureId);

    if (session) await this.store.putSession({ ...session, error: null, missingRounds: 0, updatedAt: this.now() });
    await this.pump();
  }

  /** Drop a session and its audio for good (discard an abandoned recording). */
  async discard(lectureId: string): Promise<void> {
    await this.dropLecture(lectureId);
    await this.refresh();
  }

  /** Single-flight: a call during a run makes the run go around once more. */
  pump(): Promise<void> {
    if (this.running) {
      this.again = true;

      return this.running;
    }
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce();
        } while (this.again);
      } finally {
        this.running = null;
        await this.refresh({ uploading: false });
      }
    })();

    return this.running;
  }

  private async dropLecture(lectureId: string): Promise<void> {
    for (const chunk of await this.store.listChunks()) {
      if (chunk.lectureId === lectureId) await this.store.deleteChunk(lectureId, chunk.index);
    }
    await this.store.deleteSession(lectureId);
  }

  private async park(session: LectureSession, code: string, message: string): Promise<void> {
    await this.store.putSession({ ...session, error: { code, message }, updatedAt: this.now() });
  }

  private async runOnce(): Promise<void> {
    await this.refresh({ uploading: true });
    try {
      const sessions = new Map((await this.store.listSessions()).map((s) => [s.lectureId, s]));
      const chunks = (await this.store.listChunks())
        .filter((chunk) => !chunk.uploaded)
        .sort((a, b) => (a.lectureId === b.lectureId ? a.index - b.index : a.createdAt - b.createdAt));

      for (const chunk of chunks) {
        const session = sessions.get(chunk.lectureId);

        if (session?.error) continue;
        try {
          await this.deps.putChunk(
            chunk.lectureId,
            chunk.index,
            chunk.blob,
            normalizeChunkMime(session?.mime ?? chunk.mime),
          );
        } catch (error) {
          const { status, code } = errorInfo(error);

          if (code === 'LECTURE_FINISHED') {
            await this.dropLecture(chunk.lectureId);
            sessions.delete(chunk.lectureId);
            continue;
          }
          if (session && (code === 'CHUNK_TYPE_MISMATCH' || isPermanent(status))) {
            const parked = { ...session, error: { code: code ?? `HTTP_${status}`, message: errorMessage(error) } };

            await this.park(session, parked.error.code, parked.error.message);
            sessions.set(session.lectureId, parked);
            continue;
          }
          throw error;
        }
        await this.store.putChunk({ ...chunk, uploaded: true });
        await this.refresh({ uploading: true, lastError: null });
      }

      const remaining = (await this.store.listChunks()).filter((chunk) => !chunk.uploaded);

      for (const session of Array.from(sessions.values())) {
        if (session.state !== 'stopped' || session.error) continue;
        if (remaining.some((chunk) => chunk.lectureId === session.lectureId)) continue;
        await this.finishSession(session);
      }
      this.backoffMs = this.minBackoffMs;
      await this.refresh({ lastError: null, retryInMs: null });
    } catch (error) {
      const delay = this.backoffMs;

      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      this.again = false;
      this.cancelRetry = this.schedule(() => {
        this.cancelRetry = null;
        void this.pump();
      }, delay);
      await this.refresh({ lastError: errorMessage(error), retryInMs: delay });
    }
  }

  private async finishSession(session: LectureSession): Promise<void> {
    let current = session;

    if (current.pageId && !current.pageUploaded && this.deps.uploadPage) {
      try {
        const pageVersion = await this.deps.uploadPage(current);

        current = { ...current, pageVersion, pageUploaded: true, updatedAt: this.now() };
      } catch (error) {
        // The notes are also saved on this tablet; a page the backend refuses must not hold the audio.
        if (!isPermanent(errorInfo(error).status)) throw error;
        current = { ...current, pageUploaded: true, updatedAt: this.now() };
      }
      await this.store.putSession(current);
    }

    try {
      await this.deps.finish(current.lectureId, current.nextIndex, Math.round(current.durationMs / 1000));
    } catch (error) {
      const { status, code, missing } = errorInfo(error);

      if (code === 'LECTURE_PROCESSING' || code === 'LECTURE_FINISHED') {
        await this.dropLecture(current.lectureId);

        return;
      }
      if (code === 'CHUNKS_MISSING' && missing) {
        await this.requeueMissing(current, missing);

        return;
      }
      if (isPermanent(status)) {
        await this.park(current, code ?? `HTTP_${status}`, errorMessage(error));

        return;
      }
      throw error;
    }
    await this.dropLecture(current.lectureId);
  }

  private async requeueMissing(session: LectureSession, missing: number[]): Promise<void> {
    const rounds = (session.missingRounds ?? 0) + 1;
    const onDisk = new Map(
      (await this.store.listChunks()).filter((c) => c.lectureId === session.lectureId).map((c) => [c.index, c]),
    );
    const lost = missing.filter((index) => !onDisk.has(index));

    if (lost.length > 0 || rounds > MAX_MISSING_ROUNDS) {
      const message =
        lost.length > 0
          ? `${lost.length} audio part${lost.length === 1 ? ' is' : 's are'} no longer on this tablet`
          : 'The server keeps reporting missing audio parts';

      await this.park({ ...session, missingRounds: rounds }, 'CHUNKS_MISSING', message);

      return;
    }
    for (const index of missing) {
      const chunk = onDisk.get(index);

      if (chunk) await this.store.putChunk({ ...chunk, uploaded: false });
    }
    await this.store.putSession({ ...session, missingRounds: rounds, updatedAt: this.now() });
    this.again = true;
  }

  private async refresh(patch: Partial<QueueStatus> = {}): Promise<void> {
    const [chunks, sessions] = await Promise.all([this.store.listChunks(), this.store.listSessions()]);

    this.status = {
      ...this.status,
      ...patch,
      pendingChunks: chunks.filter((chunk) => !chunk.uploaded).length,
      sessions,
    };
    this.listeners.forEach((listener) => listener(this.status));
  }
}

/** In-memory store: tests, and the fallback when IndexedDB is unavailable. */
export function createMemoryChunkStore(): ChunkStore {
  const chunks = new Map<string, PendingChunk>();
  const sessions = new Map<string, LectureSession>();
  const key = (lectureId: string, index: number) => `${lectureId}\u0000${index}`;

  return {
    putChunk: async (chunk) => void chunks.set(key(chunk.lectureId, chunk.index), { ...chunk }),
    listChunks: async () => Array.from(chunks.values()).map((chunk) => ({ ...chunk })),
    deleteChunk: async (lectureId, index) => void chunks.delete(key(lectureId, index)),
    putSession: async (session) => void sessions.set(session.lectureId, { ...session }),
    getSession: async (lectureId) => {
      const session = sessions.get(lectureId);

      return session ? { ...session } : null;
    },
    listSessions: async () => Array.from(sessions.values()).map((session) => ({ ...session })),
    deleteSession: async (lectureId) => void sessions.delete(lectureId),
  };
}
