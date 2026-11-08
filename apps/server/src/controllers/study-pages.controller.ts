import { Request, Response } from "express";
import { Types } from "mongoose";
import { StudyClass } from "@/models/study/class";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyPage, IStudyPage, STUDY_PAGE_KINDS, PAGE_VERSION_LOG_MAX } from "@/models/study/page";
import { Admin } from "@/models/admin";
import { StudyModule } from "@/models/study/module";
import { StudyLecture, IStudyLecture } from "@/models/study/lecture";
import { StudyQuestion, IStudyQuestion } from "@/models/study/question";
import { getStudyObject, pageContentKey, presignedPutUrl, putStudyObject, signedGetUrl, studyObjectExists } from "@/services/study/storage";
import { editedByDto, editedByOf, pageHasEditors, scopedPage } from "@/services/share/edit";
import { publishPageEvent, withPageLock } from "@/services/study/page-live";
import { displayName, loadCaller, NamedCaller } from "@/services/share/access";
import { itemsDto, LIST_PROJECTION } from "@/services/study/views";
import { questionDto } from "@/services/study/questions";
import { searchTranscripts } from "@/services/study/transcript-search";
import { escapeRegex, fail, isOid, uid, wrap } from "./study.controller";

/**
 * Notebook pages + search (contract "Notebook pages", P2). A page's board JSON is uploaded
 * straight to storage by presigned PUT; the BE only hands out versioned keys and flips the
 * pointer on commit (optimistic concurrency on `version`).
 *
 * Sharing: an editor of a page (services/share/edit.ts) may read it and write its content (GET page /
 * content, PUT content / blob, commit, OCR), always under the owner's storage prefix. Renaming, filing,
 * deleting, renders, rulers and annotations stay owner-only. Every commit records its author.
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
  editedBy: editedByDto(p.editedBy, p.userId),
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

export const PAGE_PROJECTION = { ocrText: 0, renders: 0, annotations: 0, versionLog: 0 } as const;

const ownPage = async (req: Request, res: Response): Promise<IStudyPage | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid page id");
    return null;
  }
  const page = await StudyPage.findOne({ _id: req.params.id, userId: uid(req), deletedAt: null }, PAGE_PROJECTION).lean<IStudyPage>();
  if (!page) fail(res, 404, "NOT_FOUND", "Page not found");
  return page;
};

/** The owner's page, or one shared with the caller as editor (`editor` set). 404 for anyone else. */
const editablePage = async (req: Request, res: Response): Promise<{ page: IStudyPage; editor: NamedCaller | null } | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid page id");
    return null;
  }
  const found = await scopedPage(req, req.params.id, PAGE_PROJECTION);
  if (!found) {
    fail(res, 404, "NOT_FOUND", "Page not found");
    return null;
  }
  return { page: found.doc, editor: found.editor };
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
  const found = await scopedPage(req, req.params.id, { renders: 0, annotations: 0, versionLog: 0 });
  if (!found) return fail(res, 404, "NOT_FOUND", "Page not found");
  const page = found.doc;
  // `live`: someone besides the owner may edit, so the app syncs it live (pushes + the stream).
  if (!found.editor) return res.json({ ...pageDto(page), markdown: page.ocrText ?? null, live: await pageHasEditors(page) });
  // Someone else's page shared with the caller to edit: no class / lecture links into the owner's account.
  const owner = await Admin.findById(page.userId, { name: 1, email: 1 }).lean<{ name?: string; email?: string }>();
  res.json({
    ...pageDto(page),
    classId: null,
    itemId: null,
    lectureId: null,
    moduleId: null,
    lecture: null,
    markdown: page.ocrText ?? null,
    live: true,
    shared: { role: "editor", ownerName: displayName(owner) },
  });
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
  const found = await editablePage(req, res);
  if (!found) return;
  const { page } = found;
  if (req.query.version !== undefined) return earlierContent(req, res, page, req.query.version);
  if (!page.version || !page.contentKey) return res.json({ url: null, version: 0, expiresAt: null });
  const { url, expiresAt } = await signedGetUrl(page.contentKey, { contentType: "application/json" });
  res.json({ url, version: page.version, expiresAt });
});

const intOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export const putPageContent = wrap(async (req, res) => {
  const baseVersion = intOf(req.body?.baseVersion);
  if (baseVersion === null) return fail(res, 400, "VALIDATION_ERROR", "baseVersion must be a non-negative integer");
  const found = await editablePage(req, res);
  if (!found) return;
  const { page } = found;
  if (baseVersion !== page.version)
    return res.status(409).json({ message: "This page changed since you opened it", code: "STALE_VERSION", currentVersion: page.version });
  const version = page.version + 1;
  const { url, expiresAt } = await presignedPutUrl(pageContentKey(String(page.userId), String(page._id), version));
  res.json({ uploadUrl: url, version, expiresAt });
});

