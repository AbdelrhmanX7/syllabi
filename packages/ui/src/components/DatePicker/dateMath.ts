/**
 * Pure calendar math for the date and time pickers.
 *
 * Every value is a LOCAL calendar date ('YYYY-MM-DD') or wall-clock time ('HH:mm'), never an instant.
 * Day arithmetic runs on UTC timestamps (`Date.UTC` + `getUTC*`), so no time zone or daylight-saving
 * jump can shift a date. Never pass a 'YYYY-MM-DD' string to `new Date()` (it parses as UTC midnight and
 * lands on the previous day west of Greenwich) and never read a date back with `toISOString()`.
 *
 * Names are hard-coded en-US rather than `Intl`: old Android WebViews and newer ICU builds disagree on
 * details (newer ICU puts a narrow no-break space before "PM"), and the product is English only.
 */

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface CalendarDate {
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' → parts, or null when it is not a real calendar date. */
export function parseDate(value: string | null | undefined): CalendarDate | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());

  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;

  return { year, month, day };
}

export function formatDate({ year, month, day }: CalendarDate): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** Today's local calendar date as 'YYYY-MM-DD'. */
export function todayISO(now: Date = new Date()): string {
  return formatDate({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

function fromUTC(ms: number): string {
  const d = new Date(ms);

  return formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/** Shift a 'YYYY-MM-DD' by whole days. */
export function addDays(iso: string, days: number): string {
  const p = parseDate(iso);

  if (!p) return iso;

  return fromUTC(Date.UTC(p.year, p.month - 1, p.day + days));
}

/** Shift by whole months, clamping the day (Jan 31 + 1 month → Feb 28/29). */
export function addMonths(iso: string, months: number): string {
  const p = parseDate(iso);

  if (!p) return iso;
  const index = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index - year * 12) + 1;

  return formatDate({ year, month, day: Math.min(p.day, daysInMonth(year, month)) });
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: string): number {
  const p = parseDate(iso);

  return p ? new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() : 0;
}

/** The first day of the month `iso` falls in. */
export function startOfMonth(iso: string): string {
  const p = parseDate(iso);

  return p ? formatDate({ ...p, day: 1 }) : iso;
}

/**
 * 42 'YYYY-MM-DD' strings (6 weeks × 7, Sunday first) covering the given month, padded with the tail
 * of the previous month and the head of the next.
 */
export function monthGrid(year: number, month: number): string[] {
  const first = formatDate({ year, month, day: 1 });
  const start = addDays(first, -weekday(first));

  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** True when `iso` is outside [min, max]. Plain string comparison is safe for 'YYYY-MM-DD'. */
export function isOutOfRange(iso: string, min?: string, max?: string): boolean {
  if (min && parseDate(min) && iso < min) return true;
  if (max && parseDate(max) && iso > max) return true;

  return false;
}

/** "Tue, Nov 10, 2026" */
export function formatDateShort(iso: string): string {
  const p = parseDate(iso);

  if (!p) return '';

  return `${WEEKDAYS_SHORT[weekday(iso)]}, ${MONTHS_SHORT[p.month - 1]} ${p.day}, ${p.year}`;
}

/** "Tuesday, November 10, 2026" — the accessible name of a day button. */
export function formatDateLong(iso: string): string {
  const p = parseDate(iso);

  if (!p) return '';

  return `${WEEKDAYS_LONG[weekday(iso)]}, ${MONTHS_LONG[p.month - 1]} ${p.day}, ${p.year}`;
}

/** "November 2026" */
export function formatMonthTitle(year: number, month: number): string {
  return `${MONTHS_LONG[month - 1]} ${year}`;
}

/**
 * Where an arrow / paging key moves the focused day, or null for keys the grid does not handle.
 * Left/Right ±1 day, Up/Down ±1 week, PageUp/PageDown ±1 month (with Shift ±1 year), Home/End to the
 * start/end of that week.
 */
export function moveByKey(iso: string, key: string, shiftKey = false): string | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(iso, -1);
    case 'ArrowRight':
      return addDays(iso, 1);
    case 'ArrowUp':
      return addDays(iso, -7);
    case 'ArrowDown':
      return addDays(iso, 7);
    case 'PageUp':
      return addMonths(iso, shiftKey ? -12 : -1);
    case 'PageDown':
      return addMonths(iso, shiftKey ? 12 : 1);
    case 'Home':
      return addDays(iso, -weekday(iso));
    case 'End':
      return addDays(iso, 6 - weekday(iso));
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ time */

export interface WallTime {
  /** 0–23 */
  hours: number;
  /** 0–59 */
  minutes: number;
}

/** 'HH:mm' (24h) → parts, or null. Accepts a trailing ':ss' as a native time input can produce. */
export function parseTime(value: string | null | undefined): WallTime | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());

  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes };
}

export function formatTime({ hours, minutes }: WallTime): string {
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/** 24h hours → 12h clock: 0 → 12 AM, 12 → 12 PM, 19 → 7 PM. */
export function to12h(hours: number): { hour: number; pm: boolean } {
  return { hour: hours % 12 === 0 ? 12 : hours % 12, pm: hours >= 12 };
}

/** 12h clock → 24h hours: 12 AM → 0, 12 PM → 12, 7 PM → 19. */
export function from12h(hour: number, pm: boolean): number {
  return (hour % 12) + (pm ? 12 : 0);
}

/** "19:00" → "7:00 PM" (plain ASCII space). Empty string for an invalid value. */
export function formatTime12(value: string | null | undefined): string {
  const t = parseTime(value);

  if (!t) return '';
  const { hour, pm } = to12h(t.hours);

  return `${hour}:${pad2(t.minutes)} ${pm ? 'PM' : 'AM'}`;
}

/** Minute choices: every `step` minutes, plus `current` when it is off-step, sorted. */
export function minuteOptions(step = 5, current?: number | null): number[] {
  const list: number[] = [];

  for (let m = 0; m < 60; m += step) list.push(m);
  if (current != null && current >= 0 && current < 60 && !list.includes(current)) {
    list.push(current);
    list.sort((a, b) => a - b);
  }

  return list;
}

/* ------------------------------------------------------------------ date + time */

/** 'YYYY-MM-DDTHH:mm' → its two halves ('' for a half that is missing or invalid). */
export function splitDateTime(value: string | null | undefined): { date: string; time: string } {
  if (!value) return { date: '', time: '' };
  const [d = '', t = ''] = value.split('T');
  const date = parseDate(d) ? d : '';
  const time = parseTime(t);

  return { date, time: time ? formatTime(time) : '' };
}

/** Join both halves into 'YYYY-MM-DDTHH:mm', or '' when either is missing. */
export function joinDateTime(date: string, time: string): string {
  const t = parseTime(time);

  if (!parseDate(date) || !t) return '';

  return `${date}T${formatTime(t)}`;
}
