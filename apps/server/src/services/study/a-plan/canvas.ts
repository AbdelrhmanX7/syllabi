import { Types } from "mongoose";
import { StudyCanvasConnection, IStudyCanvasConnection } from "@/models/study/canvas-connection";
import { decryptToken } from "../crypto";
import { CanvasClient } from "../canvas-client";
import { assignmentIdentity } from "../canvas-mapping";
import { AssignmentGroupLite, getAssignmentGroups } from "./deps";
import { isSyllabusTitle, SyllabusHints } from "./syllabus";

/**
 * The A plan's own read-only Canvas calls: the course's `syllabus_body` + time zone, and its
 * assignment groups (only when the Grade-plan adapter has none). Tests inject `fetchImpl`.
 */
export type CanvasDeps = { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };

type Json = Record<string, any>;

export async function clientFor(userId: Types.ObjectId, deps: CanvasDeps = {}): Promise<CanvasClient | null> {
  const conn = await StudyCanvasConnection.findOne({ userId }).lean<IStudyCanvasConnection>();
  if (!conn) return null;
  return new CanvasClient({ baseUrl: conn.baseUrl, token: decryptToken(conn.tokenEnc), fetchImpl: deps.fetchImpl, sleep: deps.sleep, maxRetries: 2 });
}

export async function fetchCourseSyllabus(client: CanvasClient, courseId: number): Promise<{ syllabusBody: string; timeZone: string | null }> {
  const c = await client.get<Json>(`/api/v1/courses/${courseId}?include[]=syllabus_body`);
  return { syllabusBody: typeof c?.syllabus_body === "string" ? c.syllabus_body : "", timeZone: typeof c?.time_zone === "string" ? c.time_zone : null };
}

/**
 * Module items whose MODULE title says syllabus. Needed because the sync names a File item by its
 * filename (e.g. "Math-101-0001 2026FA.pdf"), so the module title "Course Syllabus" is not on the item.
 */
export async function fetchSyllabusHints(client: CanvasClient, courseId: number): Promise<SyllabusHints> {
  const modules = await client.getAll<Json>(`/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`);
  const hints: SyllabusHints = { fileIds: [], pageUrls: [] };
  for (const m of modules)
    for (const it of Array.isArray(m.items) ? m.items : []) {
      if (!isSyllabusTitle(String(it.title ?? ""))) continue;
      if (it.type === "File" && it.content_id) hints.fileIds.push(String(it.content_id));
      if (it.type === "Page" && it.page_url) hints.pageUrls.push(String(it.page_url));
    }
  return hints;
}

export interface CanvasGroups {
  applyWeights: boolean;
  groups: AssignmentGroupLite[];
  /** Canvas assignment id → item identity key `${canvasType}/${canvasId}`. */
  identity: Map<number, string>;
  source: "grade-plan" | "canvas";
}

/** Assignment groups: the Grade-plan adapter's synced copy if present, else straight from Canvas. */
export async function loadAssignmentGroups(
  userId: Types.ObjectId,
  classId: Types.ObjectId,
  courseId: number,
  client: CanvasClient | null
): Promise<CanvasGroups | null> {
  const synced = await getAssignmentGroups(userId, classId);
  if (synced) return { ...synced, source: "grade-plan" };
  if (!client) return null;
  const [course, groups] = await Promise.all([
    client.get<Json>(`/api/v1/courses/${courseId}`),
    client.getAll<Json>(`/api/v1/courses/${courseId}/assignment_groups?include[]=assignments&per_page=100`),
  ]);
  const identity = new Map<number, string>();
  const out: AssignmentGroupLite[] = groups.map((g) => {
    const assignments: Json[] = Array.isArray(g.assignments) ? g.assignments : [];
    for (const a of assignments) {
      const id = assignmentIdentity(a);
      identity.set(Number(a.id), `${id.canvasType}/${id.canvasId}`);
    }
    return {
      id: Number(g.id),
      name: String(g.name ?? ""),
      weight: typeof g.group_weight === "number" ? g.group_weight : null,
      assignmentIds: assignments.map((a) => Number(a.id)),
    };
  });
  return { applyWeights: !!course?.apply_assignment_group_weights, groups: out, identity, source: "canvas" };
}
