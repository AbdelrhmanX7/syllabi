import type { SseFrame } from '@/lib/api/http';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sseIterable } from './sseIterable';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('frames come out in order; the iteration ends when the stream resolves', async () => {
  const frames: SseFrame[] = [
    { event: 'meta', data: { conversationId: 'c' } },
    { event: 'delta', data: { text: 'a' } },
    { event: 'done', data: null },
  ];
  const seen: string[] = [];

  for await (const frame of sseIterable(async (onFrame) => {
    for (const frame of frames) {
      onFrame(frame);
      await tick();
    }
  }, new AbortController().signal)) {
    seen.push(frame.event);
  }

  assert.deepEqual(seen, ['meta', 'delta', 'done']);
});

test('a rejected stream throws at the next pull, after the frames that arrived first', async () => {
  const seen: string[] = [];

  await assert.rejects(async () => {
    for await (const frame of sseIterable(async (onFrame) => {
      onFrame({ event: 'delta', data: { text: 'x' } });
      await tick();
      throw new Error('boom');
    }, new AbortController().signal)) {
      seen.push(frame.event);
    }
  }, /boom/);

  assert.deepEqual(seen, ['delta']);
});

test('aborting ends the iteration quietly', async () => {
  const controller = new AbortController();
  const seen: string[] = [];

  for await (const frame of sseIterable(
    (onFrame, signal) =>
      new Promise<void>((resolve) => {
        onFrame({ event: 'delta', data: { text: 'first' } });
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    controller.signal,
  )) {
    seen.push(frame.event);
    controller.abort();
  }

  assert.deepEqual(seen, ['delta']);
});
