import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { StudyCanvasConnection, IStudyCanvasConnection } from "@/models/study/canvas-connection";
import { StudyClass, IStudyClass, isManualClass } from "@/models/study/class";
import { StudyModule } from "@/models/study/module";
import { StudyItem, IStudyItem, STUDY_ITEM_TYPES } from "@/models/study/item";
import { encryptToken } from "@/services/study/crypto";
import { CanvasUrlError, normaliseCanvasBaseUrl } from "@/services/study/canvas-url";
import { CanvasApiError, CanvasClient } from "@/services/study/canvas-client";
import { startSync, SYNC_STALE_MS } from "@/services/study/canvas-sync.service";
import { buildToday, classDto, DEFAULT_MEETING_TZ, resolveMeetings, countsByClass, itemDto, itemsDto, listClasses, LIST_PROJECTION } from "@/services/study/views";
import { logger } from "@/services/logger.service";
import { classifyAiError, isAiQuotaError, logAiFailure } from "@/services/study/ai-errors";
import { validateGradeSettings } from "@/services/study/grade-plan";
import { attachPendingImports } from "@/services/study/library";

/**
 * Personal study module (contract: apps/study/lib/api/endpoints.ts + types.ts, P1).
 * Mounted behind adminVerification + fullAdminOnly; every row is keyed by the admin id.
 */

export const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ message, code });
export const uid = (req: Request) => new Types.ObjectId(String(req.adminId));
export const isOid = (v: unknown) => typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v);

export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(async (e) => {
      if (isAiQuotaError(e)) {
        const c = classifyAiError(e);
        await logAiFailure("study route failed", e, { path: req.originalUrl }, c.code);
        if (!res.headersSent) return fail(res, 402, c.code, c.message);
        return next(e);
      }
      await logger.error("study route failed", e, { path: req.originalUrl });
      if (!res.headersSent) fail(res, 500, "INTERNAL", "Something went wrong");
      else next(e);
    });

// ─── Canvas connection ──────────────────────────────────────────────────────────────────

const statusDto = (c: IStudyCanvasConnection | null, now = Date.now()) =>
  c
    ? {
        connected: true,
        baseUrl: c.baseUrl,
        canvasUser: { id: c.canvasUser?.id ?? null, name: c.canvasUser?.name ?? null },
        tokenExpiresAt: c.tokenExpiresAt ? new Date(c.tokenExpiresAt).toISOString() : null,
        lastSyncAt: c.lastSyncAt ? new Date(c.lastSyncAt).toISOString() : null,
        syncing: !!c.syncing && !!c.syncStartedAt && now - new Date(c.syncStartedAt).getTime() < SYNC_STALE_MS,
        lastError: c.lastError?.code ? { code: c.lastError.code, message: c.lastError.message } : null,
      }
    : { connected: false, baseUrl: null, canvasUser: null, tokenExpiresAt: null, lastSyncAt: null, syncing: false, lastError: null };

const kickSync = (userId: string) =>
  startSync(userId).catch((e) => logger.error("study canvas sync failed to start", e, { userId }));

