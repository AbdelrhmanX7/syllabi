import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IDBFactory } from 'fake-indexeddb';

import { createIdbChunkStore } from '../idbChunkStore';

test('IndexedDB store round-trips chunks and sessions across reopen', async () => {
  const factory = new IDBFactory();
  const store = createIdbChunkStore(factory);

  await store.putChunk({ lectureId: 'L', index: 0, blob: new Blob(['ab']), size: 2, mime: 'audio/webm', createdAt: 1 });
  await store.putChunk({ lectureId: 'L', index: 1, blob: new Blob(['c']), size: 1, mime: 'audio/webm', createdAt: 2 });
  await store.putSession({
    lectureId: 'L',
    classId: 'c',
    title: 't',
    pageId: null,
    pageVersion: 0,
    pageUploaded: false,
    mime: 'audio/webm',
    startedAt: 'x',
    nextIndex: 2,
    durationMs: 60_000,
    state: 'recording',
    updatedAt: 3,
  });
  await store.deleteChunk('L', 0);

  const reopened = createIdbChunkStore(factory);

  assert.deepEqual(
    (await reopened.listChunks()).map((chunk) => chunk.index),
    [1],
  );
  assert.equal((await reopened.getSession('L'))?.nextIndex, 2);
  assert.equal(await reopened.getSession('missing'), null);
  await reopened.deleteSession('L');
  assert.deepEqual(await reopened.listSessions(), []);
});
