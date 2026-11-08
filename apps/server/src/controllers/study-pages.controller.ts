import { Request, Response } from "express";
import { Types } from "mongoose";
import { StudyClass } from "@/models/study/class";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyPage, IStudyPage, STUDY_PAGE_KINDS } from "@/models/study/page";
import { StudyModule } from "@/models/study/module";
import { StudyLecture, IStudyLecture } from "@/models/study/lecture";
import { StudyQuestion, IStudyQuestion } from "@/models/study/question";
import { pageContentKey, presignedPutUrl, putStudyObject, signedGetUrl, studyObjectExists } from "@/services/study/storage";
import { itemsDto, LIST_PROJECTION } from "@/services/study/views";
import { questionDto } from "@/services/study/questions";
import { searchTranscripts } from "@/services/study/transcript-search";
import { escapeRegex, fail, isOid, uid, wrap } from "./study.controller";

/**
 * Notebook pages + search (contract "Notebook pages", P2). A page's board JSON is uploaded
 * straight to storage by presigned PUT; the BE only hands out versioned keys and flips the
 * pointer on commit (optimistic concurrency on `version`).
 */

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
export const MAX_OCR_CHARS = 200_000;

export const pageDto = (p: IStudyPage) => ({
  id: String(p._id),
  classId: p.classId ? String(p.classId) : null,
  itemId: p.itemId ? String(p.itemId) : null,
  lectureId: p.lectureId ? String(p.lectureId) : null,
  title: p.title,
  kind: p.kind,
  updatedAt: iso(p.updatedAt),
  version: p.version ?? 0,
  thumbUrl: p.thumbUrl ?? null,
  week: p.week ?? null,
  moduleId: p.moduleId ? String(p.moduleId) : null,
  lecture: p.lecture ? { number: p.lecture.number ?? null, key: p.lecture.key, date: p.lecture.date } : null,
});

const validWeek = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 30;
const validDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
type PageLecture = NonNullable<IStudyPage["lecture"]>;
/** Shape-check the three organisation fields (each already known to be present); returns an error message or null. */
export const orgFieldError = (b: Record<string, unknown>): string | null => {
  if (b.week !== undefined && b.week !== null && !validWeek(b.week)) return "week must be an integer 1..30 or null";
  if (b.moduleId !== undefined && b.moduleId !== null && !isOid(b.moduleId)) return "moduleId must be an id or null";
  const l = b.lecture;
  if (l !== undefined && l !== null) {
    if (typeof l !== "object" || Array.isArray(l)) return "lecture must be {number, key, date} or null";
    const { number, key, date } = l as Record<string, unknown>;
    if (typeof key !== "string" || !key.trim() || key.length > 80) return "lecture.key must be a non-empty string (max 80)";
    if (!validDate(date)) return "lecture.date must be a real date YYYY-MM-DD";
    if (number !== undefined && number !== null && !(typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= 200))
      return "lecture.number must be an integer 1..200 or null";
  }
  return null;
};
const toLecture = (l: any): PageLecture | null => (l ? { number: l.number ?? null, key: l.key, date: l.date } : null);

const PAGE_PROJECTION = { ocrText: 0, renders: 0, annotations: 0 } as const;

const ownPage = async (req: Request, res: Response): Promise<IStudyPage | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid page id");
    return null;
  }
  const page = await StudyPage.findOne({ _id: req.params.id, userId: uid(req), deletedAt: null }, PAGE_PROJECTION).lean<IStudyPage>();
  if (!page) fail(res, 404, "NOT_FOUND", "Page not found");
  return page;
};

export const listPages = wrap(async (req, res) => {
  const { classId, itemId, week, lectureKey } = req.query;
  const filter: Record<string, unknown> = { userId: uid(req), deletedAt: null };
  for (const [k, v] of [["classId", classId], ["itemId", itemId]] as const) {
    if (v === undefined || v === "") continue;
    if (!isOid(v)) return fail(res, 400, "VALIDATION_ERROR", `${k} must be an id`);
    filter[k] = new Types.ObjectId(String(v));
  }
  if (week !== undefined && week !== "") {
    if (typeof week !== "string" || !/^-?\d{1,9}$/.test(week)) return fail(res, 400, "VALIDATION_ERROR", "week must be an integer");
    filter.week = Number(week);
  }
  if (lectureKey !== undefined && lectureKey !== "") {
    if (typeof lectureKey !== "string") return fail(res, 400, "VALIDATION_ERROR", "lectureKey must be a string");
    filter["lecture.key"] = lectureKey;
  }
  const pages = await StudyPage.find(filter, PAGE_PROJECTION).sort({ updatedAt: -1, _id: 1 }).limit(1000).lean<IStudyPage[]>();
  res.json(pages.map(pageDto));
});

