import { Request, Response } from "express";
import sharp from "sharp";
import { IStudyPage, IStudyPageRender, StudyPage } from "@/models/study/page";
import { deleteStudyObject, pageRenderKey, putStudyObject, signedGetUrl } from "@/services/study/storage";
import { logger } from "@/services/logger.service";
import { fail, isOid, uid, wrap } from "./study.controller";

/**
 * Notebook page renders + Claude annotations (ka-bridge m_mvpodlco6fdced). The client renders each
 * board page (ink over its PDF/paper background — only the device has the background) after a sync
 * and PUTs the image here through the server (bucket CORS may block browser PUTs). The MCP reads them
 * (services/study/notebook-renders.ts). None of these writes move `updatedAt`.
 * Renders are a derived cache (the board JSON is the source of truth), so a replaced or dropped
 * render's object is deleted (plain DeleteObject = hide; the bucket lifecycle purges it).
 *
 * REST `index` is 0-based (position in the board's page array); annotation `page` is 1-based (MCP).
 */

export const RENDER_MAX_BYTES = 8 * 1024 * 1024;
export const RENDER_MAX_INDEX = 499;
const RENDER_MIMES = { webp: "image/webp", png: "image/png", jpg: "image/jpeg" } as const;

/** Magic bytes → ext; the client's Content-Type is not trusted. */
export function sniffRenderImage(buf: Buffer): keyof typeof RENDER_MIMES | null {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  return null;
}

/** Best-effort: a leftover image costs storage, never correctness. */
const dropObjects = (keys: string[]) =>
  Promise.all(
    keys.map((key) =>
      deleteStudyObject(key).catch((e) => logger.warn("study: render object delete failed", { key, error: String((e as Error)?.message ?? e).slice(0, 200) }))
    )
  );

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const RENDER_PROJECTION = { renders: 1, rendersPageCount: 1, version: 1, userId: 1 } as const;

const ownPageWith = async (req: Request, res: Response, projection: Record<string, 1>): Promise<IStudyPage | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid page id");
    return null;
  }
  const page = await StudyPage.findOne({ _id: req.params.id, userId: uid(req), deletedAt: null }, projection).lean<IStudyPage>();
  if (!page) fail(res, 404, "NOT_FOUND", "Page not found");
  return page;
};

const renderMeta = (r: IStudyPageRender) => ({
  index: r.index,
  boardPageId: r.boardPageId ?? null,
  hash: r.hash,
  version: r.version,
  width: r.width,
  height: r.height,
  mime: r.mime,
  bytes: r.bytes,
  renderedAt: iso(r.renderedAt),
});

async function rendersBody(page: IStudyPage) {
  const renders = [...(page.renders ?? [])].sort((a, b) => a.index - b.index);
  return {
    version: page.version ?? 0,
    pageCount: page.rendersPageCount ?? null,
    renders: await Promise.all(
      renders.map(async (r) => {
        const { url, expiresAt } = await signedGetUrl(r.key, { contentType: r.mime });
        return { ...renderMeta(r), url, expiresAt };
      })
    ),
  };
}

/** `GET /pages/:id/renders` → `{version, pageCount, renders:[{…meta, url, expiresAt}]}`. */
export const getPageRenders = wrap(async (req, res) => {
  const page = await ownPageWith(req, res, RENDER_PROJECTION);
  if (!page) return;
  res.json(await rendersBody(page));
});

const qInt = (v: unknown) => (typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : null);
const qStr = (v: unknown, max: number) => (typeof v === "string" && v.length >= 1 && v.length <= max ? v : null);

/**
 * `PUT /pages/:id/renders/:index?hash&version[&boardPageId]`, raw image body ≤ 8 MB. Upserts the
 * render at that index. `version` must not exceed the page's content version, and an older render
 * never replaces a newer one at the same index (two devices syncing) — both are 409 STALE_VERSION.
 */
