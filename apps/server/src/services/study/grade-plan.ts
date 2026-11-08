import { Types } from "mongoose";
import { plural } from "./plural";
import { StudyClass, IStudyClass, GRADE_POLICY_KINDS, StudyGradePolicy } from "@/models/study/class";
import { StudyAssignmentGroup, IStudyAssignmentGroup } from "@/models/study/assignment-group";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyClassGuide, IStudyClassGuide } from "@/models/study/library";
import { letterFromScore } from "./canvas-mapping";
import { SEMESTER_PLANS } from "./semester-plans";
import {
  CalcGroup,
  categoryStatus,
  CategoryResult,
  countMeetings,
  countsTowardGrade,
  courseScore,
  localDate,
  groupScore,
  isCounted,
  isRemaining,
  round2,
  solveNeededPct,
} from "./grade-calc";

/**
 * GET /study/classes/:id/grade-plan — Canvas-parity current grade + what it takes to reach the
 * target letter. The math lives in grade-calc.ts (pure); this file loads, shapes and validates.
 */

export const DEFAULT_SCHEME = [
  { name: "A", value: 0.9 },
  { name: "B", value: 0.8 },
  { name: "C", value: 0.7 },
  { name: "D", value: 0.6 },
  { name: "F", value: 0 },
];
export const EXAM_GROUP_RE = /exam|midterm|final/i;
export const WARNING_WINDOW_MS = 48 * 3600 * 1000;

export type ScheduledExam = { title: string; date: Date | null };

/**
 * The class's exam schedule — P-CM's store (`study_class_guides.examsSchedule`, served by
 * `GET/PUT /study/classes/:id/exams-schedule`), matched to the class by canvasCourseId. An
 * entry's `date` is the exam day or its week's Monday ("week of …"); null when unknown.
 */
export async function loadExamSchedule(userId: Types.ObjectId, classId: Types.ObjectId): Promise<ScheduledExam[]> {
  const cls = await StudyClass.findOne({ _id: classId, userId }, { canvasCourseId: 1 }).lean<{ canvasCourseId: number }>();
  if (!cls) return [];
  const g = await StudyClassGuide.findOne({ userId, canvasCourseId: cls.canvasCourseId }, { examsSchedule: 1 }).sort({ updatedAt: -1 }).lean<IStudyClassGuide>();
  return (g?.examsSchedule ?? []).map((e) => ({ title: e.name, date: e.date ? new Date(`${e.date}T12:00:00.000Z`) : null }));
}

const schemeOf = (cls: Pick<IStudyClass, "grading">) =>
  (cls.grading?.scheme?.length ? cls.grading.scheme : DEFAULT_SCHEME).slice().sort((a, b) => b.value - a.value);

/** Default target: "A" when the scheme has it, else the top row. */
export const defaultTargetLetter = (scheme: { name: string }[]) => (scheme.find((r) => r.name === "A") ?? scheme[0])?.name ?? "A";

export const itemKey = (canvasType: string, canvasId: string) => `${canvasType}:${canvasId}`;

export const toCalcGroup = (g: IStudyAssignmentGroup): CalcGroup => ({
  id: g.canvasGroupId,
  name: g.name,
  weight: g.weight ?? 0,
  rules: { dropLowest: g.rules?.dropLowest ?? 0, dropHighest: g.rules?.dropHighest ?? 0, neverDrop: g.rules?.neverDrop ?? [] },
  assignments: (g.assignments ?? []).map((a) => ({
    id: a.canvasAssignmentId,
    name: a.name,
    points: a.points ?? null,
    omit: !!a.omit,
    published: a.published !== false,
    gradingType: a.gradingType ?? null,
    dueAt: a.dueAt ? new Date(a.dueAt) : null,
    score: typeof a.score === "number" ? a.score : null,
    excused: !!a.excused,
  })),
});

