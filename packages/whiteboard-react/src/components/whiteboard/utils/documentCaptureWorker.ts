import type { SerializedSnapshot, SerializedSnapshotMeta } from '@repo/whiteboard-core';

/**
 * Read a board from IndexedDB and serialise it for the outbox — WITHOUT touching the main thread.
 *
 * Resolves `null` when the document no longer exists locally. Rejects when the capture failed; the
 * caller is expected to fall back to the in-thread path for that one call rather than lose a sync.
 */
export type CaptureDocument = (
  documentId: string,
) => Promise<{ meta: SerializedSnapshotMeta; serialized: SerializedSnapshot } | null>;

interface CaptureWorkerSuccess {
  id: number;
  ok: true;
  result: { meta: SerializedSnapshotMeta; serialized: SerializedSnapshot } | null;
}

interface CaptureWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

type CaptureWorkerResponse = CaptureWorkerSuccess | CaptureWorkerFailure;

interface PendingCapture {
  resolve: (value: CaptureWorkerSuccess['result']) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Ceiling on one capture. A worker that wedges (a blocked IndexedDB upgrade, an OOM that never
 * surfaces as `onerror`) must not wedge the syncer with it: the hook's fallback needs a rejection
 * to act on, and a promise that never settles is not one. Generous on purpose — a 54 MB board on a
 * slow ViewSonic takes seconds, never minutes.
 */
const CAPTURE_TIMEOUT_MS = 120_000;

/**
 * Build the worker-backed capture function, or `null` where `Worker` does not exist — SSR, the
 * Node test runner, and old WebViews. A `null` here is not an error: the caller keeps using the
 * main-thread path it has always used.
 *
 * The worker itself is a LAZY singleton: nothing is spawned until the first capture, so a board
 * that is never edited never pays for one. It is torn down and dropped on any failure, so the next
 * call gets a fresh worker instead of inheriting a poisoned one.
 */
export function createWorkerDocumentCapture(): CaptureDocument | null {
  if (typeof Worker === 'undefined') {
    return null;
  }

  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingCapture>();

  const settleAllWith = (error: Error): void => {
    pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(error);
    });

    pending.clear();
  };

  /** Drop the singleton. The NEXT call builds a clean one. */
  const disposeWorker = (): void => {
    const dying = worker;

    worker = null;

    dying?.terminate();
  };

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker;
    }

    // webpack 5 (the whiteboard app builds with `next --webpack`) understands this exact form and
    // bundles the worker as its own chunk — no worker-loader, no separate build step. Keep the
    // `new URL(..., import.meta.url)` literal inline; a hoisted variable defeats the static
    // analysis and ships a runtime 404 instead.
    const created = new Worker(new URL('../workers/documentCapture.worker.ts', import.meta.url), {
      type: 'module',
    });

    created.onmessage = (event: MessageEvent<CaptureWorkerResponse>) => {
      const message = event.data;
      const entry = message ? pending.get(message.id) : undefined;

      if (!entry) {
        return;
      }

      pending.delete(message.id);
      clearTimeout(entry.timer);

      if (message.ok) {
        entry.resolve(message.result);

        return;
      }

      // A failed capture is a failed WORKER as far as we know: the same board will be captured
      // again in seconds, and retrying it inside a process that just threw buys nothing.
      entry.reject(new Error(message.error));
      disposeWorker();
      settleAllWith(new Error(message.error));
    };

    created.onerror = () => {
      const error = new Error('Whiteboard capture worker failed.');

      disposeWorker();
      settleAllWith(error);
    };

    worker = created;

    return created;
  };

  return (documentId: string) =>
    new Promise<CaptureWorkerSuccess['result']>((resolve, reject) => {
      let active: Worker;

      try {
        active = ensureWorker();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));

        return;
      }

      const id = nextId;

      nextId += 1;

      const timer = setTimeout(() => {
        pending.delete(id);
        disposeWorker();
        reject(new Error('Whiteboard capture worker timed out.'));
      }, CAPTURE_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });

      try {
        active.postMessage({ id, documentId });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        disposeWorker();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
}
