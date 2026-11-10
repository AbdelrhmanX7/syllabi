import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createLeaveGate, leaveBoard } from './leave-board';

const never = () => new Promise<never>(() => undefined);

describe('leaveBoard', () => {
  test('navigates before the upload finishes', async () => {
    const order: string[] = [];
    let finishUpload: () => void = () => undefined;
    const result = await leaveBoard({
      gate: createLeaveGate(),
      navigate: () => order.push('navigate'),
      afterLeave: () =>
        new Promise<void>((resolve) => {
          order.push('upload started');
          finishUpload = () => {
            order.push('upload done');
            resolve();
          };
        }),
    });

    assert.equal(result, 'left');
    assert.deepEqual(order, ['navigate', 'upload started']);
    finishUpload();
    assert.deepEqual(order, ['navigate', 'upload started', 'upload done']);
  });

  test('repeat taps while leaving do nothing', async () => {
    const gate = createLeaveGate();
    let navigations = 0;
    const steps = { gate, navigate: () => (navigations += 1), setTimer: () => undefined };
    const results = await Promise.all([leaveBoard(steps), leaveBoard(steps), leaveBoard(steps)]);

    assert.deepEqual(results, ['left', 'busy', 'busy']);
    assert.equal(navigations, 1);
  });

  test('a board that closed while waiting never navigates', async () => {
    const gate = createLeaveGate();
    let release: () => void = () => undefined;
    let navigations = 0;
    const leaving = leaveBoard({
      gate,
      mustFinish: () => new Promise<void>((resolve) => (release = resolve)),
      navigate: () => (navigations += 1),
    });

    // The owner pressed the tablet's back key meanwhile and opened another notebook.
    gate.dispose();
    release();
    assert.equal(await leaving, 'stale');
    assert.equal(navigations, 0);
    assert.equal(await leaveBoard({ gate, navigate: () => (navigations += 1) }), 'busy');
    assert.equal(navigations, 0);
  });

  test('a stuck live send is capped', async () => {
    let navigations = 0;
    const started = Date.now();
    const result = await leaveBoard({ gate: createLeaveGate(), mustFinish: never, waitCapMs: 30, navigate: () => (navigations += 1) });

    assert.equal(result, 'left');
    assert.equal(navigations, 1);
    assert.ok(Date.now() - started < 1000);
  });

  test('a failing upload or live send does not stop the leave', async () => {
    let navigations = 0;
    const result = await leaveBoard({
      gate: createLeaveGate(),
      mustFinish: () => Promise.reject(new Error('offline')),
      navigate: () => (navigations += 1),
      afterLeave: () => Promise.reject(new Error('offline')),
      setTimer: () => undefined,
    });

    assert.equal(result, 'left');
    assert.equal(navigations, 1);
  });

  test('taps work again if the screen did not change', async () => {
    const gate = createLeaveGate();
    const timers: (() => void)[] = [];
    let navigations = 0;
    const steps = { gate, navigate: () => (navigations += 1), setTimer: (fn: () => void) => timers.push(fn) };

    await leaveBoard(steps);
    assert.equal(await leaveBoard(steps), 'busy');
    timers.forEach((fn) => fn());
    assert.equal(await leaveBoard(steps), 'left');
    assert.equal(navigations, 2);
  });
});
