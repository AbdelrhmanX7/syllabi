import type { BoardAiStreamEvent } from '@repo/whiteboard-react';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardErrorText, createWhiteboardAi, FALLBACK, mismatchLine, quotaMessage } from './whiteboardAi';

import { AI_QUOTA_MESSAGE } from '@/lib/api/errors';

/**
 * Contract tests against the SSE shapes BE #554 serves on /whiteboard/ai/* (the whiteboard app's
 * fixtures), with Study's credentials: Bearer only, `lang: 'en'` on every body, English errors.
 */

const sse = (frames: unknown[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(': ping\n\n');

      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const ASK_FIXTURE = [
  { type: 'status', data: 'Reading the selection…' },
  { type: 'transcript', data: 'Solve: $2x + 3 = 11$' },
  { type: 'text', data: '## Solution\n\n$$2x = 8$$' },
  { type: 'text', data: '\n\n$$x = 4$$' },
  { type: 'done', data: { usageId: 'u1', content: '## Solution\n\n$$2x = 8$$\n\n$$x = 4$$' } },
];

const GENERATE_FIXTURE = [
  { type: 'status', data: 'Drafting…' },
  { type: 'text', data: '**Q1:** …' },
  { type: 'result', data: { blocks: [{ type: 'question', stem: 'What is $2+2$?', answer: '4' }] } },
  { type: 'done', data: { usageId: 'u2' } },
];

interface Call {
  url: string;
  headers: Record<string, string>;
  body: FormData | string;
}

function harness(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as FormData | string,
    };

    calls.push(call);

    return respond(call);
  };
  const service = createWhiteboardAi({
    resolveAccess: () => ({ baseUrl: 'https://api.example.test', headers: { Authorization: 'Bearer study-jwt' } }),
    fetchImpl,
    boardContext: () => ({ boardId: 'pg_1' }),
  });

  return { calls, service };
}

const drain = async (stream: AsyncIterable<BoardAiStreamEvent>) => {
  const events: BoardAiStreamEvent[] = [];

  for await (const event of stream) events.push(event);

  return events;
};

test('/ask: multipart under /whiteboard/ai with the Study bearer, boardId and lang=en; frames pass through', async () => {
  const { calls, service } = harness(() => new Response(sse(ASK_FIXTURE), { status: 200 }));
  const events = await drain(
    service.ask({ image: new Blob(['png'], { type: 'image/png' }), action: 'solve' }, new AbortController().signal),
  );

  // ?lang=en too: the auth / quota / size errors fire before multer reads the `lang` field.
  assert.equal(calls[0].url, 'https://api.example.test/whiteboard/ai/ask?lang=en');
  assert.equal(calls[0].headers.Authorization, 'Bearer study-jwt');
  assert.equal('X-Whiteboard-Teacher-Id' in calls[0].headers, false);
  const form = calls[0].body as FormData;

  assert.equal(form.get('action'), 'solve');
  assert.equal(form.get('boardId'), 'pg_1');
  assert.equal(form.get('lang'), 'en');
  assert.ok(form.get('image') instanceof Blob);
  assert.deepEqual(
    events.map((event) => event.type),
    ['status', 'transcript', 'text', 'text', 'done'],
  );
});

test('/generate: JSON body carries lang=en; result blocks surface; a /study base is normalised', async () => {
  const { calls, service } = harness(() => new Response(sse(GENERATE_FIXTURE), { status: 200 }));
  const events = await drain(service.generate({ prompt: 'limits', kind: 'questions' }, new AbortController().signal));
  const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;

  assert.equal(body.lang, 'en');
  assert.equal(body.kind, 'questions');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  const result = events.find((event) => event.type === 'result');

  assert.ok(result && result.type === 'result' && result.data.blocks[0].type === 'question');

  const withStudyBase = createWhiteboardAi({
    resolveAccess: () => ({ baseUrl: 'https://api.example.test/study', headers: {} }),
    fetchImpl: async (input) => {
      assert.equal(String(input), 'https://api.example.test/whiteboard/ai/generate?lang=en');

      return new Response(sse(GENERATE_FIXTURE), { status: 200 });
    },
  });

  await drain(withStudyBase.generate({ prompt: 'x', kind: 'summary' }, new AbortController().signal));
});

