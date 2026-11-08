import type { ResolvedIntroAttempt } from './pageIntroPolicy';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveIntroTimeoutMs, shouldPlayResolvedIntro } from './pageIntroPolicy';

const BASE: ResolvedIntroAttempt = {
  currentPageId: 'page-1',
  currentVisit: 3,
  playedThisVisit: false,
  requestedPageId: 'page-1',
  requestedVisit: 3,
};

test('plays when the resolution still belongs to the page on screen', () => {
  assert.equal(shouldPlayResolvedIntro(BASE), true);
});

test('drops a resolution that landed after the teacher moved to another page', () => {
  assert.equal(shouldPlayResolvedIntro({ ...BASE, currentPageId: 'page-2' }), false);
});

test('drops a resolution from an earlier visit of the SAME page', () => {
  // Navigated away and back while the clip was being resolved: the old request must not play over
  // the new visit, which mints its own request.
  assert.equal(shouldPlayResolvedIntro({ ...BASE, requestedVisit: 2 }), false);
});

test('plays only once per visit', () => {
  assert.equal(shouldPlayResolvedIntro({ ...BASE, playedThisVisit: true }), false);
});

test('a re-entry of the same page is a new visit and may play again', () => {
  assert.equal(shouldPlayResolvedIntro({ ...BASE, currentVisit: 4, playedThisVisit: false, requestedVisit: 4 }), true);
});

test('drops everything while no page is open', () => {
  assert.equal(shouldPlayResolvedIntro({ ...BASE, currentPageId: null }), false);
});

test('the playback timeout allows for slack over the declared duration', () => {
  assert.equal(resolveIntroTimeoutMs(2_000), 3_500);
});

test('an UNKNOWN duration waits for the ceiling, never the slack alone', () => {
  // 0 is what the native probe reports when ffmpeg's banner did not parse. Treating it as a length
  // would cut a 4s morph off after 1.5s.
  assert.equal(resolveIntroTimeoutMs(0), 30_000);
  assert.equal(resolveIntroTimeoutMs(Number.NaN), 30_000);
  assert.equal(resolveIntroTimeoutMs(-10), 30_000);
  assert.equal(resolveIntroTimeoutMs(Number.POSITIVE_INFINITY), 30_000);
});

test('a known duration is never cut short by the timeout', () => {
  const clipMs = 4_000;

  assert.ok(resolveIntroTimeoutMs(clipMs) > clipMs);
});

test('an absurd duration is still bounded by the ceiling', () => {
  assert.equal(resolveIntroTimeoutMs(10 * 60_000), 30_000);
});
