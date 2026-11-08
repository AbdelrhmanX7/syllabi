import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_SAVE_INTERVAL_MS,
  AUTO_SAVE_MAX_DEFERRAL_MS,
  AUTO_SAVE_STROKE_GAP_MS,
  AUTO_SAVE_WORST_CASE_UNSAVED_MS,
  startAutoSaveScheduler,
  type AutoSaveTimerHandle,
} from './autoSaveScheduler';

/**
 * The autosave's IndexedDB write is the dominant stall in a production profile (50-93ms per burst,
 * 6x throttle) and the old fixed interval landed it ON the stroke. These tests pin the two halves of
 * the fix that can silently invert into data loss: a save must NOT be issued mid-stroke, and it MUST
 * still be issued — promptly when the pen lifts, and unconditionally once the ceiling is reached.
 *
 * Driven by a fake clock + fake timers rather than real ones, so "did a write land while the pen was
 * down?" is a deterministic question about ordering instead of a flaky one about wall time.
 */
interface FakeScheduler {
  /** Advance the clock, firing every timer whose deadline is reached, in deadline order. */
  advance: (ms: number) => Promise<void>;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => AutoSaveTimerHandle;
  clearTimer: (handle: AutoSaveTimerHandle) => void;
}

function createFakeScheduler(): FakeScheduler {
  let clock = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    now: () => clock,
    setTimer: (callback, delayMs) => {
      const id = nextId++;

      timers.set(id, { at: clock + delayMs, callback });

      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    advance: async (ms) => {
      const target = clock + ms;

      for (;;) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;

        timers.forEach((timer, id) => {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        });

        if (dueId === null) {
          break;
        }

        const timer = timers.get(dueId);

        timers.delete(dueId);
        clock = dueAt;
        timer?.callback();
        // Let the persist() promise chain settle before the next timer fires — a real write resolves
        // on a microtask too, and without this the "no overlapping writes" invariant is untested.
        await Promise.resolve();
        await Promise.resolve();
      }

      clock = target;
    },
  };
}

interface Harness {
  fake: FakeScheduler;
  /** Wall-clock of every persist() call, in order. */
  saves: number[];
  /** Simulate the pen being on the glass: `millisecondsSinceLastInput` reports 0 until released. */
  setDrawing: (drawing: boolean) => void;
  /** Mark the page dirty / clean, the way the editor's needsPersistRef does. */
  setDirty: (dirty: boolean) => void;
  stop: () => void;
}

function startHarness(overrides: { writeDurationMs?: number } = {}): Harness {
  const fake = createFakeScheduler();
  const saves: number[] = [];
  const writeDurationMs = overrides.writeDurationMs ?? 0;

  let dirty = true;
  let lastInputAt: number | null = null;
  let drawing = false;
  let lastDurableSaveAt = 0;
  let inFlight = 0;

  const scheduler = startAutoSaveScheduler({
    needsPersist: () => dirty,
    millisecondsSinceLastInput: () => {
      if (drawing) {
        return 0;
      }

      return lastInputAt === null ? Number.POSITIVE_INFINITY : fake.now() - lastInputAt;
    },
    lastDurableSaveAt: () => lastDurableSaveAt,
    persist: async () => {
      assert.equal(inFlight, 0, 'two durable writes must never overlap');
      inFlight += 1;
      saves.push(fake.now());

      if (writeDurationMs > 0) {
        await new Promise<void>((resolve) => {
          fake.setTimer(resolve, writeDurationMs);
        });
      }

      inFlight -= 1;
      dirty = false;
      lastDurableSaveAt = fake.now();
    },
    now: fake.now,
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
  });

  return {
    fake,
    saves,
    setDirty: (next) => {
      dirty = next;
    },
    setDrawing: (next) => {
      drawing = next;

      if (!next) {
        lastInputAt = fake.now();
      }
    },
    stop: () => scheduler.stop(),
  };
}

test('an idle board still saves on the plain 2s cadence', async () => {
  const harness = startHarness();

  await harness.fake.advance(AUTO_SAVE_INTERVAL_MS + 1);

  assert.equal(harness.saves.length, 1, 'a dirty page with no input must save on the first tick');

  harness.stop();
});

test('no save is issued while a stroke is in flight', async () => {
  const harness = startHarness();

  harness.setDrawing(true);
  // Well past the cadence, but still inside the deferral ceiling.
  await harness.fake.advance(AUTO_SAVE_INTERVAL_MS + AUTO_SAVE_MAX_DEFERRAL_MS - 1);

  assert.deepEqual(harness.saves, [], 'the 50-93ms IndexedDB write must not land on a live stroke');

  harness.stop();
});

