import { NextFunction, Request, Response } from "express";
import { isOwnerRole } from "@/auth/roles";
import { Types } from "mongoose";
import { Admin } from "@/models/admin";
import { PERF_KINDS, PERF_SCHEMA, StudyPerfBatch, StudyPerfQuota } from "@/models/study/perf";
import { logger } from "@/services/logger.service";
import { readSessionUserId } from "@/compat/auth";

/**
 * Study app perf telemetry — POST/GET /study/telemetry/perf (routes/study/telemetry.ts).
 *
 * Mounted OUTSIDE the /study admin mount: POST takes any signed-in study session (any admin
 * role — `fullAdminOnly` and the confined-role check would 403 a valid session), GET is
 * owner-only (full admin, the same rule `fullAdminOnly` applies to the rest of /study).
 */

export const PERF_MAX_EVENTS = 5000;
export const PERF_QUOTA = { requestsPerHour: 120, bytesPerDay: 5 * 1024 * 1024 } as const;
export const PERF_GET_MAX_LIMIT = 5000;
const PERF_GET_DEFAULT_LIMIT = 1000;
const KIND_SET = new Set<string>(PERF_KINDS);

const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ message, code });

/** Study session = admin JWT. Any role; 401 only for a missing/invalid token or a missing/disabled account. */
export const studySessionAuth = async (req: Request, res: Response, next: NextFunction) => {
  const sessionUserId = readSessionUserId(req);
  if (!sessionUserId) return fail(res, 401, "UNAUTHORIZED", "Invalid session");
  const adminId: string = sessionUserId;
  try {
    const admin = Types.ObjectId.isValid(adminId) ? await Admin.findById(adminId).select("role isDisabled").lean() : null;
    if (!admin || (admin as any).isDisabled) return fail(res, 401, "UNAUTHORIZED", "Invalid session");
    req.adminId = adminId;
    req.userId = adminId;
    req.isAdmin = true;
    req.adminRole = (admin as any).role ?? "admin";
    logger.setUserContext({ userId: adminId, userRole: "Admin" });
    next();
  } catch (e) {
    next(e);
  }
};

/** Owner only (role "owner", or the legacy "admin"): perf traces are server-management data. */
export const studyOwnerOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!isOwnerRole(req.adminRole)) return fail(res, 403, "FORBIDDEN", "Owner only");
  next();
};

