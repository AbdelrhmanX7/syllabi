// Mock answers for the A plan endpoints (Force-mock mode; the live backend serves them since #576).
// The shell's mock transport (`lib/api/mock`) calls `aplanMockRoutes` before its own switch and passes
// `/today` through `withAPlanToday`. Class ids here are fixture ids (`cls_<canvasCourseId>`) — the
// transport maps them. Answers are in the WIRE shape, so the live normalizer runs on them too.
import type { APlanBody } from './lib/mock-data';
import type {
  AnnouncementDigest,
  APlanWire,
  GradePlan,
  PlanStatus,
  TodayAPlanFields,
  WeeklySlot,
  WireDay,
  WirePolicy,
} from './types';

import { buildGradePlan } from './lib/build-plan';
import { overallStatus } from './lib/grade-math';
import { COURSES, PLANS } from './lib/mock-data';

import { StudyApiError } from '@/lib/api/errors';

const TARGETS_KEY = 'study_aplan_targets';
const generatedAt: Record<string, string> = {};

function readTargets(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(TARGETS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function writeTarget(classId: string, letter: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TARGETS_KEY, JSON.stringify({ ...readTargets(), [classId]: letter }));
  } catch {
    // private mode: the target lives for this session only
  }
}

function gradePlanFor(classId: string): GradePlan {
  const course = COURSES[classId];

  if (!course) throw new StudyApiError(404, 'No syllabus or gradebook for this class yet', 'NO_GRADE_PLAN');

  return buildGradePlan({ ...course, targetLetter: readTargets()[classId] ?? course.targetLetter });
}

