import { Request, Response } from "express";
import { Types } from "mongoose";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyPage, IStudyPage } from "@/models/study/page";
import { StudyQuestion, IStudyQuestion, STUDY_QUESTION_SOURCE_KINDS, QuestionSourceKind } from "@/models/study/question";
import {
  decodeCursor,
  dedupeText,
  dueRule,
  encodeCursor,
  mergeTopics,
  QuestionDraft,
  QuestionInputError,
  questionDto,
  recordAttempt,
  reviewNext,
  saveQuestion,
  toDraft,
  topicMastery,
  REVIEW_MAX,
} from "@/services/study/questions";
import { stemHash, shingleHashes } from "@/services/study/dedupe";
import { newSrs } from "@/services/study/fsrs";
import { openStudySse, StudySse } from "@/services/study/sse";
import { newSpend, Spend } from "@/services/study/ai-models";
import { buildQuestionsFromImage, buildQuestionsFromText, generateSimilar, ReadTimeoutError } from "@/services/study/ai";
import { AttemptInputError, AttemptPlan, planAttempt, runPlan, selfRatingOf } from "@/services/study/attempt-grading";
import { htmlToText, parsePageRange, rasterisePdfRange, SourceError, toPng } from "@/services/study/extract-sources";
import { getStudyObject } from "@/services/study/storage";
import { logger } from "@/services/logger.service";
import { recordStudyUsage } from "@/services/study/usage";
import { classifyAiError, logAiFailure } from "@/services/study/ai-errors";
import { withClassGuide } from "@/services/study/ai";
import { StudyLibraryDoc, IStudyLibraryDoc } from "@/models/study/library";
import { libraryTextSource } from "@/services/study/library";
import { existingTopics, extractFromTranscript, flashcardsFromText, saveModelQuestions } from "@/services/study/extract";
import { itemTextSource, lectureTextSource, pageTextSource, TextSource, videoTextSource } from "@/services/study/text-sources";
import { editedByOf, isCard, questionWritable, scopedQuestion } from "@/services/share/edit";
import { loadCaller } from "@/services/share/access";
import { sharedQuestionDto } from "@/services/share/resources";
import { denyUnlessAi } from "@/auth/verified";
import { escapeRegex, fail, isOid, uid, wrap } from "./study.controller";

/**
 * Question bank (contract "Question bank", P2).
 *
 * Sharing: an editor of a deck / question set (services/share/edit.ts) may add, edit and delete the
 * owner's questions in it: content fields only, never progress (stats / schedule; attempt and similar
 * stay owner-only), and never class, topic, image or the flashcard tag (that would move a row out of
 * the share). Editors get the shared DTO back (no progress), and their writes record `editedBy`.
 */

export const MAX_IMAGE_B64 = 11 * 1024 * 1024; // ≈ 8 MB decoded
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const SAVE_MAX = 100;
const EXTRACT_CONCURRENCY = 3;
const QUESTION_PROJECTION = { shingles: 0 } as const;

const ownQuestion = async (req: Request, res: Response): Promise<IStudyQuestion | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid question id");
    return null;
  }
  const q = await StudyQuestion.findOne({ _id: req.params.id, userId: uid(req) }, QUESTION_PROJECTION).lean<IStudyQuestion>();
  if (!q) fail(res, 404, "NOT_FOUND", "Question not found");
  return q;
};

const ownClassIds = async (userId: Types.ObjectId, ids: string[]) => {
  const uniq = [...new Set(ids)];
  const found = await StudyClass.find({ _id: { $in: uniq.map((i) => new Types.ObjectId(i)) }, userId }, { _id: 1 }).lean();
  return found.length === uniq.length;
};

type BankEndpoint = "extract" | "attempt" | "similar" | "flashcards";

/** Persist one usage row; a logging failure never reaches the student. */
const recordUsage = (userId: Types.ObjectId, endpoint: BankEndpoint, spend: Spend, startedAt: number, status: "done" | "error" | "stopped", extra: { questionId?: Types.ObjectId; error?: string; errorCode?: string } = {}) =>
  recordStudyUsage(userId, endpoint, spend, startedAt, status, extra);

