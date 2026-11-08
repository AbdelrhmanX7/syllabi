import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { GlyphBankConflictError, GlyphBankUnavailableError } from '@repo/whiteboard-react';

import { getHandwritingBank, GlyphBankTooLargeError, putHandwritingBank } from './api';

import { StudyApiError } from '@/lib/api/errors';
import { setStudyTransport } from '@/lib/api/http';

interface Call {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

let calls: Call[] = [];
let answer: (call: Call) => unknown = () => undefined;

beforeEach(() => {
  calls = [];
  setStudyTransport({
    json: async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
      const call = { method, path, body, headers };

      calls.push(call);

      return answer(call) as T;
    },
    sse: async () => undefined,
  });
});

const bank = { version: 0, updatedAt: 1, glyphs: { k: { key: 'k', samples: [] } } } as never;
const fail = (status: number, code?: string) => () => {
  throw new StudyApiError(status, `HTTP ${status}`, code);
};

test('GET 404 NOT_FOUND → null («no bank yet»); a bare 404 (no route) → unavailable', async () => {
  answer = fail(404, 'NOT_FOUND');
  assert.equal(await getHandwritingBank(), null);
  answer = fail(404);
  await assert.rejects(getHandwritingBank(), GlyphBankUnavailableError);
  await assert.rejects(putHandwritingBank(bank, 0), GlyphBankUnavailableError);
});

test('GET 200 with an unreadable bank keeps the version', async () => {
  answer = () => ({ version: 3, etag: '"3"', bank: [] });
  assert.equal((await getHandwritingBank())?.version, 3);
});

test('GET 200 → the snapshot at the envelope version', async () => {
  answer = () => ({ version: 4, etag: '"4"', bank: { ...(bank as object), version: 1 } });
  const got = await getHandwritingBank();

  assert.equal(got?.version, 4);
  assert.equal(got?.bank.version, 4);
});

test('GET 401/403/405/501 → GlyphBankUnavailableError', async () => {
  for (const status of [401, 403, 405, 501]) {
    answer = fail(status);
    await assert.rejects(getHandwritingBank(), GlyphBankUnavailableError);
  }
});

test('PUT sends {bank} with If-Match only when version > 0, returns {bank:{…, version}, version}', async () => {
  answer = () => ({ version: 1, etag: '"1"' });
  const created = await putHandwritingBank(bank, 0);

  assert.deepEqual(calls[0].body, { bank });
  assert.equal(calls[0].headers, undefined);
  assert.equal(created.version, 1);
  assert.equal(created.bank.version, 1);

  answer = () => ({ version: 4, etag: '"4"' });
  const updated = await putHandwritingBank(bank, 3);

  assert.deepEqual(calls[1].headers, { 'If-Match': '"3"' });
  assert.equal(updated.version, 4);
  assert.equal(updated.bank.version, 4);
});

test('PUT 412 / 428 → GlyphBankConflictError(null); 413 → too large', async () => {
  for (const status of [412, 428]) {
    answer = fail(status);
    await assert.rejects(putHandwritingBank(bank, 2), (error: unknown) => {
      assert.ok(error instanceof GlyphBankConflictError);
      assert.equal(error.current, null);

      return true;
    });
  }
  answer = fail(413);
  await assert.rejects(putHandwritingBank(bank, 2), GlyphBankTooLargeError);
});