/** The exam group: the only name-matched group, else the heaviest (ties: most points). */
export function pickExamGroup(groups: CalcGroup[]): CalcGroup | null {
  const pts = (g: CalcGroup) => g.assignments.reduce((t, a) => t + (a.omit ? 0 : a.points ?? 0), 0);
  const heaviest = (gs: CalcGroup[]) =>
    gs.slice().sort((a, b) => b.weight - a.weight || pts(b) - pts(a))[0] ?? null;
  const named = groups.filter((g) => EXAM_GROUP_RE.test(g.name));
  if (named.length === 1) return named[0];
  return heaviest(named.length ? named : groups);
}

/**
 * Per-category numbers for an `all_categories_min` policy, over the SEMESTER total: Canvas's
 * graded + published work, plus an estimate of what is not published yet from the course's
 * hardcoded semester plan (semester-plans.ts). Categories without a plan use published work only
 * (`estimated: false`, `estimateBasis: "published_only"`).
 */
export function policyCategories(
  cls: { canvasCourseId?: number; gradePolicy?: StudyGradePolicy | null },
  groups: CalcGroup[],
  now: Date
) {
  const policy = cls.gradePolicy;
  if (policy?.kind !== "all_categories_min") return [];
  const min = policy.min ?? 0.9;
  const plan = cls.canvasCourseId ? SEMESTER_PLANS[cls.canvasCourseId] : undefined;
  return policy.categories
    .map((id) => groups.find((g) => String(g.id) === id))
    .filter((g): g is CalcGroup => !!g)
    .map((g) => {
      const rule = plan?.categories.find((c) => c.match.test(g.name.trim()));
      const slots = g.assignments.filter((a) => countsTowardGrade(a) && (a.points ?? 0) > 0);
      const lastDue = slots.reduce<Date | null>((m, a) => (a.dueAt && (!m || a.dueAt > m) ? a.dueAt : m), null);
      let future = 0;
      if (plan && rule) {
        const after = localDate(lastDue ?? now, plan.tz);
        if (rule.estimate.kind === "per_meeting")
          future = countMeetings(plan.meetingWeekdays, after, plan.lastClassDay, plan.noCreditDays) * rule.estimate.perMeeting;
        else if (rule.estimate.kind === "fixed_total")
          future = Math.max(0, rule.estimate.total - slots.reduce((t, a) => t + a.points!, 0));
        else {
          const ref = slots.find((a) => typeof a.score === "number") ?? slots[0];
          future = rule.estimate.dates.filter((d) => d > after).length * (ref?.points ?? 0);
        }
      }
      const st = categoryStatus(g, min, future);
      const unit = rule?.unit ?? "point";
      return {
        groupId: String(g.id),
        name: g.name,
        unit,
        ...st,
        estimateBasis: plan && rule ? (`semester_plan:${rule.estimate.kind}` as string) : "published_only",
        ...(unit === "question"
          ? {
              // Canvas gives the student only the assessment TOTAL (Successful count) — no per-question
              // Successful/Revise/Retry marks — so not-yet-successful is derivable, the revise split is not.
              notYetSuccessful: Math.max(0, st.possible - st.earned),
              pendingRevisions: null,
              questionDetail: "totals_only" as const,
            }
          : {}),
      };
    });
}

export type GradePlanInput = {
  cls: Pick<IStudyClass, "grading" | "targetLetter" | "gradePolicy" | "grade"> & { canvasCourseId?: number };
  groups: IStudyAssignmentGroup[];
  itemIdByKey: Map<string, string>;
  schedule: ScheduledExam[];
  now: Date;
};

