import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withStreamRetry } from './streamRetry';

import { StudyApiError } from '@/lib/api/errors';

const instant = async () => {};

test('withStreamRetry: a stream cut by the network is rerun once, after the delay', async () => {
  let runs = 0;
  const waits: number[] = [];
  const retried: unknown[] = [];

  await withStreamRetry(
    async () => {
      runs++;
      if (runs === 1) throw new TypeError('network error');
    },
    { delayMs: 2000, onRetry: (error) => retried.push(error), sleep: async (ms) => void waits.push(ms) },
  );
  assert.equal(runs, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(retried.length, 1);
});

test('withStreamRetry: only once — a second cut is thrown', async () => {
  let runs = 0;

  await assert.rejects(
    withStreamRetry(
      async () => {
        runs++;
        throw new TypeError('Failed to fetch');
      },
      { sleep: instant },
    ),
    /Failed to fetch/,
  );
  assert.equal(runs, 2);
});

test('withStreamRetry: server errors, aborts and finished streams are not retried', async () => {
  for (const [error, options] of [
    [new StudyApiError(500, 'AI failed', 'AI_FAILED'), {}],
    [new TypeError('network error'), { finished: () => true }],
    [new TypeError('network error'), { signal: AbortSignal.abort() }],
  ] as const) {
    let runs = 0;

    await assert.rejects(
      withStreamRetry(
        async () => {
          runs++;
          throw error;
        },
        { ...options, sleep: instant },
      ),
    );
    assert.equal(runs, 1);
  }
});

test('withStreamRetry: a SERVER_RESTARTING frame is rerun once', async () => {
  let runs = 0;

  await withStreamRetry(
    async () => {
      runs++;
      if (runs === 1) throw new StudyApiError(200, 'The server is restarting. Please retry.', 'SERVER_RESTARTING');
    },
    { sleep: instant },
  );
  assert.equal(runs, 2);
});
