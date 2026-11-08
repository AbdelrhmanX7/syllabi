import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dayIndex,
  describeMeetings,
  draftToMeetings,
  meetingDays,
  meetingsToDraft,
  normalizeTime,
  resolveMeetingDays,
} from './meetings';

const GEOL = {
  slots: [
    { day: 'Mon' as const, start: '10:15', end: '11:40' },
    { day: 'Wed' as const, start: '10:15', end: '11:40' },
  ],
};

test('dayIndex / normalizeTime', () => {
  assert.equal(dayIndex('Mon'), 1);
  assert.equal(dayIndex('wednesday'), 3);
  assert.equal(dayIndex(0), 0);
  assert.equal(dayIndex(7), null);
  assert.equal(dayIndex('Xyz'), null);
  assert.equal(normalizeTime('8:30'), '08:30');
  assert.equal(normalizeTime('24:00'), null);
});

test('resolveMeetingDays: Class.meetings decides when the field is sent, else the A plan', () => {
  assert.deepEqual(resolveMeetingDays({ meetings: GEOL }, [2, 4]), { days: [1, 3], source: 'class' });
  // Field sent as null (an online class: not in the syllabus): no class-today row, the A plan is not consulted.
  assert.deepEqual(resolveMeetingDays({ meetings: null }, [2, 4]), { days: [], source: 'none' });
  // Older backend without the field.
  assert.deepEqual(resolveMeetingDays({}, [1, 3]), { days: [1, 3], source: 'aplan' });
  assert.deepEqual(resolveMeetingDays({}, []), { days: [], source: 'none' });
  assert.deepEqual(
    meetingDays({
      slots: [
        { day: 3, start: '1:00', end: '2:00' },
        { day: 'Mon', start: '1', end: '2' },
      ],
    }),
    [1, 3],
  );
});

test('describeMeetings groups days with the same times', () => {
  assert.equal(describeMeetings(GEOL), 'Mon/Wed 10:15–11:40');
  assert.equal(
    describeMeetings({ slots: [...GEOL.slots, { day: 'Fri', start: '09:00', end: '10:00' }] }),
    'Mon/Wed 10:15–11:40 · Fri 09:00–10:00',
  );
  assert.equal(describeMeetings(null), null);
});

test('draftToMeetings validates and sorts; meetingsToDraft round-trips', () => {
  const ok = draftToMeetings(
    [
      { day: 3, start: '9:05', end: '10:55' },
      { day: 1, start: '09:05', end: '10:55' },
    ],
    'America/Los_Angeles',
  );

  assert.deepEqual(ok, {
    ok: true,
    meetings: {
      slots: [
        { day: 'Mon', start: '09:05', end: '10:55' },
        { day: 'Wed', start: '09:05', end: '10:55' },
      ],
      timeZone: 'America/Los_Angeles',
    },
  });
  assert.equal(draftToMeetings([], null).ok, false);
  assert.equal(draftToMeetings([{ day: 1, start: '11:00', end: '10:00' }], null).ok, false);
  assert.equal(draftToMeetings([{ day: 1, start: 'noon', end: '13:00' }], null).ok, false);
  assert.deepEqual(meetingsToDraft(GEOL), [
    { day: 1, start: '10:15', end: '11:40' },
    { day: 3, start: '10:15', end: '11:40' },
  ]);
});

test('a syllabus slot with no end time does not print «null»', () => {
  const syllabus = { slots: [{ day: 'Mon' as const, start: '10:15', end: null }] };

  assert.equal(describeMeetings(syllabus), 'Mon 10:15');
  assert.deepEqual(meetingsToDraft(syllabus), [{ day: 1, start: '10:15', end: '10:15' }]);
});