export function computeGradePlan({ cls, groups: rows, itemIdByKey, schedule, now }: GradePlanInput) {
  const scheme = schemeOf(cls);
  const weighted = !!cls.grading?.weighted;
  const sorted = rows.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const groups = sorted.map(toCalcGroup);
  const keyOf = new Map<number, string>();
  for (const r of sorted) for (const a of r.assignments ?? []) keyOf.set(a.canvasAssignmentId, itemKey(a.canvasType, a.canvasId));
  const itemIdOf = (assignmentId: number) => itemIdByKey.get(keyOf.get(assignmentId) ?? "") ?? null;
  const policy: StudyGradePolicy = cls.gradePolicy?.kind ? cls.gradePolicy : { kind: "weighted", min: null, categories: [] };

  const score = courseScore(groups, weighted);
  const targetLetter =
    cls.targetLetter && scheme.some((r) => r.name === cls.targetLetter) ? cls.targetLetter : defaultTargetLetter(scheme);
  const targetMin = round2((scheme.find((r) => r.name === targetLetter)?.value ?? 0.9) * 100);

  // ── Unpublished future exams, ONLY from the class exam schedule; points = Exam 1's points. ──
  const examGroup = pickExamGroup(groups);
  let estimatedGroups = groups;
  if (examGroup) {
    const ref =
      examGroup.assignments.filter(isCounted).sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0))[0] ??
      examGroup.assignments.find((a) => !a.omit && (a.points ?? 0) > 0);
    const known = examGroup.assignments.map((a) => a.name.toLowerCase());
    const future = schedule.filter(
      (s) =>
        (!s.date || s.date.getTime() > now.getTime()) &&
        !known.some((n) => n.includes(s.title.toLowerCase()) || s.title.toLowerCase().includes(n))
    );
    if (ref?.points && future.length) {
      const synthetic = future.map((s, i) => ({
        id: -(i + 1), // negative = estimated, never a Canvas id
        name: s.title,
        points: ref.points,
        omit: false,
        published: true,
        gradingType: "points",
        dueAt: s.date,
        score: null,
        excused: false,
      }));
      estimatedGroups = groups.map((g) => (g === examGroup ? { ...g, assignments: [...g.assignments, ...synthetic] } : g));
    }
  }
  const remainingOf = (g: CalcGroup) => g.assignments.filter((a) => isRemaining(a) && (a.points ?? 0) > 0);

  const groupsOut = estimatedGroups.map((g) => {
    const r = groupScore(g);
    const nameOf = new Map(g.assignments.map((a) => [a.id, a.name]));
    return {
      id: String(g.id),
      name: g.name,
      weight: g.weight,
      dropLowest: g.rules.dropLowest,
      dropHighest: g.rules.dropHighest,
      neverDrop: g.rules.neverDrop.map((id) => itemIdOf(id) ?? `canvas:${id}`),
      earned: round2(r.score),
      possible: round2(r.possible),
      effectivePct: r.pct === null ? null : round2(r.pct * 100),
      gradedCount: g.assignments.filter(isCounted).length,
      // Every counted score BEFORE drops (excused/omitted left out) — FE's what-if re-runs the drop rules.
      graded: g.assignments
        .filter(isCounted)
        .map((a) => ({ itemId: itemIdOf(a.id), assignmentId: String(a.id), title: a.name, score: a.score!, possible: a.points ?? 0 })),
      dropped: r.dropped.map((id) => ({ itemId: itemIdOf(id), title: nameOf.get(id) ?? "" })),
      remaining: remainingOf(g)
        .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity))
        .map((a) => ({
          itemId: a.id < 0 ? null : itemIdOf(a.id),
          assignmentId: a.id < 0 ? null : String(a.id),
          title: a.name,
          points: a.points!,
          dueAt: a.dueAt ? a.dueAt.toISOString() : null,
          estimated: a.id < 0,
        })),
    };
  });

  const base = {
    scheme: scheme.map((r) => ({ name: r.name, min: round2(r.value * 100) })),
    weighted,
    policy: { kind: policy.kind, min: policy.min ?? null, categories: policy.categories ?? [] },
    current: {
      score,
      letter: score === null ? null : letterFromScore(score, scheme),
      canvasScore: cls.grade?.score ?? null,
      basis: "canvas" as "canvas" | "lowest_category",
    },
    groups: groupsOut,
  };

  // ── "≥ min in every category" policy: per-category status; `required` does not apply. ──
  if (policy.kind === "all_categories_min") {
    const min = policy.min ?? 0.9;
    const categories = policyCategories(cls, groups, now);
    // Letter = the scheme letter of the WEAKEST category today (the policy is a min over categories).
    // `score` stays Canvas's own number (null for Calc), never a made-up blend.
    const pcts = categories.map((c) => c.pct).filter((p): p is number => p !== null);
    const lowest = pcts.length ? Math.min(...pcts) : null;
    return {
      ...base,
      current: { ...base.current, letter: lowest === null ? null : letterFromScore(lowest, scheme), lowestCategoryPct: lowest, basis: "lowest_category" as const },
      categories,
      target: { letter: targetLetter, min: round2(min * 100) },
      required: null,
    };
  }

  // ── weighted / total points: solve for the needed % ──
  const toSolve = (as: { id: number; points: number | null }[]) => as.map((a) => ({ id: a.id, points: a.points! }));
  const exams: { itemId: string | null; title: string; neededPct: number | null; estimated?: true; points: number; dueAt: string | null }[] = [];
  if (examGroup) {
    const eg = estimatedGroups[groups.indexOf(examGroup)];
    const rem = remainingOf(eg);
    const needed = solveNeededPct(estimatedGroups, weighted, toSolve(rem), targetMin);
    for (const a of rem)
      exams.push({
        itemId: a.id < 0 ? null : itemIdOf(a.id),
        title: a.name,
        neededPct: needed,
        ...(a.id < 0 ? { estimated: true as const } : {}),
        points: a.points!,
        dueAt: a.dueAt?.toISOString() ?? null,
      });
  }

  // Each group alone: only its remaining work (estimated exams included) moves.
  const byGroup = estimatedGroups.map((g) => ({
    groupId: String(g.id),
    neededPct: solveNeededPct(estimatedGroups, weighted, toSolve(remainingOf(g)), targetMin),
  }));

  return {
    ...base,
    target: { letter: targetLetter, min: targetMin },
    required: {
      byGroup,
      exams,
      examGroupId: examGroup ? String(examGroup.id) : null,
      examScheduleAvailable: schedule.length > 0,
    },
  };
}

