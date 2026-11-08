import { Types } from "mongoose";
import { StudyClass, IStudyClass, StudyGradePolicy } from "@/models/study/class";
import { StudyAssignmentGroup } from "@/models/study/assignment-group";
import { CanvasApiError, CanvasClient } from "./canvas-client";
import { assignmentIdentity } from "./canvas-mapping";

/**
 * Grade-plan half of the Canvas sync: assignment groups (weights, drop rules, assignment →
 * group mapping, omit_from_final_grade, visible scores), the course grading standard and the
 * `apply_assignment_group_weights` flag. Called once per course from canvas-sync.service.
 */

type Json = Record<string, any>;

const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * Optional per-course grade rules, keyed by Canvas course id, seeded into the class policy on
 * first sync. Example — "an A means ≥ 90 % in EACH of these three groups":
 *   12345: { min: 0.9, categoryNames: [/^practice credits$/i, /^assessments$/i, /^engagement credits$/i] },
 */
export const SEEDED_POLICIES: Record<number, { min: number; categoryNames: RegExp[] }> = {};

export function mapAssignment(a: Json) {
  const id = assignmentIdentity(a);
  const sub = a.submission ?? null;
  return {
    canvasAssignmentId: Number(a.id),
    name: String(a.name ?? ""),
    points: typeof a.points_possible === "number" ? a.points_possible : null,
    dueAt: toDate(a.due_at),
    omit: !!a.omit_from_final_grade,
    published: a.published !== false,
    gradingType: a.grading_type ?? null,
    canvasType: id.canvasType,
    canvasId: id.canvasId,
    // The student API hides unposted scores (score null) — exactly what the student sees.
    score: sub && !sub.excused && typeof sub.score === "number" ? sub.score : null,
    excused: !!sub?.excused,
    workflowState: sub?.workflow_state ?? null,
  };
}

async function gradingScheme(client: CanvasClient, course: Json): Promise<{ name: string; value: number }[] | null> {
  const gsid = course.grading_standard_id;
  if (!gsid) return null;
  const shape = (std: Json | undefined) =>
    Array.isArray(std?.grading_scheme) ? std!.grading_scheme.map((r: Json) => ({ name: String(r.name), value: Number(r.value) })) : null;
  try {
    const list = await client.getAll<Json>(`/api/v1/courses/${course.id}/grading_standards?per_page=100`);
    const hit = shape(list.find((s) => Number(s.id) === Number(gsid)));
    if (hit) return hit;
  } catch {
    /* fall through */
  }
  try {
    return shape(await client.get<Json>(`/api/v1/courses/${course.id}/grading_standards/${gsid}`));
  } catch {
    return null;
  }
}

export async function syncGradebook(client: CanvasClient, userId: Types.ObjectId, cls: IStudyClass, course: Json) {
  const cid = Number(course.id);
  let groups: Json[];
  try {
    groups = await client.getAll<Json>(
      `/api/v1/courses/${cid}/assignment_groups?include[]=assignments&include[]=submission&per_page=100`
    );
  } catch (e) {
    if (e instanceof CanvasApiError && (e.status === 403 || e.status === 404)) groups = [];
    else throw e;
  }
  const scheme = await gradingScheme(client, course);

  for (const g of groups) {
    await StudyAssignmentGroup.updateOne(
      { userId, classId: cls._id, canvasGroupId: Number(g.id) },
      {
        $set: {
          name: String(g.name ?? ""),
          position: num(g.position),
          weight: num(g.group_weight),
          rules: {
            dropLowest: num(g.rules?.drop_lowest),
            dropHighest: num(g.rules?.drop_highest),
            neverDrop: (Array.isArray(g.rules?.never_drop) ? g.rules.never_drop : []).map(Number),
          },
          assignments: (Array.isArray(g.assignments) ? g.assignments : []).map(mapAssignment),
        },
      },
      { upsert: true }
    );
  }
  await StudyAssignmentGroup.deleteMany({ userId, classId: cls._id, canvasGroupId: { $nin: groups.map((g) => Number(g.id)) } });

  const set: Record<string, unknown> = { grading: { weighted: !!course.apply_assignment_group_weights, scheme } };
  const seed = SEEDED_POLICIES[cid];
  if (seed && !cls.gradePolicy) {
    const categories = seed.categoryNames
      .map((re) => groups.find((g) => re.test(String(g.name ?? "").trim())))
      .filter(Boolean)
      .map((g) => String(g!.id));
    if (categories.length === seed.categoryNames.length) {
      const policy: StudyGradePolicy = { kind: "all_categories_min", min: seed.min, categories };
      set.gradePolicy = policy;
    }
  }
  await StudyClass.updateOne({ _id: cls._id }, { $set: set });
}
