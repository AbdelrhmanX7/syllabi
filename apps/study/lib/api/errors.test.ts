import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_QUOTA_MESSAGE,
  describeError,
  EMAIL_NOT_VERIFIED_MESSAGE,
  isEmailNotVerified,
  isAiQuotaError,
  isNetworkError,
  isRetryableStreamError,
  isServerRestarting,
  NETWORK_MESSAGE,
  retryUnlessAiQuota,
  SERVER_RESTARTING_MESSAGE,
  StudyApiError,
} from './errors';
import { readSse } from './http';

test('AI_QUOTA: the error itself carries the English line, whatever the server wrote', () => {
  const error = new StudyApiError(503, 'Insufficient Balance', 'AI_QUOTA');

  assert.equal(error.message, AI_QUOTA_MESSAGE);
  assert.equal(error.code, 'AI_QUOTA');
  assert.equal(new StudyApiError(402, 'Payment Required').message, AI_QUOTA_MESSAGE);
  assert.equal(new StudyApiError(500, 'boom', 'AI_FAILED').message, 'boom');
});

test('describeError maps AI_QUOTA from any shape; other errors unchanged', () => {
  assert.equal(describeError(new StudyApiError(400, 'x', 'AI_QUOTA')), AI_QUOTA_MESSAGE);
  assert.equal(describeError(Object.assign(new Error('raw provider text'), { code: 'AI_QUOTA' })), AI_QUOTA_MESSAGE);
  assert.equal(describeError({ status: 402 }), AI_QUOTA_MESSAGE);
  assert.equal(describeError(new Error('Class not found')), 'Class not found');
  assert.equal(isAiQuotaError(AI_QUOTA_MESSAGE), true);
  assert.equal(isAiQuotaError(null), false);
});

test('retryUnlessAiQuota: one retry for anything else, none for an empty AI account', () => {
  assert.equal(retryUnlessAiQuota(0, new Error('network')), true);
  assert.equal(retryUnlessAiQuota(1, new Error('network')), false);
  assert.equal(retryUnlessAiQuota(0, new StudyApiError(400, 'x', 'AI_QUOTA')), false);
});

test('an SSE `error {code: AI_QUOTA}` frame rejects with the English line', async () => {
  const body =
    'event: meta\ndata: {"conversationId":"x"}\n\nevent: error\ndata: {"message":"Insufficient Balance","code":"AI_QUOTA"}\n\n';

  await assert.rejects(
    readSse(new Response(body), () => undefined),
    (error: unknown) => {
      return error instanceof StudyApiError && error.code === 'AI_QUOTA' && error.message === AI_QUOTA_MESSAGE;
    },
  );
});

test("isNetworkError / describeError: the browsers' «connection broke» errors read as plain English", () => {
  for (const message of [
    'network error',
    'Failed to fetch',
    'Load failed',
    'NetworkError when attempting to fetch resource.',
    'The network connection was lost.',
  ]) {
    assert.ok(isNetworkError(new TypeError(message)), message);
    assert.equal(describeError(new TypeError(message)), NETWORK_MESSAGE);
  }
  assert.equal(
    describeError(new TypeError('network error'), 'x', 'Lost connection while drawing'),
    'Lost connection while drawing',
  );
  // Server answers and ordinary bugs are not network errors.
  assert.ok(!isNetworkError(new StudyApiError(502, 'network error')));
  assert.ok(!isNetworkError(new TypeError("Cannot read properties of undefined (reading 'x')")));
  assert.ok(!isNetworkError('network error'));
  assert.equal(describeError(new Error('Class not found')), 'Class not found');
});

test('SERVER_RESTARTING (a deploy drain) is retryable and reads as a restart, not an alarm', () => {
  const error = new StudyApiError(200, 'The server is restarting. Please retry.', 'SERVER_RESTARTING');

  assert.equal(isServerRestarting(error), true);
  assert.equal(isRetryableStreamError(error), true);
  assert.equal(isRetryableStreamError(new TypeError('network error')), true);
  assert.equal(isRetryableStreamError(new StudyApiError(400, 'x', 'NO_NOTES')), false);
  assert.equal(describeError(error), SERVER_RESTARTING_MESSAGE);
  assert.equal(SERVER_RESTARTING_MESSAGE, 'Server restarted — try again');
});

test('NO_PROMPT_TERMS maps to the concept-list prompt', () => {
  assert.equal(
    describeError(new StudyApiError(400, 'That concept map has no prompt terms yet', 'NO_PROMPT_TERMS')),
    "Enter this map's concept list first",
  );
});

test('EMAIL_NOT_VERIFIED: describeError points at Settings → Account', () => {
  const error = new StudyApiError(403, 'Email not verified', 'EMAIL_NOT_VERIFIED');

  assert.equal(isEmailNotVerified(error), true);
  assert.equal(describeError(error), EMAIL_NOT_VERIFIED_MESSAGE);
  assert.equal(isEmailNotVerified(new StudyApiError(403, 'Forbidden')), false);
});
