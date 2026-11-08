import { StudyClass, IStudyClass } from "@/models/study/class";
import { buildGradePlan } from "@/services/study/grade-plan";
import { fail, isOid, uid, wrap } from "./study.controller";

/** GET /study/classes/:id/grade-plan */
export const getGradePlan = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid class id");
  const cls = await StudyClass.findOne({ _id: req.params.id, userId: uid(req) }).lean<IStudyClass>();
  if (!cls) return fail(res, 404, "NOT_FOUND", "Class not found");
  res.json(await buildGradePlan(uid(req), cls));
});
