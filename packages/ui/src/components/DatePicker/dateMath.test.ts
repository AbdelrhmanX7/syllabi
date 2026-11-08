import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDays,
  addMonths,
  daysInMonth,
  formatDateLong,
  formatDateShort,
  formatMonthTitle,
  formatTime12,
  from12h,
  isOutOfRange,
  joinDateTime,
  minuteOptions,
  monthGrid,
  moveByKey,
  parseDate,
  parseTime,
  splitDateTime,
  to12h,
  todayISO,
  weekday,
} from './dateMath';

test('parseDate accepts real dates and rejects the rest', () => {
  assert.deepEqual(parseDate('2026-11-10'), { year: 2026, month: 11, day: 10 });
  assert.deepEqual(parseDate('2028-02-29'), { year: 2028, month: 2, day: 29 });
  assert.equal(parseDate('2026-02-29'), null);
  assert.equal(parseDate('2026-13-01'), null);
  assert.equal(parseDate('2026-1-01'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(undefined), null);
});

test('daysInMonth handles leap years', () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(2026, 12), 31);
});

test('addDays crosses months, years and DST weekends without drifting', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  // US DST starts 2026-03-08, ends 2026-11-01 — a day is still a day.
  assert.equal(addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
});

test('addMonths clamps the day', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-03-31', -13), '2025-02-28');
});

test('weekday is Sunday-first', () => {
  assert.equal(weekday('2026-11-08'), 0); // Sunday
  assert.equal(weekday('2026-11-10'), 2); // Tuesday
  assert.equal(weekday('2026-11-14'), 6); // Saturday
});

test('monthGrid is 6 Sunday-first weeks covering the month', () => {
  const grid = monthGrid(2026, 11);

  assert.equal(grid.length, 42);
  assert.equal(grid[0], '2026-11-01'); // Nov 1 2026 is a Sunday
  assert.equal(grid[41], '2026-12-12');
  const feb = monthGrid(2026, 2);

  assert.equal(feb[0], '2026-02-01'); // also a Sunday
  const dec = monthGrid(2026, 12);

  assert.equal(dec[0], '2026-11-29'); // Dec 1 is a Tuesday
  assert.equal(weekday(dec[0]!), 0);
  assert.ok(dec.includes('2026-12-31'));
});

test('isOutOfRange respects min and max', () => {
  assert.equal(isOutOfRange('2026-11-10', '2026-11-10', '2026-11-12'), false);
  assert.equal(isOutOfRange('2026-11-09', '2026-11-10'), true);
  assert.equal(isOutOfRange('2026-11-13', undefined, '2026-11-12'), true);
  assert.equal(isOutOfRange('2026-11-13', 'junk', ''), false);
});

test('en-US labels', () => {
  assert.equal(formatDateShort('2026-11-10'), 'Tue, Nov 10, 2026');
  assert.equal(formatDateLong('2026-11-10'), 'Tuesday, November 10, 2026');
  assert.equal(formatMonthTitle(2026, 11), 'November 2026');
  assert.equal(formatDateShort('nope'), '');
});

test('todayISO reads the local calendar day, not UTC', () => {
  // 11:30 PM local on Nov 10 must stay Nov 10 whatever TZ this runs in.
  assert.equal(todayISO(new Date(2026, 10, 10, 23, 30)), '2026-11-10');
  assert.equal(todayISO(new Date(2026, 10, 10, 0, 5)), '2026-11-10');
});

test('moveByKey', () => {
  assert.equal(moveByKey('2026-11-10', 'ArrowLeft'), '2026-11-09');
  assert.equal(moveByKey('2026-11-10', 'ArrowRight'), '2026-11-11');
  assert.equal(moveByKey('2026-11-10', 'ArrowUp'), '2026-11-03');
  assert.equal(moveByKey('2026-11-30', 'ArrowDown'), '2026-12-07');
  assert.equal(moveByKey('2026-11-10', 'PageDown'), '2026-12-10');
  assert.equal(moveByKey('2026-11-10', 'PageUp', true), '2025-11-10');
  assert.equal(moveByKey('2026-11-10', 'Home'), '2026-11-08');
  assert.equal(moveByKey('2026-11-10', 'End'), '2026-11-14');
  assert.equal(moveByKey('2026-11-10', 'Enter'), null);
});

test('12h ↔ 24h edges', () => {
  assert.deepEqual(to12h(0), { hour: 12, pm: false });
  assert.deepEqual(to12h(12), { hour: 12, pm: true });
  assert.deepEqual(to12h(19), { hour: 7, pm: true });
  assert.deepEqual(to12h(11), { hour: 11, pm: false });
  assert.equal(from12h(12, false), 0);
  assert.equal(from12h(12, true), 12);
  assert.equal(from12h(7, true), 19);
  assert.equal(from12h(11, false), 11);
  for (let h = 0; h < 24; h++) {
    const { hour, pm } = to12h(h);

    assert.equal(from12h(hour, pm), h);
  }
});

test('time parse and format', () => {
  assert.deepEqual(parseTime('19:05'), { hours: 19, minutes: 5 });
  assert.deepEqual(parseTime('07:00:00'), { hours: 7, minutes: 0 });
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime(''), null);
  assert.equal(formatTime12('19:00'), '7:00 PM');
  assert.equal(formatTime12('00:15'), '12:15 AM');
  assert.equal(formatTime12('12:00'), '12:00 PM');
  assert.equal(formatTime12('bad'), '');
});

test('minuteOptions adds an off-step current value', () => {
  assert.equal(minuteOptions().length, 12);
  assert.deepEqual(minuteOptions(5, 7).slice(0, 4), [0, 5, 7, 10]);
  assert.equal(minuteOptions(5, 10).length, 12);
});

test('date-time split and join', () => {
  assert.deepEqual(splitDateTime('2026-11-10T19:00'), { date: '2026-11-10', time: '19:00' });
  assert.deepEqual(splitDateTime('2026-11-10'), { date: '2026-11-10', time: '' });
  assert.deepEqual(splitDateTime(''), { date: '', time: '' });
  assert.equal(joinDateTime('2026-11-10', '7:05'), '2026-11-10T07:05');
  assert.equal(joinDateTime('', '07:05'), '');
  assert.equal(joinDateTime('2026-11-10', ''), '');
});
