import { Types } from "mongoose";
import { StudyBuddyMemory, StudyBuddyTurn } from "@/models/study/buddy";
import { BUDDY_EXPERTS } from "@/services/study/buddy/experts";
import { forgetBuddyMemory, rememberForBuddy } from "@/services/study/buddy/memory";
import { signedGetUrl } from "@/services/study/storage";
import { fail, isOid, uid, wrap } from "./study.controller";

/** The buddy's answer log, ratings, quick-check results and memory. See services/study/buddy. */

const turnDto = async (t: any, withImage: boolean) => ({
  id: String(t._id),
  at: t.createdAt,
  classId: t.classId ? String(t.classId) : null,
  pageId: t.pageId ? String(t.pageId) : null,
  question: t.question,
  handwritten: t.handwritten,
  skill: t.skill,
  expert: BUDDY_EXPERTS.find((e) => e.id === t.skill)?.name ?? t.skill,
  pickedBy: t.pickedBy,
  status: t.status,
  error: t.error,
  trace: t.trace,
  reply: t.reply,
  quizAnswer: t.quizAnswer,
  rating: t.rating,
  ratingNote: t.ratingNote,
  models: t.models,
  costUsd: t.costUsd,
  latencyMs: t.latencyMs,
  imageUrl: withImage && t.imageKey ? (await signedGetUrl(t.imageKey, { contentType: "image/jpeg" }).catch(() => null))?.url ?? null : null,
});

/** GET /study/ai/buddy/turns?limit=&before=&rating= → the caller's own turns, newest first. */
export const listBuddyTurns = wrap(async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const filter: Record<string, unknown> = { userId: uid(req) };
  if (isOid(req.query.before)) filter._id = { $lt: new Types.ObjectId(String(req.query.before)) };
  if (req.query.rating === "up" || req.query.rating === "down") filter.rating = req.query.rating;
  if (req.query.rating === "none") filter.rating = null;
  const rows = await StudyBuddyTurn.find(filter).sort({ _id: -1 }).limit(limit).lean();
  res.json({ turns: await Promise.all(rows.map((row) => turnDto(row, false))) });
});

/** GET /study/ai/buddy/turns/:id → one turn with the page as the buddy saw it. */
export const getBuddyTurn = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 404, "NOT_FOUND", "Not found");
  const row = await StudyBuddyTurn.findOne({ _id: req.params.id, userId: uid(req) }).lean();
  if (!row) return fail(res, 404, "NOT_FOUND", "Not found");
  res.json(await turnDto(row, true));
});

/** POST /study/ai/buddy/turns/:id/rating {rating: "up" | "down" | null, note?} */
export const rateBuddyTurn = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 404, "NOT_FOUND", "Not found");
  const rating = req.body?.rating;
  if (rating !== "up" && rating !== "down" && rating !== null) return fail(res, 400, "VALIDATION_ERROR", "rating must be up, down or null");
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : null;
  const done = await StudyBuddyTurn.updateOne({ _id: req.params.id, userId: uid(req) }, { $set: { rating, ratingNote: note || null } });
  if (!done.matchedCount) return fail(res, 404, "NOT_FOUND", "Not found");
  res.json({ ok: true });
});

/** POST /study/ai/buddy/turns/:id/quiz {choice} → {correct, answer, why}; the result joins the buddy's memory. */
export const answerBuddyQuiz = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 404, "NOT_FOUND", "Not found");
  const userId = uid(req);
  const row = await StudyBuddyTurn.findOne({ _id: req.params.id, userId }).lean();
  const quiz = (row?.reply as any)?.quiz;
  if (!row || !quiz) return fail(res, 404, "NOT_FOUND", "Not found");
  const choice = Number(req.body?.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= quiz.choices.length) return fail(res, 400, "VALIDATION_ERROR", "choice is out of range");
  const correct = choice === quiz.answer;
  // The first answer counts; a second tap only reads the result back.
  if (!row.quizAnswer) {
    await StudyBuddyTurn.updateOne({ _id: row._id, quizAnswer: null }, { $set: { quizAnswer: { choice, correct, at: new Date() } } });
    if (quiz.topic) {
      await rememberForBuddy(userId, row.classId, [`Quick check on ${quiz.topic}: ${correct ? "got it right" : "got it wrong"}.`], "quiz").catch(() => []);
    }
  }
  res.json({ correct, answer: quiz.answer, why: quiz.why });
});

/** GET /study/ai/buddy/memory?classId= → what the buddy remembers (this class + general). */
export const getBuddyMemory = wrap(async (req, res) => {
  const userId = uid(req);
  const classId = isOid(req.query.classId) ? new Types.ObjectId(String(req.query.classId)) : null;
  const rows = await StudyBuddyMemory.find({ userId, classId: classId ? { $in: [classId, null] } : null }).lean();
  res.json({
    notes: rows
      .flatMap((row) => row.notes.map((note) => ({ text: note.text, at: note.at, by: note.by, classId: row.classId ? String(row.classId) : null })))
      .sort((a, b) => +new Date(b.at) - +new Date(a.at)),
  });
});

/** POST /study/ai/buddy/memory/forget {text, classId?} */
export const forgetBuddyNote = wrap(async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text) return fail(res, 400, "VALIDATION_ERROR", "text is required");
  await forgetBuddyMemory(uid(req), isOid(req.body?.classId) ? new Types.ObjectId(String(req.body.classId)) : null, text);
  res.json({ ok: true });
});

/** GET /study/ai/buddy/experts → the experts and their jobs, as written (so the app can show them). */
export const listBuddyExperts = wrap(async (_req, res) => {
  res.json({ experts: BUDDY_EXPERTS.map((e) => ({ id: e.id, name: e.name, when: e.when, job: e.job })) });
});