/** body-parser errors on these routes → 413 / 400 with the study error shape. */
export const perfBodyErrors = (err: any, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.too.large" || err?.status === 413) return fail(res, 413, "PAYLOAD_TOO_LARGE", "Body exceeds the 2 MB limit");
  if (err?.status === 415) return fail(res, 415, "UNSUPPORTED_ENCODING", "Unsupported Content-Encoding");
  if (typeof err?.status === "number" && err.status >= 400 && err.status < 500) return fail(res, 400, "MALFORMED", "Malformed body");
  next(err);
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/** Envelope check: the reason the batch is rejected, or null. Shape errors → 400, too many events → 413. */
export const validatePerfBatch = (b: any): { status: 400 | 413; message: string } | null => {
  if (!isObj(b)) return { status: 400, message: "Body must be a PerfBatch object" };
  if (b.schema !== PERF_SCHEMA) return { status: 400, message: `schema must be "${PERF_SCHEMA}"` };
  if (!isStr(b.batchId, 128)) return { status: 400, message: "batchId must be a non-empty string" };
  if (b.session !== undefined && typeof b.session !== "string") return { status: 400, message: "session must be a string" };
  if (!isObj(b.device) || !isStr(b.device.id, 128)) return { status: 400, message: "device.id is required" };
  if (b.app !== undefined && b.app !== null && !isObj(b.app)) return { status: 400, message: "app must be an object" };
  if (b.dropped !== undefined && !(typeof b.dropped === "number" && b.dropped >= 0)) return { status: 400, message: "dropped must be a number ≥ 0" };
  if (!Array.isArray(b.events)) return { status: 400, message: "events must be an array" };
  if (b.events.length > PERF_MAX_EVENTS) return { status: 413, message: `At most ${PERF_MAX_EVENTS} events per batch` };
  return null;
};

/**
 * Per-event check. A bad event is DROPPED, never a 400: the client treats 400 as poison and
 * deletes the whole batch, so one new event kind shipped by FE would otherwise destroy every batch.
 */
export const isValidPerfEvent = (e: unknown): boolean =>
  isObj(e) && KIND_SET.has(e.k as string) && typeof e.t === "number" && Number.isFinite(e.t);

const bump = async (user: Types.ObjectId, key: string, inc: Record<string, number>, expireAt: Date) => {
  const run = () =>
    StudyPerfQuota.findOneAndUpdate({ user, key }, { $inc: inc, $setOnInsert: { expireAt } }, { upsert: true, new: true }).lean();
  try {
    return await run();
  } catch (e: any) {
    if (e?.code === 11000) return run(); // first-insert race: the other upsert won, now we update it
    throw e;
  }
};

/**
 * Fixed windows: ≤120 requests per user per UTC hour, ≤5 MB inflated per user per UTC day.
 * A rejected batch's bytes are given back. FAIL-OPEN: a counter outage never drops telemetry.
 * Returns the Retry-After seconds when over quota, else null.
 */
export const checkPerfQuota = async (user: Types.ObjectId, bytes: number, now = Date.now()): Promise<number | null> => {
  try {
    const hour = Math.floor(now / 3_600_000);
    const day = Math.floor(now / 86_400_000);
    const h = await bump(user, `h:${hour}`, { count: 1 }, new Date((hour + 2) * 3_600_000));
    if ((h?.count ?? 0) > PERF_QUOTA.requestsPerHour) return Math.max(1, Math.ceil(((hour + 1) * 3_600_000 - now) / 1000));
    const d = await bump(user, `d:${day}`, { bytes }, new Date((day + 2) * 86_400_000));
    if ((d?.bytes ?? 0) > PERF_QUOTA.bytesPerDay) {
      await StudyPerfQuota.updateOne({ user, key: `d:${day}` }, { $inc: { bytes: -bytes } });
      return Math.max(1, Math.ceil(((day + 1) * 86_400_000 - now) / 1000));
    }
    return null;
  } catch (e) {
    await logger.error("study perf quota check failed (fail-open)", e as Error, { user: String(user) });
    return null;
  }
};

/** Undo one accepted request's reservation (a concurrent duplicate that lost on the unique index). */
export const releasePerfQuota = async (user: Types.ObjectId, bytes: number, now: number) => {
  try {
    await StudyPerfQuota.updateOne({ user, key: `h:${Math.floor(now / 3_600_000)}` }, { $inc: { count: -1 } });
    await StudyPerfQuota.updateOne({ user, key: `d:${Math.floor(now / 86_400_000)}` }, { $inc: { bytes: -bytes } });
  } catch (e) {
    await logger.error("study perf quota release failed", e as Error, { user: String(user) });
  }
};

export const postPerf = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = req.body;
    const bad = validatePerfBatch(b);
    if (bad) return fail(res, bad.status, bad.status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION", bad.message);

    const user = new Types.ObjectId(String(req.adminId));
    // A retry of a stored batch is a success and must not burn quota.
    if (await StudyPerfBatch.exists({ user, batchId: b.batchId })) return res.status(204).end();

    const bytes = Number((req as any).perfRawBytes) || Buffer.byteLength(JSON.stringify(b));
    const now = Date.now();
    const retryAfter = await checkPerfQuota(user, bytes, now);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return fail(res, 429, "QUOTA", "Telemetry quota exceeded");
    }

    const events = (b.events as unknown[]).filter(isValidPerfEvent);
    try {
      await StudyPerfBatch.create({
        user,
        batchId: b.batchId,
        session: b.session ?? "",
        sentAt: b.sentAt ?? null,
        device: b.device,
        app: b.app ?? null,
        dropped: b.dropped ?? 0,
        events,
        rejectedEvents: b.events.length - events.length,
        bytes,
        t: new Date(),
      });
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      // Concurrent duplicate: both passed `exists`, the other one stored it. Same answer (204),
      // but give back this request's reservation — retries must never burn quota.
      await releasePerfQuota(user, bytes, now);
    }
    return res.status(204).end();
  } catch (e) {
    next(e);
  }
};

