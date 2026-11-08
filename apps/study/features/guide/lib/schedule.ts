// Pure helpers: exam dates from week numbers, the next exam, days left, result percent + trend.

import type { ExamResultRow, ExamScheduleEntry } from '../types';

/** Known term starts (YYYY-MM-DD, the Monday of week 1) when the class does not carry one. */
const TERM_STARTS: { match: RegExp; start: string }[] = [
  { match: /fall\s*2026|2026\s*-?\s*fa\b|fa\s*2026/i, start: '2026-08-24' },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The class's own term start when the API sends one, else the known table by term name. */
export function termStartFor(cls: { term?: string | null } & Record<string, unknown>): string | null {
  for (const key of ['termStart', 'termStartAt', 'termStartDate']) {
    const value = cls[key];

    if (typeof value === 'string' && ISO_DATE.test(value.slice(0, 10))) return value.slice(0, 10);
  }
  const term = cls.term ?? '';

  return TERM_STARTS.find((t) => t.match.test(term))?.start ?? null;
}

/** Days since the epoch for a `YYYY-MM-DD` (timezone-free). */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);

  return Math.round(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

export function isoFromDayNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Local calendar date of `now` as `YYYY-MM-DD`. */
export function localIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Monday of week N = termStart + (N − 1) × 7 days. */
export function weekStart(termStart: string, week: number): string {
  return isoFromDayNumber(dayNumber(termStart) + (Math.max(1, week) - 1) * 7);
}

export interface ResolvedExam extends ExamScheduleEntry {
  /** The date used for the countdown, or null when neither date nor week+term are known. */
  when: string | null;
  /** True when `when` came from the week number (Monday of that week). */
  approx: boolean;
}

export function resolveExam(entry: ExamScheduleEntry, termStart: string | null): ResolvedExam {
  if (entry.date && ISO_DATE.test(entry.date)) return { ...entry, when: entry.date, approx: false };
  if (entry.week && termStart) return { ...entry, when: weekStart(termStart, entry.week), approx: true };

  return { ...entry, when: null, approx: false };
}

/**
 * Whole days from `today` to `date`. A week-derived (approx) date is the Monday of that week, so
 * an approx exam stays "this week" (0) until its week is over.
 */
export function daysUntil(exam: Pick<ResolvedExam, 'when' | 'approx'>, today: string): number | null {
  if (!exam.when) return null;
  const diff = dayNumber(exam.when) - dayNumber(today);

  if (exam.approx && diff < 0 && diff > -7) return 0;

  return diff;
}

/** Upcoming exams (today included), nearest first; undated ones last. */
export function upcomingExams(schedule: ExamScheduleEntry[], termStart: string | null, today: string): ResolvedExam[] {
  return schedule
    .map((e) => resolveExam(e, termStart))
    .filter((e) => {
      const days = daysUntil(e, today);

      return days === null || days >= 0;
    })
    .sort((a, b) => {
      const da = daysUntil(a, today);
      const db = daysUntil(b, today);

      if (da === null) return db === null ? 0 : 1;
      if (db === null) return -1;

      return da - db;
    });
}

export function nextExam(schedule: ExamScheduleEntry[], termStart: string | null, today: string): ResolvedExam | null {
  return upcomingExams(schedule, termStart, today).find((e) => e.when) ?? null;
}

export function daysLabel(days: number | null, approx = false): string {
  if (days === null) return 'Date not set';
  if (approx) {
    if (days === 0) return 'This week';
    if (days < 7) return `~${days} day${days === 1 ? '' : 's'}`;

    return `~${Math.round(days / 7)} wk`;
  }
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';

  return `${days} days`;
}

/** Topics for the mock exam: explicit topics, else the chapters. */
export const examTopics = (e: Pick<ExamScheduleEntry, 'topics' | 'chapters'>) =>
  e.topics.length ? e.topics : e.chapters;

/**
 * `/bank?classId=…&mock=1&blueprint=class&topics=…` — the bank opens the mock setup in the class's
 * real exam format with these topics picked.
 */
export function mockExamHref(classId: string, topics: string[]): string {
  const params = new URLSearchParams({ classId, mock: '1', blueprint: 'class' });

  for (const t of topics) params.append('topics', t);

  return `/bank?${params.toString()}`;
}

export function drillHref(classId: string): string {
  return `/bank?${new URLSearchParams({ classId, review: '1' }).toString()}`;
}

/* ------------------------------------------------------------------ results */

export function resultPercent(r: Pick<ExamResultRow, 'score' | 'maxScore' | 'percent'>): number | null {
  if (typeof r.percent === 'number') return r.percent;
  if (!r.maxScore) return null;

  return Math.round((r.score / r.maxScore) * 1000) / 10;
}

/** Δ percent between each result and the one before it (oldest first, as the API lists them). */
export function resultTrend(rows: Pick<ExamResultRow, 'score' | 'maxScore' | 'percent'>[]): (number | null)[] {
  return rows.map((row, i) => {
    if (i === 0) return null;
    const now = resultPercent(row);
    const before = resultPercent(rows[i - 1]!);

    return now === null || before === null ? null : Math.round((now - before) * 10) / 10;
  });
}

/** Splits a comma / newline list into trimmed, de-duplicated, non-empty entries (≤120 chars each). */
export function splitList(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[,\n]/)
        .map((s) => s.trim().slice(0, 120))
        .filter(Boolean),
    ),
  );
}

/** Schedule rows as the BE validates them; returns an error message instead when one is invalid. */
export function cleanSchedule(rows: ExamScheduleEntry[]): ExamScheduleEntry[] | string {
  if (rows.length > 20) return 'At most 20 exams.';
  const out: ExamScheduleEntry[] = [];

  for (const [i, row] of rows.entries()) {
    const name = row.name.trim();

    if (!name) return `Exam ${i + 1} needs a name.`;
    if (row.week !== null && (!Number.isInteger(row.week) || row.week < 0 || row.week > 60))
      return `${name}: week must be 0–60.`;
    if (row.date && !ISO_DATE.test(row.date)) return `${name}: date must be YYYY-MM-DD.`;
    out.push({
      name: name.slice(0, 120),
      week: row.week,
      date: row.date || null,
      chapters: row.chapters.map((s) => s.trim()).filter(Boolean),
      topics: row.topics.map((s) => s.trim()).filter(Boolean),
    });
  }

  return out;
}
