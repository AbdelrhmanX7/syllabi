import { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { adminVerification, studyAccess } from "@/compat/auth";
import { openStudySse } from "@/services/study/sse";
import { subscribeInbox } from "@/services/study/inbox/bus";
import { newNonce, renderDropPage, renderInvalidDropPage, setDropPageHeaders } from "@/services/study/inbox/drop-page";
import { createInboxItem, deleteInboxItem, inboxItemDto, InboxError, listInboxItems, patchInboxItem, validateMeta } from "@/services/study/inbox/items";
import { INBOX_MAX_BYTES, InboxMediaError } from "@/services/study/inbox/media";
import { IStudyClass, StudyClass } from "@/models/study/class";
import { IStudyInboxItem, StudyInboxItem } from "@/models/study/inbox";
import { createGeneratedPdfPage } from "@/services/study/generated-pdf";
import { getStudyObject, studyObjectExists } from "@/services/study/storage";
import {
  authenticateDropToken,
  claimUploadLink,
  createDropToken,
  deleteDropToken,
  DROP_TOKEN_PREFIX,
  InboxTokenError,
  listDropTokens,
  releaseUploadLink,
  touchDropToken,
} from "@/services/study/inbox/tokens";
import { fail, isOid, uid, wrap } from "./study.controller";
import { orgFieldError } from "./study-pages.controller";

/**
 * Study phone inbox — see services/study/inbox/README.md.
 *
 * Public (routes/study/inbox.ts, mounted BEFORE the /study admin mount): `POST /study/inbox`
 * (admin JWT OR a drop token) and `GET /study/drop`. Everything else is under the normal
 * /study admin auth (routes/study/router.ts) and never accepts a drop token.
 */

const knownError = (res: Response, e: unknown) => {
  if (e instanceof InboxError || e instanceof InboxMediaError || e instanceof InboxTokenError) {
    fail(res, e.status, e.code, e.message);
    return true;
  }
  return false;
};

// ─── drop-token auth (POST /study/inbox and GET /study/drop ONLY) ───────────────────────

const bearerOf = (req: Request) => {
  const h = req.headers.authorization;
  return typeof h === "string" && /^Bearer /i.test(h) ? h.slice(7).trim() : "";
};

/**
 * `Authorization: Bearer sk_drop_…`, or `?t=sk_drop_…` when no Authorization header is sent
 * (the browser form fallback). Anything else falls through to the normal admin JWT chain.
 */
export const inboxUploadAuth: RequestHandler = async (req, res, next) => {
  try {
    const bearer = bearerOf(req);
    const hasAuthHeader = typeof req.headers.authorization === "string" && req.headers.authorization.length > 0;
    const queryToken = typeof req.query.t === "string" ? req.query.t : "";
    const dropToken = bearer.startsWith(DROP_TOKEN_PREFIX) ? bearer : !hasAuthHeader && queryToken ? queryToken : "";
    if (!dropToken) {
      return adminVerification(req, res, (err?: unknown) => (err ? next(err) : studyAccess(req, res, next)));
    }
    const principal = await authenticateDropToken(dropToken);
    if (!principal) return fail(res, 401, "UNAUTHORIZED", "Invalid or revoked drop token");
    req.adminId = String(principal.userId);
    req.userId = String(principal.userId);
    res.locals.dropTokenId = principal.tokenId;
    res.locals.dropOneShot = principal.oneShot;
    next();
  } catch (e) {
    next(e);
  }
};

/** Rate-limit key: the drop token if one was used, else the admin. */
export const inboxLimiterKey = (req: Request) => {
  const res = (req as Request & { res?: Response }).res;
  const tokenId = res?.locals?.dropTokenId;
  return tokenId ? `tok:${tokenId}` : req.adminId ? `adm:${req.adminId}` : null;
};

/** Reject an obviously oversized body before multer buffers it (multer still enforces the real cap). */
export const inboxContentLengthGuard: RequestHandler = (req, res, next) => {
  const len = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(len) && len > INBOX_MAX_BYTES + 1024 * 1024) {
    res.setHeader("Connection", "close");
    return fail(res, 413, "PAYLOAD_TOO_LARGE", "File exceeds the 25 MB limit");
  }
  next();
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INBOX_MAX_BYTES, files: 1, fields: 5, fieldSize: 4096, parts: 7 },
});
const single = upload.single("file") as unknown as RequestHandler;

