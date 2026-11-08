import type { TodayAPlanEntry } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { visibleTodayPlans } from './today';

const row = (classId: string, status: TodayAPlanEntry['status'], topAction: string | null, alerts: string[] = []) => ({
  classId,
  status,
  topAction,
  alerts,
});

test('building / none / empty rows are hidden; alerts first, then most at risk', () => {
  const visible = visibleTodayPlans([
    row('building', 'building', null),
    row('none', 'none', null),
    row('quiet', 'on_track', null),
    row('ok', 'on_track', 'Read ch. 4'),
    row('risk', 'at_risk', 'Finish Quiz 5'),
    row('alert', 'on_track', null, ['Class tomorrow 9:00 — 2 credits to spare']),
    row('missed', 'missed', 'Talk to the instructor'),
  ]);

  assert.deepEqual(
    visible.map((entry) => entry.classId),
    ['alert', 'missed', 'risk', 'ok'],
  );
});

test('a built plan reported as building but WITH an action still shows', () => {
  assert.equal(visibleTodayPlans([row('c', 'building', 'Do the lab')]).length, 1);
  assert.deepEqual(visibleTodayPlans(undefined), []);
});
