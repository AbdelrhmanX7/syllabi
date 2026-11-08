import type { APlanResponse, APlanWire } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aPlanPoll, basePhase, BUILD_POLL_MS, isBuilding, POLL_CAP_MS, UPDATE_POLL_MS } from './poll';

const plan = (extra: Partial<APlanWire> = {}) =>
  ({ classId: 'c1', status: 'on_track', generatedAt: '2026-10-05T10:00:00.000Z', stale: false, ...extra }) as APlanWire;
const building: APlanResponse = { status: 'building', lastError: null };
const T0 = 1_000_000;

test('basePhase: loading, building, refreshing, stale, ready', () => {
  assert.equal(basePhase(undefined, null), 'loading');
  assert.equal(basePhase(building, null), 'building');
  assert.equal(basePhase(building, '2026-10-05T10:00:00.000Z'), 'building');
  assert.equal(basePhase(plan(), '2026-10-05T10:00:00.000Z'), 'refreshing');
  assert.equal(basePhase(plan({ generatedAt: '2026-10-05T10:05:00.000Z' }), '2026-10-05T10:00:00.000Z'), 'ready');
  assert.equal(basePhase(plan({ stale: true }), null), 'stale');
  assert.equal(basePhase(plan(), null), 'ready');
});

test('isBuilding tells the 202 body from a plan (whose status is a requirement status)', () => {
  assert.equal(isBuilding(building), true);
  assert.equal(isBuilding(plan({ status: 'at_risk' })), false);
  assert.equal(isBuilding(undefined), false);
});

test('building polls every 5 s, then times out at the cap', () => {
  assert.deepEqual(aPlanPoll({ data: building, refreshFrom: null, since: T0, now: T0 + 1_000 }), {
    phase: 'building',
    intervalMs: BUILD_POLL_MS,
  });
  assert.deepEqual(aPlanPoll({ data: building, refreshFrom: null, since: T0, now: T0 + POLL_CAP_MS }), {
    phase: 'timed_out',
    intervalMs: false,
  });
});

test('stale and refreshing poll slower and settle to ready at the cap (the old plan stays readable)', () => {
  assert.deepEqual(aPlanPoll({ data: plan({ stale: true }), refreshFrom: null, since: T0, now: T0 }), {
    phase: 'stale',
    intervalMs: UPDATE_POLL_MS,
  });
  assert.deepEqual(
    aPlanPoll({ data: plan(), refreshFrom: '2026-10-05T10:00:00.000Z', since: T0, now: T0 + POLL_CAP_MS + 1 }),
    { phase: 'ready', intervalMs: false },
  );
});

test('ready and loading never poll', () => {
  assert.equal(aPlanPoll({ data: plan(), refreshFrom: null, since: T0, now: T0 }).intervalMs, false);
  assert.equal(aPlanPoll({ data: undefined, refreshFrom: null, since: T0, now: T0 }).intervalMs, false);
});