test('the save lands promptly once the stroke ends', async () => {
  const harness = startHarness();

  harness.setDrawing(true);
  await harness.fake.advance(AUTO_SAVE_INTERVAL_MS + 500);
  assert.deepEqual(harness.saves, [], 'still drawing');

  const liftedAt = harness.fake.now();

  harness.setDrawing(false);
  await harness.fake.advance(AUTO_SAVE_STROKE_GAP_MS * 2);

  assert.equal(harness.saves.length, 1, 'a stroke that ends must be saved, not dropped');
  assert.ok(
    harness.saves[0]! - liftedAt <= AUTO_SAVE_STROKE_GAP_MS * 2,
    `the write must follow the pen-up within a probe or two (was ${harness.saves[0]! - liftedAt}ms)`,
  );

  harness.stop();
});

test('an unbroken stroke still gets saved at the ceiling — deferral is bounded, not open-ended', async () => {
  const harness = startHarness();

  harness.setDrawing(true);
  await harness.fake.advance(AUTO_SAVE_WORST_CASE_UNSAVED_MS + AUTO_SAVE_STROKE_GAP_MS + 1);

  assert.equal(harness.saves.length, 1, 'a teacher who never lifts the pen must still be saved');

  harness.stop();
});

test('the unsaved-work bound holds across an abrupt close at any instant of a continuous stroke', async () => {
  const harness = startHarness({ writeDurationMs: 90 });
  const start = harness.fake.now();

  // 30 seconds of unbroken drawing: the pathological case the ceiling exists for. Step in 10ms
  // slices and, at every slice, assert what an abrupt quit right there would have cost.
  harness.setDrawing(true);

  let worstUnsavedMs = 0;

  for (let elapsed = 0; elapsed < 30_000; elapsed += 10) {
    harness.setDirty(true);
    await harness.fake.advance(10);

    const lastSaveAt = harness.saves.length > 0 ? harness.saves[harness.saves.length - 1]! : start;

    worstUnsavedMs = Math.max(worstUnsavedMs, harness.fake.now() - lastSaveAt);
  }

  // 30s / (4000ms ceiling + one 140ms probe + the 90ms write) ≈ 7 forced saves. Assert the floor,
  // not the exact count, so the test pins "the ceiling keeps firing" rather than the arithmetic.
  assert.ok(harness.saves.length >= 6, `the ceiling must keep firing (only ${harness.saves.length} saves in 30s)`);
  assert.ok(
    // + one probe (the ceiling is checked on a probe, not continuously) + the write's own duration:
    // work is only durable once the put commits.
    worstUnsavedMs <= AUTO_SAVE_WORST_CASE_UNSAVED_MS + AUTO_SAVE_STROKE_GAP_MS + 90,
    `an abrupt quit must never cost more than the documented bound (worst was ${worstUnsavedMs}ms)`,
  );

  harness.stop();
});

test('a clean page costs nothing — no write is issued when nothing changed', async () => {
  const harness = startHarness();

  harness.setDirty(false);
  await harness.fake.advance(AUTO_SAVE_INTERVAL_MS * 5);

  assert.deepEqual(harness.saves, [], 'an untouched board must not write every 2s');

  harness.stop();
});

test('a failed write re-arms instead of ending autosave for the session', async () => {
  const fake = createFakeScheduler();
  const attempts: number[] = [];

  const scheduler = startAutoSaveScheduler({
    needsPersist: () => true,
    millisecondsSinceLastInput: () => Number.POSITIVE_INFINITY,
    lastDurableSaveAt: () => 0,
    persist: () => {
      attempts.push(fake.now());

      return Promise.reject(new Error('quota exceeded'));
    },
    now: fake.now,
    setTimer: fake.setTimer,
    clearTimer: fake.clearTimer,
  });

  await fake.advance(AUTO_SAVE_INTERVAL_MS * 3 + 1);

  assert.ok(attempts.length >= 3, `a rejected write must be retried (only ${attempts.length} attempts)`);

  scheduler.stop();
});

test('stop() ends the schedule', async () => {
  const harness = startHarness();

  harness.stop();
  await harness.fake.advance(AUTO_SAVE_INTERVAL_MS * 5);

  assert.deepEqual(harness.saves, [], 'a stopped scheduler must not keep writing after unmount');
});
