import type { PerfSendResult } from './uploader';
import type { PerfBatch, PerfEvent } from './types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryPerfStore, utf8Length } from './store';
import {
  backoffDelay,
  parseRetryAfter,
  PERF_BATCH_MAX_BYTES,
  PERF_KEEPALIVE_MAX_BYTES,
  PerfUploader,
} from './uploader';

const big = (t: number): PerfEvent => ({ k: 'pen', t, type: 'x', text: 'y'.repeat(1000) });

function setup(results: PerfSendResult[]) {
  const store = new MemoryPerfStore();
  const sent: { batch: PerfBatch; keepalive: boolean }[] = [];
  let now = 1_000;
  const uploader = new PerfUploader({
    store,
    send: async (batch, { keepalive }) => {
      sent.push({ batch, keepalive });

      return results.shift() ?? { ok: true, status: 204 };
    },
    now: () => now,
    random: () => 0.5,
    newId: () => `b${sent.length}`,
    header: () => ({
      session: 's',
      device: { id: 'd', ua: 'ua', screen: [1, 1], dpr: 1, platform: 'web' },
      app: { version: '1', sha: 'abc', versionCode: 1 },
    }),
  });

  return { store, sent, uploader, advance: (ms: number) => (now += ms) };
}

test('a 2xx deletes exactly the sent events; batches respect the byte cap', async () => {
  const { store, sent, uploader } = setup([]);

  await store.append(Array.from({ length: 600 }, (_, index) => big(index)));
  assert.equal(await uploader.upload(), 'sent');
  for (const { batch } of sent) {
    assert.ok(utf8Length(JSON.stringify(batch)) <= PERF_BATCH_MAX_BYTES);
  }
  // 600 KB in ≤ 256 KB batches: 3 batches drain it.
  assert.equal(sent.length, 3);
  assert.equal(store.stats().count, 0);
  assert.equal(uploader.sentEvents, 600);
  assert.equal(await uploader.upload(), 'empty');
});

test('keepalive sends one small batch', async () => {
  const { store, sent, uploader } = setup([]);

  await store.append(Array.from({ length: 200 }, (_, index) => big(index)));
  await uploader.upload({ keepalive: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].keepalive, true);
  assert.ok(utf8Length(JSON.stringify(sent[0].batch)) <= PERF_KEEPALIVE_MAX_BYTES);
  assert.ok(store.stats().count > 0);
});

test('a failure keeps the events, reports drops again, and backs off', async () => {
  const { store, sent, uploader, advance } = setup([{ ok: false, status: 404 }]);

  await store.append([big(1)]);
  store.restoreDropped(3);
  assert.equal(await uploader.upload(), 'failed');
  assert.equal(sent[0].batch.dropped, 3);
  assert.equal(store.stats().count, 1);
  assert.equal(store.stats().dropped, 3);
  assert.equal(await uploader.upload(), 'backoff');
  advance(backoffDelay(404, 1, 0.5));
  assert.equal(await uploader.upload(), 'sent');
  assert.equal(sent[1].batch.dropped, 3);
  assert.equal(store.stats().count, 0);
  assert.equal(uploader.attempts, 0);
});

test('force ignores the backoff window', async () => {
  const { store, uploader } = setup([{ ok: false, status: 0 }]);

  await store.append([big(1)]);
  await uploader.upload();
  assert.equal(await uploader.upload(), 'backoff');
  assert.equal(await uploader.upload({ force: true }), 'sent');
});

test('a poison status drops the batch instead of retrying forever', async () => {
  const { store, uploader } = setup([{ ok: false, status: 413 }]);

  await store.append([big(1), big(2)]);
  assert.equal(await uploader.upload(), 'failed');
  assert.equal(store.stats().count, 0);
  assert.equal(store.stats().dropped, 2);
  assert.equal(uploader.nextAttemptAt, 0);
});

test('a throwing sender counts as a network failure', async () => {
  const store = new MemoryPerfStore();
  const uploader = new PerfUploader({
    store,
    send: async () => {
      throw new Error('boom');
    },
    now: () => 0,
    random: () => 0,
    newId: () => 'x',
    header: () => ({
      session: 's',
      device: { id: 'd', ua: '', screen: [0, 0], dpr: 1, platform: 'web' },
      app: { version: '', sha: '', versionCode: null },
    }),
  });

  await store.append([big(1)]);
  assert.equal(await uploader.upload(), 'failed');
  assert.equal(uploader.lastStatus, 0);
  assert.equal(store.stats().count, 1);
});

test('backoff: doubling per class, capped, jittered ±20 %', () => {
  const MIN = 60_000;

  assert.equal(backoffDelay(0, 1, 0.5), MIN);
  assert.equal(backoffDelay(503, 2, 0.5), 2 * MIN);
  assert.equal(backoffDelay(0, 50, 0.5), 30 * MIN);
  assert.equal(backoffDelay(401, 1, 0.5), 5 * MIN);
  assert.equal(backoffDelay(-1, 10, 0.5), 60 * MIN);
  assert.equal(backoffDelay(404, 1, 0.5), 30 * MIN);
  assert.equal(backoffDelay(404, 9, 0.5), 6 * 60 * MIN);
  assert.equal(backoffDelay(0, 1, 0), 0.8 * MIN);
  assert.equal(backoffDelay(0, 1, 0.999999), Math.round(MIN * (0.8 + 0.4 * 0.999999)));
});

test('a retry of the same events re-sends the same batchId (server dedupes a lost 204)', async () => {
  const { store, sent, uploader, advance } = setup([
    { ok: false, status: 0 },
    { ok: false, status: 503 },
  ]);

  await store.append([big(1), big(2)]);
  assert.equal(await uploader.upload(), 'failed');
  // New events during the backoff do not change the retried batch.
  await store.append([big(10), big(11)]);
  advance(60 * 60_000);
  assert.equal(await uploader.upload(), 'failed');
  advance(60 * 60_000);
  assert.equal(await uploader.upload(), 'sent');
  assert.equal(sent[1].batch.events.length, 2);
  assert.equal(sent[2].batch.events.length, 2);
  assert.equal(sent[1].batch.batchId, sent[0].batch.batchId);
  assert.equal(sent[2].batch.batchId, sent[0].batch.batchId);
  // The same pass moves on to the newer events under a new id.
  assert.equal(sent.length, 4);
  assert.notEqual(sent[3].batch.batchId, sent[0].batch.batchId);
  assert.equal(store.stats().count, 0);
});

test('429 waits at least Retry-After', async () => {
  const { store, uploader, advance } = setup([{ ok: false, status: 429, retryAfterMs: 2 * 60 * 60_000 }]);

  await store.append([big(1)]);
  assert.equal(await uploader.upload(), 'failed');
  advance(60 * 60_000);
  assert.equal(await uploader.upload(), 'backoff');
  advance(61 * 60_000);
  assert.equal(await uploader.upload(), 'sent');
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('120', 0), 120_000);
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter('soon', 0), null);
  assert.equal(parseRetryAfter(new Date(90_000).toUTCString(), 30_000), 60_000);
});
