import {
  createIndexedDbWhiteboardStorage,
  createWhiteboardRawDataBlob,
  serializedSnapshotMetaFromDocument,
} from '@repo/whiteboard-core';

import type { SerializedSnapshot, SerializedSnapshotMeta } from '@repo/whiteboard-core';

/**
 * Cloud-sync capture, off the main thread.
 *
 * Measured on the Win10 rig (2026-09-13, 109-page board, 54 MB stored document): every pen-up used
 * to be followed ~1.5 s later by `loadWhiteboard` (IndexedDB read + a 54 MB structured
 * deserialize, ~430 ms), `JSON.stringify` (2.4 s across the session), `new Blob` (740 ms) and a
 * gzip — all on the thread that draws ink. Pointer gaps reached 900 ms.
 *
 * None of that work needs the DOM. This worker does the read, the stringify and the gzip, and the
 * main thread receives only the finished (gzipped) Blob plus the handful of scalars the outbox
 * records. The document itself NEVER crosses the postMessage boundary — sending 54 MB back would
 * just move the structured-clone cost, not remove it.
 */

/** One capture request. `id` correlates the reply; the worker handles requests one at a time. */
interface CaptureWorkerRequest {
  id: number;
  documentId: string;
}

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

/**
 * The worker's own global, typed locally.
 *
 * The package's `lib` is `dom`, so the ambient `self` here is a `Window` — whose `postMessage`
 * demands a targetOrigin and whose `onmessage` carries a `MessageEvent<any>`. Adding
 * `"webworker"` to the package-wide lib would collide with `dom` for every other file, so the two
 * members this file actually uses are declared instead.
 */
interface CaptureWorkerScope {
  onmessage: ((event: { data: CaptureWorkerRequest }) => void) | null;
  postMessage(message: CaptureWorkerResponse): void;
}

const scope = self as unknown as CaptureWorkerScope;

async function capture(documentId: string): Promise<CaptureWorkerSuccess['result']> {
  // A connection per request, closed in the `finally` below. A worker that holds an open
  // IndexedDB connection BLOCKS a future version upgrade from any other context (the whole app
  // stalls on `onblocked`), and this worker outlives any single capture.
  const storage = createIndexedDbWhiteboardStorage();

  try {
    const doc = await storage.loadWhiteboard(documentId);

    if (!doc) {
      return null;
    }

    const serialized = await createWhiteboardRawDataBlob(doc, { gzip: true });

    return {
      meta: serializedSnapshotMetaFromDocument(doc),
      serialized: {
        blob: serialized.blob,
        contentType: serialized.contentType,
        fileSize: serialized.blob.size,
      },
    };
  } finally {
    storage.close();
  }
}

scope.onmessage = (event) => {
  const request = event.data;

  if (!request || typeof request.id !== 'number') {
    return;
  }

  void (async () => {
    try {
      const result = await capture(request.documentId);

      scope.postMessage({ id: request.id, ok: true, result });
    } catch (error) {
      scope.postMessage({
        id: request.id,
        ok: false,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  })();
};
