import test from 'node:test';
import assert from 'node:assert/strict';

import { createYieldFn, resolveYieldSchedulerEnvironment, type YieldSchedulerEnvironment } from './pdfYieldScheduler';

test('resolveYieldSchedulerEnvironment prefers scheduler.yield when present', () => {
  const scope = {
    MessageChannel: function MessageChannel() {},
    scheduler: { yield: async () => {} },
    setTimeout: (callback: () => void) => {
      callback();

      return 0;
    },
  };

  const env = resolveYieldSchedulerEnvironment(scope);

  assert.equal(typeof env.schedulerYield, 'function');
  assert.equal(env.hasMessageChannel, true);
});

test('resolveYieldSchedulerEnvironment reports a missing MessageChannel', () => {
  const scope = {
    setTimeout: (callback: () => void) => {
      callback();

      return 0;
    },
  };

  const env = resolveYieldSchedulerEnvironment(scope);

  assert.equal(env.schedulerYield, undefined);
  assert.equal(env.hasMessageChannel, false);
});

test('resolveYieldSchedulerEnvironment is SSR-safe with an empty scope', () => {
  const env = resolveYieldSchedulerEnvironment({});

  assert.equal(env.schedulerYield, undefined);
  assert.equal(env.hasMessageChannel, false);
  assert.equal(typeof env.setTimeoutFn, 'function');
});

test('createYieldFn uses scheduler.yield with a user-visible priority', async () => {
  const calls: Array<{ priority?: string } | undefined> = [];
  const env: YieldSchedulerEnvironment = {
    hasMessageChannel: true,
    schedulerYield: async (options) => {
      calls.push(options);
    },
    setTimeoutFn: (callback) => {
      callback();

      return 0;
    },
  };

  const yieldFn = createYieldFn(env);

  await yieldFn();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { priority: 'user-visible' });
});

test('createYieldFn falls back to setTimeout when no scheduler or MessageChannel', async () => {
  let timeoutCalls = 0;
  const env: YieldSchedulerEnvironment = {
    hasMessageChannel: false,
    schedulerYield: undefined,
    setTimeoutFn: (callback, delayMs) => {
      timeoutCalls += 1;
      assert.equal(delayMs, 0);
      callback();

      return 0;
    },
  };

  const yieldFn = createYieldFn(env);

  await yieldFn();

  assert.equal(timeoutCalls, 1);
});

test('createYieldFn resolves a promise that callers can await sequentially', async () => {
  const order: string[] = [];
  const env: YieldSchedulerEnvironment = {
    hasMessageChannel: false,
    schedulerYield: undefined,
    setTimeoutFn: (callback) => {
      callback();

      return 0;
    },
  };

  const yieldFn = createYieldFn(env);

  for (let index = 0; index < 3; index += 1) {
    order.push(`before:${index}`);
    await yieldFn();
    order.push(`after:${index}`);
  }

  assert.deepEqual(order, ['before:0', 'after:0', 'before:1', 'after:1', 'before:2', 'after:2']);
});
