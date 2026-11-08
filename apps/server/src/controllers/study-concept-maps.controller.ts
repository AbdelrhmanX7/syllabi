import { Request, Response } from "express";
import { Types } from "mongoose";
import sharp from "sharp";
import { IStudyClass, StudyClass } from "@/models/study/class";
import { IStudyConceptMap, IStudyConceptMapAttempt, NOTES_PAGES_MAX, StudyConceptMap, StudyConceptMapAttempt } from "@/models/study/concept-map";
import { IStudyPage, StudyPage } from "@/models/study/page";
import { StudyAiUsage, StudyAiEndpoint } from "@/models/study/ai-usage";
import { newSpend, Spend, spendTotal, spendFor, spendForUser } from "@/services/study/ai-models";
import { cmTextJson } from "@/services/study/cm-text";
import { predictConceptMap } from "@/services/study/concept-map-predict";
import { CM_CONTEXT_MAX_CHARS, CmBlock, CmSource, conceptMapContext, dedupeSources, LectureScope, notesDigestFor, NotesPageFrame } from "@/services/study/concept-map-context";
import { PHOTO_IMAGES_MAX, PHOTO_MAX_PX, readPhotoTerms } from "@/services/study/concept-map-photo";
import { withClassGuide } from "@/services/study/ai";
import { openStudySse, StudySse } from "@/services/study/sse";
import { SourceError, toPng } from "@/services/study/extract-sources";
import { putStudyObject, signedGetUrl } from "@/services/study/storage";
import { cleanTerms, fillPromptTerms, TERMS_MAX } from "@/services/study/concept-map-terms";
import { QuestionDraft, questionDto, saveQuestion, toDraft } from "@/services/study/questions";
import {
  conceptMapDto,
  generateShortAnswers,
  gradeExamples,
  gradeReading,
  linkCanvasConceptMaps,
  manualScoreUpdate,
  ownClassForCourse,
  readConceptMap,
} from "@/services/study/concept-maps";
import {
  buildGenerateTurnEn,
  CM_GENERATE_SYSTEM_PROMPT_EN,
  ConceptGraph,
  isConnected,
  layoutGraph,
  parseGraph,
} from "@/services/whiteboard-ai/concept-map";
import { logger } from "@/services/logger.service";
import { classifyAiError, logAiFailure } from "@/services/study/ai-errors";
import { FROM_TERMS_CONTEXT_MAX_CHARS, FROM_TERMS_HINT_MAX, isPngOrJpeg, LANG_RX, mapTermsFromInk, parseClusters } from "@/services/study/concept-map-from-terms";
import { getLectureMaterial, LectureQuery, resolveLectureScope } from "@/services/study/lecture-material";
import { decodeB64Image } from "./study-questions.controller";
import { ownClass } from "./study-library.controller";
import { editedByDto, editedByOf, scopedMap } from "@/services/share/edit";
import { fail, isOid, uid, wrap } from "./study.controller";

/** Concept maps (P-CM): list (+ lazy Canvas link), practice, attempts, and the grade / predict / reference SSE streams. */

const MAX_TERMS = 20;
const termList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length >= 1 && v.length <= MAX_TERMS && v.every((t) => typeof t === "string" && t.trim() && t.length <= 120)
    ? [...new Map(v.map((t: string) => [t.trim().toLowerCase(), t.trim()])).values()]
    : null;

/** 400 NO_PROMPT_TERMS: the map (even after the lazy Canvas fill) has no terms — FE saves them with PATCH. */
const noPromptTerms = (res: Response) =>
  fail(res, 400, "NO_PROMPT_TERMS", "This concept map has no prompt terms yet — save them with PATCH /study/concept-maps/:id {promptTerms}, or send promptTerms in this request");

const ownMap = async (req: Request, res: Response, id: unknown): Promise<IStudyConceptMap | null> => {
  if (!isOid(id)) {
    fail(res, 400, "INVALID_ID", "Invalid concept map id");
    return null;
  }
  const m = await StudyConceptMap.findOne({ _id: id, userId: uid(req) }).lean<IStudyConceptMap>();
  if (!m) fail(res, 404, "NOT_FOUND", "Concept map not found");
  return m;
};

export async function writeUsage(userId: Types.ObjectId, endpoint: StudyAiEndpoint, spend: Spend, startedAt: number, status: "done" | "error" | "stopped", error?: string, errorCode?: string): Promise<string | null> {
  if (!spend.models.length && status !== "error") return null;
  try {
    const row = await StudyAiUsage.create({
      userId,
      endpoint,
      status,
      error: error ? error.slice(0, 500) : null,
      errorCode: status === "error" ? errorCode ?? null : null,
      models: spend.models,
      visionCostUsd: Number(spend.visionCostUsd.toFixed(6)),
      textCostUsd: Number(spend.textCostUsd.toFixed(6)),
      costUsd: Number(spendTotal(spend).toFixed(6)),
      latencyMs: Date.now() - startedAt,
    });
    return String(row._id);
  } catch (e) {
    await logger.error("study concept-map usage write failed", e as Error, { endpoint });
    return null;
  }
}

type CmSse = Pick<StudySse, "send" | "signal"> & { done(data?: Record<string, unknown>): Promise<void>; error(message: string, code?: string): Promise<void> };

