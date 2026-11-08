import express, { NextFunction, Request, Response } from "express";
import { plural } from "@/services/study/plural";
import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { StudyClass } from "@/models/study/class";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyLecture, IStudyLecture } from "@/models/study/lecture";
import { StudyPage } from "@/models/study/page";
import { StudyTranscript, IStudyTranscript, TranscriptSegment } from "@/models/study/transcript";
import {
  LECTURE_CHUNK_MAX_BYTES,
  LECTURE_MAX_CHUNKS,
  lectureChunkKey,
  presignedPutUrl,
  putStudyObject,
  signedGetUrl,
  studyObjectExists,
} from "@/services/study/storage";
import { JOB_STALE_MS, kickStudyJobs, kickUploadedTranscriptSummary, queueVideoTranscript } from "@/services/study/jobs";
import { fail, isOid, uid, wrap } from "./study.controller";

/**
 * Video transcripts + in-class lectures (contract "Classes & items" transcript lines and
 * "Lectures", P3). The heavy work (yt-dlp, ffmpeg, ASR, summary, extraction) runs in the
 * background job lane (services/study/jobs.ts); these handlers only validate, store and queue.
 */

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

// ─── video transcripts ──────────────────────────────────────────────────────────────────

const ownVideo = async (req: Request, res: Response): Promise<IStudyItem | null> => {
  if (!isOid(req.params.itemId)) {
    fail(res, 400, "INVALID_ID", "Invalid item id");
    return null;
  }
  const item = await StudyItem.findOne({ _id: req.params.itemId, userId: uid(req) }, { type: 1, video: 1, classId: 1 }).lean<IStudyItem>();
  if (!item) {
    fail(res, 404, "NOT_FOUND", "Item not found");
    return null;
  }
  if (item.type !== "video" || !item.video?.videoId) {
    fail(res, 400, "NOT_A_VIDEO", "This item is not a video");
    return null;
  }
  return item;
};

/** The item's public status: a claimed run is still "pending" to the client. */
const publicStatus = (t: IStudyTranscript | null): "none" | "pending" | "ready" | "failed" =>
  !t ? "none" : t.status === "processing" ? "pending" : t.status;

export const transcriptDto = (t: IStudyTranscript | null, extra: Record<string, unknown> = {}) => ({
  ...extra,
  transcriptStatus: publicStatus(t),
  segments: t?.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text })) ?? [],
  summary: t?.summary ?? null,
  keyPoints: t?.keyPoints ?? [],
  source: t?.source ?? null,
  lang: t?.lang ?? "en",
  durationSec: t?.durationSec ?? null,
  error: t?.status === "failed" && t.error?.code ? { code: t.error.code, message: t.error.message } : null,
  updatedAt: iso(t?.updatedAt),
});

/** `{segments, summary, keyPoints}` (+ status fields). Before any request: status `none`, empty. */
export const getVideoTranscript = wrap(async (req, res) => {
  const item = await ownVideo(req, res);
  if (!item) return;
  const t = await StudyTranscript.findOne({ userId: uid(req), itemId: item._id }).lean<IStudyTranscript>();
  res.json(transcriptDto(t, { itemId: String(item._id) }));
});

/** (Re)queue → 202 `{itemId, transcriptStatus:'pending'}`. A run already in flight is left alone. */
export const postVideoTranscript = wrap(async (req, res) => {
  const item = await ownVideo(req, res);
  if (!item) return;
  const state = await queueVideoTranscript(uid(req), item._id);
  res.status(202).json({ itemId: String(item._id), transcriptStatus: "pending", alreadyRunning: state === "running" });
});

