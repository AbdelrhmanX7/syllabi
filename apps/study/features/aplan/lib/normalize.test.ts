import type { APlanWire } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aplanMockRoutes } from '../mock';

import { normalizeAPlan, toMeetings, toRecovery, toWeeklySlot } from './normalize';

test('toWeeklySlot: day names → 0..6, missing end = one hour, bad input dropped', () => {
  assert.deepEqual(toWeeklySlot({ day: 'Mon', start: '09:00', end: '10:50', place: 'MS 214' }), {
    day: 1,
    start: '09:00',
    end: '10:50',
    place: 'MS 214',
  });
  assert.deepEqual(toWeeklySlot({ day: 'Sun', start: '23:30', end: null }), { day: 0, start: '23:30', end: '23:59' });
  assert.equal(toWeeklySlot({ day: 'Xyz' as never, start: '09:00', end: null }), null);
});

test('toRecovery: null lead hours → 0, questions → a count (empty = unknown, not "all Successful")', () => {
  const recovery = toRecovery({
    newAttempts: { perWeek: 2, formLeadHours: null, formItemId: null, slots: [], closedDates: [], questions: [] },
    revisions: [],
    rules: [],
  });

  assert.equal(recovery?.newAttempts?.formLeadHours, 0);
  assert.equal(recovery?.newAttempts?.notYetSuccessful, null);
  assert.equal(
    toRecovery({
      newAttempts: {
        perWeek: 2,
        formLeadHours: 24,
        formItemId: null,
        slots: [],
        closedDates: [],
        questions: ['Q1', 'Q3'],
      },
      revisions: [],
      rules: [],
    })?.newAttempts?.notYetSuccessful,
    2,
  );
  assert.equal(toRecovery({ newAttempts: null, revisions: [], rules: ['x'] })?.newAttempts, null);
});

test('toMeetings: numeric Canvas group id becomes the grade-plan string id', () => {
  assert.equal(
    toMeetings({ slots: [], timeZone: 'America/Los_Angeles', engagementGroupId: 4417, creditsPerMeeting: null })
      ?.engagementGroupId,
    '4417',
  );
});

test('normalizeAPlan: a plan with no syllabus keeps policy null', () => {
  const view = normalizeAPlan({
    classId: 'c1',
    status: 'unknown',
    policy: null,
    policyStatus: 'no_syllabus',
    recovery: null,
    meetings: null,
    conflicts: [],
    announcements: [],
    sources: [],
  } as unknown as APlanWire);

  assert.equal(view.policy, null);
  assert.equal(view.recovery, null);
});

test('the mock answers the wire shape and round-trips through the normalizer', () => {
  const wire = aplanMockRoutes('GET', ['classes', 'cls_demo_math', 'a-plan'])!.value as APlanWire;

  assert.equal(wire.meetings?.slots[0].day, 'Mon');
  assert.ok(Array.isArray(wire.policy?.exams[0]?.topics ?? []));
  const view = normalizeAPlan(wire);

  assert.equal(view.meetings?.slots[0].day, 1);
  assert.equal(view.meetings?.engagementGroupId, 'calc_engagement');
  assert.equal(view.recovery?.newAttempts?.notYetSuccessful, 3);
  assert.equal(view.policy?.scale[0].name, 'A');
});