/** `GET content?version=N`: an earlier stored version of the page (owner or editor). */
export async function earlierContent(req: Request, res: Response, page: IStudyPage, raw: unknown): Promise<void> {
  const version = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(version) || version < 1 || version > (page.version ?? 0)) {
    fail(res, 400, "VALIDATION_ERROR", "version must be a stored version of this page");
    return;
  }
  const key = version === page.version && page.contentKey ? page.contentKey : pageContentKey(String(page.userId), String(page._id), version);
  if (!(await studyObjectExists(key))) {
    fail(res, 404, "NOT_FOUND", "That version is no longer stored");
    return;
  }
  const { url, expiresAt } = await signedGetUrl(key, { contentType: "application/json" });
  res.json({ url, version, expiresAt });
}

/** Who is writing: the editor, else the owner (looked up for the name). */
export const authorOf = async (req: Request, editor: NamedCaller | null) => editor ?? (await loadCaller(req.adminId));

/**
 * Compare-and-set on the version: two racing commits of the same version → exactly one wins (null =
 * lost). The same update records the author (editedBy + one versionLog entry, newest last, capped).
 */
export const casCommit = (page: IStudyPage, version: number, key: string, author: NamedCaller | null, restoredFrom: number | null = null) => {
  const at = new Date();
  return StudyPage.findOneAndUpdate(
    { _id: page._id, userId: page.userId, deletedAt: null, version: version - 1 },
    {
      $set: { version, contentKey: key, updatedAt: at, ...(author ? { editedBy: editedByOf(author) } : {}) },
      ...(author
        ? { $push: { versionLog: { $each: [{ version, userId: author.userId, name: author.name, at, restoredFrom }], $slice: -PAGE_VERSION_LOG_MAX } } }
        : {}),
    },
    { new: true, projection: PAGE_PROJECTION, timestamps: false }
  ).lean<IStudyPage>();
};

export const commitPageContent = wrap(async (req, res) => {
  const version = intOf(req.body?.version);
  if (!version) return fail(res, 400, "VALIDATION_ERROR", "version must be a positive integer");
  const found = await editablePage(req, res);
  if (!found) return;
  const { page, editor } = found;
  const stale = () =>
    res.status(409).json({ message: "This page changed since you opened it", code: "STALE_VERSION", currentVersion: page.version });
  if (version !== page.version + 1) return stale();
  const key = pageContentKey(String(page.userId), String(page._id), version);
  if (!(await studyObjectExists(key)))
    return res.status(409).json({ message: "The upload for this version was not found — PUT the content first", code: "UPLOAD_MISSING", currentVersion: page.version });
  const author = await authorOf(req, editor);
  const updated = await casCommit(page, version, key, author);
  if (!updated) return stale();
  announceVersion(page, page.version, version, req, author);
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
  const found = await editablePage(req, res);
  if (!found) return;
  const { page, editor } = found;
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return fail(res, 400, "EMPTY_BODY", "Request body is empty");
  try {
    JSON.parse(body.toString("utf8"));
  } catch {
    return fail(res, 400, "INVALID_JSON", "Body must be valid JSON");
  }
  const stale = (currentVersion: number) =>
    res.status(409).json({ message: "This page changed since you opened it", code: "STALE_VERSION", currentVersion });
  const author = await authorOf(req, editor);
  // Under the page lock (live pushes and other saves of this page wait), re-reading the version: two
  // savers on the same base can no longer both write the v+1 object and leave the winner pointing at
  // the loser's bytes.
  const outcome = await withPageLock(String(page._id), async () => {
    const fresh = await StudyPage.findOne({ _id: page._id, deletedAt: null }, PAGE_PROJECTION).lean<IStudyPage>();
    if (!fresh) return { stale: page.version };
    if (baseVersion !== fresh.version) return { stale: fresh.version };
    const version = fresh.version + 1;
    const key = pageContentKey(String(fresh.userId), String(fresh._id), version);
    await putStudyObject(key, body, "application/json");
    const updated = await casCommit(fresh, version, key, author);
    return updated ? { version, key } : { stale: fresh.version };
  });
  if ("stale" in outcome) return stale(outcome.stale ?? 0);
  announceVersion(page, outcome.version - 1, outcome.version, req, author);
  const { expiresAt } = await signedGetUrl(outcome.key, { contentType: "application/json" });
  res.json({ version: outcome.version, expiresAt });
});

/** A whole-board save landed: anyone live on the page re-reads it (no ops to send). */
function announceVersion(page: IStudyPage, prevVersion: number, version: number, req: Request, author: NamedCaller | null) {
  publishPageEvent(String(page._id), {
    type: "ops",
    prevVersion,
    version,
    ops: null,
    by: { clientId: "", userId: String(req.adminId), name: author?.name ?? "Someone" },
  });
}

