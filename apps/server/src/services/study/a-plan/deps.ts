import { Types } from "mongoose";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyAssignmentGroup, IStudyAssignmentGroup } from "@/models/study/assignment-group";
import { buildGradePlan } from "../grade-plan";
import { StudyClassGuide, IStudyClassGuide, ExamScheduleEntry } from "@/models/study/library";
import { GUIDE_MAX_CHARS } from "../class-guide";

/**
 * ADAPTERS to modules built in parallel. The A plan treats null as "not available" and falls
 * back to its own data. Unwired ones return null — wire each when its PR lands; call sites do not change.
 *
 *  - getGradePlan      ✅ WIRED (#573): `buildGradePlan` from services/study/grade-plan.ts.
 *  - getOwnerPolicy    ✅ WIRED (#573): the class's `gradePolicy` (all_categories_min only;
 *                        `weighted` = Canvas's own rule = no owner-stated A rule).
 *  - getAssignmentGroups ✅ WIRED (#573): synced `study_assignment_groups`. Null (none synced yet)
 *                        → the A plan fetches `/courses/:id/assignment_groups` from Canvas itself.
 *  - getClassGuide     ✅ WIRED (#575): `study_class_guides.markdown` (also applied to every A-plan
 *                        model call as system context via class-guide `withClassGuide`).
 *  - getExamsSchedule  ✅ WIRED (#575): `study_class_guides.examsSchedule` (GET/PUT /study/classes/:id/exams-schedule).
 */

export type GradePlan = Record<string, unknown>;

/** Same shape as ClassPolicy.aRequirement. */
export interface OwnerPolicy {
  text: string;
  kind: "weighted" | "all_categories_min" | "points" | "other";
  min: number | null;
  categories: string[];
  /** Canvas assignment-group ids of `categories` (same order), when the rule names groups by id. */
  groupIds?: number[];
}

export interface AssignmentGroupLite {
  id: number;
  name: string;
  weight: number | null;
  /** Canvas assignment ids in the group (for per-category stats). */
  assignmentIds?: number[];
}

export type Guide = { markdown: string; updatedAt: Date | null };
export type ExamsSchedule = { exams: ExamScheduleEntry[] };

type Uid = Types.ObjectId | string;

const ownClass = (userId: Uid, classId: Uid) =>
  StudyClass.findOne({ _id: new Types.ObjectId(String(classId)), userId: new Types.ObjectId(String(userId)) }).lean<IStudyClass>();

export async function getGradePlan(userId: Uid, classId: Uid): Promise<GradePlan | null> {
  const cls = await ownClass(userId, classId);
  if (!cls) return null;
  return (await buildGradePlan(new Types.ObjectId(String(userId)), cls)) as unknown as GradePlan;
}

/** The owner's `gradePolicy`, as an A rule. min is stored 0..1 → percent here; category ids → group names. */
export async function getOwnerPolicy(userId: Uid, classId: Uid): Promise<OwnerPolicy | null> {
  const cls = await ownClass(userId, classId);
  const gp = cls?.gradePolicy;
  if (!cls || gp?.kind !== "all_categories_min") return null;
  const groups = await StudyAssignmentGroup.find({ userId: cls.userId, classId: cls._id }, { canvasGroupId: 1, name: 1 }).lean<IStudyAssignmentGroup[]>();
  const names = gp.categories.map((id) => groups.find((g) => String(g.canvasGroupId) === id)?.name ?? id);
  const min = gp.min === null || gp.min === undefined ? 90 : Math.round(gp.min * 1000) / 10;
  const groupIds = gp.categories.map(Number).filter((n) => Number.isFinite(n));
  return {
    text: `An A requires at least ${min}% in ALL ${names.length} categories: ${names.join(", ")}.`,
    kind: "all_categories_min",
    min,
    categories: names,
    ...(groupIds.length === names.length ? { groupIds } : {}),
  };
}

export async function getAssignmentGroups(
  userId: Uid,
  classId: Uid
): Promise<{ applyWeights: boolean; groups: AssignmentGroupLite[]; identity: Map<number, string> } | null> {
  const cls = await ownClass(userId, classId);
  if (!cls) return null;
  const rows = await StudyAssignmentGroup.find({ userId: cls.userId, classId: cls._id }).sort({ position: 1 }).lean<IStudyAssignmentGroup[]>();
  if (!rows.length) return null;
  const identity = new Map<number, string>();
  for (const g of rows) for (const a of g.assignments ?? []) identity.set(a.canvasAssignmentId, `${a.canvasType}/${a.canvasId}`);
  return {
    applyWeights: !!cls.grading?.weighted,
    groups: rows.map((g) => ({ id: g.canvasGroupId, name: g.name, weight: g.weight ?? null, assignmentIds: (g.assignments ?? []).map((a) => a.canvasAssignmentId) })),
    identity,
  };
}

/** Newest guide row of the class (same lookup as class-guide `loadClassGuide` / grade-plan). */
async function guideRow(userId: Uid, classId: Uid): Promise<IStudyClassGuide | null> {
  const cls = await ownClass(userId, classId);
  if (!cls) return null;
  return StudyClassGuide.findOne({ userId: cls.userId, canvasCourseId: cls.canvasCourseId }).sort({ updatedAt: -1 }).lean<IStudyClassGuide>();
}

export async function getClassGuide(userId: Uid, classId: Uid): Promise<Guide | null> {
  const g = await guideRow(userId, classId);
  const md = g?.markdown?.trim();
  return md ? { markdown: md.slice(0, GUIDE_MAX_CHARS), updatedAt: g!.updatedAt ?? null } : null;
}

export async function getExamsSchedule(userId: Uid, classId: Uid): Promise<ExamsSchedule | null> {
  const g = await guideRow(userId, classId);
  return g?.examsSchedule?.length
    ? { exams: g.examsSchedule.map((e) => ({ name: e.name, week: e.week ?? null, date: e.date ?? null, chapters: e.chapters ?? [], topics: e.topics ?? [] })) }
    : null;
}

export async function resolveOwnerPolicy(userId: Uid, classId: Uid): Promise<{ policy: OwnerPolicy; source: "owner" } | null> {
  const owner = await getOwnerPolicy(userId, classId);
  return owner ? { policy: owner, source: "owner" } : null;
}
