// Calendar events from what the app already knows: Canvas due dates, the exam schedule, class
// meeting times and spaced-repetition reviews. Pure (no fetching), so the merge and the date maths
// are unit-tested. Dates are local `YYYY-MM-DD` keys; times are 24 h `HH:MM`.
import type { ExamScheduleEntry, Item, Question, StudyClass } from '@/lib/api/types';

import { effectiveDue } from '@/lib/due';
import { dayIndex, normalizeTime } from '@/features/lecturenotes/lib/meetings';

export type CalendarKind = 'class' | 'due' | 'exam' | 'review';

export interface CalendarEvent {
  id: string;
  date: string;
  /** Start time; null = all day (a due date without a time, an exam with only a date). */
  time: string | null;
  end: string | null;
  kind: CalendarKind;
  title: string;
  classId: string | null;
  color: string | null;
  href: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD` for a Date. */
export const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local midnight of a `YYYY-MM-DD` key. */
export const fromKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);

  return new Date(y!, (m ?? 1) - 1, d ?? 1);
};

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Monday-start week containing `d`. */
export const startOfWeek = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));

/** The 6×7 Monday-start grid that covers `d`'s month. */
export function monthGrid(d: Date): Date[] {
  const first = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1));

  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

const timeOf = (iso: string) => {
  const d = new Date(iso);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // Canvas «end of day» (23:59) reads as a deadline time; midnight exactly means «no time given».
  return hhmm === '00:00' ? null : hhmm;
};

const inRange = (key: string, from: string, to: string) => key >= from && key <= to;

export interface CalendarSources {
  classes: StudyClass[];
  /** Items per class (any type; only dated assignments / quizzes become events). */
  items: Item[];
  /** Exam schedules keyed by class id. */
  exams: Record<string, ExamScheduleEntry[]>;
  questions: Question[];
}

/** Every event between `from` and `to` (inclusive `YYYY-MM-DD`), sorted by date, then all-day first, then time. */
export function buildEvents(src: CalendarSources, from: string, to: string): CalendarEvent[] {
  const byId = new Map(src.classes.map((c) => [c.id, c]));
  const color = (classId: string | null) => (classId ? (byId.get(classId)?.color ?? null) : null);
  const label = (classId: string | null) => {
    const c = classId ? byId.get(classId) : undefined;

    return c ? c.code || c.name : '';
  };
  const out: CalendarEvent[] = [];

  for (const item of src.items) {
    if (item.type !== 'assignment' && item.type !== 'quiz') continue;
    const due = effectiveDue(item);

    if (!due) continue;
    const key = dateKey(new Date(due));

    if (!inRange(key, from, to)) continue;
    out.push({
      id: `due:${item.id}`,
      date: key,
      time: timeOf(due),
      end: null,
      kind: 'due',
      title: item.title,
      classId: item.classId,
      color: color(item.classId),
      href: `/item/?id=${encodeURIComponent(item.id)}`,
    });
  }

  for (const [classId, entries] of Object.entries(src.exams)) {
    for (const exam of entries) {
      if (!exam.date || !inRange(exam.date, from, to)) continue;
      out.push({
        id: `exam:${classId}:${exam.name}:${exam.date}`,
        date: exam.date,
        time: null,
        end: null,
        kind: 'exam',
        title: [label(classId), exam.name].filter(Boolean).join(' · '),
        classId,
        color: color(classId),
        href: `/class/?id=${encodeURIComponent(classId)}&tab=guide`,
      });
    }
  }

  // Class meetings repeat weekly across the range.
  for (let d = fromKey(from); dateKey(d) <= to; d = addDays(d, 1)) {
    const key = dateKey(d);

    for (const cls of src.classes) {
      for (const slot of cls.meetings?.slots ?? []) {
        if (dayIndex(slot.day) !== d.getDay()) continue;
        const start = normalizeTime(slot.start);

        out.push({
          id: `class:${cls.id}:${key}:${start ?? ''}`,
          date: key,
          time: start,
          end: slot.end ? normalizeTime(slot.end) : null,
          kind: 'class',
          title: cls.code || cls.name,
          classId: cls.id,
          color: cls.color,
          href: `/class/?id=${encodeURIComponent(cls.id)}`,
        });
      }
    }
  }

  // Reviews: one event per day with the count (overdue reviews land on today).
  const today = dateKey(new Date());
  const reviews = new Map<string, number>();

  for (const q of src.questions) {
    const due = dateKey(new Date(q.srs.dueAt));
    const key = due < today ? today : due;

    if (inRange(key, from, to)) reviews.set(key, (reviews.get(key) ?? 0) + 1);
  }
  for (const [key, n] of reviews) {
    out.push({
      id: `review:${key}`,
      date: key,
      time: null,
      end: null,
      kind: 'review',
      title: `${n} review${n === 1 ? '' : 's'}`,
      classId: null,
      color: null,
      href: '/bank/',
    });
  }

  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time === null ? -1 : 0) - (b.time === null ? -1 : 0) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.title.localeCompare(b.title),
  );
}

/** Events grouped by date key. */
export function byDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();

  for (const e of events) map.set(e.date, [...(map.get(e.date) ?? []), e]);

  return map;
}