export const putPageRender = wrap(async (req, res) => {
  const index = qInt(req.params.index);
  if (index === null || index > RENDER_MAX_INDEX) return fail(res, 400, "VALIDATION_ERROR", `index must be an integer 0..${RENDER_MAX_INDEX}`);
  const hash = qStr(req.query.hash, 128);
  if (!hash) return fail(res, 400, "VALIDATION_ERROR", "hash is required (max 128 chars)");
  const version = qInt(req.query.version);
  if (version === null) return fail(res, 400, "VALIDATION_ERROR", "version must be a non-negative integer");
  const rawBoard = req.query.boardPageId;
  const boardPageId = rawBoard === undefined || rawBoard === "" ? null : qStr(rawBoard, 128);
  if (rawBoard !== undefined && rawBoard !== "" && !boardPageId) return fail(res, 400, "VALIDATION_ERROR", "boardPageId must be a string (max 128 chars)");

  const page = await ownPageWith(req, res, RENDER_PROJECTION);
  if (!page) return;
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return fail(res, 400, "EMPTY_BODY", "Request body is empty");
  const ext = sniffRenderImage(body);
  if (!ext) return fail(res, 400, "UNSUPPORTED_IMAGE", "Body must be a WebP, PNG or JPEG image");
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(body).metadata());
  } catch {
    /* handled below */
  }
  if (!width || !height) return fail(res, 400, "UNSUPPORTED_IMAGE", "The image could not be read");

  const stale = (currentVersion: number) => res.status(409).json({ message: "This render is older than the page", code: "STALE_VERSION", currentVersion });
  if (version > (page.version ?? 0)) return stale(page.version ?? 0);
  const existing = (page.renders ?? []).find((r) => r.index === index);
  if (existing && existing.version > version) return stale(page.version ?? 0);

  const key = pageRenderKey(String(page.userId), String(page._id), index, ext);
  await putStudyObject(key, body, RENDER_MIMES[ext]);
  const render: IStudyPageRender = { index, boardPageId, key, hash, version, width, height, mime: RENDER_MIMES[ext], bytes: body.length, renderedAt: new Date() };

  // Replace in place if a render at this index (no newer than ours) exists, else push one — retried
  // once because a parallel PUT of the same index can slip in between the two conditional writes.
  const base = { _id: page._id, userId: page.userId, deletedAt: null, version: { $gte: version } };
  for (let attempt = 0; attempt < 2; attempt++) {
    // Pre-image: the render this one replaced, whose object is then deleted.
    const prev = await StudyPage.findOneAndUpdate(
      { ...base, renders: { $elemMatch: { index, version: { $lte: version } } } },
      { $set: { "renders.$": render } },
      { new: false, projection: { renders: { $elemMatch: { index } } }, timestamps: false }
    ).lean<IStudyPage>();
    if (prev) {
      const old = prev.renders?.[0]?.key;
      if (old && old !== key) await dropObjects([old]);
      return res.json(renderMeta(render));
    }
    const push = await StudyPage.updateOne({ ...base, "renders.index": { $ne: index } }, { $push: { renders: render } }, { timestamps: false });
    if (push.matchedCount) return res.json(renderMeta(render));
  }
  await dropObjects([key]);
  const now = await StudyPage.findOne({ _id: page._id, userId: page.userId, deletedAt: null }, { version: 1 }).lean<IStudyPage>();
  if (!now) return fail(res, 404, "NOT_FOUND", "Page not found");
  return stale(now.version ?? 0);
});

/**
 * `POST /pages/:id/renders/commit {version, pageCount}` — drops renders with index ≥ pageCount; same
 * body as GET. `version` = the content version the client just synced. A commit older than the last
 * one (a delayed device) or ahead of the page is 409 STALE_VERSION, so it can never drop a newer
 * device's renders.
 */
export const commitPageRenders = wrap(async (req, res) => {
  const { pageCount, version } = req.body ?? {};
  if (typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 0 || pageCount > RENDER_MAX_INDEX + 1)
    return fail(res, 400, "VALIDATION_ERROR", `pageCount must be an integer 0..${RENDER_MAX_INDEX + 1}`);
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return fail(res, 400, "VALIDATION_ERROR", "version must be a non-negative integer");
  const page = await ownPageWith(req, res, { userId: 1 });
  if (!page) return;
  const prev = await StudyPage.findOneAndUpdate(
    {
      _id: page._id,
      userId: page.userId,
      deletedAt: null,
      version: { $gte: version },
      $or: [{ rendersCommitVersion: null }, { rendersCommitVersion: { $lte: version } }],
    },
    { $pull: { renders: { index: { $gte: pageCount } } }, $set: { rendersPageCount: pageCount, rendersCommitVersion: version } },
    { new: false, projection: RENDER_PROJECTION, timestamps: false }
  ).lean<IStudyPage>();
  if (!prev) {
    const now = await StudyPage.findOne({ _id: page._id, userId: page.userId, deletedAt: null }, { version: 1 }).lean<IStudyPage>();
    if (!now) return fail(res, 404, "NOT_FOUND", "Page not found");
    return res.status(409).json({ message: "A newer sync already committed this page's renders", code: "STALE_VERSION", currentVersion: now.version ?? 0 });
  }
  const renders = prev.renders ?? [];
  await dropObjects(renders.filter((r) => r.index >= pageCount).map((r) => r.key));
  res.json(await rendersBody({ ...prev, rendersPageCount: pageCount, renders: renders.filter((r) => r.index < pageCount) }));
});

// ─── annotations (Claude feedback → board) ──────────────────────────────────────────────

export const annotationDto = (a: IStudyPage["annotations"][number]) => ({
  id: String(a._id),
  page: a.page,
  markdown: a.markdown,
  author: a.author ?? "claude",
  createdAt: iso(a.createdAt),
});

/** `GET /pages/:id/annotations` → oldest first. */
export const listPageAnnotations = wrap(async (req, res) => {
  const page = await ownPageWith(req, res, { annotations: 1 });
  if (!page) return;
  const rows = [...(page.annotations ?? [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  res.json(rows.map(annotationDto));
});

export const deletePageAnnotation = wrap(async (req, res) => {
  if (!isOid(req.params.annotationId)) return fail(res, 400, "INVALID_ID", "Invalid annotation id");
  const page = await ownPageWith(req, res, { userId: 1 });
  if (!page) return;
  const r = await StudyPage.updateOne(
    { _id: page._id, userId: page.userId, deletedAt: null, "annotations._id": req.params.annotationId },
    { $pull: { annotations: { _id: req.params.annotationId } } },
    { timestamps: false }
  );
  if (!r.modifiedCount) return fail(res, 404, "NOT_FOUND", "Annotation not found");
  res.status(204).end();
});
