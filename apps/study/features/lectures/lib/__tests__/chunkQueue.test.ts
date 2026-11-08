import type { LectureSession, UploadDeps } from '../chunkQueue';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChunkUploadQueue, createMemoryChunkStore, normalizeChunkMime } from '../chunkQueue';

const session = (id: string, mime = 'audio/webm;codecs=opus'): Omit<LectureSession, 'updatedAt'> => ({
  lectureId: id,
  classId: 'c1',
  title: 'Lecture',
  pageId: `page-${id}`,
  pageVersion: 1,
  pageUploaded: false,
  mime,
  startedAt: '2026-10-04T10:00:00.000Z',
  nextIndex: 0,
  durationMs: 0,
  state: 'recording',
});

/** Shaped like the transport's `StudyApiError` + body extras. */
const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(code), { status, code }, extra);

type Script = { put?: (index: number) => Error | null; finish?: () => Error | null };

function harness(script: Script = {}) {
  const store = createMemoryChunkStore();
  const log: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const deps: UploadDeps = {
    putChunk: async (lectureId, index, blob, mime) => {
      const error = script.put?.(index);

      if (error) throw error;
      log.push(`put ${lectureId}#${index} ${blob.size} ${mime}`);
    },
    uploadPage: async (s) => {
      log.push(`page ${s.pageId}@${s.pageVersion}`);

      return s.pageVersion + 1;
    },
    finish: async (lectureId, chunks, durationSec) => {
      const error = script.finish?.();

      if (error) throw error;
      log.push(`finish ${lectureId} ${chunks} ${durationSec}`);
    },
  };
  const queue = new ChunkUploadQueue(store, deps, {
    schedule: (fn, ms) => {
      const entry = { fn, ms };

      timers.push(entry);

      return () => timers.splice(timers.indexOf(entry), 1);
    },
  });

  return { store, log, timers, queue };
}

const blob = (n: number) => new Blob([new Uint8Array(n)]);

test('normalizeChunkMime keeps the two accepted families', () => {
  assert.equal(normalizeChunkMime('audio/webm;codecs=opus'), 'audio/webm;codecs=opus');
  assert.equal(normalizeChunkMime('audio/webm; codecs="opus"'), 'audio/webm;codecs=opus');
  assert.equal(normalizeChunkMime('audio/webm'), 'audio/webm');
  assert.equal(normalizeChunkMime('audio/mp4;codecs=mp4a.40.2'), 'audio/mp4');
});

test('chunks upload in order with the pinned mime, then the page, then finish; disk is cleared', async () => {
  const { queue, log, store } = harness();

  await queue.startSession(session('L1'));
  await queue.enqueue('L1', blob(10), 'audio/webm', 30_000);
  await queue.enqueue('L1', blob(20), 'video/whatever', 60_000);
  await queue.pump();
  assert.equal(log.filter((line) => line.startsWith('finish')).length, 0, 'no finish while still recording');
  assert.equal((await store.listChunks()).length, 2, 'uploaded chunks stay on disk until finish');
  assert.equal(queue.getStatus().pendingChunks, 0);

  await queue.enqueue('L1', blob(5), 'audio/webm', 61_400);
  await queue.stop('L1', 61_400);
  await queue.pump();

  assert.deepEqual(log, [
    'put L1#0 10 audio/webm;codecs=opus',
    'put L1#1 20 audio/webm;codecs=opus',
    'put L1#2 5 audio/webm;codecs=opus',
    'page page-L1@1',
    'finish L1 3 61',
  ]);
  assert.deepEqual(await store.listChunks(), []);
  assert.deepEqual(await store.listSessions(), []);
});

test('offline: chunks stay on disk, retry with backoff, finish after recovery', async () => {
  let failures = 2;
  const { queue, log, store, timers } = harness({
    put: () => (failures-- > 0 ? new TypeError('Failed to fetch') : null),
  });

  await queue.startSession(session('L2'));
  await queue.enqueue('L2', blob(8), 'audio/webm', 30_000);
  await queue.stop('L2');
  await queue.pump();

  assert.equal(queue.getStatus().pendingChunks, 1);
  assert.equal(queue.getStatus().lastError, 'Failed to fetch');
  assert.equal(timers.length, 1);
  const firstDelay = timers[0].ms;

  timers.shift()!.fn();
  await queue.pump();
  assert.ok(timers[0].ms > firstDelay, 'backoff grows');

  timers.shift()!.fn();
  await queue.pump();
  assert.deepEqual(await store.listChunks(), []);
  assert.ok(log.includes('finish L2 1 30'));
  assert.equal(queue.getStatus().lastError, null);
});