/** One page: the Page DTO + `markdown` = its stored OCR/search text (what `PUT /pages/:id/ocr` wrote). */
export const getPage = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid page id");
  const page = await StudyPage.findOne({ _id: req.params.id, userId: uid(req), deletedAt: null }).lean<IStudyPage>();
  if (!page) return fail(res, 404, "NOT_FOUND", "Page not found");
  res.json({ ...pageDto(page), markdown: page.ocrText ?? null });
});

export const createPage = wrap(async (req, res) => {
  const { classId, itemId, lectureId, title, kind } = req.body ?? {};
  const k = kind ?? "note";
  if (!(STUDY_PAGE_KINDS as readonly string[]).includes(k)) return fail(res, 400, "VALIDATION_ERROR", `kind must be one of ${STUDY_PAGE_KINDS.join(", ")}`);
  if (title !== undefined && title !== null && (typeof title !== "string" || title.length > 200))
    return fail(res, 400, "VALIDATION_ERROR", "title must be a string (max 200)");
  const orgErr = orgFieldError(req.body ?? {});
  if (orgErr) return fail(res, 400, "VALIDATION_ERROR", orgErr);
  for (const [name, v] of [["classId", classId], ["itemId", itemId], ["lectureId", lectureId]] as const)
    if (v !== undefined && v !== null && !isOid(v)) return fail(res, 400, "VALIDATION_ERROR", `${name} must be an id`);

  const userId = uid(req);
  let cls: Types.ObjectId | null = null;
  if (classId) {
    const c = await StudyClass.exists({ _id: classId, userId });
    if (!c) return fail(res, 404, "NOT_FOUND", "Class not found");
    cls = new Types.ObjectId(classId);
  }
  let item: Types.ObjectId | null = null;
  if (itemId) {
    const it = await StudyItem.findOne({ _id: itemId, userId }, { classId: 1 }).lean<IStudyItem>();
    if (!it) return fail(res, 404, "NOT_FOUND", "Item not found");
    if (cls && String(it.classId) !== String(cls)) return fail(res, 400, "VALIDATION_ERROR", "itemId belongs to another class");
    cls ??= it.classId;
    item = it._id;
  }
  let lecture: Types.ObjectId | null = null;
  if (lectureId) {
    const lec = await StudyLecture.findOne({ _id: lectureId, userId }, { classId: 1 }).lean<IStudyLecture>();
    if (!lec) return fail(res, 404, "NOT_FOUND", "Lecture not found");
    if (cls && String(lec.classId) !== String(cls)) return fail(res, 400, "VALIDATION_ERROR", "lectureId belongs to another class");
    cls ??= lec.classId;
    lecture = lec._id;
  }
  let moduleOid: Types.ObjectId | null = null;
  if (req.body?.moduleId) {
    const m = await StudyModule.findOne({ _id: req.body.moduleId, userId }, { classId: 1 }).lean();
    if (!m) return fail(res, 404, "NOT_FOUND", "Module not found");
    if (cls && String(m.classId) !== String(cls)) return fail(res, 400, "VALIDATION_ERROR", "moduleId belongs to another class");
    cls ??= m.classId;
    moduleOid = m._id;
  }
  const page = await StudyPage.create({
    userId, classId: cls, itemId: item, lectureId: lecture, title: (title ?? "").trim() || "Untitled", kind: k,
    week: req.body?.week ?? null, moduleId: moduleOid, lecture: toLecture(req.body?.lecture),
  });
  res.status(201).json(pageDto(page.toObject() as IStudyPage));
});