/** SSE + spend + class guide: the terminal frame goes out after the usage row is written (`done` carries its id). */
async function runCm(res: Response, userId: Types.ObjectId, endpoint: StudyAiEndpoint, classId: Types.ObjectId | null, fn: (sse: CmSse, spend: Spend) => Promise<void>) {
  const startedAt = Date.now();
  const spend = await spendForUser(userId);
  const raw = openStudySse(res);
  let settled = false;
  const settle = async (status: "done" | "error" | "stopped", error?: string, errorCode?: string) => {
    if (settled) return null;
    settled = true;
    return writeUsage(userId, endpoint, spend, startedAt, raw.signal.aborted ? "stopped" : status, error, errorCode);
  };
  const sse: CmSse = {
    send: raw.send,
    signal: raw.signal,
    done: async (data = {}) => {
      const usageId = await settle("done");
      raw.done({ ...data, usageId });
    },
    error: async (message, code) => {
      await settle("error", `${code ?? ""} ${message}`.trim());
      raw.error(message, code);
    },
  };
  try {
    await withClassGuide(userId, classId, () => fn(sse, spend));
    await settle("stopped");
  } catch (e) {
    const c = e instanceof SourceError ? { code: e.code, message: e.message } : classifyAiError(e);
    if (!raw.signal.aborted) await logAiFailure(`study ${endpoint} failed`, e, {}, c.code);
    await settle("error", String((e as Error)?.message ?? e), c.code);
    raw.error(c.message, c.code);
  }
}

// ─── list / practice / attempts ─────────────────────────────────────────────────────────

const SOURCE_ORDER: Record<string, number> = { import: 0, canvas: 0, practice: 1 };

export const listConceptMaps = wrap(async (req, res) => {
  const cls = await ownClass(req, res, req.query.classId);
  if (!cls) return;
  const userId = uid(req);
  await linkCanvasConceptMaps(userId, cls);
  const maps = await Promise.all((await StudyConceptMap.find({ userId, canvasCourseId: cls.canvasCourseId }).lean<IStudyConceptMap[]>()).map((m) => fillPromptTerms(userId, m)));
  maps.sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      (a.number ?? 1e9) - (b.number ?? 1e9) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  res.json(await Promise.all(maps.map((m) => conceptMapDto(m, cls._id))));
});

const classOfMap = (req: Request, m: IStudyConceptMap) => ownClassForCourse(uid(req), m.canvasCourseId);

export const createPractice = wrap(async (req, res) => {
  const { classId, mapId, promptTerms } = req.body ?? {};
  if ((mapId === undefined || mapId === null) === (promptTerms === undefined || promptTerms === null))
    return fail(res, 400, "VALIDATION_ERROR", "Send exactly one of mapId or promptTerms");
  const terms = promptTerms !== undefined && promptTerms !== null ? termList(promptTerms) : null;
  if (promptTerms !== undefined && promptTerms !== null && !terms) return fail(res, 400, "VALIDATION_ERROR", `promptTerms must be 1–${MAX_TERMS} strings`);
  const cls = await ownClass(req, res, classId);
  if (!cls) return;
  let base: IStudyConceptMap | null = null;
  if (mapId !== undefined && mapId !== null) {
    base = await ownMap(req, res, mapId);
    if (!base) return;
    if (base.canvasCourseId !== cls.canvasCourseId) return fail(res, 404, "NOT_FOUND", "Concept map not found");
    base = await fillPromptTerms(uid(req), base);
    if (!base.promptTerms?.length) return noPromptTerms(res);
  }
  const doc = await StudyConceptMap.create({
    userId: uid(req),
    canvasUserId: null,
    canvasCourseId: cls.canvasCourseId,
    source: "practice",
    number: base?.number ?? null,
    week: base?.week ?? null,
    lecture: base?.lecture ?? null,
    // the ORIGINAL (non-practice) map, so a copy of a copy still resolves its lecture
    baseMapId: base ? (base.source === "practice" ? base.baseMapId ?? null : base._id) : null,
    promptTerms: base ? base.promptTerms : terms,
    maxScore: 10,
  });
  res.status(201).json(await conceptMapDto(doc.toObject() as IStudyConceptMap, cls._id));
});

const attemptDto = async (a: IStudyConceptMapAttempt) => ({
  id: String(a._id),
  mapId: String(a.mapId),
  promptTerms: a.promptTerms ?? [],
  imageUrl: a.imageKey ? (await signedGetUrl(a.imageKey)).url : null,
  reading: a.reading,
  criteria: a.criteria,
  verdict: a.verdict,
  score: a.verdict?.score ?? null,
  model: a.model ?? null,
  sources: a.sources ?? [],
  createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : null,
});

export const listAttempts = wrap(async (req, res) => {
  const m = await ownMap(req, res, req.params.id);
  if (!m) return;
  const rows = await StudyConceptMapAttempt.find({ userId: uid(req), mapId: m._id }).sort({ createdAt: -1 }).limit(100).lean<IStudyConceptMapAttempt[]>();
  res.json(await Promise.all(rows.map(attemptDto)));
});

