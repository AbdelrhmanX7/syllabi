import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { handwritingMockRoutes, resetHandwritingMock } from './mock';

import { isStudyApiError } from '@/lib/api/errors';

const bank = (version: number) => ({ version, updatedAt: version, glyphs: { k: { key: 'k', samples: [] } } });

beforeEach(() => resetHandwritingMock());

test('not a handwriting path → undefined', () => {
  assert.equal(handwritingMockRoutes.json('GET', '/pages'), undefined);
  assert.equal(handwritingMockRoutes.json('GET', '/handwritings'), undefined);
});

const H = (version: number | string) => ({ 'If-Match': typeof version === 'number' ? `"${version}"` : version });

test('GET before any PUT is a 404 («no bank yet»)', () => {
  assert.throws(
    () => handwritingMockRoutes.json('GET', '/handwriting/bank'),
    (error: unknown) => isStudyApiError(error, 404),
  );
});

test('PUT without If-Match creates v1; If-Match updates; GET returns {version, etag, bank}', () => {
  assert.deepEqual(handwritingMockRoutes.json('PUT', '/handwriting/bank', { bank: bank(1) })!.value, {
    version: 1,
    etag: '"1"',
  });
  const got = handwritingMockRoutes.json('GET', '/handwriting/bank')!.value as { version: number; etag: string };

  assert.equal(got.version, 1);
  assert.equal(got.etag, '"1"');
  assert.deepEqual(handwritingMockRoutes.json('PUT', '/handwriting/bank', { bank: bank(5) }, H(1))!.value, {
    version: 2,
    etag: '"2"',
  });
  // W/ and * are accepted too.
  assert.equal(
    (
      handwritingMockRoutes.json('PUT', '/handwriting/bank', { bank: bank(6) }, H('W/"2"'))!.value as {
        version: number;
      }
    ).version,
    3,
  );
  assert.equal(
    (handwritingMockRoutes.json('PUT', '/handwriting/bank', { bank: bank(7) }, H('*'))!.value as { version: number })
      .version,
    4,
  );
});

test('no If-Match while a bank exists → 428; stale If-Match → 412; If-Match with no bank → 412', () => {
  assert.throws(
    () => handwritingMockRoutes.json('PUT', '/handwriting/bank', { bank: bank(1) }, H(1)),
    (error: unknown) => isStudyApiError(error, 412),
  );
  handwritingMockRoutes.json('PUT', '/handwriting/bank', { bank: bank(1) });
  assert.throws(
    () => handwritingMockRoutes.json('PUT', '/handwriting/bank', { bank: bank(2) }),
    (error: unknown) => isStudyApiError(error, 428),
  );
  assert.throws(
    () => handwritingMockRoutes.json('PUT', '/handwriting/bank', { bank: bank(2) }, H(7)),
    (error: unknown) => isStudyApiError(error, 412),
  );
});

test('PUT without a bank is a 400; an unknown sub-path a 404', () => {
  assert.throws(
    () => handwritingMockRoutes.json('PUT', '/handwriting/bank', {}),
    (error: unknown) => isStudyApiError(error, 400),
  );
  assert.throws(
    () => handwritingMockRoutes.json('GET', '/handwriting/other'),
    (error: unknown) => isStudyApiError(error, 404),
  );
});
