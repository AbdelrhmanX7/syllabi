import assert from 'node:assert/strict';
import { test } from 'node:test';

import 'fake-indexeddb/auto';

import { createIdbKv, createMemoryKv } from './idb-kv';
import { backoffMs, newClientId, Outbox, type SendResult } from './outbox';

function clock(start = 1_000) {
  let now = start;

  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test('jobs are sent in order and removed; only the current scope is sent', async () => {
  const box = new Outbox({ kv: createMemoryKv() });
  const sent: string[] = [];

  box.register('grade', async (job) => {
    sent.push((job.payload as { q: string }).q);

    return 'done';
  });
  await box.enqueue({ kind: 'grade', payload: { q: 'a' }, scope: 'u1' });
  await box.enqueue({ kind: 'grade', payload: { q: 'b' }, scope: 'u2' });
  await box.enqueue({ kind: 'grade', payload: { q: 'c' }, scope: 'u1' });

  assert.equal(await box.flush('u1'), 2);
  assert.deepEqual(sent, ['a', 'c']);
  assert.equal(await box.pending('u1'), 0);
  assert.equal(await box.pending('u2'), 1);
});

test('a network failure keeps the job, backs off and stops the flush', async () => {
  const time = clock();
  const box = new Outbox({ kv: createMemoryKv(), now: time.now });
  let fail = true;
  const sent: string[] = [];

  box.register('grade', async (job) => {
    if (fail) return 'retry';
    sent.push(job.id);

    return 'done';
  });
  await box.enqueue({ kind: 'grade', payload: {}, scope: 's', id: 'one' });
  await box.enqueue({ kind: 'grade', payload: {}, scope: 's', id: 'two' });

  assert.equal(await box.flush('s'), 0);
  const [first, second] = await box.all();

  assert.equal(first.attempts, 1);
  assert.equal(first.nextAt, time.now() + backoffMs(1));
  // stopped at the first failure: the second was not tried
  assert.equal(second.attempts, 0);

  fail = false;
  // 'one' is still backing off; 'two' (independent) goes
  assert.equal(await box.flush('s'), 1);
  assert.deepEqual(sent, ['two']);
  time.advance(backoffMs(1));
  assert.equal(await box.flush('s'), 1);
  assert.deepEqual(sent, ['two', 'one']);
});

test('a thrown handler counts as a retry; force ignores the backoff', async () => {
  const box = new Outbox({ kv: createMemoryKv() });
  let calls = 0;

  box.register('x', async () => {
    calls++;
    if (calls === 1) throw new Error('boom');

    return 'done';
  });
  await box.enqueue({ kind: 'x', payload: {}, scope: 's' });
  assert.equal(await box.flush('s'), 0);
  assert.equal((await box.all())[0].lastError, 'boom');
  assert.equal(await box.flush('s', { force: true }), 1);
});

test('a server refusal drops the job; later keeps it without backoff and goes on', async () => {
  const box = new Outbox({ kv: createMemoryKv() });
  const results: Record<string, SendResult> = { bad: 'drop', wait: 'later', ok: 'done' };

  box.register('k', async (job) => results[job.id]);
  await box.enqueue({ kind: 'k', payload: {}, scope: 's', id: 'bad' });
  await box.enqueue({ kind: 'k', payload: {}, scope: 's', id: 'wait' });
  await box.enqueue({ kind: 'k', payload: {}, scope: 's', id: 'ok' });

  assert.equal(await box.flush('s'), 1);
  const left = await box.all();

  assert.deepEqual(
    left.map((job) => [job.id, job.attempts, job.nextAt]),
    [['wait', 0, 0]],
  );
});

test('dedupe key replaces the queued job of the same scope only', async () => {
  const box = new Outbox({ kv: createMemoryKv() });

  await box.enqueue({ kind: 'seen', payload: { n: 1 }, scope: 's', dedupeKey: 'seen:i1' });
  await box.enqueue({ kind: 'seen', payload: { n: 2 }, scope: 's', dedupeKey: 'seen:i1' });
  await box.enqueue({ kind: 'seen', payload: { n: 3 }, scope: 'other', dedupeKey: 'seen:i1' });
  const jobs = await box.all();

  assert.deepEqual(
    jobs.map((job) => [job.scope, (job.payload as { n: number }).n]),
    [
      ['s', 2],
      ['other', 3],
    ],
  );
});

test('patch records progress so a retry does not redo the first step', async () => {
  const box = new Outbox({ kv: createMemoryKv() });
  let creates = 0;
  let second = false;

  box.register('create', async (job) => {
    const payload = job.payload as { serverId?: string };

    if (!payload.serverId) {
      creates++;
      await box.patch(job.id, { serverId: 'srv1' });
    }
    if (!second) {
      second = true;

      return 'retry';
    }

    return 'done';
  });
  await box.enqueue({ kind: 'create', payload: {}, scope: 's' });
  await box.flush('s');
  await box.flush('s', { force: true });
  assert.equal(creates, 1);
  assert.equal(await box.pending(), 0);
});

test('jobs survive a restart through IndexedDB', async () => {
  const kv = createIdbKv(indexedDB);
  const first = new Outbox({ kv });

  await first.enqueue({ kind: 'grade', payload: { q: 'persisted' }, scope: 's', id: 'keep-me' });

  const second = new Outbox({ kv: createIdbKv(indexedDB) });
  const jobs = await second.all();

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'keep-me');
  assert.deepEqual(jobs[0].payload, { q: 'persisted' });
});

test('client ids are unique hex with the prefix', () => {
  const a = newClientId('local-');
  const b = newClientId('local-');

  assert.match(a, /^local-[0-9a-f]{24}$/);
  assert.notEqual(a, b);
});

test('backoff grows and caps', () => {
  assert.equal(backoffMs(1), 5_000);
  assert.equal(backoffMs(2), 10_000);
  assert.equal(backoffMs(50), 10 * 60_000);
});