export const putConnection = wrap(async (req, res) => {
  const { baseUrl: rawUrl, token, expiresAt } = req.body ?? {};
  let baseUrl: string;
  try {
    baseUrl = normaliseCanvasBaseUrl(rawUrl);
  } catch (e) {
    if (e instanceof CanvasUrlError) return fail(res, 400, e.code, e.message);
    throw e;
  }
  if (typeof token !== "string" || !token.trim() || token.length > 4096) return fail(res, 400, "VALIDATION_ERROR", "token is required");
  let tokenExpiresAt: Date | null = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    tokenExpiresAt = new Date(String(expiresAt));
    if (Number.isNaN(tokenExpiresAt.getTime())) return fail(res, 400, "VALIDATION_ERROR", "expiresAt must be an ISO date");
  }

  let self: any;
  try {
    self = await new CanvasClient({ baseUrl, token: token.trim(), maxRetries: 1 }).get("/api/v1/users/self");
  } catch (e) {
    if (e instanceof CanvasApiError && e.status === 401) return fail(res, 400, "CANVAS_TOKEN_INVALID", "Canvas rejected this token");
    return fail(res, 502, "CANVAS_UNREACHABLE", "Could not reach Canvas to validate the token");
  }

  const conn = await StudyCanvasConnection.findOneAndUpdate(
    { userId: uid(req) },
    {
      $set: {
        baseUrl,
        tokenEnc: encryptToken(token.trim()),
        canvasUser: { id: Number(self?.id), name: String(self?.name ?? "") },
        tokenExpiresAt,
        lastError: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean<IStudyCanvasConnection>();
  // P-CM: class-folder imports waiting for this Canvas user become this admin's (idempotent; other Canvas users untouched).
  await attachPendingImports(uid(req), Number(self?.id)).catch((e) => logger.error("study pending import attach failed", e, {}));
  void kickSync(String(req.adminId));
  res.json(statusDto(conn));
});

export const getConnection = wrap(async (req, res) => {
  res.json(statusDto(await StudyCanvasConnection.findOne({ userId: uid(req) }).lean<IStudyCanvasConnection>()));
});

/** Removes the connection (and the stored token) only — synced classes/items stay. */
export const deleteConnection = wrap(async (req, res) => {
  await StudyCanvasConnection.deleteOne({ userId: uid(req) });
  res.json(statusDto(null));
});

export const postSync = wrap(async (req, res) => {
  const conn = await StudyCanvasConnection.exists({ userId: uid(req) });
  if (!conn) return fail(res, 400, "CANVAS_NOT_CONNECTED", "Connect Canvas first");
  void kickSync(String(req.adminId));
  res.json({ started: true });
});

// ─── classes & items ────────────────────────────────────────────────────────────────────

export const getClasses = wrap(async (req, res) => {
  res.json(await listClasses(uid(req), req.query.term === "all"));
});

const ownClass = async (req: Request, res: Response): Promise<IStudyClass | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid class id");
    return null;
  }
  const cls = await StudyClass.findOne({ _id: req.params.id, userId: uid(req) }).lean<IStudyClass>();
  if (!cls) fail(res, 404, "NOT_FOUND", "Class not found");
  return cls;
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};
/** `{slots:[{day,start,end}], timeZone?}` → the stored override, or an error message. */
const parseMeetings = (v: unknown): { value: { slots: { day: string; start: string; end: string }[]; timeZone: string } } | { error: string } => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "meetings must be {slots, timeZone?} or null" };
  const { slots, timeZone } = v as Record<string, unknown>;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 14) return { error: "meetings.slots must have 1..14 entries" };
  const out: { day: string; start: string; end: string }[] = [];
  for (const s of slots) {
    const { day, start, end } = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    if (typeof day !== "string" || !DAYS.includes(day)) return { error: `slot day must be one of ${DAYS.join(", ")}` };
    if (typeof start !== "string" || !HHMM.test(start) || typeof end !== "string" || !HHMM.test(end)) return { error: "slot start/end must be 24h HH:MM" };
    if (end <= start) return { error: "slot end must be after start" };
    out.push({ day, start, end });
  }
  if (timeZone !== undefined && timeZone !== null && (typeof timeZone !== "string" || !timeZone || !validZone(timeZone))) return { error: "meetings.timeZone must be an IANA time zone" };
  return { value: { slots: out, timeZone: (timeZone as string | undefined) || DEFAULT_MEETING_TZ } };
};

const COLOR = /^#[0-9a-fA-F]{6}$/;
/** Manual-class `name` (1..80) / `code` (0..30), trimmed; undefined = not sent. */
const parseNameCode = (body: any): { name?: string; code?: string } | { error: string } => {
  const out: { name?: string; code?: string } = {};
  if (body?.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return { error: "name must be 1..80 characters" };
    out.name = body.name.trim();
  }
  if (body?.code !== undefined && body.code !== null) {
    if (typeof body.code !== "string" || body.code.trim().length > 30) return { error: "code must be 0..30 characters" };
    out.code = body.code.trim();
  } else if (body?.code === null) out.code = "";
  return out;
};

