import { Types } from "mongoose";
import { openStudySse } from "@/services/study/sse";
import { getConversation, listConversations, prepareAsk, runAsk, TutorInputError } from "@/services/study/tutor/ask";
import { StudyClass } from "@/models/study/class";
import { fail, isOid, uid, wrap } from "./study.controller";

/** Class tutor — POST /study/ai/ask (SSE) and the conversation reads. Every row is the caller's. */

export const postAsk = wrap(async (req, res) => {
  let prepared;
  try {
    prepared = await prepareAsk(uid(req), req.body);
  } catch (e) {
    if (e instanceof TutorInputError) return fail(res, e.status, e.code, e.message);
    throw e;
  }
  await runAsk(prepared, openStudySse(res));
});

export const getConversations = wrap(async (req, res) => {
  const userId = uid(req);
  const { classId } = req.query;
  let cid: Types.ObjectId | null = null;
  if (classId !== undefined && classId !== "") {
    if (!isOid(classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
    cid = new Types.ObjectId(String(classId));
    if (!(await StudyClass.exists({ _id: cid, userId }))) return fail(res, 404, "NOT_FOUND", "Class not found");
  }
  res.status(200).json(await listConversations(userId, cid));
});

export const getConversationById = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Conversation id must be an id");
  const c = await getConversation(uid(req), new Types.ObjectId(String(req.params.id)));
  if (!c) return fail(res, 404, "NOT_FOUND", "Conversation not found");
  res.status(200).json(c);
});
