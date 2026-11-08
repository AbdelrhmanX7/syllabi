import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CALC_PLAN_RECOVERY } from './mock-data';
import { attemptSlots, countdown, nextMeeting, zonedTime } from './schedule';

const TZ = 'America/Los_Angeles';
// Monday 2026-10-05, 10:00 PDT.
const NOW = Date.parse('2026-10-05T17:00:00Z');

test('zonedTime: Pacific wall clock → UTC across DST', () => {
  assert.equal(new Date(zonedTime('2026-10-07', '09:00', TZ)).toISOString(), '2026-10-07T16:00:00.000Z');
  assert.equal(new Date(zonedTime('2026-12-07', '08:00', TZ)).toISOString(), '2026-12-07T16:00:00.000Z');
});

test('nextMeeting: after Monday class started, the next one is Wednesday 9:00', () => {
  const next = nextMeeting(
    [
      { day: 1, start: '09:00', end: '10:50' },
      { day: 3, start: '09:00', end: '10:50' },
    ],
    TZ,
    NOW,
  );

  assert.equal(new Date(next!.start).toISOString(), '2026-10-07T16:00:00.000Z');
});

test('attemptSlots: 24 h sign-up lead, closed Friday skipped', () => {
  const slots = attemptSlots(CALC_PLAN_RECOVERY.newAttempts!, TZ, NOW, 8);
  const iso = slots.map((slot) => [new Date(slot.start).toISOString(), slot.bookable]);

  assert.deepEqual(iso.slice(0, 4), [
    ['2026-10-05T20:00:00.000Z', false], // today 1:00 — sign-up was due yesterday
    ['2026-10-06T18:00:00.000Z', true], // Tue 11:00 — sign-up due by today 11:00
    ['2026-10-08T22:30:00.000Z', true], // Thu 3:30
    ['2026-10-12T20:00:00.000Z', true], // next Mon — Fri 10/9 is closed
  ]);
  assert.equal(new Date(slots[1].formDeadline).toISOString(), '2026-10-05T18:00:00.000Z');
});

test('countdown: days/hours, urgent under 24 h, overdue', () => {
  assert.deepEqual(countdown('2026-10-06T06:59:00Z', NOW), { text: '13 h left', urgent: true, overdue: false });
  assert.deepEqual(countdown('2026-10-08T05:00:00Z', NOW), { text: '2 d 12 h left', urgent: false, overdue: false });
  assert.equal(countdown('2026-10-05T16:00:00Z', NOW).overdue, true);
});