export const UPLOAD_MAX_SEGMENTS = 20_000;
export const UPLOAD_MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Validate + normalise an uploaded caption body: trim, drop empties, sort by start. */
export function parseUploadedTranscript(body: any): { error: string } | { segments: TranscriptSegment[]; lang: string; durationSec: number | null; chars: number } {
  if (!body || typeof body !== "object") return { error: "A JSON body is required" };
  if (body.source !== "captions") return { error: "source must be 'captions'" };
  const raw = body.segments;
  if (!Array.isArray(raw) || raw.length < 1) return { error: "segments must be a non-empty array" };
  if (raw.length > UPLOAD_MAX_SEGMENTS) return { error: `segments must have at most ${UPLOAD_MAX_SEGMENTS} entries` };
  let bytes = 0;
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== "object" || typeof s.text !== "string" || typeof s.start !== "number" || typeof s.end !== "number" || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end < s.start)
      return { error: `segments[${i}] must be {start, end, text} with finite numbers, 0 <= start <= end, and a string text` };
    bytes += Buffer.byteLength(s.text);
    if (bytes > UPLOAD_MAX_TEXT_BYTES) return { error: "Total transcript text must be at most 2 MB" };
    const text = s.text.trim();
    if (text) segments.push({ start: s.start, end: s.end, text });
  }
  if (!segments.length) return { error: "segments contain no text" };
  segments.sort((a, b) => a.start - b.start);
  let lang = "en";
  if (body.lang !== undefined && body.lang !== null) {
    if (typeof body.lang !== "string" || !body.lang.trim() || body.lang.trim().length > 16) return { error: "lang must be a short string" };
    lang = body.lang.trim();
  }
  let durationSec: number | null = null;
  if (body.durationSec !== undefined && body.durationSec !== null) {
    if (typeof body.durationSec !== "number" || !Number.isFinite(body.durationSec) || body.durationSec < 0) return { error: "durationSec must be a non-negative number" };
    durationSec = Math.round(body.durationSec);
  } else durationSec = Math.round(Math.max(...segments.map((s) => s.end)));
  return { segments, lang, durationSec, chars: segments.reduce((n, s) => n + s.text.length, 0) };
}

/**
 * The tablet fetched the captions on-device (YouTube blocks yt-dlp from the server) and uploads
 * them. Overwrite: none/failed/pending/processing → this upload wins (row → ready, `claimedAt`
 * cleared so a running server job's fenced final write no-ops); an existing ready transcript →
 * whichever has more text characters. Summary + keyPoints are generated afterwards, async.
 */
export const putVideoTranscript = wrap(async (req, res) => {
  const item = await ownVideo(req, res);
  if (!item) return;
  const p = parseUploadedTranscript(req.body);
  if ("error" in p) return fail(res, 400, "VALIDATION_ERROR", p.error);
  const userId = uid(req);
  const base = { userId, itemId: item._id };
  const set = { status: "ready" as const, claimedAt: null, attempts: 0, error: null, segments: p.segments, summary: null, keyPoints: [], source: "captions" as const, lang: p.lang, durationSec: p.durationSec };
  let stored: IStudyTranscript | null = null;
  for (let tries = 0; tries < 3 && !stored; tries++) {
    const existing = await StudyTranscript.findOne(base).lean<IStudyTranscript>();
    if (existing?.status === "ready") {
      const had = existing.segments.reduce((n, s) => n + (s.text?.length ?? 0), 0);
      if (had >= p.chars) return void res.json(transcriptDto(existing, { itemId: String(item._id), kept: "existing" }));
    }
    try {
      stored = existing
        ? await StudyTranscript.findOneAndUpdate({ _id: existing._id, status: existing.status, updatedAt: existing.updatedAt }, { $set: set }, { new: true }).lean<IStudyTranscript>()
        : await StudyTranscript.findOneAndUpdate(base, { $set: set, $setOnInsert: { lectureId: null } }, { new: true, upsert: true }).lean<IStudyTranscript>();
    } catch (e: any) {
      if (e?.code !== 11000) throw e; // a concurrent first write: re-read and decide again
    }
  }
  if (!stored) return fail(res, 409, "CONFLICT", "The transcript changed while uploading; try again");
  await StudyItem.updateOne({ _id: item._id, userId }, { $set: { "video.transcriptStatus": "ready", "video.durationSec": p.durationSec } });
  kickUploadedTranscriptSummary(userId, item._id);
  res.json(transcriptDto(stored, { itemId: String(item._id), kept: "uploaded" }));
});

// ─── lectures ───────────────────────────────────────────────────────────────────────────

const CHUNK_EXIST_CONCURRENCY = 8;
const MISSING_LIST_MAX = 1000;
const MAX_DURATION_SEC = 8 * 3600;

