// Reminders the app schedules on the device: deadlines, flashcards ready to review and the student's
// own reminders. Pure (no storage, no platform), so the date maths is unit-tested; lib/reminders/notify.ts
// hands the result to the phone (scheduled ahead) or to the open browser tab (a one-minute tick).
import type { Item, SubmissionState } from '@/lib/api/types';

import { effectiveDue } from '@/lib/due';

/** How early a deadline reminder comes: the evening before (18:00) or N minutes before the deadline. */
export type DueLead = 'evening' | 1440 | 180 | 60;
export const DUE_LEADS: DueLead[] = ['evening', 1440, 180, 60];
export const DEFAULT_DUE_LEADS: DueLead[] = ['evening', 180];

export type Repeat = 'none' | 'daily' | 'weekly';

export interface CustomReminder {
  id: string;
  text: string;
  /** Local wall-clock start, `YYYY-MM-DDTHH:mm` (no zone, so it stays 8:00 across time changes). */
  at: string;
  repeat: Repeat;
}

export interface PlanSettings {
  due: boolean;
  flashcards: boolean;
  leads: DueLead[];
}

export interface PlanInput {
  settings: PlanSettings;
  /** Upcoming work (Today's `due` list); anything handed in or past is skipped here again. */
  items: Pick<Item, 'id' | 'classId' | 'type' | 'title' | 'dueAt' | 'effectiveDueAt' | 'submission'>[];
  /** classId → short label shown in the body ("CS 101"). */
  classLabels?: Record<string, string>;
  /** Flashcards (only `srs.dueAt` matters; a card without one is new, so ready now). */
  cards: { srs?: { dueAt?: string | null; reps?: number } | null }[];
  custom: CustomReminder[];
  now: number;
}

export interface PlannedReminder {
  /** Stable key (same reminder → same key across reschedules). */
  key: string;
  /** Positive 31-bit id for the phone (Android ids are Java ints). */
  id: number;
  /** Epoch ms. */
  at: number;
  title: string;
  body: string;
  /** In-app path to open on tap; undefined = just open the app. */
  url?: string;
}

export const HORIZON_DAYS = 14;
export const MAX_REMINDERS = 30;
/** Never schedule closer than this to now (the phone drops times already in the past). */
const MIN_AHEAD_MS = 60_000;
const EVENING_HOUR = 18;
const FLASHCARD_HOUR = 17;
const HANDED_IN: SubmissionState[] = ['submitted', 'graded', 'late'];

/** FNV-1a of the key, folded into 1..2^31-1. */
export function reminderId(key: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return ((hash >>> 0) % 0x7ffffffe) + 1;
}

const atHour = (day: Date, hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
const addDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());

const timeText = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayText = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today at 11:59 PM" / "tomorrow at 9:00 AM" / "Fri, Nov 14 at 5:00 PM", seen from `from`. */
export function dueWhen(due: Date, from: Date): string {
  if (sameDay(due, from)) return `today at ${timeText(due)}`;
  if (sameDay(due, addDays(from, 1))) return `tomorrow at ${timeText(due)}`;

  return `${dayText(due)} at ${timeText(due)}`;
}

const leadTime = (due: Date, lead: DueLead) =>
  lead === 'evening' ? atHour(addDays(due, -1), EVENING_HOUR).getTime() : due.getTime() - lead * 60_000;

function dueReminders(input: PlanInput, from: number, to: number): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const leads = DUE_LEADS.filter((lead) => input.settings.leads.includes(lead));

  for (const item of input.items) {
    if (item.type !== 'assignment' && item.type !== 'quiz') continue;
    if (item.submission && HANDED_IN.includes(item.submission.state)) continue;
    const iso = effectiveDue(item);
    const due = iso ? new Date(iso) : null;

    if (!due || !Number.isFinite(due.getTime()) || due.getTime() <= input.now) continue;
    const label = input.classLabels?.[item.classId];
    const taken: number[] = [];

    for (const lead of leads) {
      const at = leadTime(due, lead);

      // The evening before can land after «1 day before» or close to «3 hours before»: one ping is enough.
      if (at < from || at > to || at >= due.getTime() || taken.some((t) => Math.abs(t - at) < 30 * 60_000)) continue;
      taken.push(at);
      const key = `due:${item.id}:${lead}`;

      out.push({
        key,
        id: reminderId(key),
        at,
        title: item.title,
        body: `${label ? `${label} · ` : ''}Due ${dueWhen(due, new Date(at))}`,
        url: `/item/?id=${encodeURIComponent(item.id)}`,
      });
    }
  }

  return out;
}

function flashcardReminders(input: PlanInput, from: number, to: number): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const dues = input.cards.map((card) => {
    const raw = card.srs?.dueAt;
    const t = raw ? Date.parse(raw) : NaN;

    return Number.isFinite(t) ? t : -Infinity;
  });

  for (let day = 0; day <= HORIZON_DAYS; day++) {
    const at = atHour(addDays(new Date(input.now), day), FLASHCARD_HOUR).getTime();

    if (at < from || at > to) continue;
    const count = dues.filter((t) => t <= at).length;

    if (count === 0) continue;
    const key = `cards:${new Date(at).toDateString()}`;

    out.push({
      key,
      id: reminderId(key),
      at,
      title: 'Flashcards ready',
      body: `${count} card${count === 1 ? '' : 's'} ready to review.`,
      url: '/flashcards/',
    });
  }

  return out;
}

function customReminders(input: PlanInput, from: number, to: number): PlannedReminder[] {
  const out: PlannedReminder[] = [];

  for (const reminder of input.custom) {
    const start = new Date(reminder.at);

    if (!Number.isFinite(start.getTime()) || !reminder.text.trim()) continue;
    const step = reminder.repeat === 'daily' ? 1 : reminder.repeat === 'weekly' ? 7 : 0;
    // Jump close to the window first so an old daily reminder doesn't loop through years of days.
    let n = step && start.getTime() < from ? Math.max(0, Math.floor((from - start.getTime()) / (step * 86_400_000)) - 1) : 0;

    for (;;) {
      const at = step ? addDays(start, n * step).getTime() : start.getTime();

      if (at > to) break;
      if (at >= from) {
        const key = `own:${reminder.id}:${at}`;

        out.push({ key, id: reminderId(key), at, title: reminder.text.trim(), body: 'Your reminder', url: undefined });
      }
      if (!step) break;
      n++;
    }
  }

  return out;
}

/** Everything to schedule from `now`: the next 14 days, soonest first, at most 30. */
export function planReminders(input: PlanInput): PlannedReminder[] {
  const from = input.now + MIN_AHEAD_MS;
  const to = input.now + HORIZON_DAYS * 86_400_000;
  const all = [
    ...(input.settings.due ? dueReminders(input, from, to) : []),
    ...(input.settings.flashcards ? flashcardReminders(input, from, to) : []),
    ...customReminders(input, from, to),
  ];

  return all.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key)).slice(0, MAX_REMINDERS);
}
