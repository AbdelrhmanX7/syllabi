// Class meeting times: `Class.meetings` (his override or the syllabus) first, the A-plan's meetings
// for a backend that does not send the field yet. Pure, so the source order and the editor's
// validation are unit-tested.
import type { ClassMeetingSlot, ClassMeetingTimes } from '@/lib/api/types';

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export type DayName = (typeof DAY_NAMES)[number];

/** 'Mon' / 'monday' / 1 → 1 (0 = Sunday); null for anything else. */
export function dayIndex(day: ClassMeetingSlot['day'] | string): number | null {
  if (typeof day === 'number') return Number.isInteger(day) && day >= 0 && day <= 6 ? day : null;
  const at = DAY_NAMES.findIndex((name) => name.toLowerCase() === String(day).slice(0, 3).toLowerCase());

  return at >= 0 ? at : null;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** «8:30» → «08:30»; null when it is not a 24 h time. */
export function normalizeTime(value: string): string | null {
  const match = HHMM.exec(value.trim());

  return match ? `${match[1]!.padStart(2, '0')}:${match[2]}` : null;
}

/** Weekdays (0 = Sun) the class meets, deduped and sorted. */
export function meetingDays(meetings: ClassMeetingTimes | null | undefined): number[] {
  const days = (meetings?.slots ?? []).map((slot) => dayIndex(slot.day)).filter((day): day is number => day !== null);

  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Which meeting days count for a class. A backend that sends `meetings` decides alone (null = unknown,
 * so the class shows no «Class today» row); one that does not yet falls back to the A plan.
 */
export function resolveMeetingDays(
  cls: { meetings?: ClassMeetingTimes | null },
  aPlanDays: readonly number[],
): { days: number[]; source: 'class' | 'aplan' | 'none' } {
  if ('meetings' in cls) {
    const days = meetingDays(cls.meetings);

    return { days, source: days.length > 0 ? 'class' : 'none' };
  }

  return aPlanDays.length > 0 ? { days: [...aPlanDays], source: 'aplan' } : { days: [], source: 'none' };
}

/** «Mon/Wed 11:10–12:35 · Fri 09:00–10:00» (slots with the same times share a group). */
export function describeMeetings(meetings: ClassMeetingTimes | null | undefined): string | null {
  const groups = new Map<string, number[]>();

  for (const slot of meetings?.slots ?? []) {
    const day = dayIndex(slot.day);

    if (day === null) continue;
    const time = slot.end ? `${slot.start}–${slot.end}` : slot.start;

    groups.set(time, [...(groups.get(time) ?? []), day]);
  }
  if (groups.size === 0) return null;

  return [...groups.entries()]
    .map(
      ([time, days]) =>
        `${[...new Set(days)]
          .sort((a, b) => a - b)
          .map((day) => DAY_NAMES[day])
          .join('/')} ${time}`,
    )
    .join(' · ');
}

export interface DraftSlot {
  day: number;
  start: string;
  end: string;
}

/** The editor's rows → the PATCH body, or the first problem to show. */
export function draftToMeetings(
  slots: readonly DraftSlot[],
  timeZone: string | null,
): { ok: true; meetings: ClassMeetingTimes } | { ok: false; error: string } {
  if (slots.length === 0) return { ok: false, error: 'Add at least one class time, or use Clear.' };
  const out: ClassMeetingSlot[] = [];

  for (const slot of slots) {
    const start = normalizeTime(slot.start);
    const end = normalizeTime(slot.end);

    if (!start || !end) return { ok: false, error: 'Times are 24-hour, like 11:10.' };
    if (end <= start) return { ok: false, error: `${DAY_NAMES[slot.day]}: the end is before the start.` };
    out.push({ day: DAY_NAMES[slot.day]!, start, end });
  }
  out.sort((a, b) => dayIndex(a.day)! - dayIndex(b.day)! || a.start.localeCompare(b.start));

  return { ok: true, meetings: { slots: out, ...(timeZone ? { timeZone } : {}) } };
}

export function meetingsToDraft(meetings: ClassMeetingTimes | null | undefined): DraftSlot[] {
  return (meetings?.slots ?? []).flatMap((slot) => {
    const day = dayIndex(slot.day);

    return day === null ? [] : [{ day, start: slot.start, end: slot.end ?? slot.start }];
  });
}