/**
 * `PATCH /pages/:id {title?, week?, moduleId?, lecture?}` — organisation metadata. `null` clears.
 * Does NOT touch `version`/contentKey, and (like OCR) does not move `updatedAt`: that field
 * means "content changed", so renaming/filing a page must not reorder the notebook list.
 */
export const patchPage = wrap(async (req, res) => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const keys = ["title", "week", "moduleId", "lecture"].filter((k) => body[k] !== undefined);
  if (!keys.length) return fail(res, 400, "VALIDATION_ERROR", "Send at least one of title, week, moduleId, lecture");
  const err = orgFieldError(body);
  if (err) return fail(res, 400, "VALIDATION_ERROR", err);
  const set: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (!t || t.length > 200) return fail(res, 400, "VALIDATION_ERROR", "title must be a non-empty string (max 200)");
    set.title = t;
  }
  const page = await ownPage(req, res);
  if (!page) return;
  if (body.week !== undefined) set.week = body.week;
  if (body.lecture !== undefined) set.lecture = toLecture(body.lecture);
  if (body.moduleId !== undefined) {
    if (body.moduleId === null) set.moduleId = null;
    else {
      const m = await StudyModule.findOne({ _id: body.moduleId, userId: page.userId }, { classId: 1 }).lean();
      if (!m) return fail(res, 404, "NOT_FOUND", "Module not found");
      if (!page.classId || String(m.classId) !== String(page.classId)) return fail(res, 400, "VALIDATION_ERROR", "moduleId belongs to another class");
      set.moduleId = m._id;
    }
  }
  const updated = await StudyPage.findOneAndUpdate(
    { _id: page._id, userId: page.userId, deletedAt: null },
    { $set: set },
    { new: true, projection: PAGE_PROJECTION, timestamps: false }
  ).lean<IStudyPage>();
  if (!updated) return fail(res, 404, "NOT_FOUND", "Page not found");
  res.json(pageDto(updated));
});

/** `{url, version, expiresAt}`; before the first commit `{url:null, version:0, expiresAt:null}`. */
export const getPageContent = wrap(async (req, res) => {
  const page = await ownPage(req, res);
  if (!page) return;
  if (!page.version || !page.contentKey) return res.json({ url: null, version: 0, expiresAt: null });
  const { url, expiresAt } = await signedGetUrl(page.contentKey, { contentType: "application/json" });
  res.json({ url, version: page.version, expiresAt });
});

const intOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export const putPageContent = wrap(async (req, res) => {
  const baseVersion = intOf(req.body?.baseVersion);
  if (baseVersion === null) return fail(res, 400, "VALIDATION_ERROR", "baseVersion must be a non-negative integer");
  const page = await ownPage(req, res);
  if (!page) return;
  if (baseVersion !== page.version)
    return res.status(409).json({ message: "This page changed since you opened it", code: "STALE_VERSION", currentVersion: page.version });
  const version = page.version + 1;
  const { url, expiresAt } = await presignedPutUrl(pageContentKey(String(page.userId), String(page._id), version));
  res.json({ uploadUrl: url, version, expiresAt });
});

/** Compare-and-set on the version: two racing commits of the same version → exactly one wins (null = lost). */
const casCommit = (page: IStudyPage, version: number, key: string) =>
  StudyPage.findOneAndUpdate(
    { _id: page._id, userId: page.userId, deletedAt: null, version: version - 1 },
    { $set: { version, contentKey: key, updatedAt: new Date() } },
    { new: true, projection: PAGE_PROJECTION, timestamps: false }
  ).lean<IStudyPage>();

export const commitPageContent = wrap(async (req, res) => {
  const version = intOf(req.body?.version);
  if (!version) return fail(res, 400, "VALIDATION_ERROR", "version must be a positive integer");
  const page = await ownPage(req, res);
  if (!page) return;
  const stale = () =>
    res.status(409).json({ message: "This page changed since you opened it", code: "STALE_VERSION", currentVersion: page.version });
  if (version !== page.version + 1) return stale();
  const key = pageContentKey(String(page.userId), String(page._id), version);
  if (!(await studyObjectExists(key)))
    return res.status(409).json({ message: "The upload for this version was not found — PUT the content first", code: "UPLOAD_MISSING", currentVersion: page.version });
  const updated = await casCommit(page, version, key);
  if (!updated) return stale();
  res.json(pageDto(updated));
});

