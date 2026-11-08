import type { InboxItem } from '../types';
import type { InboxLiveDeps, InboxLiveMode } from './live';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startInboxLive, streamUnsupported } from './live';

import { StudyApiError } from '@/lib/api/errors';

const item = (id: string): InboxItem => ({
  id,
  kind: 'image',
  url: id,
  thumbUrl: null,
  width: null,
  height: null,
  bytes: 0,
  note: null,
  createdAt: '2026-10-05T10:00:00.000Z',
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A fake clock: `sleep` waits until the test calls `advance()`. */
function fakeSleep() {
  const waiting: { ms: number; resolve: () => void }[] = [];

  return {
    waiting,
    sleep: (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        waiting.push({ ms, resolve });
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    async advance() {
      waiting.splice(0).forEach((w) => w.resolve());
      await tick();
      await tick();
    },
  };
}

function harness(stream: InboxLiveDeps['stream'], pollResults: InboxItem[][] = []) {
  const clock = fakeSleep();
  const modes: InboxLiveMode[] = [];
  const received: string[] = [];
  const polls: (string | null)[] = [];
  const stop = startInboxLive({
    stream,
    poll: async (since) => {
      polls.push(since);

      return pollResults.shift() ?? [];
    },
    getSince: () => 'cursor',
    onItems: (items) => received.push(...items.map((i) => i.id)),
    onMode: (mode) => modes.push(mode),
    sleep: clock.sleep,
    pollMs: 10_000,
  });

  return { clock, modes, received, polls, stop };
}

test('streamUnsupported: 404/405/501 and the mock «no route»', () => {
  assert.ok(streamUnsupported(new StudyApiError(404, 'nope')));
  assert.ok(streamUnsupported(new StudyApiError(501, 'nope')));
  assert.ok(streamUnsupported({ code: 'MOCK_NO_ROUTE' }));
  assert.ok(!streamUnsupported(new StudyApiError(500, 'boom')));
  assert.ok(!streamUnsupported(new TypeError('Failed to fetch')));
});

test('SSE: items flow through, mode is sse, stop aborts the stream', async () => {
  let aborted = false;
  const h = harness((handlers, signal) => {
    handlers.onOpen();
    handlers.onItem(item('a'));
    handlers.onItem(item('b'));

    return new Promise((resolve) => signal.addEventListener('abort', () => ((aborted = true), resolve())));
  });

  await tick();
  assert.deepEqual(h.received, ['a', 'b']);
  assert.deepEqual(h.modes, ['connecting', 'sse']);
  assert.deepEqual(h.polls, []);
  h.stop();
  await tick();
  assert.ok(aborted);
  assert.equal(h.modes.at(-1), 'stopped');
});

test('404 on the stream → polling every 10 s with the since cursor', async () => {
  const h = harness(async () => {
    throw new StudyApiError(404, 'Cannot GET /study/inbox/stream');
  }, [[item('p1')], [], [item('p2')]]);

  await tick();
  assert.equal(h.modes.at(-1), 'poll');
  assert.deepEqual(
    h.clock.waiting.map((w) => w.ms),
    [10_000],
  );
  await h.clock.advance();
  await h.clock.advance();
  await h.clock.advance();
  assert.deepEqual(h.received, ['p1', 'p2']);
  assert.deepEqual(h.polls, ['cursor', 'cursor', 'cursor']);
  h.stop();
});

test('a stream that worked and dropped: one catch-up poll, then reconnect with backoff', async () => {
  let opens = 0;
  const h = harness(
    async (handlers) => {
      opens += 1;
      handlers.onOpen();
      if (opens === 1) throw new TypeError('network changed');

      return new Promise(() => undefined);
    },
    [[item('missed')]],
  );

  await tick();
  await tick();
  assert.deepEqual(h.received, ['missed']);
  assert.deepEqual(
    h.clock.waiting.map((w) => w.ms),
    [2_000],
  );
  await h.clock.advance();
  assert.equal(opens, 2);
  assert.equal(h.modes.at(-1), 'sse');
  h.stop();
});

test('a stream that never opens three times running → polling', async () => {
  let attempts = 0;
  const h = harness(async () => {
    attempts += 1;
    throw new StudyApiError(502, 'Bad gateway');
  });

  for (let i = 0; i < 4; i++) {
    await tick();
    await tick();
    await h.clock.advance();
  }
  assert.equal(attempts, 3);
  assert.equal(h.modes.at(-1), 'poll');
  h.stop();
});
