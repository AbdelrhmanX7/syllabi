import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  estimateReleaseVelocity,
  FLING_RELEASE_DEFAULTS,
  FLING_TAU_MS,
  pushPanSample,
  stepFling,
  type PanSample,
} from './flingPhysics';

const steady = (speedX: number, speedY: number, from = 0, to = 200, step = 16): PanSample[] => {
  const samples: PanSample[] = [];

  for (let t = from; t <= to; t += step) {
    samples.push({ x: 100 + speedX * t, y: 50 + speedY * t, t });
  }

  return samples;
};

// --- release velocity ----------------------------------------------------------------------------

test('a steady drag that lifts without pausing flings at its speed', () => {
  const v = estimateReleaseVelocity(steady(1.5, -0.5), 205);

  assert.ok(v);
  assert.ok(Math.abs(v.vx - 1.5) < 1e-9);
  assert.ok(Math.abs(v.vy + 0.5) < 1e-9);
});

test('only the last window of samples counts — an earlier fast phase does not inflate the release', () => {
  // Fast for 100ms, then slow for 100ms, then lift.
  const samples = steady(3, 0, 0, 96).concat(
    steady(0.2, 0, 112, 208).map((s) => ({ ...s, x: 100 + 3 * 96 + 0.2 * (s.t - 96) })),
  );
  const v = estimateReleaseVelocity(samples, 210);

  assert.ok(v);
  assert.ok(v.vx < 0.4, `the fast phase leaked into the release velocity: ${v.vx}`);
});

test('a finger that paused before lifting does not fling', () => {
  const samples = steady(2, 0);
  const lastT = samples[samples.length - 1].t;

  assert.equal(estimateReleaseVelocity(samples, lastT + FLING_RELEASE_DEFAULTS.pauseMs + 1), null);
  assert.ok(estimateReleaseVelocity(samples, lastT + FLING_RELEASE_DEFAULTS.pauseMs), 'at the pause limit it still flings');
});

test('a crawl under the minimum speed is a stop, not a fling', () => {
  assert.equal(estimateReleaseVelocity(steady(0.01, 0), 205), null);
});

test('the fling speed is capped but keeps its direction', () => {
  const v = estimateReleaseVelocity(steady(30, 40), 205);

  assert.ok(v);
  assert.ok(Math.abs(Math.hypot(v.vx, v.vy) - FLING_RELEASE_DEFAULTS.maxSpeed) < 1e-9);
  assert.ok(Math.abs(v.vx / v.vy - 30 / 40) < 1e-9, 'the direction changed');
});

test('too few samples, or samples inside a single frame, measure nothing', () => {
  assert.equal(estimateReleaseVelocity([], 10), null);
  assert.equal(estimateReleaseVelocity([{ x: 0, y: 0, t: 0 }], 10), null);
  assert.equal(
    estimateReleaseVelocity(
      [
        { x: 0, y: 0, t: 100 },
        { x: 40, y: 0, t: 104 },
      ],
      105,
    ),
    null,
  );
});

test('pushPanSample keeps the window plus the one sample before it', () => {
  let samples: PanSample[] = [];

  for (let t = 0; t <= 400; t += 16) {
    samples = pushPanSample(samples, { x: t, y: 0, t }, 100);
  }

  assert.ok(samples.length >= 7 && samples.length <= 9, `window kept ${samples.length} samples`);
  assert.equal(samples[samples.length - 1].t, 400);
  assert.ok(samples[0].t <= 300, 'the far end of the slope was dropped');
  assert.ok(samples[1].t > 300 - 16, 'more than one sample before the window was kept');
});

// --- decay --------------------------------------------------------------------------------------

test('the velocity decays exponentially and the step is the exact integral over the frame', () => {
  const step = stepFling({ vx: 2, vy: 0 }, FLING_TAU_MS, FLING_TAU_MS, 0.02);

  assert.ok(Math.abs(step.velocity.vx - 2 / Math.E) < 1e-9);
  assert.ok(Math.abs(step.dx - 2 * FLING_TAU_MS * (1 - 1 / Math.E)) < 1e-9);
  assert.equal(step.done, false);
});

test('two half-frames travel exactly as far as one whole frame (frame-rate independent)', () => {
  const whole = stepFling({ vx: 1, vy: -1 }, 32, FLING_TAU_MS, 0.02);
  const half1 = stepFling({ vx: 1, vy: -1 }, 16, FLING_TAU_MS, 0.02);
  const half2 = stepFling(half1.velocity, 16, FLING_TAU_MS, 0.02);

  assert.ok(Math.abs(half1.dx + half2.dx - whole.dx) < 1e-9);
  assert.ok(Math.abs(half1.dy + half2.dy - whole.dy) < 1e-9);
  assert.ok(Math.abs(half2.velocity.vx - whole.velocity.vx) < 1e-12);
});

test('the fling reports done once it falls under the minimum speed, and never moves backwards', () => {
  let velocity = { vx: 3, vy: 0 };
  let total = 0;
  let frames = 0;

  for (;;) {
    const step = stepFling(velocity, 16, FLING_TAU_MS, 0.02);

    assert.ok(step.dx >= 0, 'the fling reversed');
    total += step.dx;
    velocity = step.velocity;
    frames += 1;

    if (step.done) break;
    assert.ok(frames < 10_000, 'the fling never ends');
  }

  // Total travel of v0·τ, minus the tail under minSpeed.
  assert.ok(Math.abs(total - 3 * FLING_TAU_MS) < 0.02 * FLING_TAU_MS + 1);
  assert.ok(frames > 60 && frames < 200, `${frames} frames at 60Hz`);
});

test('a zero dt moves nothing and keeps the velocity', () => {
  const step = stepFling({ vx: 1, vy: 2 }, 0, FLING_TAU_MS, 0.02);

  assert.deepEqual(step, { dx: 0, dy: 0, velocity: { vx: 1, vy: 2 }, done: false });
});