/** Soft delete: the row is hidden everywhere; stored versions are never deleted (storage lifecycle). */
export const deletePage = wrap(async (req, res) => {
  const page = await ownPage(req, res);
  if (!page) return;
  await StudyPage.updateOne({ _id: page._id, userId: page.userId }, { $set: { deletedAt: new Date() } }, { timestamps: false });
  publishPageEvent(String(page._id), { type: "revoke" });
  res.status(204).end();
});

export const putPageOcr = wrap(async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || text.length > MAX_OCR_CHARS) return fail(res, 400, "VALIDATION_ERROR", `text must be a string (max ${MAX_OCR_CHARS} chars)`);
  const found = await editablePage(req, res);
  if (!found) return;
  const { page } = found;
  // OCR is metadata: it must not move `updatedAt`, which means "content changed".
  await StudyPage.updateOne({ _id: page._id, userId: page.userId }, { $set: { ocrText: text.trim() || null, ocrUpdatedAt: new Date() } }, { timestamps: false });
  res.status(204).end();
});

// ─── earlier versions (owner only) ──────────────────────────────────────────────────────

export const VERSIONS_PAGE = 30;

/**
 * `GET /pages/:id/versions?before=N` → `{current, items: [{version, by, at, restoredFrom}], next}`:
 * the newest VERSIONS_PAGE versions below `before` (default: all up to the current one), newest
 * first. `by` / `at` come from the version log (null for versions written before it existed, or by
 * the AI drawing tools). `next` = the `before` for the following page, or null.
 */
export const listPageVersions = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 400, "INVALID_ID", "Invalid page id");
  const page = await StudyPage.findOne({ _id: req.params.id, userId: uid(req), deletedAt: null }, { version: 1, versionLog: 1, userId: 1 }).lean<IStudyPage>();
  if (!page) return fail(res, 404, "NOT_FOUND", "Page not found");
  const raw = req.query.before;
  const before = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Math.min(Number(raw), page.version + 1) : page.version + 1;
  const log = new Map((page.versionLog ?? []).map((e) => [e.version, e]));
  const items = [];
  for (let v = before - 1; v >= 1 && items.length < VERSIONS_PAGE; v--) {
    const e = log.get(v);
    items.push({
      version: v,
      by: e ? { name: e.name || "Someone", isOwner: String(e.userId) === String(page.userId) } : null,
      at: e ? new Date(e.at).toISOString() : null,
      restoredFrom: e?.restoredFrom ?? null,
    });
  }
  const last = items[items.length - 1]?.version ?? 1;
  res.json({ current: page.version, items, next: last > 1 ? last : null });
});

/**
 * `POST /pages/:id/versions/:version/restore {baseVersion}` → the Page DTO. Owner only. Copies the
 * stored board of `version` into a NEW version (nothing is overwritten, so the page as it was stays
 * an earlier version too). 409 STALE_VERSION when `baseVersion` is not the current version; 404 when
 * that version is no longer stored.
 */
export const restorePageVersion = wrap(async (req, res) => {
  const target = Number(req.params.version);
  const baseVersion = intOf(req.body?.baseVersion);
  if (!Number.isInteger(target) || target < 1) return fail(res, 400, "VALIDATION_ERROR", "version must be a positive integer");
  if (baseVersion === null) return fail(res, 400, "VALIDATION_ERROR", "baseVersion must be a non-negative integer");
  const page = await ownPage(req, res);
  if (!page) return;
  if (baseVersion !== page.version)
    return res.status(409).json({ message: "This page changed since you opened it", code: "STALE_VERSION", currentVersion: page.version });
  if (target >= page.version) return fail(res, 400, "VALIDATION_ERROR", "Pick an earlier version");
  const from = pageContentKey(String(page.userId), String(page._id), target);
  if (!(await studyObjectExists(from))) return fail(res, 404, "NOT_FOUND", "That version is no longer stored");
  const author = await loadCaller(req.adminId);
  const updated = await withPageLock(String(page._id), async () => {
    const fresh = await StudyPage.findOne({ _id: page._id, deletedAt: null }, PAGE_PROJECTION).lean<IStudyPage>();
    if (!fresh || fresh.version !== baseVersion) return null;
    const version = fresh.version + 1;
    const key = pageContentKey(String(fresh.userId), String(fresh._id), version);
    await putStudyObject(key, await getStudyObject(from), "application/json");
    return casCommit(fresh, version, key, author, target);
  });
  if (!updated) return res.status(409).json({ message: "This page changed since you opened it", code: "STALE_VERSION", currentVersion: page.version });
  announceVersion(page, updated.version - 1, updated.version, req, author);
  res.json(pageDto(updated));
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