/**
 * `PATCH /study/concept-maps/:id {score?, notesPageIds?, promptTerms?}` (at least one).
 * - promptTerms: 1–15 strings, trimmed + de-duplicated (case-insensitive) — the list the owner
 *   types or snaps from the slide in class; `promptTermsSource:'manual'`, never replaced by Canvas.
 * - score: manual override, 0..10 in steps of 0.5, wins until Canvas changes the linked
 *   submission's score; `null` clears it (back to Canvas, else the import).
 * - notesPageIds: the owner's notebook pages for this lecture, in order, ≤ NOTES_PAGES_MAX
 *   (duplicates dropped); every page must be the caller's and not deleted, else 404; `[]` unlinks.
 * Another user's map → 404. Returns the map DTO.
 * Sharing: an editor of the map (services/share/edit.ts) may send promptTerms only (score / notesPageIds
 * → 403) and gets back the terms-only shape the share view uses; the write records `editedBy`.
 */
export const patchConceptMap = wrap(async (req, res) => {
  const body = req.body ?? {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has("score") && !has("notesPageIds") && !has("promptTerms"))
    return fail(res, 400, "VALIDATION_ERROR", "Send score (a number 0–10 in steps of 0.5, or null), notesPageIds (page ids) and/or promptTerms (1–15 strings)");
  let promptTerms: string[] | null = null;
  if (has("promptTerms")) {
    const v = body.promptTerms;
    const valid = Array.isArray(v) && v.every((t) => typeof t === "string" && t.trim().length <= 120);
    const distinct = valid ? new Set((v as string[]).map((t) => t.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean)).size : 0;
    promptTerms = valid && distinct >= 1 && distinct <= TERMS_MAX ? cleanTerms(v) : null;
    if (!promptTerms)
      return fail(res, 400, "VALIDATION_ERROR", `promptTerms must be 1–${TERMS_MAX} distinct non-empty strings (max 120 chars each)`);
  }
  const score = body.score;
  if (has("score") && score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10 || !Number.isInteger(score * 2)))
    return fail(res, 400, "VALIDATION_ERROR", "score must be a number 0–10 in steps of 0.5, or null");
  let pageIds: Types.ObjectId[] | null = null;
  if (has("notesPageIds")) {
    const v = body.notesPageIds;
    if (!Array.isArray(v) || !v.every((x) => isOid(x))) return fail(res, 400, "VALIDATION_ERROR", "notesPageIds must be an array of page ids");
    const uniq = [...new Set(v.map((x: string) => x.toLowerCase()))];
    if (uniq.length > NOTES_PAGES_MAX) return fail(res, 400, "VALIDATION_ERROR", `notesPageIds: at most ${NOTES_PAGES_MAX} pages`);
    pageIds = uniq.map((x) => new Types.ObjectId(x));
  }
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid concept map id");
  const found = await scopedMap(req, req.params.id);
  if (!found) return fail(res, 404, "NOT_FOUND", "Concept map not found");
  const { doc: m, editor } = found;
  if (editor) {
    if (has("score") || has("notesPageIds")) return fail(res, 403, "FORBIDDEN", "Only the owner can change the score or the linked notes");
    const updated = await StudyConceptMap.findOneAndUpdate(
      { _id: m._id, userId: m.userId },
      { $set: { promptTerms, promptTermsSource: "manual", editedBy: editedByOf(editor) } },
      { new: true }
    ).lean<IStudyConceptMap>();
    if (!updated) return fail(res, 404, "NOT_FOUND", "Concept map not found");
    return res.json({
      id: String(updated._id),
      lecture: updated.lecture ?? null,
      week: updated.week ?? null,
      number: updated.number ?? null,
      promptTerms: updated.promptTerms ?? [],
      editedBy: editedByDto(updated.editedBy, updated.userId),
    });
  }
  const userId = uid(req);
  if (pageIds?.length) {
    const live = await StudyPage.countDocuments({ _id: { $in: pageIds }, userId, deletedAt: null });
    if (live !== pageIds.length) return fail(res, 404, "NOT_FOUND", "Page not found");
  }
  const $set: Record<string, unknown> = has("score") ? { ...manualScoreUpdate(m, score) } : {};
  if (pageIds) $set.notesPageIds = pageIds;
  if (promptTerms) Object.assign($set, { promptTerms, promptTermsSource: "manual", editedBy: null });
  const updated = await StudyConceptMap.findOneAndUpdate({ _id: m._id, userId }, { $set }, { new: true }).lean<IStudyConceptMap>();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Concept map not found");
  const cls = await classOfMap(req, updated);
  res.json(await conceptMapDto(updated, cls?._id ?? ""));
});

/** `GET /study/concept-maps/:id` → the map DTO (incl. notesPageIds + the cached notesDigest). */
export const getConceptMap = wrap(async (req, res) => {
  const found = await ownMap(req, res, req.params.id);
  if (!found) return;
  const m = await fillPromptTerms(uid(req), found);
  const cls = await classOfMap(req, m);
  res.json(await conceptMapDto(m, cls?._id ?? ""));
});

// ─── notes digest (SSE) ─────────────────────────────────────────────────────────────────

