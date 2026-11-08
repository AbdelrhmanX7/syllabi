import { Types } from "mongoose";
import { StudyAPlan, IStudyAPlan } from "@/models/study/a-plan";

/**
 * Reading `study_a_plans` safely. The (userId, classId) unique index is NOT guaranteed: prod runs
 * with `autoIndex: false` (config/db.ts), so a claim upsert racing (or an upsert whose filter did
 * not match an existing busy row) could insert a SECOND row for the same class — an empty one
 * stuck at `building: true`. Every reader therefore looks at ALL rows of a class and picks:
 *  - the plan: the row with a plan and the newest generatedAt;
 *  - building: any row with a FRESH build claim (older than BUILD_STALE_MS = a crashed build).
 */
export const BUILD_STALE_MS = 5 * 60 * 1000;

export const isFreshBuild = (r: Pick<IStudyAPlan, "building" | "buildStartedAt">, now = Date.now()) =>
  !!r.building && !!r.buildStartedAt && now - new Date(r.buildStartedAt).getTime() < BUILD_STALE_MS;

export interface ClassPlanState {
  /** Row holding the newest plan (null when no row has one). */
  planRow: IStudyAPlan | null;
  /** The row a build should claim: the plan row, else the oldest row. */
  canonical: IStudyAPlan | null;
  building: boolean;
  lastError: string | null;
}

export function pickState(rows: IStudyAPlan[], now = Date.now()): ClassPlanState {
  const withPlan = rows.filter((r) => r.plan).sort((a, b) => (b.generatedAt?.getTime() ?? 0) - (a.generatedAt?.getTime() ?? 0));
  const byAge = [...rows].sort((a, b) => String(a._id).localeCompare(String(b._id)));
  const errored = [...rows].sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)).find((r) => r.lastError);
  return {
    planRow: withPlan[0] ?? null,
    canonical: withPlan[0] ?? byAge[0] ?? null,
    building: rows.some((r) => isFreshBuild(r, now)),
    lastError: errored?.lastError ?? null,
  };
}

/** State per class id (string key) for several classes in one query. */
export async function planStates(userId: Types.ObjectId, classIds: Types.ObjectId[], now = Date.now()): Promise<Map<string, ClassPlanState>> {
  const rows = await StudyAPlan.find({ userId, classId: { $in: classIds } }).lean<IStudyAPlan[]>();
  const byClass = new Map<string, IStudyAPlan[]>();
  for (const r of rows) {
    const k = String(r.classId);
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k)!.push(r);
  }
  return new Map(classIds.map((id) => [String(id), pickState(byClass.get(String(id)) ?? [], now)]));
}

export const planState = async (userId: Types.ObjectId, classId: Types.ObjectId, now = Date.now()) =>
  (await planStates(userId, [classId], now)).get(String(classId))!;
