import { Request, Response } from "express";
import { Types } from "mongoose";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyCanvasConnection } from "@/models/study/canvas-connection";
import {
  ExamScheduleEntry,
  IStudyClassGuide,
  IStudyExamResult,
  IStudyLabSpecimen,
  IStudyLibraryDoc,
  StudyClassGuide,
  StudyExamResult,
  StudyLabSpecimen,
  StudyLibraryDoc,
} from "@/models/study/library";
import { examResultDto, libraryDetailDto, libraryListDto, retrieveLibrary } from "@/services/study/library";
import { signedGetUrl } from "@/services/study/storage";
import { BlueprintError, resolveBlueprint, validateBlueprint } from "@/services/study/exam-blueprint";
import type { ExamBlueprint } from "@/models/study/library";
import { fail, isOid, uid, wrap } from "./study.controller";

/** Class library, guide, exam schedule, exam results, lab kit (P-CM). Every read is userId-scoped. */

export const ownClass = async (req: Request, res: Response, id: unknown = req.params.id): Promise<IStudyClass | null> => {
  if (!isOid(id)) {
    fail(res, 400, "INVALID_ID", "Invalid class id");
    return null;
  }
  const cls = await StudyClass.findOne({ _id: id, userId: uid(req) }).lean<IStudyClass>();
  if (!cls) fail(res, 404, "NOT_FOUND", "Class not found");
  return cls;
};

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

// ─── library ────────────────────────────────────────────────────────────────────────────

export const listClassLibrary = wrap(async (req, res) => {
  const cls = await ownClass(req, res);
  if (!cls) return;
  const filter: Record<string, unknown> = { userId: uid(req), canvasCourseId: cls.canvasCourseId };
  if (req.query.kind !== undefined && req.query.kind !== "") {
    if (!["note", "pdf", "image"].includes(String(req.query.kind))) return fail(res, 400, "VALIDATION_ERROR", "kind must be note, pdf or image");
    filter.kind = req.query.kind;
  }
  if (req.query.week !== undefined && req.query.week !== "") {
    const w = Number(req.query.week);
    if (!Number.isInteger(w) || w < 0 || w > 60) return fail(res, 400, "VALIDATION_ERROR", "week must be an integer");
    filter.week = w;
  }
  const docs = await StudyLibraryDoc.find(filter, { markdown: 0 }).sort({ week: 1, relPath: 1 }).lean<IStudyLibraryDoc[]>();
  res.json(docs.map(libraryListDto));
});

export const getLibraryDoc = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid library id");
  const doc = await StudyLibraryDoc.findOne({ _id: req.params.id, userId: uid(req) }).lean<IStudyLibraryDoc>();
  if (!doc) return fail(res, 404, "NOT_FOUND", "Library doc not found");
  res.json(await libraryDetailDto(doc));
});

/** `GET /study/classes/:id/library/search?q=&week=&limit=` — keyword retrieval over the class library. */
export const searchClassLibrary = wrap(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length > 300) return fail(res, 400, "VALIDATION_ERROR", "q must be at most 300 characters");
  const week = req.query.week !== undefined && req.query.week !== "" ? Number(req.query.week) : null;
  if (week !== null && !Number.isInteger(week)) return fail(res, 400, "VALIDATION_ERROR", "week must be an integer");
  if (!q && week === null) return fail(res, 400, "VALIDATION_ERROR", "q or week is required");
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(res, 400, "VALIDATION_ERROR", "limit must be 1–50");
  const cls = await ownClass(req, res);
  if (!cls) return;
  const hits = await retrieveLibrary({ userId: uid(req), canvasCourseId: cls.canvasCourseId, query: q, week, limit, maxChars: 1500 });
  res.json(hits.map((h) => ({ libraryId: h.docId, title: h.title, kind: h.kind, week: h.week, page: h.page, score: h.score, text: h.text })));
});

// ─── guide + exam schedule ──────────────────────────────────────────────────────────────

const guideFor = (userId: Types.ObjectId, cls: IStudyClass) =>
  StudyClassGuide.findOne({ userId, canvasCourseId: cls.canvasCourseId }).sort({ updatedAt: -1 }).lean<IStudyClassGuide>();

/** Owner's guide row for a class, created on first write (keyed like an import row so a re-import finds it). */
async function upsertGuide(userId: Types.ObjectId, cls: IStudyClass, set: Record<string, unknown>) {
  const existing = await guideFor(userId, cls);
  if (existing) return StudyClassGuide.findOneAndUpdate({ _id: existing._id }, { $set: set }, { new: true }).lean<IStudyClassGuide>();
  const conn = await StudyCanvasConnection.findOne({ userId }, { canvasUser: 1 }).lean<any>();
  return (await StudyClassGuide.create({ userId, canvasUserId: conn?.canvasUser?.id ?? null, canvasCourseId: cls.canvasCourseId, ...set })).toObject() as IStudyClassGuide;
}