/** multer, with its errors shaped like the rest of /study. */
export const inboxMultipart: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) return fail(res, 400, "VALIDATION_ERROR", "Send multipart/form-data with a `file` field");
  single(req, res, (err?: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.setHeader("Connection", "close");
        return fail(res, 413, "PAYLOAD_TOO_LARGE", "File exceeds the 25 MB limit");
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE")
        return fail(res, 400, "VALIDATION_ERROR", "Send exactly one file, in the `file` field");
      return fail(res, 400, "VALIDATION_ERROR", `Malformed upload (${err.code})`);
    }
    return fail(res, 400, "VALIDATION_ERROR", "Malformed multipart body");
  });
};

export const postInboxItem = wrap(async (req, res) => {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file || !file.buffer?.length) return fail(res, 400, "VALIDATION_ERROR", "file is required");
  const tokenId = res.locals.dropTokenId ?? null;
  const oneShot = res.locals.dropOneShot ?? null;
  // A one-shot link is claimed BEFORE any work, so two concurrent uploads can't both use it; a
  // failed upload releases it again. Its note/class/page were bound (and validated) when it was minted.
  if (oneShot && !(await claimUploadLink(tokenId))) return fail(res, 401, "UNAUTHORIZED", "This upload link was already used or has expired");
  try {
    const userId = uid(req);
    const meta = oneShot ? { note: oneShot.note, classId: oneShot.classId, pageId: oneShot.pageId } : await validateMeta(userId, req.body?.note, req.body?.classId, req.body?.pageId);
    const dto = await createInboxItem(userId, file.buffer, { ...meta, tokenId });
    if (tokenId && !oneShot) touchDropToken(tokenId);
    res.status(201).json(dto);
  } catch (e) {
    if (oneShot) await releaseUploadLink(tokenId);
    if (knownError(res, e)) return;
    throw e;
  }
});

// ─── drop page ──────────────────────────────────────────────────────────────────────────

export const getDropPage = wrap(async (req, res) => {
  const nonce = newNonce();
  setDropPageHeaders(res, nonce);
  const principal = await authenticateDropToken(typeof req.query.t === "string" ? req.query.t : "");
  if (!principal) return res.status(401).send(renderInvalidDropPage(nonce));
  res.status(200).send(renderDropPage(nonce, principal.label));
});

// ─── admin JWT (/study mount) ───────────────────────────────────────────────────────────

export const createInboxToken = wrap(async (req, res) => {
  try {
    res.status(201).json(await createDropToken(uid(req), req.body?.label));
  } catch (e) {
    if (knownError(res, e)) return;
    throw e;
  }
});

export const listInboxTokens = wrap(async (req, res) => {
  res.json(await listDropTokens(uid(req)));
});

export const deleteInboxToken = wrap(async (req, res) => {
  if (!isOid(req.params.id) || !(await deleteDropToken(uid(req), req.params.id))) return fail(res, 404, "NOT_FOUND", "Token not found");
  res.status(204).end();
});

export const listInbox = wrap(async (req, res) => {
  try {
    res.json(await listInboxItems(uid(req), req.query.since, req.query.pageId));
  } catch (e) {
    if (knownError(res, e)) return;
    throw e;
  }
});

/**
 * `GET /study/inbox/:id` — one item with a fresh signed url, EVEN IF soft-deleted: a note whose pages
 * came from it re-downloads the PDF on another device. 404 once the stored object is gone.
 */