/**
 * `POST /study/concept-maps/:id/notes-digest` → `page {pageId, version, cached, error?}` per
 * linked page, in order → `digest {concepts, questions, missingFromNotes, conflicts}` →
 * `done {usageId, model, sources}`; `error {message, code}` (NO_NOTES when no pages are linked).
 * The digest itself (page reads, caching, the concept-map text chain) is
 * concept-map-context.notesDigestFor; an unchanged re-run replays the cache with no model call.
 */
export const notesDigest = wrap(async (req, res) => {
  const m = await ownMap(req, res, req.params.id);
  if (!m) return;
  const userId = uid(req);
  const cls = await classOfMap(req, m);
  await runCm(res, userId, "concept_map_notes", cls?._id ?? null, async (sse, spend) => {
    const ids = (m.notesPageIds ?? []).map(String);
    const rows = ids.length ? await StudyPage.find({ _id: { $in: ids }, userId, deletedAt: null }).lean<IStudyPage[]>() : [];
    const pages = ids.map((id) => rows.find((p) => String(p._id) === id)).filter((p): p is IStudyPage => !!p);
    if (!pages.length) return sse.error("Link this map's lecture notes pages first", "NO_NOTES");
    const r = await notesDigestFor({ userId, m, pages, spend, signal: sse.signal, onPage: (f: NotesPageFrame) => sse.send("page", f) });
    if (r.kind === "aborted") return;
    if (r.kind === "cached") {
      for (const v of r.versions) sse.send("page", { ...v, cached: true } satisfies NotesPageFrame);
      sse.send("digest", r.digest);
      return sse.done({ model: r.model, sources: r.sources });
    }
    if (r.kind === "nothing_read") return sse.error("Couldn't read anything on the linked notes pages", "NOTHING_READ");
    if (r.kind === "empty") return sse.error("Couldn't digest the notes this time — try again", "AI_EMPTY");
    sse.send("digest", r.digest);
    await sse.done({ model: r.model, sources: r.sources });
  });
});

// ─── grade (SSE) ────────────────────────────────────────────────────────────────────────

/**
 * `{classId, promptTerms, imagePngB64, mapId?}` → `reading {nodes, edges}` → 5× `criterion
 * {name, score, max, note}` → `verdict {...}` → `done {attemptId, usageId}`. With mapId the
 * attempt (and its image) is saved; promptTerms may be omitted then (the map's are used).
 */
export const gradeConceptMap = wrap(async (req, res) => {
  const { classId, mapId } = req.body ?? {};
  const img = decodeB64Image(req.body?.imagePngB64);
  if (!img) return fail(res, 400, "VALIDATION_ERROR", "imagePngB64 must be a base64 image (max ~8 MB)");
  let terms = req.body?.promptTerms !== undefined && req.body?.promptTerms !== null ? termList(req.body.promptTerms) : null;
  if (req.body?.promptTerms !== undefined && req.body?.promptTerms !== null && !terms) return fail(res, 400, "VALIDATION_ERROR", `promptTerms must be 1–${MAX_TERMS} strings`);
  const cls = await ownClass(req, res, classId);
  if (!cls) return;
  let map: IStudyConceptMap | null = null;
  if (mapId !== undefined && mapId !== null && mapId !== "") {
    map = await ownMap(req, res, mapId);
    if (!map) return;
    if (map.canvasCourseId !== cls.canvasCourseId) return fail(res, 404, "NOT_FOUND", "Concept map not found");
    if (!terms) {
      map = await fillPromptTerms(uid(req), map);
      terms = map.promptTerms?.length ? map.promptTerms : null;
      if (!terms) return noPromptTerms(res);
    }
  }
  if (!terms) return fail(res, 400, "VALIDATION_ERROR", "promptTerms is required");
  let png: Buffer;
  try {
    png = await toPng(img);
  } catch (e) {
    return fail(res, 400, "BAD_IMAGE", (e as Error).message);
  }
  const userId = uid(req);
  const promptTerms = terms;
  await runCm(res, userId, "concept_map_grade", cls._id, async (sse, spend) => {
    const reading = await readConceptMap(png, spend, sse.signal);
    if (sse.signal.aborted) return;
    sse.send("reading", reading);
    if (!reading.nodes.length) return sse.error("Couldn't read a concept map in that image", "NOTHING_READ");
    const anchors = await gradeExamples(userId, cls.canvasCourseId, map ? String(map._id) : null);
    // Lecture material grounds Accurate relationships. Notes stay out of it: the cached notes
    // digest only adds suggestions — it is never built here and never moves the score.
    const ctx = await conceptMapContext({ userId, cls, m: map, terms: promptTerms, spend, signal: sse.signal, notes: "none" });
    if (sse.signal.aborted) return;
    const digest = map?.notesDigest?.digest ?? null;
    const { criteria, verdict, model, maxChars } = await gradeReading({ terms: promptTerms, reading, ...anchors, notes: digest, material: (max) => ctx.pack(max).context }, spend, sse.signal);
    if (sse.signal.aborted) return;
    const sources = dedupeSources([...ctx.pack(maxChars ?? CM_CONTEXT_MAX_CHARS).sources, ...(digest ? [{ kind: "notes" as const, title: "Lecture notes digest" }] : [])]);
    for (const c of criteria) sse.send("criterion", c);
    sse.send("verdict", verdict);
    let attemptId: string | null = null;
    if (map) {
      const imageKey = `study/${userId}/concept-maps/${map._id}/${new Types.ObjectId()}.png`;
      await putStudyObject(imageKey, png, "image/png");
      const a = await StudyConceptMapAttempt.create({ userId, mapId: map._id, promptTerms, imageKey, reading, criteria, verdict, model, sources });
      attemptId = String(a._id);
    }
    await sse.done({ attemptId, model, sources });
  });
});