export async function buildGradePlan(userId: Types.ObjectId, cls: IStudyClass, now = new Date()) {
  const [groups, items, schedule] = await Promise.all([
    StudyAssignmentGroup.find({ userId, classId: cls._id }).lean<IStudyAssignmentGroup[]>(),
    StudyItem.find(
      { userId, classId: cls._id, canvasType: { $in: ["Assignment", "Quiz", "Discussion"] } },
      { _id: 1, canvasType: 1, canvasId: 1 }
    ).lean<IStudyItem[]>(),
    loadExamSchedule(userId, cls._id),
  ]);
  const itemIdByKey = new Map(items.map((i) => [itemKey(i.canvasType, i.canvasId), String(i._id)]));
  return computeGradePlan({ cls, groups, itemIdByKey, schedule, now });
}

// ─── PATCH /study/classes/:id {targetLetter, gradePolicy} ───────────────────────────────

export async function validateGradeSettings(
  cls: IStudyClass,
  body: { targetLetter?: unknown; gradePolicy?: unknown }
): Promise<{ set: Record<string, unknown> } | { error: string }> {
  const set: Record<string, unknown> = {};
  if (body.targetLetter !== undefined) {
    const names = schemeOf(cls).map((r) => r.name);
    if (body.targetLetter !== null && (typeof body.targetLetter !== "string" || !names.includes(body.targetLetter)))
      return { error: `targetLetter must be one of ${names.join(", ")} or null` };
    set.targetLetter = body.targetLetter;
  }
  if (body.gradePolicy !== undefined) {
    const p = body.gradePolicy as any;
    if (p === null) set.gradePolicy = null;
    else {
      if (typeof p !== "object" || Array.isArray(p) || !(GRADE_POLICY_KINDS as readonly string[]).includes(p.kind))
        return { error: `gradePolicy.kind must be one of ${GRADE_POLICY_KINDS.join(", ")}` };
      if (p.kind === "weighted") set.gradePolicy = { kind: "weighted", min: null, categories: [] };
      else {
        if (typeof p.min !== "number" || !(p.min > 0 && p.min <= 1)) return { error: "gradePolicy.min must be a number in (0, 1]" };
        if (!Array.isArray(p.categories) || !p.categories.length || p.categories.length > 50 || !p.categories.every((c: unknown) => typeof c === "string" || typeof c === "number"))
          return { error: "gradePolicy.categories must be a non-empty array of group ids" };
        const ids = [...new Set<string>(p.categories.map(String))];
        const groups = await StudyAssignmentGroup.find({ userId: cls.userId, classId: cls._id }, { canvasGroupId: 1 }).lean();
        const own = new Set(groups.map((g) => String(g.canvasGroupId)));
        const foreign = ids.filter((id) => !own.has(id));
        if (foreign.length) return { error: `gradePolicy.categories are not groups of this class: ${foreign.join(", ")}` };
        set.gradePolicy = { kind: "all_categories_min", min: p.min, categories: ids };
      }
    }
  }
  return { set };
}

