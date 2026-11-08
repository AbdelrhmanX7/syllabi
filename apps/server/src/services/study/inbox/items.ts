import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { StudyClass } from "@/models/study";
import { StudyPage } from "@/models/study/page";
import { IStudyInboxItem, StudyInboxItem } from "@/models/study/inbox";
import { putStudyObject, signedGetUrl } from "@/services/study/storage";
import { publishInboxItem } from "./bus";
import { processUpload } from "./media";

export const INBOX_LIST_LIMIT = 50;
export const NOTE_MAX = 500;

/** `study/<userId>/inbox/<uuid>.<ext>` — the thumb shares the uuid: `<uuid>.thumb.<ext>`. */
export const inboxKey = (userId: string, uuid: string, ext: string) => `study/${userId}/inbox/${uuid}.${ext}`;

export async function inboxItemDto(d: IStudyInboxItem) {
  const [main, thumb] = await Promise.all([
    signedGetUrl(d.key, { contentType: d.contentType }),
    d.thumbKey ? signedGetUrl(d.thumbKey, { contentType: d.thumbContentType ?? "image/jpeg" }) : Promise.resolve(null),
  ]);
  return {
    id: String(d._id),
    kind: d.kind,
    url: main.url,
    thumbUrl: thumb?.url ?? null,
    width: d.width ?? null,
    height: d.height ?? null,
    bytes: d.bytes,
    note: d.note ?? null,
    classId: d.classId ? String(d.classId) : null,
    pageId: d.pageId ? String(d.pageId) : null,
    createdAt: new Date(d.createdAt).toISOString(),
    usedAt: d.usedAt ? new Date(d.usedAt).toISOString() : null,
  };
}

export class InboxError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const isOidString = (v: unknown): v is string => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v);

/** An owned, live notebook page an item can be queued for; returns it (its class fills a missing classId). */
export async function validatePageTarget(userId: Types.ObjectId, pageId: unknown) {
  if (!isOidString(pageId)) throw new InboxError(400, "VALIDATION_ERROR", "pageId is not a valid id");
  const page = await StudyPage.findOne({ _id: pageId, userId, deletedAt: null }, { _id: 1, classId: 1, title: 1, kind: 1 }).lean<{ _id: Types.ObjectId; classId: Types.ObjectId | null; title: string; kind: string }>();
  if (!page) throw new InboxError(404, "NOT_FOUND", "Page not found");
  return page;
}

/** Validates note/classId/pageId BEFORE any processing; returns the normalised values. */
export async function validateMeta(userId: Types.ObjectId, note: unknown, classId: unknown, pageId?: unknown) {
  let n: string | null = null;
  if (note !== undefined && note !== null && note !== "") {
    if (typeof note !== "string") throw new InboxError(400, "VALIDATION_ERROR", "note must be a string");
    const t = note.trim();
    if (t.length > NOTE_MAX) throw new InboxError(400, "VALIDATION_ERROR", `note is at most ${NOTE_MAX} characters`);
    n = t || null;
  }
  let c: Types.ObjectId | null = null;
  if (classId !== undefined && classId !== null && classId !== "") {
    if (!isOidString(classId)) throw new InboxError(400, "VALIDATION_ERROR", "classId is not a valid id");
    const owned = await StudyClass.exists({ _id: classId, userId });
    if (!owned) throw new InboxError(404, "NOT_FOUND", "Class not found");
    c = new Types.ObjectId(classId);
  }
  let p: Types.ObjectId | null = null;
  if (pageId !== undefined && pageId !== null && pageId !== "") {
    const page = await validatePageTarget(userId, pageId);
    p = page._id;
    c ??= page.classId ?? null;
  }
  return { note: n, classId: c, pageId: p };
}

export async function createInboxItem(
  userId: Types.ObjectId,
  file: Buffer,
  meta: { note: string | null; classId: Types.ObjectId | null; pageId?: Types.ObjectId | null; tokenId: Types.ObjectId | null }
) {
  const media = await processUpload(file);
  const uid = String(userId);
  const uuid = randomUUID();
  const key = inboxKey(uid, uuid, media.ext);
  const thumbKey = media.thumb ? inboxKey(uid, uuid, `thumb.${media.thumb.ext}`) : null;
  await putStudyObject(key, media.body, media.contentType);
  if (media.thumb && thumbKey) await putStudyObject(thumbKey, media.thumb.body, media.thumb.contentType);
  const doc = await StudyInboxItem.create({
    userId,
    kind: media.kind,
    key,
    contentType: media.contentType,
    thumbKey,
    thumbContentType: media.thumb?.contentType ?? null,
    width: media.width,
    height: media.height,
    bytes: media.body.length,
    note: meta.note,
    classId: meta.classId,
    pageId: meta.pageId ?? null,
    tokenId: meta.tokenId,
  });
  const dto = await inboxItemDto(doc.toObject() as IStudyInboxItem);
  publishInboxItem(uid, dto);
  return dto;
}