// ─── predict (SSE) ──────────────────────────────────────────────────────────────────────

export { currentWeek, packPastPrompts, PREDICT_ANSWER_MAX, PREDICT_PAST_SHARE } from "@/services/study/concept-map-predict";

/**
 * `{classId, lecture?, week?}` → `prediction {lecture:{number,title,date,week}, source, postedIn,
 * terms:[{term,p}], prompt[], modelAnswer, why, alternatives:[{prompt[], why}]}` (source "posted" =
 * a Canvas page of that lecture already lists the prompt, named in postedIn; else "predicted") → back-compat `prompt {terms[],
 * lecture, week, why}` frames (the most likely prompt first, then each alternative) → `done
 * {usageId, model, sources}`. The lecture is the one after the last concept map unless `lecture`
 * (its number) or `week` names it; see services/study/concept-map-predict.
 */
export const predictConceptMaps = wrap(async (req, res) => {
  const { classId } = req.body ?? {};
  const intOrNull = (v: unknown) => (v === undefined || v === null ? null : Number(v));
  const week = intOrNull(req.body?.week);
  const lectureNo = intOrNull(req.body?.lecture);
  if (week !== null && (!Number.isInteger(week) || week < 1 || week > 60)) return fail(res, 400, "VALIDATION_ERROR", "week must be an integer 1–60");
  if (lectureNo !== null && (!Number.isInteger(lectureNo) || lectureNo < 1 || lectureNo > 200)) return fail(res, 400, "VALIDATION_ERROR", "lecture must be an integer 1–200");
  const cls = await ownClass(req, res, classId);
  if (!cls) return;
  const userId = uid(req);
  await runCm(res, userId, "concept_map_predict", cls._id, async (sse, spend) => {
    const r = await predictConceptMap({ userId, cls, spend, signal: sse.signal, override: { week, lecture: lectureNo } });
    if (sse.signal.aborted) return;
    const p = r.prediction;
    if (!p) {
      await logger.warn("study concept-map predict: unusable reply", { replyKeys: r.raw && typeof r.raw === "object" ? Object.keys(r.raw).slice(0, 10) : String(r.raw === null ? "null (not JSON)" : typeof r.raw) });
      return sse.error("Couldn't predict prompts this time — try again", "AI_EMPTY");
    }
    sse.send("prediction", { lecture: r.lecture, source: r.source, postedIn: r.posted, terms: p.terms, prompt: p.prompt, modelAnswer: p.modelAnswer, why: p.why, alternatives: p.alternatives });
    const lecture = r.lecture.title ?? "";
    for (const x of [{ prompt: p.prompt, why: p.why }, ...p.alternatives]) sse.send("prompt", { terms: x.prompt, lecture, week: r.lecture.week, why: x.why });
    await sse.done({ model: r.model, sources: r.sources });
  });
});

// ─── reference (SSE) ────────────────────────────────────────────────────────────────────

type PhotoIn = { png: Buffer | null; raw: Buffer; origin: "phone" | "page" };
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const intOrNull = (v: unknown, min: number, max: number) => v === undefined || v === null || (Number.isInteger(v) && (v as number) >= min && (v as number) <= max);
/** Body `lecture` (the device's record for the page) → a LectureQuery, null when absent; "invalid" on a bad shape. */
function bodyLecture(v: unknown): LectureQuery | null | "invalid" {
  if (v === undefined || v === null) return null;
  const l = v as Record<string, unknown>;
  if (typeof v !== "object" || Array.isArray(v)) return "invalid";
  if (!intOrNull(l.number, 1, 999) || !intOrNull(l.week, 1, 30)) return "invalid";
  if (l.key !== undefined && l.key !== null && (typeof l.key !== "string" || l.key.length > 120)) return "invalid";
  if (l.date !== undefined && l.date !== null && (typeof l.date !== "string" || !YMD.test(l.date))) return "invalid";
  const lecture = { number: (l.number as number | null) ?? null, key: (l.key as string | null)?.trim() || undefined, date: (l.date as string | null) ?? undefined };
  return { lecture, week: (l.week as number | null) ?? undefined };
}
const knowsLecture = (q: LectureQuery) => q.lecture?.number != null || !!q.lecture?.key || !!q.lecture?.date || q.week != null;

/** The owner's notes pages for a lecture with no map: same lecture key/date, else same week; at most 20. */
async function scopeNotesPages(userId: Types.ObjectId, cls: IStudyClass, q: LectureQuery, scope: LectureScope): Promise<IStudyPage[]> {
  const key = q.lecture?.key;
  const or: Record<string, unknown>[] = [];
  if (key && !/^w\d+$/i.test(key)) or.push({ "lecture.key": key });
  for (const d of new Set([q.lecture?.date, scope.date].filter(Boolean))) or.push({ "lecture.date": d });
  if (!or.length && scope.week != null) or.push({ week: scope.week });
  if (!or.length) return [];
  return StudyPage.find({ userId, classId: cls._id, deletedAt: null, $or: or }, { title: 1, version: 1, ocrText: 1 }).sort({ createdAt: 1, _id: 1 }).limit(20).lean<IStudyPage[]>();
}