/**
 * Proxy upload (`PUT /pages/:id/content/blob?baseVersion=N`, raw JSON body ≤ 25 MB): the server
 * writes the object itself, then runs the same CAS commit — for clients that cannot reach the
 * presigned url. `{version, expiresAt}`, expiresAt being the content GET's signed-url expiry.
 */
export const putPageBlob = wrap(async (req, res) => {
  const raw = req.query.baseVersion;
  const baseVersion = typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
  if (baseVersion === null) return fail(res, 400, "VALIDATION_ERROR", "baseVersion must be a non-negative integer");
  const page = await ownPage(req, res);
  if (!page) return;
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return fail(res, 400, "EMPTY_BODY", "Request body is empty");
  try {
    JSON.parse(body.toString("utf8"));
  } catch {
    return fail(res, 400, "INVALID_JSON", "Body must be valid JSON");
  }
  const stale = (currentVersion: number) =>
    res.status(409).json({ message: "This page changed since you opened it", code: "STALE_VERSION", currentVersion });
  if (baseVersion !== page.version) return stale(page.version);
  const version = page.version + 1;
  const key = pageContentKey(String(page.userId), String(page._id), version);
  await putStudyObject(key, body, "application/json");
  const updated = await casCommit(page, version, key);
  if (!updated) return stale(page.version);
  const { expiresAt } = await signedGetUrl(key, { contentType: "application/json" });
  res.json({ version, expiresAt });
});

/** Soft delete: the row is hidden everywhere; stored versions are never deleted (storage lifecycle). */
export const deletePage = wrap(async (req, res) => {
  const page = await ownPage(req, res);
  if (!page) return;
  await StudyPage.updateOne({ _id: page._id, userId: page.userId }, { $set: { deletedAt: new Date() } }, { timestamps: false });
  res.status(204).end();
});

export const putPageOcr = wrap(async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || text.length > MAX_OCR_CHARS) return fail(res, 400, "VALIDATION_ERROR", `text must be a string (max ${MAX_OCR_CHARS} chars)`);
  const page = await ownPage(req, res);
  if (!page) return;
  // OCR is metadata: it must not move `updatedAt`, which means "content changed".
  await StudyPage.updateOne({ _id: page._id, userId: page.userId }, { $set: { ocrText: text.trim() || null, ocrUpdatedAt: new Date() } }, { timestamps: false });
  res.status(204).end();
});

// ─── search ─────────────────────────────────────────────────────────────────────────────

export const SEARCH_LIMIT = 20;

/**
 * `{items, pages, questions, transcripts}` — case-insensitive substring match (the query is
 * regex-ESCAPED, so "c++" or "(x)" are literal). items: title + page/assignment HTML; pages:
 * title + client OCR text; questions: stem + tags; transcripts: matching segments. 20 per bucket.
 */
export const search = wrap(async (req, res) => {
  const q = req.query.q;
  if (typeof q !== "string" || !q.trim() || q.length > 200) return fail(res, 400, "VALIDATION_ERROR", "q is required (max 200 chars)");
  const userId = uid(req);
  const rx = { $regex: escapeRegex(q.trim()), $options: "i" };
  const [items, pages, questions] = await Promise.all([
    StudyItem.find({ userId, $or: [{ title: rx }, { html: rx }] }, LIST_PROJECTION).sort({ canvasUpdatedAt: -1, _id: 1 }).limit(SEARCH_LIMIT).lean<IStudyItem[]>(),
    StudyPage.find({ userId, deletedAt: null, $or: [{ title: rx }, { ocrText: rx }] }, PAGE_PROJECTION).sort({ updatedAt: -1, _id: 1 }).limit(SEARCH_LIMIT).lean<IStudyPage[]>(),
    StudyQuestion.find({ userId, $or: [{ stem: rx }, { tags: rx }] }, { shingles: 0 }).sort({ createdAt: -1, _id: -1 }).limit(SEARCH_LIMIT).lean<IStudyQuestion[]>(),
  ]);
  res.json({ items: await itemsDto(items), pages: pages.map(pageDto), questions: questions.map(questionDto), transcripts: await searchTranscripts(userId, rx, SEARCH_LIMIT) });
});