const parseTime = (v: unknown): Date | null | undefined => {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string") return null;
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Cursor = base64url("<batch t ms>.<batch _id>.<event index>") of the last event returned. */
const encodeCursor = (t: Date, id: Types.ObjectId, i: number) => Buffer.from(`${t.getTime()}.${id}.${i}`).toString("base64url");
const decodeCursor = (c: string) => {
  const m = /^(\d+)\.([0-9a-f]{24})\.(\d+)$/.exec(Buffer.from(c, "base64url").toString());
  return m ? { t: new Date(Number(m[1])), id: new Types.ObjectId(m[2]), i: Number(m[3]) } : null;
};

export const getPerf = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query as Record<string, unknown>;
    const match: Record<string, any> = {};
    if (q.user !== undefined) {
      if (typeof q.user !== "string" || !/^[0-9a-fA-F]{24}$/.test(q.user)) return fail(res, 400, "VALIDATION", "user must be an id");
      match.user = new Types.ObjectId(q.user);
    }
    if (q.device !== undefined) {
      if (!isStr(q.device, 128)) return fail(res, 400, "VALIDATION", "device must be a string");
      match["device.id"] = q.device;
    }
    const from = parseTime(q.from);
    const to = parseTime(q.to);
    if (from === null || to === null) return fail(res, 400, "VALIDATION", "from/to must be ISO dates or epoch ms");
    if (from || to) match.t = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    let kinds: string[] | undefined;
    if (q.kind !== undefined) {
      kinds = typeof q.kind === "string" ? q.kind.split(",").filter(Boolean) : [];
      if (!kinds.length || kinds.some((k) => !KIND_SET.has(k))) return fail(res, 400, "VALIDATION", `kind ∈ {${PERF_KINDS.join(",")}}`);
    }
    let limit = PERF_GET_DEFAULT_LIMIT;
    if (q.limit !== undefined) {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1) return fail(res, 400, "VALIDATION", "limit must be a positive integer");
      limit = Math.min(limit, PERF_GET_MAX_LIMIT);
    }
    let cursor: ReturnType<typeof decodeCursor> = null;
    if (q.cursor !== undefined) {
      cursor = typeof q.cursor === "string" ? decodeCursor(q.cursor) : null;
      if (!cursor) return fail(res, 400, "VALIDATION", "Bad cursor");
    }

    const batchMatch: Record<string, any> = { ...match };
    if (cursor) batchMatch.$or = [{ t: { $lt: cursor.t } }, { t: cursor.t, _id: { $lte: cursor.id } }];
    const eventMatch: Record<string, any> = {};
    if (kinds) eventMatch["e.v.k"] = { $in: kinds };
    if (cursor) eventMatch.$or = [{ _id: { $ne: cursor.id } }, { "e.i": { $lt: cursor.i } }];

    // Batches newest first, each batch's events reversed (appended in time order) → a
    // newest-first stream with no post-unwind sort.
    const rows = await StudyPerfBatch.aggregate([
      { $match: batchMatch },
      { $sort: { t: -1, _id: -1 } },
      {
        $project: {
          t: 1,
          user: 1,
          session: 1,
          app: 1,
          deviceId: "$device.id",
          e: {
            $reverseArray: {
              $map: {
                input: { $range: [0, { $size: "$events" }] },
                as: "i",
                in: { i: "$$i", v: { $arrayElemAt: ["$events", "$$i"] } },
              },
            },
          },
        },
      },
      { $unwind: "$e" },
      ...(Object.keys(eventMatch).length ? [{ $match: eventMatch }] : []),
      { $limit: limit + 1 },
    ]).allowDiskUse(true);

    const page = rows.slice(0, limit);
    const events = page.map((r: any) => ({ ...r.e.v, device: r.deviceId, session: r.session, user: String(r.user), app: r.app ?? null }));
    const last = page[page.length - 1];
    const devices = await StudyPerfBatch.aggregate([
      { $match: match.user ? { user: match.user } : {} },
      { $sort: { t: -1 } },
      { $group: { _id: "$device.id", ua: { $first: "$device.ua" }, lastSeen: { $first: "$t" }, app: { $first: "$app" } } },
      { $sort: { lastSeen: -1 } },
      { $limit: 200 },
    ]);
    return res.status(200).json({
      events,
      devices: devices.map((d: any) => ({ id: d._id, ua: d.ua ?? null, lastSeen: d.lastSeen, app: d.app ?? null })),
      ...(rows.length > limit && last ? { next: encodeCursor(last.t, last._id, last.e.i) } : {}),
    });
  } catch (e) {
    next(e);
  }
};