async function lectureDtos(lectures: IStudyLecture[], opts: { withTranscript?: boolean } = {}) {
  if (!lectures.length) return [];
  const ids = lectures.map((l) => l._id);
  const userId = lectures[0].userId;
  const [transcripts, pages] = await Promise.all([
    StudyTranscript.find({ userId, lectureId: { $in: ids } }, opts.withTranscript ? {} : { segments: 0 }).lean<IStudyTranscript[]>(),
    StudyPage.find({ userId, lectureId: { $in: ids }, deletedAt: null }, { _id: 1, lectureId: 1 }).sort({ createdAt: 1, _id: 1 }).lean(),
  ]);
  const tBy = new Map(transcripts.map((t) => [String(t.lectureId), t]));
  const pBy = new Map<string, string[]>();
  for (const p of pages as any[]) {
    const k = String(p.lectureId);
    if (!pBy.has(k)) pBy.set(k, []);
    pBy.get(k)!.push(String(p._id));
  }
  return Promise.all(
    lectures.map(async (l) => {
      const t = tBy.get(String(l._id)) ?? null;
      const out: Record<string, unknown> = {
        id: String(l._id),
        classId: String(l.classId),
        title: l.title,
        startedAt: iso(l.startedAt),
        durationSec: l.durationSec ?? 0,
        pageIds: pBy.get(String(l._id)) ?? [],
        audio: l.audio?.key ? { ...(await signedGetUrl(l.audio.key, { contentType: l.audio.mime })), mime: l.audio.mime } : null,
        status: l.status,
        summary: t?.summary ?? null,
        keyPoints: t?.keyPoints ?? [],
        questionCount: l.questionCount ?? 0,
        error: l.status === "failed" && l.error?.code ? { code: l.error.code, message: l.error.message } : null,
        warning: l.status === "ready" && l.warning?.code ? { code: l.warning.code, message: l.warning.message } : null,
        createdAt: iso(l.createdAt),
        updatedAt: iso(l.updatedAt),
      };
      if (opts.withTranscript) out.transcript = t?.status === "ready" ? { segments: t.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) } : null;
      return out;
    })
  );
}

const ownLecture = async (req: Request, res: Response): Promise<IStudyLecture | null> => {
  if (!isOid(req.params.id)) {
    fail(res, 400, "INVALID_ID", "Invalid lecture id");
    return null;
  }
  const lec = await StudyLecture.findOne({ _id: req.params.id, userId: uid(req) }).lean<IStudyLecture>();
  if (!lec) fail(res, 404, "NOT_FOUND", "Lecture not found");
  return lec;
};

export const createLecture = wrap(async (req, res) => {
  const { classId, title, startedAt } = req.body ?? {};
  if (!isOid(classId)) return fail(res, 400, "VALIDATION_ERROR", "classId is required");
  if (title !== undefined && title !== null && (typeof title !== "string" || title.length > 200)) return fail(res, 400, "VALIDATION_ERROR", "title must be a string (max 200)");
  let started = new Date();
  if (startedAt !== undefined && startedAt !== null) {
    started = new Date(String(startedAt));
    if (Number.isNaN(started.getTime())) return fail(res, 400, "VALIDATION_ERROR", "startedAt must be an ISO date");
  }
  const userId = uid(req);
  if (!(await StudyClass.exists({ _id: classId, userId }))) return fail(res, 404, "NOT_FOUND", "Class not found");
  const uploadId = randomUUID();
  const lec = await StudyLecture.create({
    userId,
    classId: new Types.ObjectId(classId),
    title: (title ?? "").trim() || `Lecture ${started.toISOString().slice(0, 10)}`,
    startedAt: started,
    uploadId,
  });
  const [dto] = await lectureDtos([lec.toObject() as IStudyLecture]);
  res.status(201).json({ lecture: dto, upload: { uploadId } });
});

export const listLectures = wrap(async (req, res) => {
  const filter: Record<string, unknown> = { userId: uid(req) };
  const { classId } = req.query;
  if (classId !== undefined && classId !== "") {
    if (!isOid(classId)) return fail(res, 400, "VALIDATION_ERROR", "classId must be an id");
    filter.classId = new Types.ObjectId(String(classId));
  }
  const rows = await StudyLecture.find(filter).sort({ startedAt: -1, _id: -1 }).limit(500).lean<IStudyLecture[]>();
  res.json(await lectureDtos(rows));
});

export const getLecture = wrap(async (req, res) => {
  const lec = await ownLecture(req, res);
  if (!lec) return;
  const [dto] = await lectureDtos([lec], { withTranscript: true });
  res.json(dto);
});

const UPLOADABLE = ["recording", "uploading", "failed"];