const classResponse = async (req: Request, cls: IStudyClass) => {
  const counts = await countsByClass(uid(req), [cls._id], new Date());
  const mt = (await resolveMeetings(uid(req), [cls])).get(String(cls._id));
  return classDto(cls, counts.get(String(cls._id))!, undefined, mt);
};

/**
 * POST /study/classes — a class the user makes themselves (no Canvas course behind it).
 * Its `canvasCourseId` is a unique NEGATIVE sentinel so the {userId, canvasCourseId} unique
 * index and every per-course lookup (guide, library, exam results…) still key it on its own.
 */
export const postClass = wrap(async (req, res) => {
  const body = req.body ?? {};
  const unknown = Object.keys(body).filter((k) => !["name", "code", "color"].includes(k));
  if (unknown.length) return fail(res, 400, "VALIDATION_ERROR", `Unknown field(s): ${unknown.join(", ")}`);
  if (body.name === undefined) return fail(res, 400, "VALIDATION_ERROR", "name is required");
  const nc = parseNameCode(body);
  if ("error" in nc) return fail(res, 400, "VALIDATION_ERROR", nc.error);
  if (body.color !== undefined && body.color !== null && (typeof body.color !== "string" || !COLOR.test(body.color)))
    return fail(res, 400, "VALIDATION_ERROR", "color must be #rrggbb or null");
  let created: IStudyClass | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      const doc = await StudyClass.create({
        userId: uid(req),
        source: "manual",
        canvasCourseId: -(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
        name: nc.name,
        code: nc.code ?? "",
        userColor: body.color ?? null,
        current: true,
      });
      created = doc.toObject() as IStudyClass;
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
    }
  }
  if (!created) return fail(res, 409, "CONFLICT", "Could not allocate a class id; try again");
  res.status(201).json(await classResponse(req, created));
});

/**
 * DELETE /study/classes/:id — manual classes only. Removes the class row ONLY: its pages,
 * questions, lectures and code projects are left in place (orphaned, recoverable), never
 * cascaded away.
 */
export const deleteClass = wrap(async (req, res) => {
  const cls = await ownClass(req, res);
  if (!cls) return;
  if (!isManualClass(cls)) return fail(res, 400, "CANVAS_CLASS", "Canvas classes cannot be deleted; hide it instead");
  await StudyClass.deleteOne({ _id: cls._id, userId: uid(req), source: "manual" });
  res.status(204).end();
});

export const patchClass = wrap(async (req, res) => {
  const { hidden, color, targetLetter, gradePolicy, meetings } = req.body ?? {};
  const set: Record<string, unknown> = {};
  const nc = parseNameCode(req.body);
  if ("error" in nc) return fail(res, 400, "VALIDATION_ERROR", nc.error);
  if (nc.name !== undefined) set.name = nc.name;
  if (nc.code !== undefined) set.code = nc.code;
  if (hidden !== undefined) {
    if (typeof hidden !== "boolean") return fail(res, 400, "VALIDATION_ERROR", "hidden must be a boolean");
    set.hidden = hidden;
  }
  if (color !== undefined) {
    if (color !== null && (typeof color !== "string" || !COLOR.test(color)))
      return fail(res, 400, "VALIDATION_ERROR", "color must be #rrggbb or null");
    set.userColor = color;
  }
  if (meetings !== undefined) {
    if (meetings === null) set.meetingsOverride = null;
    else {
      const r = parseMeetings(meetings);
      if ("error" in r) return fail(res, 400, "VALIDATION_ERROR", r.error);
      set.meetingsOverride = r.value;
    }
  }
  const gradeFields = targetLetter !== undefined || gradePolicy !== undefined;
  if (!Object.keys(set).length && !gradeFields) return fail(res, 400, "VALIDATION_ERROR", "Nothing to update");
  const cls = await ownClass(req, res);
  if (!cls) return;
  // Canvas owns a synced class's name/code — the next sync would overwrite an edit.
  if ((set.name !== undefined || set.code !== undefined) && !isManualClass(cls))
    return fail(res, 400, "CANVAS_CLASS", "name/code can only be edited on your own classes");
  if (gradeFields) {
    // Validated against THIS class's grading scheme / assignment groups (grade plan).
    const r = await validateGradeSettings(cls, { targetLetter, gradePolicy });
    if ("error" in r) return fail(res, 400, "VALIDATION_ERROR", r.error);
    Object.assign(set, r.set);
  }
  const updated = await StudyClass.findByIdAndUpdate(cls._id, { $set: set }, { new: true }).lean<IStudyClass>();
  res.json(await classResponse(req, updated!));
});