/** An SSE stream whose terminal frame is sent only AFTER the usage row is written. */
type BankSse = Omit<StudySse, "done" | "error"> & { done(data?: unknown): Promise<void>; error(message: string, code?: string): Promise<void> };

/** Ends an SSE stream on an unexpected throw and records the spend either way. */
async function runSse(
  res: Response,
  userId: Types.ObjectId,
  endpoint: BankEndpoint,
  fn: (sse: BankSse, spend: Spend) => Promise<void>,
  extra: { questionId?: Types.ObjectId; classId?: Types.ObjectId | null } = {}
) {
  const startedAt = Date.now();
  const raw = openStudySse(res);
  const spend = newSpend();
  let recorded = false;
  const record = async (status: "done" | "error" | "stopped", error?: string, errorCode?: string) => {
    if (recorded) return;
    recorded = true;
    await recordUsage(userId, endpoint, spend, startedAt, raw.signal.aborted ? "stopped" : status, { questionId: extra.questionId, error, errorCode });
  };
  const sse: BankSse = {
    send: raw.send,
    isOpen: raw.isOpen,
    signal: raw.signal,
    done: async (data) => {
      await record("done");
      raw.done(data);
    },
    error: async (message, code) => {
      await record("error", `${code ?? ""} ${message}`.trim());
      raw.error(message, code);
    },
  };
  try {
    await withClassGuide(userId, extra.classId, () => fn(sse, spend)); // P-CM: class guide as system context
    await record("stopped"); // fn returned without a terminal frame → the client left
  } catch (e) {
    const c = e instanceof SourceError ? { code: e.code, message: e.message } : classifyAiError(e);
    if (!raw.signal.aborted) await logAiFailure(`study ${endpoint} failed`, e, {}, c.code);
    await record("error", String((e as Error)?.message ?? e), c.code);
    raw.error(c.message, c.code);
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────────────────

export const listQuestions = wrap(async (req, res) => {
  const { classId, topic, due, source, q, limit, cursor } = req.query;
  const filter: Record<string, unknown> = { userId: uid(req) };
  if (classId !== undefined && classId !== "") {
    if (!isOid(classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
    filter.classId = new Types.ObjectId(String(classId));
  }
  if (topic !== undefined && topic !== "") {
    if (typeof topic !== "string" || topic.length > 120) return fail(res, 400, "VALIDATION_ERROR", "topic must be a string");
    filter.topic = topic;
  }
  if (source !== undefined && source !== "") {
    if (typeof source !== "string" || !(STUDY_QUESTION_SOURCE_KINDS as readonly string[]).includes(source))
      return fail(res, 400, "VALIDATION_ERROR", `source must be one of ${STUDY_QUESTION_SOURCE_KINDS.join(", ")}`);
    filter["source.kind"] = source;
  }
  if (due === "1" || due === "true") Object.assign(filter, dueRule(new Date()));
  if (q !== undefined && q !== "") {
    if (typeof q !== "string" || q.length > 200) return fail(res, 400, "VALIDATION_ERROR", "q must be a string (max 200)");
    const rx = { $regex: escapeRegex(q.trim()), $options: "i" };
    filter.$or = [{ stem: rx }, { tags: rx }];
  }
  let n = LIST_DEFAULT;
  if (limit !== undefined && limit !== "") {
    n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > LIST_MAX) return fail(res, 400, "VALIDATION_ERROR", `limit must be 1–${LIST_MAX}`);
  }
  if (cursor !== undefined && cursor !== "") {
    const c = typeof cursor === "string" ? decodeCursor(cursor) : null;
    if (!c) return fail(res, 400, "INVALID_CURSOR", "cursor is invalid");
    filter.$and = [{ $or: [{ createdAt: { $lt: c.createdAt } }, { createdAt: c.createdAt, _id: { $lt: c.id } }] }];
  }
  const rows = await StudyQuestion.find(filter, QUESTION_PROJECTION).sort({ createdAt: -1, _id: -1 }).limit(n + 1).lean<IStudyQuestion[]>();
  const page = rows.slice(0, n);
  res.json({ items: page.map(questionDto), next: rows.length > n ? encodeCursor(page[page.length - 1]) : null });
});

export const createQuestions = wrap(async (req, res) => {
  const list = req.body?.questions;
  if (!Array.isArray(list) || !list.length || list.length > SAVE_MAX) return fail(res, 400, "VALIDATION_ERROR", `questions must be a non-empty array (max ${SAVE_MAX})`);
  const drafts: QuestionDraft[] = [];
  for (let i = 0; i < list.length; i++) {
    try {
      drafts.push(toDraft(list[i], {}, { strictType: true }));
    } catch (e) {
      if (e instanceof QuestionInputError) return fail(res, 400, "VALIDATION_ERROR", `questions[${i}]: ${e.message}`);
      throw e;
    }
  }
  const userId = uid(req);
  if (await ownClassIds(userId, drafts.map((d) => String(d.classId)))) {
    const out: IStudyQuestion[] = [];
    for (const d of drafts) out.push((await saveQuestion(userId, d)).doc);
    return res.json(out.map(questionDto));
  }
  // Not all the caller's classes: an editor adding to a shared deck / question set of ONE owner's class.
  const classIds = [...new Set(drafts.map((d) => String(d.classId)))];
  const cls = classIds.length === 1 ? await StudyClass.findById(classIds[0], { userId: 1 }).lean<IStudyClass>() : null;
  const caller = cls ? await loadCaller(req.adminId) : null;
  if (!cls || !caller) return fail(res, 404, "NOT_FOUND", "Class not found");
  for (const d of drafts) {
    // No links into anyone's material; progress starts fresh (the owner's own schedule).
    d.source = { kind: "manual", itemId: null, pageId: null, lectureId: null, ref: null };
    d.imageUrl = null;
    if (!(await questionWritable(caller, cls.userId, cls._id, d.topic, isCard(d.tags)))) return fail(res, 404, "NOT_FOUND", "Class not found");
  }
  const editedBy = editedByOf(caller);
  const out: IStudyQuestion[] = [];
  // A plain insert, never the duplicate merge: that could touch an owner question outside the share.
  for (const d of drafts) {
    const created = await StudyQuestion.create({
      userId: cls.userId,
      ...d,
      stats: { attempts: 0, correct: 0, lastResult: null, mastery: 0 },
      srs: newSrs(new Date()),
      stemHash: stemHash(dedupeText(d)),
      shingles: shingleHashes(dedupeText(d)),
      editedBy,
    });
    out.push(created.toObject() as IStudyQuestion);
  }
  res.json(out.map(sharedQuestionDto));
});

const PATCHABLE = ["classId", "topic", "subtopic", "difficulty", "type", "stem", "imageUrl", "choices", "pairs", "answer", "solutionSteps", "tags"] as const;
/** What an editor (not the owner) may never change: these would move the row out of the share or into the editor's account. */
export const EDITOR_LOCKED = ["classId", "topic", "imageUrl"] as const;

/** A question the caller owns, or one in a deck / question set shared with them to edit. */
const editableQuestion = async (req: Request, res: Response) => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid question id");
    return null;
  }
  const found = await scopedQuestion(req, req.params.id, QUESTION_PROJECTION);
  if (!found) fail(res, 404, "NOT_FOUND", "Question not found");
  return found;
};

/** Only the content fields are editable; source/stats/srs/createdAt are ignored if sent. */
export const patchQuestion = wrap(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const patch = Object.fromEntries(PATCHABLE.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  if (!Object.keys(patch).length) return fail(res, 400, "VALIDATION_ERROR", `Nothing to update (editable: ${PATCHABLE.join(", ")})`);
  const found = await editableQuestion(req, res);
  if (!found) return;
  const { doc: q, editor } = found;
  if (editor) {
    const locked = EDITOR_LOCKED.find((k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(questionDto(q)[k]));
    if (locked) return fail(res, 403, "FORBIDDEN", `Only the owner can change ${locked}`);
    if (patch.tags !== undefined && (!Array.isArray(patch.tags) || isCard(patch.tags as string[]) !== isCard(q.tags)))
      return fail(res, 403, "FORBIDDEN", "Only the owner can turn a question into a card or back");
  }
  const current = questionDto(q);
  let draft: QuestionDraft;
  try {
    draft = toDraft({ ...current, ...patch, source: current.source }, {}, { strictType: true });
  } catch (e) {
    if (e instanceof QuestionInputError) return fail(res, 400, "VALIDATION_ERROR", e.message);
    throw e;
  }
  if (patch.classId !== undefined && !editor && !(await ownClassIds(uid(req), [String(draft.classId)]))) return fail(res, 404, "NOT_FOUND", "Class not found");
  const { source: _s, ...fields } = draft;
  // An editor's write is pinned to the row's class and topic (checked above; pinned again here).
  const scope = editor ? { classId: q.classId, topic: q.topic } : {};
  const updated = await StudyQuestion.findOneAndUpdate(
    { _id: q._id, userId: q.userId, ...scope },
    { $set: { ...fields, ...scope, stemHash: stemHash(dedupeText(draft)), shingles: shingleHashes(dedupeText(draft)), editedBy: editor ? editedByOf(editor) : null } },
    { new: true, projection: QUESTION_PROJECTION }
  ).lean<IStudyQuestion>();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Question not found");
  res.json(editor ? sharedQuestionDto(updated) : questionDto(updated));
});

export const deleteQuestion = wrap(async (req, res) => {
  const found = await editableQuestion(req, res);
  if (!found) return;
  await StudyQuestion.deleteOne({ _id: found.doc._id, userId: found.doc.userId });
  res.status(204).end();
});

// ─── review + mastery ───────────────────────────────────────────────────────────────────

const classScope = async (req: Request, res: Response): Promise<{ ok: boolean; classId: Types.ObjectId | null }> => {
  const { classId } = req.query;
  if (classId === undefined || classId === "") return { ok: true, classId: null };
  if (!isOid(classId)) {
    fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
    return { ok: false, classId: null };
  }
  if (!(await StudyClass.exists({ _id: classId, userId: uid(req) }))) {
    fail(res, 404, "NOT_FOUND", "Class not found");
    return { ok: false, classId: null };
  }
  return { ok: true, classId: new Types.ObjectId(String(classId)) };
};

export const getReviewNext = wrap(async (req, res) => {
  let n = 20;
  if (req.query.limit !== undefined && req.query.limit !== "") {
    n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1 || n > REVIEW_MAX) return fail(res, 400, "VALIDATION_ERROR", `limit must be 1–${REVIEW_MAX}`);
  }
  const scope = await classScope(req, res);
  if (!scope.ok) return;
  res.json((await reviewNext(uid(req), scope.classId, n)).map(questionDto));
});

export const getMastery = wrap(async (req, res) => {
  const scope = await classScope(req, res);
  if (!scope.ok) return;
  const rows = await topicMastery(uid(req), scope.classId ? { classId: scope.classId } : {});
  res.json({ topics: mergeTopics(rows) });
});

// ─── extract (SSE) ──────────────────────────────────────────────────────────────────────

const HTML_TYPES = ["page", "assignment", "quiz", "announcement"];

export const decodeB64Image = (v: unknown): Buffer | null => {
  if (typeof v !== "string" || !v || v.length > MAX_IMAGE_B64) return null;
  const b = Buffer.from(v.replace(/^data:[^;]+;base64,/, ""), "base64");
  return b.length > 32 ? b : null;
};

type Prepared =
  | { kind: "error"; message: string; code: string }
  | { kind: "images"; load: () => Promise<Buffer[]>; source: QuestionDraft["source"]; classId: Types.ObjectId | null }
  | { kind: "text"; text: string; source: QuestionDraft["source"]; classId: Types.ObjectId | null }
  | { kind: "transcript"; text: string; source: QuestionDraft["source"]; classId: Types.ObjectId | null };

const src = (kind: QuestionSourceKind, ids: { itemId?: Types.ObjectId; pageId?: Types.ObjectId } = {}): QuestionDraft["source"] => ({
  kind,
  itemId: ids.itemId ?? null,
  pageId: ids.pageId ?? null,
  lectureId: null,
  ref: null,
});

export const extractQuestions = wrap(async (req, res) => {
  const { classId, from } = req.body ?? {};
  if (!from || typeof from !== "object") return fail(res, 400, "VALIDATION_ERROR", "from is required");
  const keys = (["itemId", "pageId", "lectureId", "imagePngB64", "libraryId"] as const).filter((k) => from[k] !== undefined && from[k] !== null && from[k] !== "");
  if (keys.length !== 1) return fail(res, 400, "VALIDATION_ERROR", "from needs exactly one of itemId, pageId, lectureId, imagePngB64, libraryId");
  if (classId !== undefined && classId !== null && !isOid(classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
  const userId = uid(req);

  let prepared: Prepared;
  if (keys[0] === "lectureId") {
    if (!isOid(from.lectureId)) return fail(res, 400, "VALIDATION_ERROR", "lectureId must be an id");
    const ts = await lectureTextSource(userId, from.lectureId);
    if (ts.kind === "missing") return fail(res, 404, "NOT_FOUND", "Lecture not found");
    prepared = ts.kind === "text" ? { kind: "transcript", text: ts.text, source: ts.source, classId: ts.classId } : { kind: "error", message: ts.message, code: ts.code };
  } else if (keys[0] === "itemId") {
    if (!isOid(from.itemId)) return fail(res, 400, "VALIDATION_ERROR", "itemId must be an id");
    const item = await StudyItem.findOne({ _id: from.itemId, userId }).lean<IStudyItem>();
    if (!item) return fail(res, 404, "NOT_FOUND", "Item not found");
    if (item.type === "file") {
      const mime = item.file?.mime ?? "";
      const key = item.file?.storageKey;
      if (!key) return fail(res, 400, "UNSUPPORTED_SOURCE", "This file has not been downloaded from Canvas yet");
      let range: { first: number; last: number };
      try {
        range = parsePageRange(from.pageRange);
      } catch (e) {
        return fail(res, 400, "VALIDATION_ERROR", (e as Error).message);
      }
      if (mime === "application/pdf") {
        prepared = { kind: "images", source: src("pdf", { itemId: item._id }), classId: item.classId, load: async () => (await rasterisePdfRange(await getStudyObject(key), range)).map((p) => p.png) };
      } else if (mime.startsWith("image/")) {
        prepared = { kind: "images", source: src("photo", { itemId: item._id }), classId: item.classId, load: async () => [await toPng(await getStudyObject(key))] };
      } else {
        return fail(res, 400, "UNSUPPORTED_SOURCE", `Only PDF and image files can be extracted (this one is ${mime || "unknown"})`);
      }
    } else if (item.type === "video") {
      const ts = await videoTextSource(userId, item);
      prepared = ts.kind === "text" ? { kind: "transcript", text: ts.text, source: ts.source, classId: ts.classId } : { kind: "error", message: ts.kind === "error" ? ts.message : "Item not found", code: ts.kind === "error" ? ts.code : "NOT_FOUND" };
    } else if (HTML_TYPES.includes(item.type)) {
      const text = `${item.title}\n\n${htmlToText(item.html ?? "")}`.trim();
      const kind: QuestionSourceKind = item.type === "quiz" ? "canvas_quiz" : /derivita/i.test(item.external?.tool ?? "") ? "derivita" : "manual";
      prepared = text.length > item.title.length + 10 ? { kind: "text", text, source: src(kind, { itemId: item._id }), classId: item.classId } : { kind: "error", message: "This item has no text to extract questions from", code: "EMPTY_SOURCE" };
    } else {
      return fail(res, 400, "UNSUPPORTED_SOURCE", `Questions cannot be extracted from a ${item.type} item`);
    }
  } else if (keys[0] === "libraryId") {
    // P-CM: a class library doc — stored PDF/image → vision pages; a note or text-only PDF → its text.
    if (!isOid(from.libraryId)) return fail(res, 400, "VALIDATION_ERROR", "libraryId must be an id");
    const lib = await StudyLibraryDoc.findOne({ _id: from.libraryId, userId }, { kind: 1, file: 1, canvasCourseId: 1 }).lean<IStudyLibraryDoc>();
    if (!lib) return fail(res, 404, "NOT_FOUND", "Library doc not found");
    let range: { first: number; last: number };
    try {
      range = parsePageRange(from.pageRange);
    } catch (e) {
      return fail(res, 400, "VALIDATION_ERROR", (e as Error).message);
    }
    const libCls = await StudyClass.findOne({ userId, canvasCourseId: lib.canvasCourseId }, { _id: 1 }).lean<IStudyClass>();
    const key = lib.file?.storageKey;
    const lsrc: QuestionDraft["source"] = { kind: lib.kind === "pdf" ? "pdf" : lib.kind === "image" ? "photo" : "manual", itemId: null, pageId: null, lectureId: null, ref: `library:${lib._id}` };
    if (key && lib.kind === "pdf") prepared = { kind: "images", source: lsrc, classId: libCls?._id ?? null, load: async () => (await rasterisePdfRange(await getStudyObject(key), range)).map((p) => p.png) };
    else if (key && lib.kind === "image") prepared = { kind: "images", source: lsrc, classId: libCls?._id ?? null, load: async () => [await toPng(await getStudyObject(key))] };
    else {
      const ts = await libraryTextSource(userId, String(lib._id), from.pageRange ? range : {});
      prepared = ts.kind === "text" ? { kind: "text", text: ts.text, source: ts.source, classId: ts.classId } : { kind: "error", message: ts.kind === "error" ? ts.message : "Library doc not found", code: ts.kind === "error" ? ts.code : "NOT_FOUND" };
    }
  } else if (keys[0] === "pageId") {
    if (!isOid(from.pageId)) return fail(res, 400, "VALIDATION_ERROR", "pageId must be an id");
    const page = await StudyPage.findOne({ _id: from.pageId, userId, deletedAt: null }).lean<IStudyPage>();
    if (!page) return fail(res, 404, "NOT_FOUND", "Page not found");
    prepared = page.ocrText?.trim()
      ? { kind: "text", text: `${page.title}\n\n${page.ocrText}`, source: src("manual", { pageId: page._id }), classId: page.classId }
      : { kind: "error", message: "This page has no handwriting text yet — open it in the app so it can send its OCR text (PUT /study/pages/:id/ocr), then try again", code: "NO_OCR_TEXT" };
  } else {
    const buf = decodeB64Image(from.imagePngB64);
    if (!buf) return fail(res, 400, "VALIDATION_ERROR", "imagePngB64 must be a base64 image (max ~8 MB)");
    prepared = { kind: "images", source: src("photo"), classId: null, load: async () => [await toPng(buf)] };
  }

  const clsId = classId ? new Types.ObjectId(classId) : prepared.kind === "error" ? null : prepared.classId;
  if (!clsId && prepared.kind !== "error") return fail(res, 400, "VALIDATION_ERROR", "classId is required");
  const cls = clsId ? await StudyClass.findOne({ _id: clsId, userId }, { name: 1 }).lean<IStudyClass>() : null;
  if (clsId && !cls) return fail(res, 404, "NOT_FOUND", "Class not found");

  await runSse(res, userId, "extract", async (sse, spend) => {
    if (prepared.kind === "error") return sse.error(prepared.message, prepared.code);
    if (prepared.kind === "transcript") {
      const count = await extractFromTranscript(userId, cls!, prepared.text, prepared.source, spend, (doc) => sse.send("question", questionDto(doc)), sse.signal);
      if (sse.signal.aborted) return;
      return sse.done({ count });
    }
    const ctx = { className: cls!.name, existingTopics: await existingTopics(userId, cls!._id) };
    const emitted = new Set<string>();
    const emit = (raws: any[]) => saveModelQuestions(userId, cls!._id, raws, prepared.source, emitted, (doc) => sse.send("question", questionDto(doc)), { signal: sse.signal });

    if (prepared.kind === "text") {
      await emit(await buildQuestionsFromText(prepared.text, ctx, spend, sse.signal));
      return sse.done({ count: emitted.size });
    }

    const images = await prepared.load();
    // Pages run EXTRACT_CONCURRENCY at a time, but are emitted strictly in page order.
    const settle: Array<(v: any[] | Error) => void> = [];
    const results = images.map(() => new Promise<any[] | Error>((r) => settle.push(r)));
    let next = 0;
    const workers = Array.from({ length: Math.min(EXTRACT_CONCURRENCY, images.length) }, async () => {
      while (next < images.length) {
        const i = next++;
        settle[i](sse.signal.aborted ? new Error("aborted") : await buildQuestionsFromImage(images[i], ctx, spend, sse.signal).catch((e: Error) => e));
      }
    });
    void Promise.all(workers);
    const failedPages: number[] = [];
    let lastError: Error | null = null;
    for (let i = 0; i < results.length; i++) {
      const r = await results[i];
      if (sse.signal.aborted) return;
      if (r instanceof Error) {
        failedPages.push(i + 1);
        lastError = r;
        continue;
      }
      await emit(r);
    }
    if (failedPages.length === images.length && lastError) throw lastError;
    sse.done(failedPages.length ? { count: emitted.size, failedPages } : { count: emitted.size });
  }, { classId: cls?._id });
});

// ─── attempt (SSE) ──────────────────────────────────────────────────────────────────────

export const attemptQuestion = wrap(async (req, res) => {
  const body = req.body ?? {};
  const { typed, choice, code } = body;
  const reveal = body.reveal === true;
  const usedHelp = reveal || body.hintUsed === true;
  const timeMs = Number(body.timeMs);
  const ink = body.inkPngB64 !== undefined && body.inkPngB64 !== null && body.inkPngB64 !== "" ? decodeB64Image(body.inkPngB64) : null;
  if (body.inkPngB64 && !ink) return fail(res, 400, "VALIDATION_ERROR", "inkPngB64 must be a base64 image (max ~8 MB)");
  for (const [k, v] of [["typed", typed], ["code", code]] as const)
    if (v !== undefined && v !== null && (typeof v !== "string" || v.length > 50_000)) return fail(res, 400, "VALIDATION_ERROR", `${k} must be a string`);
  const q = await ownQuestion(req, res);
  if (!q) return;

  let plan: AttemptPlan;
  try {
    plan = planAttempt(q, { typed, choice, code, ink, reveal, matches: body.matches, blanks: body.blanks, selfRating: body.selfRating });
  } catch (e) {
    if (e instanceof AttemptInputError) return fail(res, e.status, e.code, e.message);
    throw e;
  }
  // Typed / handwritten answers are graded (and read) by a model; choices, matching, blanks and
  // flashcard self-grades are not, so they work on every account.
  if (plan.kind !== "verdict" && (await denyUnlessAi(req, res))) return;

  await runSse(
    res,
    q.userId,
    "attempt",
    async (sse, spend) => {
      let graded: Awaited<ReturnType<typeof runPlan>>;
      try {
        graded = await runPlan(q, plan, reveal, spend, sse.signal, (text) => sse.send("reading", { text }));
      } catch (e) {
        if (e instanceof ReadTimeoutError) return sse.error(e.message, e.code);
        throw e;
      }
      if ("aborted" in graded) return;
      if ("nothingRead" in graded) return sse.error("Couldn't read any handwriting in that image", "NOTHING_READ");
      const verdict = graded.verdict;
      sse.send("verdict", verdict);
      const out = await recordAttempt(q, verdict.result, { timeMs: Number.isFinite(timeMs) ? timeMs : undefined, usedHelp, rating: selfRatingOf(body.selfRating) ?? undefined });
      sse.done(out);
    },
    { questionId: q._id, classId: q.classId }
  );
});

// ─── similar (SSE) ──────────────────────────────────────────────────────────────────────

export const similarQuestions = wrap(async (req, res) => {
  const raw = req.body?.count;
  const count = raw === undefined || raw === null ? 1 : Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 3) return fail(res, 400, "VALIDATION_ERROR", "count must be 1–3");
  const q = await ownQuestion(req, res);
  if (!q) return;
  await runSse(
    res,
    q.userId,
    "similar",
    async (sse, spend) => {
      const list = await generateSimilar(q, count, spend, sse.signal);
      if (sse.signal.aborted) return;
      const source: QuestionDraft["source"] = { kind: "ai_similar", itemId: q.source?.itemId ?? null, pageId: q.source?.pageId ?? null, lectureId: q.source?.lectureId ?? null, ref: String(q._id) };
      let n = 0;
      for (const r of list) {
        let draft: QuestionDraft;
        try {
          const { classId: _c, source: _s, type: _t, topic: _p, ...rest } = r ?? {};
          draft = toDraft({ ...rest, type: q.type, topic: q.topic, subtopic: rest.subtopic ?? q.subtopic }, { classId: q.classId, source });
          draft.source = source;
        } catch {
          continue;
        }
        const { doc, merged } = await saveQuestion(q.userId, draft);
        if (merged && String(doc._id) === String(q._id)) continue; // the model copied the original
        sse.send("question", questionDto(doc));
        n++;
      }
      if (!n) return sse.error("Couldn't generate a new question this time — try again", "AI_EMPTY");
      sse.done({ count: n });
    },
    { questionId: q._id, classId: q.classId }
  );
});

// ─── flashcards (SSE, P3) ───────────────────────────────────────────────────────────────

export const FLASHCARDS_DEFAULT = 10;
export const FLASHCARDS_MAX = 30;

/**
 * `{itemId|lectureId|pageId, classId?, count?}` → `event: question {Question}` (type 'free',
 * saved to the bank through the extract save step) … `done {count}`. Sources: a video's or a
 * lecture's transcript, a page/assignment/quiz/announcement body, a PDF's text layer, or a
 * notebook page's OCR text.
 */
export const flashcards = wrap(async (req, res) => {
  if (await denyUnlessAi(req, res)) return; // also reached in-process by the MCP tool, past the router gate
  const body = req.body ?? {};
  const keys = (["itemId", "lectureId", "pageId", "libraryId"] as const).filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== "");
  if (keys.length !== 1) return fail(res, 400, "VALIDATION_ERROR", "Send exactly one of itemId, lectureId, pageId, libraryId");
  if (!isOid(body[keys[0]])) return fail(res, 400, "VALIDATION_ERROR", `${keys[0]} must be an id`);
  const count = body.count === undefined || body.count === null ? FLASHCARDS_DEFAULT : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > FLASHCARDS_MAX) return fail(res, 400, "VALIDATION_ERROR", `count must be 1–${FLASHCARDS_MAX}`);
  if (body.classId !== undefined && body.classId !== null && !isOid(body.classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
  const userId = uid(req);
  const ts: TextSource =
    keys[0] === "itemId"
      ? await itemTextSource(userId, body.itemId)
      : keys[0] === "lectureId"
        ? await lectureTextSource(userId, body.lectureId)
        : keys[0] === "libraryId"
          ? await libraryTextSource(userId, body.libraryId)
          : await pageTextSource(userId, body.pageId);
  if (ts.kind === "missing") return fail(res, 404, "NOT_FOUND", `${ts.what} not found`);
  const clsId = body.classId ? new Types.ObjectId(body.classId) : ts.classId;
  if (!clsId && ts.kind === "text") return fail(res, 400, "VALIDATION_ERROR", "classId is required");
  const cls = clsId ? await StudyClass.findOne({ _id: clsId, userId }, { name: 1 }).lean<IStudyClass>() : null;
  if (clsId && !cls) return fail(res, 404, "NOT_FOUND", "Class not found");

  await runSse(res, userId, "flashcards", async (sse, spend) => {
    if (ts.kind === "error") return sse.error(ts.message, ts.code);
    const make = () => flashcardsFromText(userId, cls!, ts.text, count, ts.source, spend, (doc) => sse.send("question", questionDto(doc)), sse.signal);
    let n = await make();
    // The model occasionally returns nothing usable: one more try before AI_EMPTY. A thrown error
    // (incl. AI_QUOTA, which classifyAiError raises at runSse) is never retried — only an empty result.
    if (!n && !sse.signal.aborted) n = await make();
    if (sse.signal.aborted) return;
    if (!n) return sse.error("Couldn't make flashcards from this source — try again", "AI_EMPTY");
    sse.done({ count: n });
  }, { classId: cls?._id });
});