/** Content-Type → stored chunk extension (webm/opus → webm, m4a/mp4 → m4a). */
export function chunkExtFor(contentType: string | undefined, fallback: "webm" | "m4a" | null): "webm" | "m4a" | null {
  const t = String(contentType ?? "").toLowerCase().trim();
  if (!t || t.startsWith("application/octet-stream")) return fallback ?? "webm";
  if (/webm|opus|ogg/.test(t)) return "webm";
  if (/m4a|mp4|aac/.test(t)) return "m4a";
  return null;
}

const parseIndex = (v: unknown): number | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n < LECTURE_MAX_CHUNKS ? n : null;
};

/** First chunk: remember the extension + move recording → uploading. */
async function noteChunk(lec: IStudyLecture, ext: "webm" | "m4a") {
  if (!lec.chunkExt) await StudyLecture.updateOne({ _id: lec._id, userId: lec.userId, chunkExt: null }, { $set: { chunkExt: ext } });
  if (lec.status === "recording") await StudyLecture.updateOne({ _id: lec._id, userId: lec.userId, status: "recording" }, { $set: { status: "uploading" } });
}

const chunkGuard = (res: Response, lec: IStudyLecture, ext: "webm" | "m4a" | null): boolean => {
  if (!UPLOADABLE.includes(lec.status)) {
    fail(res, 409, "LECTURE_FINISHED", `This lecture is ${lec.status} — chunks can no longer be uploaded`);
    return false;
  }
  if (!ext) {
    fail(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Chunks must be audio/webm (opus) or audio/mp4 (m4a)");
    return false;
  }
  if (lec.chunkExt && lec.chunkExt !== ext) {
    fail(res, 409, "CHUNK_TYPE_MISMATCH", `This lecture's chunks are ${lec.chunkExt}`);
    return false;
  }
  return true;
};

/** Presigned PUT for one chunk — same key the proxy PUT writes. `{index, size, mime?}` → `{uploadUrl, expiresAt}`. */
export const presignChunk = wrap(async (req, res) => {
  const { index, size, mime } = req.body ?? {};
  const i = parseIndex(index);
  if (i === null) return fail(res, 400, "INVALID_INDEX", `index must be an integer 0–${LECTURE_MAX_CHUNKS - 1}`);
  if (size !== undefined && size !== null && (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > LECTURE_CHUNK_MAX_BYTES))
    return fail(res, 400, "VALIDATION_ERROR", `size must be 1–${LECTURE_CHUNK_MAX_BYTES} bytes`);
  const lec = await ownLecture(req, res);
  if (!lec) return;
  const ext = chunkExtFor(typeof mime === "string" ? mime : undefined, lec.chunkExt);
  if (!chunkGuard(res, lec, ext)) return;
  await noteChunk(lec, ext!);
  const { url, expiresAt } = await presignedPutUrl(lectureChunkKey(String(lec.userId), String(lec._id), i, ext!));
  res.json({ uploadUrl: url, expiresAt, index: i });
});

/**
 * Raw-body parser for the chunk proxy, mounted on that ONE route (after auth). Over 10 MB it
 * throws `entity.too.large`, which the router-level handler (routes/study/router.ts) turns into
 * 413 `{message, code: 'PAYLOAD_TOO_LARGE'}`.
 */
export const rawChunkBody = express.raw({ type: () => true, limit: LECTURE_CHUNK_MAX_BYTES });

/** Index validation runs BEFORE the body is read. */
export const checkChunkIndex = (req: Request, res: Response, next: NextFunction) =>
  parseIndex(req.params.index) === null ? fail(res, 400, "INVALID_INDEX", `index must be an integer 0–${LECTURE_MAX_CHUNKS - 1}`) : next();

/** Proxy upload: raw audio body → the chunk key. Idempotent per index (re-PUT overwrites). */
export const putChunk = wrap(async (req, res) => {
  const i = parseIndex(req.params.index)!;
  const body = Buffer.isBuffer(req.body) ? req.body : null;
  if (!body?.length) return fail(res, 400, "EMPTY_BODY", "Send the chunk's audio bytes as the request body");
  const lec = await ownLecture(req, res);
  if (!lec) return;
  const ext = chunkExtFor(req.get("content-type"), lec.chunkExt);
  if (!chunkGuard(res, lec, ext)) return;
  await putStudyObject(lectureChunkKey(String(lec.userId), String(lec._id), i, ext!), body, ext === "m4a" ? "audio/mp4" : "audio/webm");
  await noteChunk(lec, ext!);
  res.json({ index: i, size: body.length });
});

async function missingChunks(lec: IStudyLecture, chunks: number): Promise<number[]> {
  if (!lec.chunkExt) return Array.from({ length: Math.min(chunks, MISSING_LIST_MAX) }, (_, i) => i);
  const missing: number[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_EXIST_CONCURRENCY, chunks) }, async () => {
      while (next < chunks) {
        const i = next++;
        if (!(await studyObjectExists(lectureChunkKey(String(lec.userId), String(lec._id), i, lec.chunkExt!)))) missing.push(i);
      }
    })
  );
  return missing.sort((a, b) => a - b).slice(0, MISSING_LIST_MAX);
}