test('errors are English: signed out, missing route, quota with Retry-After, server message passthrough', async () => {
  const signedOut = createWhiteboardAi({ resolveAccess: () => null, fetchImpl: async () => new Response('') });

  await assert.rejects(drain(signedOut.generate({ prompt: 'x', kind: 'free' }, new AbortController().signal)), {
    message: FALLBACK.signedOut,
  });

  // A 401 is never shown as the server wrote it — it is mapped instead.
  const { service: expired } = harness(() => new Response('{"message":"Unauthorized"}', { status: 401 }));

  await assert.rejects(drain(expired.generate({ prompt: 'x', kind: 'free' }, new AbortController().signal)), {
    message: 'Session expired — sign in again',
  });

  const { service: blank } = harness(() => new Response('{"message":"  "}', { status: 500 }));

  await assert.rejects(drain(blank.generate({ prompt: 'x', kind: 'free' }, new AbortController().signal)), {
    message: FALLBACK.server,
  });

  // The AI account is out of balance: 402 (or code AI_QUOTA) → the app-wide English notice.
  const { service: broke } = harness(() => new Response('{"message":"Insufficient Balance"}', { status: 402 }));

  await assert.rejects(
    drain(broke.generate({ prompt: 'x', kind: 'free' }, new AbortController().signal)),
    (error: Error & { code?: string }) => error.message === AI_QUOTA_MESSAGE && error.code === 'AI_QUOTA',
  );

  const { service: missing } = harness(() => new Response('', { status: 404 }));

  await assert.rejects(drain(missing.generate({ prompt: 'x', kind: 'free' }, new AbortController().signal)), {
    message: FALLBACK.missing,
  });

  const { service: quota } = harness(
    () => new Response(JSON.stringify({ code: 'WB_AI_QUOTA', retryAfterSec: 120 }), { status: 429 }),
  );

  await assert.rejects(drain(quota.generate({ prompt: 'x', kind: 'free' }, new AbortController().signal)), {
    message: quotaMessage(120),
  });
  assert.match(quotaMessage(120), /2 min/);
  assert.match(quotaMessage(7200), /2 h/);

  const { service: server } = harness(
    () => new Response(JSON.stringify({ message: 'Image is not a picture', code: 'WB_AI_BAD_IMAGE' }), { status: 400 }),
  );

  await assert.rejects(
    drain(server.ask({ image: new Blob(['x']), action: 'explain' }, new AbortController().signal)),
    (error: Error & { status?: number; code?: string }) =>
      error.message === 'Image is not a picture' && error.status === 400 && error.code === 'WB_AI_BAD_IMAGE',
  );
});

test('mismatchLine reads in English', () => {
  assert.equal(mismatchLine({ n: 2, expected: 'x', got: 'y' }), 'Q2: expected “x” but got “y”');
  assert.equal(
    mismatchLine({ n: 0, kind: 'erase_leftover' }),
    'Page: leftovers of the old text were not erased — check it',
  );
  assert.match(mismatchLine({ n: 1, typeChanged: { from: 'written', to: 'mcq' } }), /answer choices/);
});

test('boardErrorText: a deploy drain frame reads as a restart; strings pass through', () => {
  assert.equal(
    boardErrorText({ code: 'SERVER_RESTARTING', message: 'The server is restarting. Please retry.' }),
    'Server restarted — try again',
  );
  assert.equal(boardErrorText('Safety refusal'), 'Safety refusal');
  assert.equal(boardErrorText({ code: 'OTHER' }), FALLBACK.server);
});