// ─── /today warnings ────────────────────────────────────────────────────────────────────

/**
 * Items in a policy category of an `all_categories_min` class, due in the next 48 h and still
 * not handed in — one miss there can cost the letter.
 */
export async function policyWarnings(userId: Types.ObjectId, classIds: Types.ObjectId[], now = new Date()) {
  const classes = await StudyClass.find(
    { _id: { $in: classIds }, userId, "gradePolicy.kind": "all_categories_min" },
    { gradePolicy: 1, canvasCourseId: 1 }
  ).lean<IStudyClass[]>();
  if (!classes.length) return [];
  const out: { itemId: string; classId: string; title: string; dueAt: string | null; reason: string }[] = [];
  for (const cls of classes) {
    const cats = (cls.gradePolicy?.categories ?? []).map(Number);
    const min = cls.gradePolicy?.min ?? 0.9;
    const rows = await StudyAssignmentGroup.find({ userId, classId: cls._id, canvasGroupId: { $in: cats } }).lean<IStudyAssignmentGroup[]>();
    const status = new Map(policyCategories(cls, rows.map(toCalcGroup), now).map((c) => [c.groupId, c]));
    const reasonOf = new Map<string, string>();
    for (const g of rows) {
      const st = status.get(String(g.canvasGroupId));
      if (!st) continue;
      const pct = round2(min * 100);
      const reason =
        st.status === "below"
          ? `${g.name} can no longer reach ${pct}% of the semester total — every item still counts`
          : `${g.name} needs ≥ ${pct}% of the semester total for the A — ${st.maxMissesAllowed} ${plural(st.maxMissesAllowed, "miss", "misses")} left`;
      for (const a of g.assignments ?? []) {
        if (a.omit || a.excused || typeof a.score === "number" || !((a.points ?? 0) > 0)) continue;
        reasonOf.set(itemKey(a.canvasType, a.canvasId), reason);
      }
    }
    if (!reasonOf.size) continue;
    const items = await StudyItem.find(
      {
        userId,
        classId: cls._id,
        dueAt: { $gte: now, $lte: new Date(now.getTime() + WARNING_WINDOW_MS) },
        $or: [{ submission: null }, { "submission.state": { $in: ["unsubmitted", "missing"] } }],
      },
      { _id: 1, canvasType: 1, canvasId: 1, title: 1, dueAt: 1 }
    )
      .sort({ dueAt: 1 })
      .lean<IStudyItem[]>();
    for (const it of items) {
      const reason = reasonOf.get(itemKey(it.canvasType, it.canvasId));
      if (reason)
        out.push({ itemId: String(it._id), classId: String(cls._id), title: it.title, dueAt: it.dueAt ? new Date(it.dueAt).toISOString() : null, reason });
    }
  }
  return out.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
}

export type { CategoryResult };