export const getModules = wrap(async (req, res) => {
  const cls = await ownClass(req, res);
  if (!cls) return;
  const [modules, items] = await Promise.all([
    StudyModule.find({ userId: uid(req), classId: cls._id }).sort({ position: 1 }).lean(),
    StudyItem.find({ userId: uid(req), classId: cls._id, moduleId: { $ne: null } }, LIST_PROJECTION)
      .sort({ modulePosition: 1 })
      .lean<IStudyItem[]>(),
  ]);
  const byModule = new Map<string, IStudyItem[]>();
  for (const it of items) {
    const k = String(it.moduleId);
    if (!byModule.has(k)) byModule.set(k, []);
    byModule.get(k)!.push(it);
  }
  res.json(
    await Promise.all(
      modules.map(async (m: any) => ({
        id: String(m._id),
        name: m.name,
        position: m.position,
        items: await itemsDto(byModule.get(String(m._id)) ?? []),
      }))
    )
  );
});

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getClassItems = wrap(async (req, res) => {
  const { type, q } = req.query;
  if (type !== undefined && (typeof type !== "string" || !(STUDY_ITEM_TYPES as readonly string[]).includes(type)))
    return fail(res, 400, "VALIDATION_ERROR", `type must be one of ${STUDY_ITEM_TYPES.join(", ")}`);
  if (q !== undefined && (typeof q !== "string" || q.length > 200)) return fail(res, 400, "VALIDATION_ERROR", "q must be a string");
  const cls = await ownClass(req, res);
  if (!cls) return;
  const filter: Record<string, unknown> = { userId: uid(req), classId: cls._id };
  if (type) filter.type = type;
  if (q && q.trim()) filter.title = { $regex: escapeRegex(q.trim()), $options: "i" };
  const items = await StudyItem.find(filter, LIST_PROJECTION).sort({ canvasUpdatedAt: -1, _id: 1 }).lean<IStudyItem[]>();
  res.json(await itemsDto(items));
});

const ownItem = async (req: Request, res: Response, projection?: object): Promise<IStudyItem | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid item id");
    return null;
  }
  const item = await StudyItem.findOne({ _id: req.params.id, userId: uid(req) }, projection).lean<IStudyItem>();
  if (!item) fail(res, 404, "NOT_FOUND", "Item not found");
  return item;
};

export const getItem = wrap(async (req, res) => {
  const item = await ownItem(req, res);
  if (!item) return;
  res.json(await itemDto(item, { withHtml: true }));
});

export const markSeen = wrap(async (req, res) => {
  const item = await ownItem(req, res, { _id: 1, seenAt: 1 });
  if (!item) return;
  if (!item.seenAt) await StudyItem.updateOne({ _id: item._id, seenAt: null }, { $set: { seenAt: new Date() } });
  res.status(204).end();
});

export const getToday = wrap(async (req, res) => {
  res.json(await buildToday(uid(req)));
});