export const getInbox = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 404, "NOT_FOUND", "Item not found");
  const item = await StudyInboxItem.findOne({ _id: req.params.id, userId: uid(req) }).lean<IStudyInboxItem>();
  if (!item) return fail(res, 404, "NOT_FOUND", "Item not found");
  // A missing object is a 404 for this item; any other storage error stays a 500 (an outage is not "gone").
  if (!(await studyObjectExists(item.key))) return fail(res, 404, "NOT_FOUND", "The inbox file is no longer stored");
  res.json(await inboxItemDto(item));
});

export const deleteInbox = wrap(async (req, res) => {
  if (!isOid(req.params.id) || !(await deleteInboxItem(uid(req), req.params.id))) return fail(res, 404, "NOT_FOUND", "Item not found");
  res.status(204).end();
});

export const patchInbox = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 404, "NOT_FOUND", "Item not found");
  try {
    const dto = await patchInboxItem(uid(req), req.params.id, req.body);
    if (!dto) return fail(res, 404, "NOT_FOUND", "Item not found");
    res.json(dto);
  } catch (e) {
    if (knownError(res, e)) return;
    throw e;
  }
});

/**
 * `POST /study/inbox/:id/to-page {classId, title?, week?, lecture?}` — an inbox PDF becomes a `pdf`
 * notebook page. The bytes are COPIED to a fresh study file key (deleting the inbox item later must
 * not break the page); the item is marked used only once the page exists.
 */
export const postInboxToPage = wrap(async (req, res) => {
  if (!isOid(req.params.id)) return fail(res, 404, "NOT_FOUND", "Item not found");
  const b = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>;
  if (!isOid(b.classId)) return fail(res, 400, "VALIDATION_ERROR", "classId is required");
  if (b.title !== undefined && b.title !== null && (typeof b.title !== "string" || !b.title.trim() || b.title.trim().length > 200))
    return fail(res, 400, "VALIDATION_ERROR", "title must be a string (1..200)");
  const orgErr = orgFieldError({ week: b.week, lecture: b.lecture });
  if (orgErr) return fail(res, 400, "VALIDATION_ERROR", orgErr);
  const userId = uid(req);
  const item = await StudyInboxItem.findOne({ _id: req.params.id, userId, deletedAt: null }).lean<IStudyInboxItem>();
  if (!item) return fail(res, 404, "NOT_FOUND", "Item not found");
  if (item.kind !== "pdf") return fail(res, 400, "VALIDATION_ERROR", "Only PDF inbox items can become a PDF page");
  const cls = await StudyClass.findOne({ _id: b.classId, userId }).lean<IStudyClass>();
  if (!cls) return fail(res, 404, "NOT_FOUND", "Class not found");
  const title = (typeof b.title === "string" && b.title.trim()) || item.note?.slice(0, 200).trim() || "PDF from inbox";
  // A missing object is a 404 for this item; any other storage error stays a 500 (an outage is not "gone").
  if (!(await studyObjectExists(item.key))) return fail(res, 404, "NOT_FOUND", "The inbox PDF's file is no longer stored");
  const pdf = await getStudyObject(item.key);
  const r = await createGeneratedPdfPage(String(userId), cls, pdf, { title, week: b.week ?? null, lecture: b.lecture ?? null, label: "inbox_to_page" });
  if (!r.ok) return res.status(r.invoked.status).json(r.invoked.body);
  await StudyInboxItem.updateOne({ _id: item._id, userId }, { $set: { usedAt: new Date() } });
  res.status(201).json({ pageId: r.pageId, itemId: r.itemId, page: r.page });
});

/** SSE: `event: item` per new upload (any fork), `: ping` every 10 s, until the client leaves. */
export const streamInbox = (req: Request, res: Response, _next: NextFunction) => {
  const sse = openStudySse(res);
  const unsubscribe = subscribeInbox(String(uid(req)), (item) => sse.send("item", item));
  res.on("close", unsubscribe);
};
