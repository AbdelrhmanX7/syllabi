import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scheduleQuietIdleWork, type QuietIdleTimers } from './idleWork';

/**
 * A deterministic clock + timer fake. `advance(ms)` runs every timer whose deadline has passed, in
 * order, so a test can walk the scheduler through "the pen is still down" → "quiet" → "ran".
 */
function createFakeTimers() {
  let now = 1_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();

  const timers: QuietIdleTimers = {
    now: () => now,
    requestIdle: (fn) => {
      const id = nextId++;

      // rIC fires "soon" — model it as a 1 ms timer so ordering stays observable.
      pending.set(id, { at: now + 1, fn });

      return id;
    },
    cancelIdle: (id) => {
      pending.delete(id);
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;

      pending.set(id, { at: now + ms, fn });

      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id);
    },
  };

  const advance = (ms: number): void => {
    const target = now + ms;

    for (;;) {
      const due = Array.from(pending.entries())
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at);

      if (due.length === 0) {
        break;
      }

      const [id, entry] = due[0];

      pending.delete(id);
      now = Math.max(now, entry.at);
      entry.fn();
    }

    now = target;
  };

  return { advance, pendingCount: () => pending.size, timers };
}

test('runs in the idle slot when nothing is busy and input has been quiet', () => {
  const fake = createFakeTimers();
  let runs = 0;

  scheduleQuietIdleWork(() => runs++, {
    isBusy: () => false,
    msSinceInput: () => 5_000,
    timers: fake.timers,
  });

  fake.advance(2);
  assert.equal(runs, 1);
  assert.equal(fake.pendingCount(), 0);
});

test('defers while a contact is down and runs once it lifts and the quiet window passes', () => {
  const fake = createFakeTimers();
  let runs = 0;
  let pointerDown = true;
  let quietFor = 0;

  scheduleQuietIdleWork(() => runs++, {
    isBusy: () => pointerDown,
    msSinceInput: () => quietFor,
    quietMs: 700,
    timers: fake.timers,
  });

  fake.advance(2);
  assert.equal(runs, 0, 'must not run under the pen');

  fake.advance(1_500);
  assert.equal(runs, 0, 'still down → still deferred');

  pointerDown = false;
  quietFor = 100;
  fake.advance(700);
  assert.equal(runs, 0, 'lifted but not quiet for 700 ms yet');

  quietFor = 800;
  fake.advance(700);
  assert.equal(runs, 1);
});

test('after maxDeferMs it runs anyway, but never while a contact is down', () => {
  const fake = createFakeTimers();
  let runs = 0;
  let pointerDown = false;

  scheduleQuietIdleWork(() => runs++, {
    isBusy: () => pointerDown,
    maxDeferMs: 3_000,
    // Input keeps arriving every few ms (a fast writer) so the quiet window never opens.
    msSinceInput: () => 10,
    quietMs: 700,
    timers: fake.timers,
  });

  fake.advance(2_900);
  assert.equal(runs, 0);

  pointerDown = true;
  fake.advance(1_500);
  assert.equal(runs, 0, 'past the ceiling but the pen is down → still deferred');

  pointerDown = false;
  fake.advance(700);
  assert.equal(runs, 1, 'ceiling passed and the pen lifted → runs without waiting for quiet');
});

test('repeated schedule calls coalesce into one pending run and the latest callback wins', () => {
  const fake = createFakeTimers();
  const ran: string[] = [];
  const handle = scheduleQuietIdleWork(() => ran.push('first'), {
    isBusy: () => false,
    msSinceInput: () => 5_000,
    timers: fake.timers,
  });

  handle.reschedule(() => ran.push('second'));
  handle.reschedule(() => ran.push('third'));

  fake.advance(5);
  assert.deepEqual(ran, ['third']);
  assert.equal(fake.pendingCount(), 0);
});

test('cancel stops a deferred run for good', () => {
  const fake = createFakeTimers();
  let runs = 0;
  const handle = scheduleQuietIdleWork(() => runs++, {
    isBusy: () => true,
    msSinceInput: () => 0,
    timers: fake.timers,
  });

  fake.advance(2);
  handle.cancel();
  fake.advance(60_000);
  assert.equal(runs, 0);
  assert.equal(fake.pendingCount(), 0);
});

test('falls back to setTimeout when requestIdle is unavailable', () => {
  const fake = createFakeTimers();
  let runs = 0;

  scheduleQuietIdleWork(() => runs++, {
    fallbackDelayMs: 700,
    isBusy: () => false,
    msSinceInput: () => 5_000,
    timers: { ...fake.timers, requestIdle: undefined },
  });

  fake.advance(699);
  assert.equal(runs, 0);
  fake.advance(1);
  assert.equal(runs, 1);
});