test('409 CHUNKS_MISSING re-uploads the named indices from disk, then finishes', async () => {
  let finishCalls = 0;
  const { queue, log, store } = harness({
    finish: () => (++finishCalls === 1 ? apiError(409, 'CHUNKS_MISSING', { missing: [1] }) : null),
  });

  await queue.startSession(session('L3'));
  await queue.enqueue('L3', blob(1), 'audio/webm', 30_000);
  await queue.enqueue('L3', blob(2), 'audio/webm', 60_000);
  await queue.stop('L3', 60_000);
  await queue.pump();

  assert.deepEqual(
    log.filter((line) => line.startsWith('put')),
    ['put L3#0 1 audio/webm;codecs=opus', 'put L3#1 2 audio/webm;codecs=opus', 'put L3#1 2 audio/webm;codecs=opus'],
  );
  assert.ok(log.includes('finish L3 2 60'));
  assert.deepEqual(await store.listSessions(), []);
});

test('CHUNK_TYPE_MISMATCH parks only that lecture; others keep flowing; retry un-parks', async () => {
  let mismatch = true;
  const { queue, log, store } = harness({
    put: (index) => (mismatch && index === 0 ? apiError(409, 'CHUNK_TYPE_MISMATCH') : null),
  });

  await queue.startSession(session('BAD'));
  await queue.enqueue('BAD', blob(3), 'audio/webm', 30_000);
  await queue.stop('BAD');
  await queue.pump();
  const [parked] = await store.listSessions();

  assert.equal(parked.error?.code, 'CHUNK_TYPE_MISMATCH');
  assert.equal(queue.getStatus().lastError, null, 'not a connection problem');

  mismatch = false;
  await queue.retry('BAD');
  await queue.pump();
  assert.ok(log.includes('finish BAD 1 30'));
});

test('409 LECTURE_FINISHED on a chunk drops the lecture from the queue', async () => {
  const { queue, store } = harness({ put: () => apiError(409, 'LECTURE_FINISHED') });

  await queue.startSession(session('DONE'));
  await queue.enqueue('DONE', blob(3), 'audio/webm', 30_000);
  await queue.pump();
  assert.deepEqual(await store.listChunks(), []);
  assert.deepEqual(await store.listSessions(), []);
});

test('409 LECTURE_PROCESSING on finish counts as done', async () => {
  const { queue, store } = harness({ finish: () => apiError(409, 'LECTURE_PROCESSING') });

  await queue.startSession(session('P'));
  await queue.enqueue('P', blob(3), 'audio/webm', 30_000);
  await queue.stop('P');
  await queue.pump();
  assert.deepEqual(await store.listSessions(), []);
});

test('a crash leaves a resumable session; a fresh queue over the same store finishes it', async () => {
  const first = harness({ put: () => new TypeError('offline') });

  await first.queue.startSession(session('L4'));
  await first.queue.enqueue('L4', blob(4), 'audio/webm', 30_000);
  await first.queue.pump();

  const log: string[] = [];
  const revived = new ChunkUploadQueue(first.store, {
    putChunk: async (id, i) => void log.push(`put ${id}#${i}`),
    finish: async (id, chunks) => void log.push(`finish ${id} ${chunks}`),
  });
  const [orphan] = await first.store.listSessions();

  assert.equal(orphan.state, 'recording');
  await revived.stop('L4');
  await revived.pump();
  assert.deepEqual(log, ['put L4#0', 'finish L4 1']);
});

test('discard drops audio and session', async () => {
  const { queue, store } = harness({ put: () => new TypeError('offline') });

  await queue.startSession(session('L5'));
  await queue.enqueue('L5', blob(4), 'audio/webm', 1000);
  await queue.discard('L5');
  assert.deepEqual(await store.listChunks(), []);
  assert.deepEqual(await store.listSessions(), []);
});