/**
 * `{classId, promptTerms?, mapId?, pageId?, lecture?, images?}` → the whiteboard
 * `/ai/concept-map/generate` frames, in study SSE framing: `status "…"` → (`terms {terms,
 * from:'image'}` when the terms were read off the pictures) → `result {graph, model, sources}`
 * (laid out, every node has a bbox; rect boxes, labeled end-arrows; `model` = the text model that
 * answered, `sources` = what grounded it, pictures first) → `done {usageId}`.
 * Terms: promptTerms, else ONE vision read of `images` (never written to the map), else the map's.
 * With mapId the context is that map's lecture (concept-map-context.conceptMapContext): its
 * module's slides and pages, its recordings, the owner's notes for it (the digest is built here
 * when missing), the textbook, its model answer — plus the pageId page's own notes. Without a map,
 * a pageId scopes it: the page's lecture/week (else the body's `lecture`) → that lecture's material
 * and the owner's notes pages for it, the page first.
 */
export const referenceConceptMap = wrap(async (req, res) => {
  const { classId, mapId, pageId } = req.body ?? {};
  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  let terms = given(req.body?.promptTerms) ? termList(req.body.promptTerms) : null;
  if (given(req.body?.promptTerms) && !terms) return fail(res, 400, "VALIDATION_ERROR", `promptTerms must be 1–${MAX_TERMS} strings`);
  const photos: PhotoIn[] = [];
  if (req.body?.images !== undefined && req.body?.images !== null) {
    const imgs = req.body.images;
    if (!Array.isArray(imgs) || imgs.length < 1 || imgs.length > PHOTO_IMAGES_MAX) return fail(res, 400, "VALIDATION_ERROR", `images must be 1–${PHOTO_IMAGES_MAX} pictures`);
    for (const [i, img] of imgs.entries()) {
      const raw = decodeB64Image(img?.jpegB64);
      if (!raw || !isPngOrJpeg(raw)) return fail(res, 400, "VALIDATION_ERROR", `images[${i}] must be a base64 PNG or JPEG`);
      photos.push({ raw, png: null, origin: img?.origin === "page" ? "page" : "phone" });
    }
  }
  const bodyLec = bodyLecture(req.body?.lecture);
  if (bodyLec === "invalid") return fail(res, 400, "VALIDATION_ERROR", "lecture must be {number, key, date 'YYYY-MM-DD', week} (each may be null)");
  const cls = await ownClass(req, res, classId);
  if (!cls) return;
  const userId = uid(req);
  let page: IStudyPage | null = null;
  if (given(pageId)) {
    if (!isOid(pageId)) return fail(res, 400, "INVALID_ID", "Invalid page id");
    page = await StudyPage.findOne({ _id: pageId, userId, deletedAt: null }, { classId: 1, lecture: 1, week: 1, title: 1, version: 1, ocrText: 1 }).lean<IStudyPage>();
    if (!page || String(page.classId) !== String(cls._id)) return fail(res, 404, "NOT_FOUND", "Page not found");
  }
  // the pictures are read only when no terms were sent — with promptTerms they cost nothing
  const fromImages = !terms && photos.length > 0;
  let map: IStudyConceptMap | null = null;
  if (given(mapId)) {
    map = await ownMap(req, res, mapId);
    if (!map) return;
    if (map.canvasCourseId !== cls.canvasCourseId) return fail(res, 404, "NOT_FOUND", "Concept map not found");
    if (!terms && !fromImages) {
      map = await fillPromptTerms(userId, map);
      terms = map.promptTerms?.length ? map.promptTerms : null;
      if (!terms) return noPromptTerms(res);
    }
  }
  if (!terms && !fromImages) return fail(res, 400, "VALIDATION_ERROR", "promptTerms is required");
  if (fromImages)
    for (const [i, p] of photos.entries()) {
      try {
        p.png = await toPng(p.raw, PHOTO_MAX_PX);
      } catch {
        return fail(res, 400, "VALIDATION_ERROR", `images[${i}] must be a base64 PNG or JPEG`);
      }
    }
  // No map: the page's lecture (its own fields win over the device's record) scopes the material.
  let scope: LectureScope | null = null;
  let notesPages: IStudyPage[] = page ? [page] : [];
  if (!map && page) {
    const q: LectureQuery =
      page.lecture || page.week != null
        ? { lecture: page.lecture ? { number: page.lecture.number, key: page.lecture.key || undefined, date: page.lecture.date || undefined } : undefined, week: page.week ?? undefined }
        : (bodyLec ?? {});
    if (knowsLecture(q)) {
      scope = await resolveLectureScope(userId, cls, q);
      const same = await scopeNotesPages(userId, cls, q, scope);
      notesPages = [page, ...same.filter((p) => String(p._id) !== String(page!._id))].slice(0, 20);
    }
  }
  const textTerms = terms;
  await runCm(res, userId, "concept_map_reference", cls._id, async (sse, spend) => {
    let promptTerms = textTerms ?? [];
    const extra: CmBlock[] = [];
    const imageSources: CmSource[] = [];
    if (fromImages) {
      sse.send("status", "Reading the terms off your photo…");
      const read = await readPhotoTerms(photos.map((p) => p.png!), spend, sse.signal);
      if (sse.signal.aborted) return;
      if (!read.terms.length) return sse.error("No terms found on the photo", "NO_TERMS_ON_IMAGE");
      promptTerms = read.terms;
      sse.send("terms", { terms: promptTerms, from: "image" });
      const text = read.summaries.map((s, i) => (s ? `Picture ${i + 1} (${photos[i].origin === "page" ? "on the notes page" : "phone photo"}): ${s}` : "")).filter(Boolean);
      extra.push({ kind: "image", title: "Pictures from the lecture", text: [...text, `Terms read off them: ${promptTerms.join(", ")}`].join("\n") });
      for (const p of photos) imageSources.push({ kind: "image", title: p.origin === "page" ? "Picture on this page" : "Photo from your phone" });
    }
    if (!map && notesPages.length) sse.send("status", "Reading your lecture notes…");
    // the read terms reach the context through `terms` only — `map` stays as stored (its notes digest is keyed on its own terms)
    const ctx = await conceptMapContext({ userId, cls, m: map, terms: promptTerms, spend, signal: sse.signal, notes: "build", onStatus: (t) => sse.send("status", t), scope, notesPages, extra });
    if (sse.signal.aborted) return;
    sse.send("status", "Drafting the reference map…");
    // Course material leads the turn, so maps of one class share the cacheable prompt prefix.
    const turn = (max: number) => buildGenerateTurnEn({ terms: promptTerms, title: map?.lecture ?? null, context: ctx.pack(max).context, contextMax: max, contextFirst: true });
    let graph: ConceptGraph | null = null;
    let model: string | null = null;
    let sources: CmSource[] = [];
    for (let attempt = 0; attempt < 2 && !graph; attempt++) {
      const r = await cmTextJson(CM_GENERATE_SYSTEM_PROMPT_EN, turn, spend, { signal: sse.signal, maxTokens: 16_000 });
      if (sse.signal.aborted) return;
      const g = parseGraph(r.out);
      if (g && g.nodes.length >= 3 && isConnected(g)) [graph, model, sources] = [g, r.model, ctx.pack(r.maxChars ?? CM_CONTEXT_MAX_CHARS).sources];
    }
    if (!graph) return sse.error("Couldn't draw a reference map this time — try again", "AI_EMPTY");
    sse.send("status", "Laying out the map…");
    const styled: ConceptGraph = {
      ...graph,
      direction: "TB",
      nodes: graph.nodes.map((n) => ({ ...n, shape: "rect" as const, color: graph!.style.nodeColors[n.level % graph!.style.nodeColors.length] })),
      edges: graph.edges.map((e) => ({ ...e, arrow: "end" as const })),
      style: { ...graph.style, font: "print" },
    };
    // one source per picture, first (the packed image block is a single entry)
    sse.send("result", { graph: layoutGraph(styled), model, sources: [...imageSources, ...sources.filter((x) => x.kind !== "image")] });
    await sse.done({});
  });
});