const DAYS: WireDay[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const wireSlot = (slot: WeeklySlot) => ({
  day: DAYS[slot.day],
  start: slot.start,
  end: slot.end,
  place: slot.place ?? null,
});

const wireDigest = (digest: AnnouncementDigest): AnnouncementDigest => ({
  ...digest,
  title: digest.title ?? '',
  deadlineChanges: digest.deadlineChanges ?? [],
});

const PLAN_STATUS = { on_track: 'on_track', at_risk: 'at_risk', below: 'missed' } as const;

/** The view-shaped fixtures (lib/mock-data) as the backend would send them. */
export function toWire(classId: string, body: APlanBody, gradePlan: GradePlan, at: string): APlanWire {
  const policy = body.policy;
  const wirePolicy: WirePolicy | null = policy && {
    gradingCategories: policy.gradingCategories.map((row) => ({ ...row, canvasGroupId: null, rules: '' })),
    aRequirement: policy.aRequirement,
    scale: policy.scale.map((row) => ({ letter: row.name, min: row.min })),
    lateWork: policy.lateWork,
    makeupAndRevisions: policy.makeupAndRevisions,
    drops: policy.drops,
    attendance: policy.attendance,
    exams: policy.exams.map((exam) => ({
      name: exam.name,
      date: exam.date ?? null,
      week: exam.week ?? null,
      topics: exam.topics ? [exam.topics] : [],
      format: exam.format,
      allowed: exam.allowed,
    })),
    extraCredit: policy.extraCredit,
    instructor: policy.instructor,
    requiredMaterials: policy.requiredMaterials,
    keyDates: policy.keyDates,
    closedDates: policy.closedDates ?? body.recovery?.newAttempts?.closedDates ?? [],
    quotes: policy.quotes,
    quotesDropped: 0,
    emphasis: policy.emphasis ?? [],
    syllabus: policy.syllabus ?? { kind: 'none', itemId: null, title: null, note: null },
  };
  const attempts = body.recovery?.newAttempts;
  const status: PlanStatus = PLAN_STATUS[overallStatus(gradePlan)];

  return {
    classId,
    status,
    policy: wirePolicy,
    policyStatus: wirePolicy ? 'ready' : 'no_syllabus',
    ownerPolicy: null,
    conflicts: body.conflicts,
    gradePlan,
    categoryStats: [],
    groups: [],
    recovery: body.recovery
      ? {
          newAttempts: attempts
            ? {
                perWeek: attempts.perWeek,
                formLeadHours: attempts.formLeadHours,
                formItemId: attempts.formItemId,
                slots: attempts.slots.map(wireSlot),
                closedDates: attempts.closedDates,
                questions: Array.from({ length: attempts.notYetSuccessful ?? 0 }, (_, index) => `Q${index + 1}`),
              }
            : null,
          revisions: body.recovery.revisions,
          rules: body.recovery.rules,
        }
      : null,
    meetings: body.meetings
      ? {
          slots: body.meetings.slots.map((slot) => ({ day: DAYS[slot.day], start: slot.start, end: slot.end })),
          timeZone: body.meetings.timeZone,
          // Fixture group ids are strings (`calc_engagement`); live ones are Canvas numbers. The normalizer
          // stringifies either, so the fixture id passes through as-is.
          engagementGroupId: body.meetings.engagementGroupId as unknown as number | null,
          creditsPerMeeting: body.meetings.creditsPerMeeting,
        }
      : null,
    requirements: body.requirements,
    risks: body.risks,
    thisWeek: body.thisWeek,
    announcements: body.announcements.map(wireDigest),
    sources: body.sources,
    synthesis: 'model',
    generatedAt: at,
    stale: false,
  };
}

function aPlanFor(classId: string): APlanWire {
  const body = PLANS[classId];

  if (!body) throw new StudyApiError(404, 'Class not found', 'NOT_FOUND');
  generatedAt[classId] ??= new Date(Date.now() - 3 * 3_600_000).toISOString();

  return toWire(classId, body, gradePlanFor(classId), generatedAt[classId]);
}

/**
 * `GET|POST|PATCH` routes this feature owns. Returns `{ value }` when it answered, null otherwise —
 * PATCH /classes/:id only claims bodies that carry `targetLetter` (a scheme letter, or null = default A;
 * anything else is a 400 like the live route).
 */
export function aplanMockRoutes(
  method: string,
  segments: string[],
  body?: Record<string, unknown>,
): { value: unknown } | null {
  const [head, classId, sub, action] = segments;

  if (head !== 'classes' || !classId) return null;
  if (sub === 'grade-plan' && !action && method === 'GET') return { value: gradePlanFor(classId) };
  if (sub === 'a-plan' && !action && method === 'GET') return { value: aPlanFor(classId) };
  if (sub === 'a-plan' && action === 'refresh' && method === 'POST') {
    generatedAt[classId] = new Date().toISOString();

    return { value: { status: 'building', started: true } };
  }
  if (!sub && method === 'PATCH' && body && 'targetLetter' in body) {
    const letter = body.targetLetter;
    const names = (COURSES[classId]?.scheme ?? []).map((entry) => entry.name);

    if (letter !== null && (typeof letter !== 'string' || !names.includes(letter)))
      throw new StudyApiError(400, `targetLetter must be one of ${names.join(', ')} or null`, 'INVALID');
    writeTarget(classId, letter ?? 'A');

    return { value: { id: classId, targetLetter: letter } };
  }

  return null;
}

/** Adds `aPlan` + `highAnnouncements` to the mock `/today` answer. */
export function withAPlanToday<T extends { classes?: { id: string }[] }>(today: T): T & TodayAPlanFields {
  const ids = (today.classes ?? []).map((cls) => cls.id).filter((id) => COURSES[id] && PLANS[id]);
  const aPlan = ids.map((classId) => {
    const plan = aPlanFor(classId);

    return { classId, status: plan.status, topAction: plan.thisWeek[0]?.text ?? null, alerts: [] };
  });
  const highAnnouncements = ids
    .flatMap((classId) =>
      PLANS[classId].announcements
        .filter((ann) => ann.importance === 'high')
        .map((ann) => ({ ...wireDigest(ann), classId })),
    )
    .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));

  return { ...today, aPlan, highAnnouncements };
}