export const getGuide = wrap(async (req, res) => {
  const cls = await ownClass(req, res);
  if (!cls) return;
  const g = await guideFor(uid(req), cls);
  res.json({ markdown: g?.markdown ?? "", updatedAt: iso(g?.editedAt ?? g?.updatedAt) });
});

export const GUIDE_MAX = 20_000;
export const putGuide = wrap(async (req, res) => {
  const md = req.body?.markdown;
  if (typeof md !== "string" || md.length > GUIDE_MAX) return fail(res, 400, "VALIDATION_ERROR", `markdown must be a string (max ${GUIDE_MAX} chars)`);
  const cls = await ownClass(req, res);
  if (!cls) return;
  const now = new Date();
  const g = await upsertGuide(uid(req), cls, { markdown: md, editedAt: now });
  res.json({ markdown: g!.markdown, updatedAt: iso(g!.editedAt) });
});

const scheduleDto = (e: ExamScheduleEntry) => ({ name: e.name, week: e.week ?? null, date: e.date ?? null, chapters: e.chapters ?? [], topics: e.topics ?? [] });

export const getExamsSchedule = wrap(async (req, res) => {
  const cls = await ownClass(req, res);
  if (!cls) return;
  const g = await guideFor(uid(req), cls);
  res.json((g?.examsSchedule ?? []).map(scheduleDto));
});

const strList = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.trim() && x.length <= 120);

export const putExamsSchedule = wrap(async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body?.schedule;
  if (!Array.isArray(list) || list.length > 20) return fail(res, 400, "VALIDATION_ERROR", "send an array of up to 20 {name, week, date?, chapters[], topics[]}");
  const out: ExamScheduleEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i] ?? {};
    if (typeof e.name !== "string" || !e.name.trim() || e.name.length > 120) return fail(res, 400, "VALIDATION_ERROR", `[${i}].name is required`);
    if (e.week !== undefined && e.week !== null && (!Number.isInteger(e.week) || e.week < 0 || e.week > 60)) return fail(res, 400, "VALIDATION_ERROR", `[${i}].week must be an integer or null`);
    if (e.date !== undefined && e.date !== null && (typeof e.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.date))) return fail(res, 400, "VALIDATION_ERROR", `[${i}].date must be YYYY-MM-DD or null`);
    for (const k of ["chapters", "topics"]) if (e[k] !== undefined && !strList(e[k], 30)) return fail(res, 400, "VALIDATION_ERROR", `[${i}].${k} must be an array of strings`);
    out.push({ name: e.name.trim(), week: e.week ?? null, date: e.date ?? null, chapters: (e.chapters ?? []).map((s: string) => s.trim()), topics: (e.topics ?? []).map((s: string) => s.trim()) });
  }
  const cls = await ownClass(req, res);
  if (!cls) return;
  const g = await upsertGuide(uid(req), cls, { examsSchedule: out, scheduleEditedAt: new Date() });
  res.json((g!.examsSchedule ?? []).map(scheduleDto));
});

// ─── exam results ───────────────────────────────────────────────────────────────────────

/** Validates a full (POST) or partial (PATCH) result body → the fields to write, or an error string. */
function examResultFields(b: any, partial: boolean): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  const has = (k: string) => b?.[k] !== undefined;
  if (!partial || has("name")) {
    if (typeof b?.name !== "string" || !b.name.trim() || b.name.length > 120) return "name is required";
    out.name = b.name.trim();
  }
  if (has("date")) {
    if (b.date !== null && (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date))) return "date must be YYYY-MM-DD";
    out.date = b.date;
  }
  for (const k of ["score", "maxScore"]) {
    if (!partial || has(k)) {
      if (typeof b?.[k] !== "number" || !Number.isFinite(b[k]) || b[k] < 0 || b[k] > 100_000) return `${k} must be a non-negative number`;
      out[k] = b[k];
    }
  }
  if (out.maxScore !== undefined && (out.maxScore as number) <= 0) return "maxScore must be positive";
  if (has("chapters")) {
    if (!strList(b.chapters, 40)) return "chapters must be an array of strings";
    out.chapters = b.chapters.map((s: string) => s.trim());
  }
  if (has("sections")) {
    if (!Array.isArray(b.sections) || b.sections.length > 30) return "sections must be an array";
    for (const s of b.sections)
      if (!s || typeof s.name !== "string" || !s.name.trim() || typeof s.score !== "number" || typeof s.max !== "number" || s.max <= 0 || s.score < 0) return "each section needs {name, score, max}";
    out.sections = b.sections.map((s: any) => ({ name: s.name.trim().slice(0, 120), score: s.score, max: s.max }));
  }
  if (has("notes")) {
    if (b.notes !== null && (typeof b.notes !== "string" || b.notes.length > 5000)) return "notes must be a string";
    out.notes = b.notes;
  }
  return out;
}

