// Weekly-slot arithmetic in the class's time zone (office hours, class meetings, form deadlines).
// Pure: `now` is always passed in so tests pin the clock.
import type { RecoveryPlan, WeeklySlot } from '../types';

const DAY = 86_400_000;
const HOUR = 3_600_000;

interface ZonedDay {
  ymd: string;
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function zonedDay(ms: number, timeZone: string): ZonedDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';

  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, weekday: WEEKDAYS.indexOf(get('weekday')) };
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));

  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock `ymd` + "HH:MM" in `timeZone` → epoch ms. */
export function zonedTime(ymd: string, hhmm: string, timeZone: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - zoneOffset(guess, timeZone);

  // Second pass settles the DST-edge case where the offset at `guess` differs from the answer's.
  return guess - zoneOffset(first, timeZone);
}

export interface SlotOccurrence {
  slot: WeeklySlot;
  start: number;
  end: number;
}

/** Upcoming occurrences (end still in the future) over the next `days`, earliest first. */
export function upcomingSlots(
  slots: WeeklySlot[],
  timeZone: string,
  now: number,
  options: { days?: number; closedDates?: string[] } = {},
): SlotOccurrence[] {
  const closed = new Set(options.closedDates ?? []);
  const out: SlotOccurrence[] = [];

  for (let offset = 0; offset <= (options.days ?? 14); offset += 1) {
    const day = zonedDay(now + offset * DAY, timeZone);

    if (closed.has(day.ymd)) continue;
    for (const slot of slots) {
      if (slot.day !== day.weekday) continue;
      const start = zonedTime(day.ymd, slot.start, timeZone);
      const end = zonedTime(day.ymd, slot.end, timeZone);

      if (end > now) out.push({ slot, start, end });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}

export const nextMeeting = (slots: WeeklySlot[], timeZone: string, now: number) =>
  upcomingSlots(slots, timeZone, now, { days: 8 }).find((occurrence) => occurrence.start > now) ?? null;

export interface AttemptSlot extends SlotOccurrence {
  /** Latest time the retake request can go in for this slot. */
  formDeadline: number;
  /** Still bookable: the form deadline has not passed. */
  bookable: boolean;
}

/** office hours slots coming up, each with its form deadline (slot start − lead hours). */
export function attemptSlots(
  plan: NonNullable<RecoveryPlan['newAttempts']>,
  timeZone: string,
  now: number,
  days = 10,
): AttemptSlot[] {
  return upcomingSlots(plan.slots, timeZone, now, { days, closedDates: plan.closedDates })
    .filter((occurrence) => occurrence.start > now)
    .map((occurrence) => {
      const formDeadline = occurrence.start - plan.formLeadHours * HOUR;

      return { ...occurrence, formDeadline, bookable: formDeadline > now };
    });
}

/** "2 d 4 h left" / "5 h left" / "40 min left" / "overdue"; urgent under 24 h. */
export function countdown(dueAt: string | number, now: number): { text: string; urgent: boolean; overdue: boolean } {
  const diff = new Date(dueAt).getTime() - now;

  if (Number.isNaN(diff)) return { text: '', urgent: false, overdue: false };
  if (diff <= 0) return { text: 'overdue', urgent: true, overdue: true };
  const days = Math.floor(diff / DAY);
  const hours = Math.floor((diff % DAY) / HOUR);
  const minutes = Math.max(1, Math.floor((diff % HOUR) / 60_000));
  const text = days > 0 ? `${days} d ${hours} h left` : hours > 0 ? `${hours} h left` : `${minutes} min left`;

  return { text, urgent: diff < DAY, overdue: false };
}