// ─── map my terms (SSE) ─────────────────────────────────────────────────────────────────

/**
 * `POST /study/ai/concept-map/from-terms {imagePngB64, imageSize?:{width,height}, clusters:[{id, bbox}],
 * classId?, pageId?, hint?, lang?}` →
 * `status {text}` → `terms_map {map}` → `done {usageId, repaired, sources}`. The owner's lassoed,
 * hand-written terms (one ink cluster ≈ one word) become a concept-map STRUCTURE; the FE redraws it
 * in his ink. With a pageId stamped with a lecture/week, that lecture's material grounds the
 * propositions (bounded — vision call). `lang` (default en) = the language of the title / edge
 * labels. imageSize is checked for shape only: bboxes are normalized, so the decoded size is what
 * the overlay uses when the two disagree. See services/study/concept-map-from-terms.
 */
export const conceptMapFromTerms = wrap(async (req, res) => {
  const { classId, pageId, hint, imageSize, lang } = req.body ?? {};
  const img = decodeB64Image(req.body?.imagePngB64);
  if (!img || !isPngOrJpeg(img)) return fail(res, 400, "VALIDATION_ERROR", "imagePngB64 must be a base64 PNG or JPEG (max ~8 MB)");
  const posInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 20_000;
  if (imageSize !== undefined && imageSize !== null && !(posInt(imageSize?.width) && posInt(imageSize?.height)))
    return fail(res, 400, "VALIDATION_ERROR", "imageSize must be {width, height} in positive whole pixels");
  if (lang !== undefined && lang !== null && lang !== "" && (typeof lang !== "string" || !LANG_RX.test(lang)))
    return fail(res, 400, "VALIDATION_ERROR", "lang must be a language code such as 'en'");
  const parsed = parseClusters(req.body?.clusters);
  if ("error" in parsed) return fail(res, 400, "VALIDATION_ERROR", parsed.error);
  if (hint !== undefined && hint !== null && (typeof hint !== "string" || hint.length > FROM_TERMS_HINT_MAX))
    return fail(res, 400, "VALIDATION_ERROR", `hint must be a string of at most ${FROM_TERMS_HINT_MAX} characters`);
  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  const userId = uid(req);
  let cls: IStudyClass | null = null;
  if (given(classId)) {
    cls = await ownClass(req, res, classId);
    if (!cls) return;
  }
  let page: IStudyPage | null = null;
  if (given(pageId)) {
    if (!isOid(pageId)) return fail(res, 400, "INVALID_ID", "Invalid page id");
    page = await StudyPage.findOne({ _id: pageId, userId, deletedAt: null }, { classId: 1, lecture: 1, week: 1 }).lean<IStudyPage>();
    if (!page || (cls && page.classId && String(page.classId) !== String(cls._id))) return fail(res, 404, "NOT_FOUND", "Page not found");
    if (!cls && page.classId) cls = await StudyClass.findOne({ _id: page.classId, userId }).lean<IStudyClass>();
  }
  let png: Buffer;
  try {
    png = await toPng(img);
  } catch (e) {
    return fail(res, 400, "BAD_IMAGE", (e as Error).message);
  }
  if (imageSize) {
    // toPng may downscale, so only the aspect can be compared; the decoded image wins either way
    const meta = await sharp(png).metadata();
    const aspect = (meta.width ?? 1) / (meta.height ?? 1);
    if (Math.abs(aspect / (imageSize.width / imageSize.height) - 1) > 0.02)
      await logger.warn("study concept-map from-terms: imageSize disagrees with the image", { imageSize, decoded: { width: meta.width, height: meta.height } });
  }
  const clusters = parsed.clusters;
  const lecturePage = cls && page && (page.lecture || page.week != null) ? page : null;
  await runCm(res, userId, "concept_map_from_terms", cls?._id ?? null, async (sse, spend) => {
    let material: string | null = null;
    let sources: CmSource[] = [];
    if (cls && lecturePage) {
      sse.send("status", { text: "Reading the lecture material…" });
      const lec = lecturePage.lecture;
      const m = await getLectureMaterial(userId, cls, { lecture: lec ? { number: lec.number, key: lec.key, date: lec.date } : undefined, week: lecturePage.week ?? undefined }, FROM_TERMS_CONTEXT_MAX_CHARS);
      if (sse.signal.aborted) return;
      [material, sources] = [m.text || null, m.sources];
    }
    sse.send("status", { text: "Mapping your terms…" });
    const r = await mapTermsFromInk({ png, clusters, hint: typeof hint === "string" ? hint.trim() || null : null, material, lang: lang || "en", spend, signal: sse.signal });
    if (sse.signal.aborted) return;
    if (!r) return sse.error("Couldn't map those terms this time — try again", "AI_EMPTY");
    sse.send("terms_map", { map: r.map });
    await sse.done({ repaired: r.repaired, sources });
  });
});

