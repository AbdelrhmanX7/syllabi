import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerDocumentCapture } from './documentCaptureWorker';

test('createWorkerDocumentCapture returns null where Worker does not exist', () => {
  // Node's test runner has no DOM `Worker` — the same shape as SSR and an old WebView. The factory
  // must ANSWER (null) rather than throw, because the hook treats null as "keep using the
  // main-thread path" and a throw here would take the whole board page down at import time.
  assert.equal(typeof (globalThis as { Worker?: unknown }).Worker, 'undefined');
  assert.equal(createWorkerDocumentCapture(), null);
});

test('a capture is correlated by id, and one failure does not poison the next call', async () => {
  const posted: { id: number; documentId: string }[] = [];
  let liveWorkers = 0;
  let terminated = 0;
  // Held on an object: TS narrows a `let` assigned only inside the class to `null` at every call site.
  const live: { deliver: ((data: unknown) => void) | null } = { deliver: null };

  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
      liveWorkers += 1;
      live.deliver = (data) => this.onmessage?.({ data });
    }

    postMessage(message: { id: number; documentId: string }): void {
      posted.push(message);
    }

    terminate(): void {
      terminated += 1;
      liveWorkers -= 1;
    }
  }

  const globals = globalThis as { Worker?: unknown };

  globals.Worker = FakeWorker;

  try {
    const capture = createWorkerDocumentCapture();

    assert.ok(capture);

    // Two captures in flight at once: each must be answered by ITS id, not by arrival order.
    const first = capture('doc-a');
    const second = capture('doc-b');

    assert.deepEqual(posted, [
      { id: 1, documentId: 'doc-a' },
      { id: 2, documentId: 'doc-b' },
    ]);

    // Reply to the SECOND one first.
    live.deliver?.({ id: 2, ok: true, result: null });
    assert.equal(await second, null);

    const meta = { id: 'doc-a', pageCount: 3, title: 'A', thumbnail: null, updatedAt: 1 };
    const serialized = { blob: new Blob(['bytes']), contentType: 'application/octet-stream', fileSize: 5 };

    live.deliver?.({ id: 1, ok: true, result: { meta, serialized } });
    assert.deepEqual((await first)?.meta, meta);

    // A worker-side failure rejects that call AND drops the worker...
    const failing = capture('doc-c');

    live.deliver?.({ id: 3, ok: false, error: 'IndexedDB exploded' });
    await assert.rejects(failing, /IndexedDB exploded/);
    assert.equal(terminated, 1);

    // ...so the next call builds a fresh one and succeeds.
    const afterFailure = capture('doc-d');

    assert.equal(liveWorkers, 1);
    live.deliver?.({ id: 4, ok: true, result: null });
    assert.equal(await afterFailure, null);
  } finally {
    delete globals.Worker;
  }
});
