import { Types } from "mongoose";
import { StudyClass } from "@/models/study/class";
import { getAPlan, startBuild } from "@/services/study/a-plan";
import { denyUnlessAi } from "@/auth/verified";
import { fail, isOid, uid, wrap } from "./study.controller";

/**
 * GET  /study/classes/:id/a-plan          → 200 cached plan (`stale: true` while a rebuild runs)
 *                                          | 202 {status:'building'} when none exists yet (build started)
 * POST /study/classes/:id/a-plan/refresh  → 202 {status:'building', started} — full async rebuild
 *                                          (syllabus re-check, new digests, re-synthesis).
 */
export const getClassAPlan = wrap(async (req, res) => {
  if (await denyUnlessAi(req, res)) return;
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid class id");
  const r = await getAPlan(uid(req), req.params.id);
  if (r.status === "not_found") return fail(res, 404, "NOT_FOUND", "Class not found");
  if (r.status === "building") return res.status(202).json({ status: "building", lastError: r.lastError });
  res.json({ ...r.plan, stale: r.stale });
});

export const refreshClassAPlan = wrap(async (req, res) => {
  if (await denyUnlessAi(req, res)) return;
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid class id");
  const cls = await StudyClass.exists({ _id: req.params.id, userId: uid(req) });
  if (!cls) return fail(res, 404, "NOT_FOUND", "Class not found");
  const started = await startBuild(uid(req), new Types.ObjectId(req.params.id));
  res.status(202).json({ status: "building", started });
});
