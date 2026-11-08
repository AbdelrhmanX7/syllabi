// Live a-plan body → the view the components read. The wire keeps the backend's shapes (slot days as
// "Mon", nullable syllabus fields, exam topics as a list, numeric Canvas group ids); the view uses
// what the schedule math and the grade-plan already speak (0 = Sunday, string group ids).
import type {
  APlan,
  APlanWire,
  ClassMeetings,
  RecoveryPlan,
  SyllabusPolicy,
  WeeklySlot,
  WireDay,
  WireMeetings,
  WirePolicy,
  WireRecovery,
} from '../types';

const DAYS: WireDay[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A slot with no stated end is treated as an hour long. */
const DEFAULT_SLOT_MINUTES = 60;

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + minutes);

  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function toWeeklySlot(slot: {
  day: WireDay;
  start: string;
  end: string | null;
  place?: string | null;
}): WeeklySlot | null {
  const day = DAYS.indexOf(slot.day);

  if (day < 0 || !/^\d{1,2}:\d{2}$/.test(slot.start)) return null;

  return {
    day,
    start: slot.start,
    end: slot.end ?? addMinutes(slot.start, DEFAULT_SLOT_MINUTES),
    ...(slot.place ? { place: slot.place } : {}),
  };
}

const slotsOf = (slots: Parameters<typeof toWeeklySlot>[0][]) =>
  slots.map(toWeeklySlot).filter((slot): slot is WeeklySlot => slot !== null);

export function toPolicy(policy: WirePolicy | null): SyllabusPolicy | null {
  if (!policy) return null;

  return {
    gradingCategories: policy.gradingCategories.map(({ name, weight, unit }) => ({ name, weight, unit })),
    aRequirement: policy.aRequirement,
    scale: policy.scale.map((row) => ({ name: row.letter, min: row.min })),
    lateWork: policy.lateWork,
    makeupAndRevisions: policy.makeupAndRevisions,
    drops: policy.drops,
    attendance: policy.attendance,
    exams: policy.exams.map((exam) => ({ ...exam, topics: exam.topics.join(', ') })),
    extraCredit: policy.extraCredit,
    instructor: policy.instructor,
    requiredMaterials: policy.requiredMaterials,
    keyDates: policy.keyDates,
    quotes: policy.quotes,
    quotesDropped: policy.quotesDropped,
    closedDates: policy.closedDates ?? [],
    emphasis: policy.emphasis ?? [],
    syllabus: policy.syllabus ?? null,
  };
}

export function toRecovery(recovery: WireRecovery | null): RecoveryPlan | null {
  if (!recovery) return null;
  const attempts = recovery.newAttempts;

  return {
    newAttempts: attempts && {
      perWeek: attempts.perWeek,
      formLeadHours: attempts.formLeadHours ?? 0,
      formItemId: attempts.formItemId,
      slots: slotsOf(attempts.slots),
      closedDates: attempts.closedDates,
      // An empty list means "none marked", which is not the same as "all Successful".
      notYetSuccessful: attempts.questions.length || null,
      questions: attempts.questions,
    },
    revisions: recovery.revisions,
    rules: recovery.rules,
  };
}

export function toMeetings(meetings: WireMeetings | null): ClassMeetings | null {
  if (!meetings) return null;

  return {
    slots: slotsOf(meetings.slots),
    timeZone: meetings.timeZone,
    engagementGroupId: meetings.engagementGroupId === null ? null : String(meetings.engagementGroupId),
    creditsPerMeeting: meetings.creditsPerMeeting,
  };
}

export function normalizeAPlan(wire: APlanWire): APlan {
  return {
    ...wire,
    policy: toPolicy(wire.policy),
    recovery: toRecovery(wire.recovery),
    meetings: toMeetings(wire.meetings),
    conflicts: wire.conflicts ?? [],
    announcements: wire.announcements ?? [],
    sources: wire.sources ?? [],
  };
}