/** `pageId` → only the items still waiting to go on that page (not capped by recency, so none is missed). */
export async function listInboxItems(userId: Types.ObjectId, since: unknown, pageId?: unknown) {
  const filter: Record<string, unknown> = { userId, deletedAt: null };
  if (pageId !== undefined && pageId !== "") {
    if (!isOidString(pageId)) throw new InboxError(400, "VALIDATION_ERROR", "pageId is not a valid id");
    filter.pageId = new Types.ObjectId(pageId);
    filter.usedAt = null;
  }
  if (since !== undefined && since !== "") {
    const d = typeof since === "string" ? new Date(since) : new Date(NaN);
    if (Number.isNaN(d.getTime())) throw new InboxError(400, "VALIDATION_ERROR", "since must be an ISO date");
    filter.createdAt = { $gt: d };
  }
  const rows = await StudyInboxItem.find(filter).sort({ createdAt: -1, _id: -1 }).limit(INBOX_LIST_LIMIT).lean<IStudyInboxItem[]>();
  return Promise.all(rows.map(inboxItemDto));
}

/** Soft delete; the stored object is kept. False when it is not the caller's (or already gone). */
export async function deleteInboxItem(userId: Types.ObjectId, id: string) {
  const r = await StudyInboxItem.updateOne({ _id: id, userId, deletedAt: null }, { $set: { deletedAt: new Date() } });
  return r.matchedCount === 1;
}

/** `PATCH /study/inbox/:id {usedAt?, pageId?}` — at least one; `pageId: null` drops a queued placement. */
export async function patchInboxItem(userId: Types.ObjectId, id: string, body: any) {
  if (!body || typeof body !== "object" || !("usedAt" in body || "pageId" in body))
    throw new InboxError(400, "VALIDATION_ERROR", "usedAt (ISO date or null) or pageId (id or null) is required");
  const set: { usedAt?: Date | null; pageId?: Types.ObjectId | null } = {};
  if ("usedAt" in body) {
    if (body.usedAt === null) set.usedAt = null;
    else {
      const d = typeof body.usedAt === "string" ? new Date(body.usedAt) : new Date(NaN);
      if (Number.isNaN(d.getTime())) throw new InboxError(400, "VALIDATION_ERROR", "usedAt must be an ISO date or null");
      set.usedAt = d;
    }
  }
  if ("pageId" in body) set.pageId = body.pageId === null ? null : (await validatePageTarget(userId, body.pageId))._id;
  const doc = await StudyInboxItem.findOneAndUpdate({ _id: id, userId, deletedAt: null }, { $set: set }, { new: true }).lean<IStudyInboxItem>();
  return doc ? inboxItemDto(doc) : null;
}

/**
 * Queues inbox items for a notebook page (MCP `add_inbox_to_page`), in the order given. Re-queues an
 * item already placed elsewhere (`usedAt` cleared) — the owner asked for it on THIS page. Returns
 * the queued DTOs and the ids that are not the owner's (or deleted).
 */
export async function queueInboxItemsForPage(userId: Types.ObjectId, pageId: unknown, ids: string[]) {
  const page = await validatePageTarget(userId, pageId);
  const unique = [...new Set(ids)];
  const rows = await StudyInboxItem.find({ _id: { $in: unique }, userId, deletedAt: null }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>();
  const found = new Set(rows.map((r) => String(r._id)));
  const queued = unique.filter((id) => found.has(id));
  if (queued.length) await StudyInboxItem.updateMany({ _id: { $in: queued }, userId, deletedAt: null }, { $set: { pageId: page._id, usedAt: null } });
  const docs = await StudyInboxItem.find({ _id: { $in: queued }, userId, deletedAt: null }).lean<IStudyInboxItem[]>();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const items = await Promise.all(queued.filter((id) => byId.has(id)).map((id) => inboxItemDto(byId.get(id)!)));
  for (const item of items) publishInboxItem(String(userId), item);
  return { page, items, notFound: unique.filter((id) => !found.has(id)) };
}
