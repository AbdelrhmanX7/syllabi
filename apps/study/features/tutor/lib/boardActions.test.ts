import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardActionsJson, NOT_AVAILABLE_CODE, PEN_UNAVAILABLE_MESSAGE, postBoardActions } from './boardActions';
import { BoardAiHttpError } from './whiteboardAi';

const access = { baseUrl: 'https://api.example.test', headers: { Authorization: 'Bearer t' } };
const json = { question: 'q', lang: 'en' as const, clusters: [] };
const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

const fetchWith = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
  (async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })) as typeof fetch;

test('boardActionsJson: the editor clusters (bbox) become the contract clusters (box); lang is always en', () => {
  assert.deepEqual(
    boardActionsJson({ question: '  where?  ', lang: 'en', clusters: [{ id: 'c1', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 } }] }),
    { question: 'where?', lang: 'en', clusters: [{ id: 'c1', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.04 } }] },
  );
  assert.deepEqual(boardActionsJson({ clusters: [] }), { question: '', lang: 'en', clusters: [] });
});

test('postBoardActions: multipart to /study/ai/board-actions with the Study bearer; the body is returned as is', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });

    return new Response(JSON.stringify({ actions: [{ type: 'point_at', at: { x: 0.5, y: 0.5 } }], say: 'ok' }), { status: 200 });
  };
  const result = await postBoardActions(access, image, json, new AbortController().signal, fetchImpl);

  assert.deepEqual(result, { actions: [{ type: 'point_at', at: { x: 0.5, y: 0.5 } }], say: 'ok' });
  assert.equal(calls.length, 1);

  const seen = calls[0]!;

  assert.equal(seen.url, 'https://api.example.test/study/ai/board-actions');
  assert.equal(seen.init.method, 'POST');
  assert.equal((seen.init.headers as Record<string, string>).Authorization, 'Bearer t');

  const form = seen.init.body as FormData;

  assert.ok(form instanceof FormData);
  assert.equal(JSON.parse(String(form.get('json'))).question, 'q');
  assert.equal((form.get('image') as File).name, 'page.jpg');
});

test('postBoardActions: a 404 (route not shipped) is the calm NOT_AVAILABLE, not a failure', async () => {
  await assert.rejects(postBoardActions(access, image, json, new AbortController().signal, fetchWith(404, { message: 'Cannot POST' })), (error: unknown) => {
    assert.ok(error instanceof BoardAiHttpError);
    assert.equal(error.code, NOT_AVAILABLE_CODE);
    assert.equal(error.message, PEN_UNAVAILABLE_MESSAGE);

    return true;
  });
});

test('postBoardActions: 429 reads as the quota line, 400 shows the server message', async () => {
  await assert.rejects(postBoardActions(access, image, json, new AbortController().signal, fetchWith(429, { retryAfterSec: 120 })), /limit.*2 min/);
  await assert.rejects(postBoardActions(access, image, json, new AbortController().signal, fetchWith(400, { message: 'clusters must be an array' })), /clusters must be an array/);
});