/** `{chunks, durationSec}` → every chunk 0..chunks-1 must exist (else 409 CHUNKS_MISSING) → processing. */
export const finishLecture = wrap(async (req, res) => {
  const { chunks, durationSec } = req.body ?? {};
  if (typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 1 || chunks > LECTURE_MAX_CHUNKS)
    return fail(res, 400, "VALIDATION_ERROR", `chunks must be an integer 1–${LECTURE_MAX_CHUNKS}`);
  if (durationSec !== undefined && durationSec !== null && (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec < 0 || durationSec > MAX_DURATION_SEC))
    return fail(res, 400, "VALIDATION_ERROR", "durationSec must be a non-negative number of seconds");
  const lec = await ownLecture(req, res);
  if (!lec) return;
  if (!UPLOADABLE.includes(lec.status)) {
    const running = lec.status === "processing" && (!lec.claimedAt || Date.now() - new Date(lec.claimedAt).getTime() < JOB_STALE_MS);
    return fail(res, 409, running ? "LECTURE_PROCESSING" : "LECTURE_FINISHED", running ? "This lecture is already being processed" : `This lecture is already ${lec.status}`);
  }
  const missing = await missingChunks(lec, chunks);
  if (missing.length) return res.status(409).json({ message: `${missing.length} ${plural(missing.length, "chunk was", "chunks were")} not uploaded`, code: "CHUNKS_MISSING", missing });
  // Compare-and-set on the status: two racing finishes → exactly one queues the run.
  const updated = await StudyLecture.findOneAndUpdate(
    { _id: lec._id, userId: lec.userId, status: { $in: UPLOADABLE } },
    { $set: { status: "processing", chunks, durationSec: Math.round(Number(durationSec) || 0), claimedAt: null, attempts: 0, error: null, warning: null, reuseAudio: false } },
    { new: true }
  ).lean<IStudyLecture>();
  if (!updated) return fail(res, 409, "LECTURE_PROCESSING", "This lecture is already being processed");
  kickStudyJobs();
  const [dto] = await lectureDtos([updated]);
  res.status(202).json(dto);
});

const RETRANSCRIBABLE = ["ready", "failed"];

/**
 * Re-run ASR + summary + question extraction on the stored final audio (e.g. after a NO_SPEECH
 * warning). Allowed on a ready/failed lecture whose audio exists, else 409. Same compare-and-set
 * claim as finish: two racing calls → exactly one queues the run.
 */
export const retranscribeLecture = wrap(async (req, res) => {
  const lec = await ownLecture(req, res);
  if (!lec) return;
  if (!RETRANSCRIBABLE.includes(lec.status)) {
    const processing = lec.status === "processing";
    return fail(res, 409, processing ? "LECTURE_PROCESSING" : "LECTURE_NOT_FINISHED", processing ? "This lecture is already being processed" : `This lecture is still ${lec.status}`);
  }
  if (!lec.audio?.key) return fail(res, 409, "NO_AUDIO", "This lecture has no stored audio to transcribe");
  const updated = await StudyLecture.findOneAndUpdate(
    { _id: lec._id, userId: lec.userId, status: { $in: RETRANSCRIBABLE }, "audio.key": { $type: "string" } },
    { $set: { status: "processing", claimedAt: null, attempts: 0, error: null, warning: null, reuseAudio: true } },
    { new: true }
  ).lean<IStudyLecture>();
  if (!updated) return fail(res, 409, "LECTURE_PROCESSING", "This lecture is already being processed");
  kickStudyJobs();
  const [dto] = await lectureDtos([updated]);
  res.status(202).json(dto);
});
