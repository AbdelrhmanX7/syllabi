import type { SseFrame } from './http';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StudyApiError } from './errors';
import { readSse } from './http';

/** A Response whose body arrives in the given chunks (split mid-frame on purpose). */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function frames(chunks: string[]): Promise<SseFrame[]> {
  const out: SseFrame[] = [];

  await readSse(sseResponse(chunks), (frame) => out.push(frame));

  return out;
}

test('readSse: the #577 ask stream, split across chunks, with ping comments between frames', async () => {
  const out = await frames([
    'event: meta\ndata: {"conversationId":"cv1"}\n\n: ping\n\nevent: del',
    'ta\ndata: {"text":"Hel"}\n\nevent: delta\ndata: {"text":"lo"}\n\n',
    ': ping\n\nevent: sources\ndata: {"sources":[]}\n\nevent: done\ndata: {}\n\n',
    'event: delta\ndata: {"text":"after done"}\n\n',
  ]);

  assert.deepEqual(
    out.map((frame) => frame.event),
    ['meta', 'delta', 'delta', 'sources', 'done'],
  );
  assert.deepEqual(out[1].data, { text: 'Hel' });
});

test('readSse: CRLF framing parses the same', async () => {
  const out = await frames(['event: meta\r\ndata: {"conversationId":"x"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n']);

  assert.deepEqual(out, [
    { event: 'meta', data: { conversationId: 'x' } },
    { event: 'done', data: {} },
  ]);
});

test('readSse: an error frame rejects with its message and code', async () => {
  await assert.rejects(
    frames([
      'event: meta\ndata: {"conversationId":"x"}\n\nevent: error\ndata: {"message":"The tutor failed — try again","code":"AI_FAILED"}\n\n',
    ]),
    (error: unknown) =>
      error instanceof StudyApiError && error.message === 'The tutor failed — try again' && error.code === 'AI_FAILED',
  );
});