// ─── short answers ──────────────────────────────────────────────────────────────────────

/** `POST /study/concept-maps/:id/short-answers` → Question[] (type 'free', topic = lecture), saved via the bank's dedupe path. */
export const shortAnswers = wrap(async (req, res) => {
  const m = await ownMap(req, res, req.params.id);
  if (!m) return;
  if (!m.promptTerms?.length) return fail(res, 400, "NO_TERMS", "That concept map has no prompt terms yet");
  const userId = uid(req);
  const cls = (await classOfMap(req, m)) as IStudyClass | null;
  if (!cls) return fail(res, 409, "CLASS_NOT_SYNCED", "This map's class has not synced from Canvas yet");
  const startedAt = Date.now();
  const spend = await spendFor(req);
  let raws: any[];
  try {
    raws = await withClassGuide(userId, cls._id, () => generateShortAnswers(m, spend));
  } catch (e) {
    await writeUsage(userId, "concept_map_short_answers", spend, startedAt, "error", String((e as Error)?.message ?? e));
    throw e;
  }
  await writeUsage(userId, "concept_map_short_answers", spend, startedAt, "done");
  const topic = (m.lecture ?? (m.number ? `Concept Map ${m.number}` : "Concept map")).slice(0, 120);
  const source: QuestionDraft["source"] = { kind: "manual", itemId: null, pageId: null, lectureId: null, ref: `concept-map:${m._id}` };
  const seen = new Set<string>();
  const out = [];
  for (const r of raws) {
    let draft: QuestionDraft;
    try {
      draft = toDraft({ stem: r?.stem, answer: r?.answer, difficulty: r?.difficulty, tags: [...(Array.isArray(r?.tags) ? r.tags : []), "concept-map", "short-answer"], type: "free", topic }, { classId: cls._id, source });
      draft.source = source;
    } catch {
      continue;
    }
    const { doc } = await saveQuestion(userId, draft);
    if (seen.has(String(doc._id))) continue;
    seen.add(String(doc._id));
    out.push(questionDto(doc));
  }
  if (!out.length) return fail(res, 502, "AI_EMPTY", "Couldn't write short-answer questions this time — try again");
  res.json(out);
});