export const listExamResults = wrap(async (req, res) => {
  const cls = await ownClass(req, res);
  if (!cls) return;
  const rows = await StudyExamResult.find({ userId: uid(req), canvasCourseId: cls.canvasCourseId }).sort({ date: 1, createdAt: 1 }).lean<IStudyExamResult[]>();
  res.json(rows.map(examResultDto));
});

export const createExamResult = wrap(async (req, res) => {
  const f = examResultFields(req.body, false);
  if (typeof f === "string") return fail(res, 400, "VALIDATION_ERROR", f);
  const cls = await ownClass(req, res);
  if (!cls) return;
  const doc = await StudyExamResult.create({ userId: uid(req), canvasCourseId: cls.canvasCourseId, ...f });
  res.status(201).json(examResultDto(doc.toObject() as IStudyExamResult));
});

export const patchExamResult = wrap(async (req, res) => {
  if (!isOid(req.params.resultId)) return fail(res, 400, "INVALID_ID", "Invalid result id");
  const f = examResultFields(req.body, true);
  if (typeof f === "string") return fail(res, 400, "VALIDATION_ERROR", f);
  if (!Object.keys(f).length) return fail(res, 400, "VALIDATION_ERROR", "Nothing to update");
  const cls = await ownClass(req, res);
  if (!cls) return;
  const doc = await StudyExamResult.findOneAndUpdate({ _id: req.params.resultId, userId: uid(req), canvasCourseId: cls.canvasCourseId }, { $set: f }, { new: true }).lean<IStudyExamResult>();
  if (!doc) return fail(res, 404, "NOT_FOUND", "Exam result not found");
  res.json(examResultDto(doc));
});

// ─── lab kit ────────────────────────────────────────────────────────────────────────────

export const listLabSpecimens = wrap(async (req, res) => {
  const cls = await ownClass(req, res);
  if (!cls) return;
  const rows = await StudyLabSpecimen.find({ userId: uid(req), canvasCourseId: cls.canvasCourseId }).sort({ kit: 1, number: 1 }).lean<IStudyLabSpecimen[]>();
  const photoIds = [...new Set(rows.flatMap((r) => r.photoDocIds.map(String)))];
  const photos = new Map(
    (await StudyLibraryDoc.find({ _id: { $in: photoIds.map((i) => new Types.ObjectId(i)) }, userId: uid(req) }, { title: 1, file: 1 }).lean<IStudyLibraryDoc[]>()).map((d) => [String(d._id), d])
  );
  res.json(
    await Promise.all(
      rows.map(async (r) => ({
        id: String(r._id),
        kit: r.kit,
        number: r.number,
        name: r.name ?? null,
        unknown: !!r.unknown,
        properties: r.properties,
        photos: await Promise.all(
          r.photoDocIds
            .map((i) => photos.get(String(i)))
            .filter((d): d is IStudyLibraryDoc => !!d?.file?.storageKey)
            .map(async (d) => ({ libraryId: String(d._id), title: d.title, url: (await signedGetUrl(d.file!.storageKey, { contentType: d.file!.mime })).url }))
        ),
      }))
    )
  );
});

// ─── exam blueprint ─────────────────────────────────────────────────────────────────────

/** `GET /study/classes/:id/exam-blueprint` → `{blueprint, source:'stored'|'default'|null}`. */
export const getExamBlueprint = wrap(async (req, res) => {
  const cls = await ownClass(req, res);
  if (!cls) return;
  const r = await resolveBlueprint(uid(req), cls.canvasCourseId);
  res.json({ blueprint: r?.blueprint ?? null, source: r?.source ?? null });
});

/** `PUT /study/classes/:id/exam-blueprint` `{minutes?, sections}` (or `{blueprint: null}` → back to the course default). */
export const putExamBlueprint = wrap(async (req, res) => {
  const body = req.body ?? {};
  let bp: ExamBlueprint | null = null;
  if (!(body && typeof body === "object" && "blueprint" in body && body.blueprint === null)) {
    try {
      bp = validateBlueprint(body.blueprint ?? body);
    } catch (e) {
      if (e instanceof BlueprintError) return fail(res, e.status, e.code, e.message);
      throw e;
    }
  }
  const cls = await ownClass(req, res);
  if (!cls) return;
  await upsertGuide(uid(req), cls, { examBlueprint: bp });
  const r = await resolveBlueprint(uid(req), cls.canvasCourseId);
  res.json({ blueprint: r?.blueprint ?? null, source: r?.source ?? null });
});
