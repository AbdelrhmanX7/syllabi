import assert from 'node:assert/strict';
import { test } from 'node:test';

import { centeredScrollTop, followReducer, initialFollow, mayAutoScroll, PEN_SETTLE_MS } from './follow';
import { createPlaybackClock } from './playbackClock';
import {
  clampMiniPosition,
  clampNotesRatio,
  MIN_NOTES_PX,
  MIN_VIDEO_COLUMN_PX,
  NOTES_RATIO_DEFAULT,
} from './studyLayout';

test('follow: a user scroll pauses until resume or a cue seek', () => {
  const paused = followReducer(initialFollow, { type: 'user-scroll' });

  assert.equal(paused.mode, 'paused');
  assert.equal(mayAutoScroll(paused, 0), false);
  assert.equal(followReducer(paused, { type: 'user-scroll' }), paused);
  assert.equal(followReducer(paused, { type: 'resume' }).mode, 'follow');
  assert.equal(followReducer(paused, { type: 'seek' }).mode, 'follow');
  assert.equal(followReducer(initialFollow, { type: 'resume' }), initialFollow);
});

test('follow: the pen holds it while down and for a moment after it lifts', () => {
  const down = followReducer(initialFollow, { type: 'pen-down' });

  assert.equal(mayAutoScroll(down, 10_000), false);
  const up = followReducer(down, { type: 'pen-up', now: 10_000 });

  assert.equal(up.penDown, false);
  assert.equal(mayAutoScroll(up, 10_000 + PEN_SETTLE_MS - 1), false);
  assert.equal(mayAutoScroll(up, 10_000 + PEN_SETTLE_MS), true);
  // A pen stroke does not undo a manual pause.
  const pausedThenPen = followReducer(
    followReducer(followReducer(initialFollow, { type: 'user-scroll' }), { type: 'pen-down' }),
    {
      type: 'pen-up',
      now: 0,
    },
  );

  assert.equal(mayAutoScroll(pausedThenPen, 1e9), false);
});

test('centeredScrollTop: centres, clamps, and stays put inside the middle band', () => {
  // view 400, rows of 40; row at 1000 → centre at 1020 → top 820.
  assert.equal(centeredScrollTop(1000, 40, 400, 5000, 0), 820);
  // Near the top / bottom: clamped to the scroll range.
  assert.equal(centeredScrollTop(40, 40, 400, 5000, 300), 0);
  assert.equal(centeredScrollTop(4960, 40, 400, 5000, 0), 4600);
  // Row centre at 180 of 400 (inside 120..240): no motion.
  assert.equal(centeredScrollTop(960, 40, 400, 5000, 800), null);
  // Already at the clamped target.
  assert.equal(centeredScrollTop(4960, 40, 400, 5000, 4600), null);
});

test('clampNotesRatio keeps both columns usable', () => {
  assert.equal(clampNotesRatio(0.62, 2000), 0.62);
  assert.equal(clampNotesRatio(0.99, 2000), 1 - MIN_VIDEO_COLUMN_PX / 2000);
  assert.equal(clampNotesRatio(0.05, 2000), MIN_NOTES_PX / 2000);
  assert.equal(clampNotesRatio(NaN, 2000), NOTES_RATIO_DEFAULT);
  // Narrower than both minimums: proportional split.
  assert.equal(clampNotesRatio(0.9, 500), MIN_NOTES_PX / (MIN_NOTES_PX + MIN_VIDEO_COLUMN_PX));
  for (const width of [720, 1280, 1848, 2000]) {
    const ratio = clampNotesRatio(0.95, width);

    assert.ok(width * ratio >= MIN_NOTES_PX - 1e-9 && width * (1 - ratio) >= MIN_VIDEO_COLUMN_PX - 1e-9);
  }
});

test('clampMiniPosition keeps the mini player on screen', () => {
  const size = { width: 320, height: 200 };
  const area = { width: 1000, height: 800 };

  assert.deepEqual(clampMiniPosition(-50, -50, size, area), { x: 12, y: 12 });
  assert.deepEqual(clampMiniPosition(5000, 5000, size, area), { x: 668, y: 588 });
  assert.deepEqual(clampMiniPosition(100, 100, size, area), { x: 100, y: 100 });
});

test('playback clock notifies only on change', () => {
  const clock = createPlaybackClock();
  let calls = 0;
  const off = clock.subscribe(() => calls++);

  clock.set(1);
  clock.set(1);
  clock.set(NaN);
  clock.set(2.5);
  assert.equal(calls, 2);
  assert.equal(clock.get(), 2.5);
  off();
  clock.set(3);
  assert.equal(calls, 2);
});
