import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STROKE_IN_PROGRESS_MAX_MS,
  getScaledRasterTarget,
  isStrokeInProgress,
  resolveBackgroundRedrawQuality,
  shouldSkipDuplicateLowPass,
} from './backgroundRedrawPolicy';

/**
 * The PDF background is a separate canvas holding a ~7 MP decoded page. Every viewport commit used to
 * repaint it three times (a synchronous 'low' pass in the commit, a duplicate rAF 'low' pass from
 * after:render, and the 160 ms 'high' settle pass) — and on an IR touch panel stray palm contacts
 * commit viewports WHILE the teacher writes. These helpers decide when a pass may be skipped or must
 * wait for pen-up, and when a pre-scaled bitmap can stand in for the full-resolution raster.
 */

test('a stroke is in progress only while the pen is down in drawing mode', () => {
  assert.equal(isStrokeInProgress(1_000, true, 1_500), true);
  assert.equal(isStrokeInProgress(null, true, 1_500), false, 'no pen-down recorded');
  assert.equal(isStrokeInProgress(1_000, false, 1_500), false, 'the hook flipped drawing off (pan override)');
});

test('a pen-down that never saw its pen-up stops counting as a stroke after the cap', () => {
  assert.equal(isStrokeInProgress(1_000, true, 1_000 + STROKE_IN_PROGRESS_MAX_MS - 1), true);
  assert.equal(isStrokeInProgress(1_000, true, 1_000 + STROKE_IN_PROGRESS_MAX_MS), false);
});

test('the crisp pass waits for pen-up; the cheap pass keeps the page glued to the ink', () => {
  assert.equal(resolveBackgroundRedrawQuality('high', true), 'defer');
  assert.equal(resolveBackgroundRedrawQuality('low', true), 'low');
  assert.equal(resolveBackgroundRedrawQuality('high', false), 'high');
  assert.equal(resolveBackgroundRedrawQuality('low', false), 'low');
});

test('the rAF low pass is skipped only when the commit already painted this exact viewport', () => {
  assert.equal(shouldSkipDuplicateLowPass('1,0,0,1,10,20', '1,0,0,1,10,20'), true);
  assert.equal(shouldSkipDuplicateLowPass('1,0,0,1,10,21', '1,0,0,1,10,20'), false);
  assert.equal(shouldSkipDuplicateLowPass('1,0,0,1,10,20', null), false);
});

test('a pre-scaled raster is only worth it when it is smaller than the source', () => {
  // A4 page fitted to a 1920 px wide frame at zoom 1, DPR 1: 1920 x 2715 device px from a 2263 x 3200 raster.
  assert.deepEqual(getScaledRasterTarget(1920, 2715.2, 1, 1, 2263, 3200), { height: 2715, width: 1920 });
  // Zoomed in past the raster's own size: drawing the source directly is already the cheap path.
  assert.equal(getScaledRasterTarget(1920, 2715.2, 1.5, 1, 2263, 3200), null);
  // Degenerate frame.
  assert.equal(getScaledRasterTarget(0, 0, 1, 1, 2263, 3200), null);
  // Above the bitmap ceiling (side or area) — never allocate a bitmap larger than the source can justify.
  assert.equal(getScaledRasterTarget(9000, 12000, 1, 1, 20000, 30000), null);
});
