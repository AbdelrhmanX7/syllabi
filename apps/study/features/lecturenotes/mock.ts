// Mock side of class meetings (Class.meetings + PATCH /classes/:id {meetings}) and the lecture-note
// fields on Page (week / moduleId / lecture, PATCH /pages/:id). Plain data, no React.
import type { ClassMeetingTimes, Page, StudyClass } from '@/lib/api/types';

import { StudyApiError } from '@/lib/api/errors';

const TZ = 'America/Los_Angeles';
const weekly = (days: ('Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri')[], start: string, end: string): ClassMeetingTimes => ({
  slots: days.map((day) => ({ day, start, end })),
  timeZone: TZ,
});

/** Demo meeting times "from the syllabus" (invented; CS 101 is online, so it has none). */
const SYLLABUS: { match: RegExp; meetings: ClassMeetingTimes | null }[] = [
  { match: /^MATH[\s-]?101\b/i, meetings: weekly(['Mon', 'Wed'], '10:00', '11:50') },
  { match: /^EAS[\s-]?101\b/i, meetings: weekly(['Tue', 'Thu'], '10:30', '11:50') },
  { match: /^EAS[\s-]?102\b/i, meetings: weekly(['Thu'], '13:00', '15:50') },
  { match: /^CS[\s-]?101\b/i, meetings: null },
];

const OVERRIDES_KEY = 'study_mock_class_meetings';

function readOverrides(): Record<string, ClassMeetingTimes> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(OVERRIDES_KEY) ?? '{}') as Record<string, ClassMeetingTimes>;
  } catch {
    return {};
  }
}

function writeOverrides(table: Record<string, ClassMeetingTimes>) {
  try {
    globalThis.localStorage?.setItem(OVERRIDES_KEY, JSON.stringify(table));
  } catch {
    // the mock forgets on reload
  }
}

/** The class with `meetings` + `meetingsSource`, as the backend sends it. */
export function withClassMeetings(cls: StudyClass): StudyClass {
  const manual = readOverrides()[cls.id];

  if (manual) return { ...cls, meetings: manual, meetingsSource: 'manual' };
  const syllabus = SYLLABUS.find((row) => row.match.test(cls.code))?.meetings ?? null;

  return { ...cls, meetings: syllabus, meetingsSource: syllabus ? 'syllabus' : null };
}

/** PATCH /classes/:id `{ meetings }` (null drops the override). Null = not this route. */
export function patchClassMeetings(
  cls: StudyClass | undefined,
  body: Record<string, unknown> | undefined,
): { value: StudyClass } | null {
  if (!body || !('meetings' in body)) return null;
  if (!cls) throw new StudyApiError(404, 'Class not found', 'NOT_FOUND');
  const table = readOverrides();
  const meetings = body.meetings as ClassMeetingTimes | null;

  if (meetings !== null && (!meetings || !Array.isArray(meetings.slots))) {
    throw new StudyApiError(400, 'meetings must be { slots: [...] } or null', 'INVALID');
  }
  if (meetings) table[cls.id] = meetings;
  else delete table[cls.id];
  writeOverrides(table);

  return { value: withClassMeetings(cls) };
}

type LectureFields = Pick<Page, 'week' | 'moduleId' | 'lecture'>;

/** The fields a page is created with (always present, null when not filed). */
export function pageLectureFields(body: Partial<Page>): Required<LectureFields> {
  return { week: body.week ?? null, moduleId: body.moduleId ?? null, lecture: body.lecture ?? null };
}

/** PATCH /pages/:id: title + lecture fields; the content version stays. */
export function patchPageFields(page: Page, body: Record<string, unknown> | undefined): Page {
  const patch = body ?? {};

  if ('title' in patch) {
    if (typeof patch.title !== 'string' || !patch.title.trim())
      throw new StudyApiError(400, 'title is empty', 'INVALID');
    page.title = patch.title.trim();
  }
  if ('week' in patch) page.week = (patch.week as number | null) ?? null;
  if ('moduleId' in patch) page.moduleId = (patch.moduleId as string | null) ?? null;
  if ('lecture' in patch) page.lecture = (patch.lecture as Page['lecture']) ?? null;
  page.updatedAt = new Date().toISOString();

  return page;
}

/** `GET /pages?week=&lectureKey=` filters. */
export function pageMatchesLecture(page: Page, week: string | null, lectureKey: string | null): boolean {
  if (week && String(page.week ?? '') !== week) return false;
  if (lectureKey && page.lecture?.key !== lectureKey) return false;

  return true;
}
