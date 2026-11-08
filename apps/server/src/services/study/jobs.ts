import fs from "fs";
import { withClassGuide } from "./class-guide";
import os from "os";
import path from "path";
import { Types } from "mongoose";
import { StudyItem, IStudyItem } from "@/models/study/item";
import { StudyClass, IStudyClass } from "@/models/study/class";
import { StudyLecture, IStudyLecture } from "@/models/study/lecture";
import { StudyTranscript, IStudyTranscript, TranscriptSegment } from "@/models/study/transcript";
import { logger } from "@/services/logger.service";
import { newSpend, Spend } from "./ai-models";
import { summariseTranscript } from "./ai";
import { chooseCaptionTrack, captionsToSegments } from "./captions";
import { ffmpeg, MediaToolError, probeDurationSec, ytDlpAudio, ytDlpInfo, ytDlpSubtitle } from "./media-tools";
import { ASR_MAX_SEC, transcribeAudioFile, transcriptText } from "./transcribe";
import { extractFromTranscript } from "./extract";
import { getStudyObject, lectureAudioKey, lectureChunkKey, putStudyObject } from "./storage";
import { recordStudyUsage } from "./usage";
import { AI_QUOTA_CODE, AI_QUOTA_MESSAGE, isAiQuotaError, logAiFailure } from "./ai-errors";

/**
 * Background jobs of the study module: video transcripts and lecture processing.
 *
 * Asynchronous, like the Canvas sync: a request (or the recovery poll in services/study/background.ts)
 * calls `kickStudyJobs()`, which drains the queue on ONE lane per process. With
 * RUN_WORKER_IN_PROCESS=false the API turns kicks off and `node dist/worker.js` polls instead — so at most one
 * ASR/ffmpeg job runs per API fork. Rows are claimed atomically with findOneAndUpdate, so the
 * four API forks never double-process a row:
 *   - transcript (video): `status` pending → processing (+ `claimedAt`);
 *   - lecture: `status: 'processing'` with `claimedAt: null` → `claimedAt: now`.
 * A claim older than 60 min is dead (the process crashed or restarted) and is re-claimable.
 * Every final write is fenced on `claimedAt`, so a run that was re-claimed underneath it cannot
 * overwrite the newer run's result. A row claimed more than 3 times is given up as failed.
 */

export const JOB_STALE_MS = 60 * 60 * 1000;
export const JOB_MAX_ATTEMPTS = 3;
const LECTURE_AUDIO_EXT = "webm";
const LECTURE_AUDIO_MIME = "audio/webm";

export class JobError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const errOf = (e: unknown): { code: string; message: string } => {
  if (e instanceof JobError || e instanceof MediaToolError) return { code: e.code, message: e.message.slice(0, 300) };
  if (isAiQuotaError(e)) return { code: AI_QUOTA_CODE, message: AI_QUOTA_MESSAGE };
  return { code: "JOB_FAILED", message: String((e as Error)?.message ?? e).slice(0, 300) };
};

// ─── claims ─────────────────────────────────────────────────────────────────────────────

const staleCutoff = (now: Date) => new Date(now.getTime() - JOB_STALE_MS);

/** Atomically claim the oldest pending (or stale) video transcript job. Null when there is none. */
export function claimTranscriptJob(now = new Date()) {
  return StudyTranscript.findOneAndUpdate(
    {
      itemId: { $type: "objectId" },
      $or: [{ status: "pending" }, { status: "processing", claimedAt: null }, { status: "processing", claimedAt: { $lt: staleCutoff(now) } }],
    },
    { $set: { status: "processing", claimedAt: now }, $inc: { attempts: 1 } },
    { new: true, sort: { updatedAt: 1 } }
  ).lean<IStudyTranscript>();
}

/** Atomically claim the oldest queued (or stale) lecture run. Null when there is none. */
export function claimLectureJob(now = new Date()) {
  return StudyLecture.findOneAndUpdate(
    { status: "processing", $or: [{ claimedAt: null }, { claimedAt: { $lt: staleCutoff(now) } }] },
    { $set: { claimedAt: now }, $inc: { attempts: 1 } },
    { new: true, sort: { updatedAt: 1 } }
  ).lean<IStudyLecture>();
}

// ─── the lane ───────────────────────────────────────────────────────────────────────────

let running = false;
let again = false;
// Tests drive the lane explicitly (`drainStudyJobs`); a request never starts it behind their back.
let autoKick = process.env.NODE_ENV !== "test";
export const setStudyJobsAutoKick = (on: boolean) => {
  autoKick = on;
};
/** Whether request-path kicks run jobs in this process (false in an API whose worker is separate). */
export const studyJobsAutoKick = () => autoKick;

/** Fire-and-forget: drain the queue on this process's single lane. */
export function kickStudyJobs(): void {
  if (!autoKick) return;
  void drainStudyJobs().catch((e) => logger.error("study jobs drain crashed", e as Error));
}

/** Run jobs until none is claimable. A call while the lane is busy just asks it to look again. */
export async function drainStudyJobs(): Promise<number> {
  if (running) {
    again = true;
    return 0;
  }
  running = true;
  let n = 0;
  try {
    do {
      again = false;
      while (await runOneStudyJob()) n++;
    } while (again);
  } finally {
    running = false;
  }
  return n;
}

export async function runOneStudyJob(now = new Date()): Promise<boolean> {
  const tr = await claimTranscriptJob(now);
  if (tr) {
    await processTranscriptJob(tr);
    return true;
  }
  const lec = await claimLectureJob(now);
  if (lec) {
    await processLectureJob(lec);
    return true;
  }
  return false;
}

const withTmp = async <T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

// ─── video transcript ───────────────────────────────────────────────────────────────────

/** Captions first (one English track), else bestaudio → ASR. */
export async function transcribeYouTube(videoId: string, dir: string, spend: Spend): Promise<{ segments: TranscriptSegment[]; source: "captions" | "asr"; durationSec: number | null }> {
  const info = await ytDlpInfo(videoId);
  let durationSec = info.durationSec;
  const track = chooseCaptionTrack(info);
  if (track) {
    const sub = await ytDlpSubtitle(videoId, track.lang, track.auto, dir);
    if (sub) {
      const segments = captionsToSegments(await fs.promises.readFile(sub.file, "utf8"), sub.format);
      if (segments.length) return { segments, source: "captions", durationSec };
    }
  }
  if (durationSec && durationSec > ASR_MAX_SEC) throw new JobError("AUDIO_TOO_LONG", `Video is longer than ${ASR_MAX_SEC / 3600} h`);
  const audio = await ytDlpAudio(videoId, dir);
  const r = await transcribeAudioFile(audio, dir, spend, { durationSec });
  durationSec ??= r.durationSec;
  return { segments: r.segments, source: "asr", durationSec };
}

async function summaryOrNothing(segments: TranscriptSegment[], spend: Spend, ctx: Record<string, unknown>) {
  try {
    return await summariseTranscript(transcriptText(segments), spend);
  } catch (e) {
    await logger.error("study transcript summary failed", e as Error, ctx);
    return { summary: null, keyPoints: [] as string[] };
  }
}

export async function processTranscriptJob(row: IStudyTranscript): Promise<void> {
  const startedAt = Date.now();
  const spend = newSpend();
  const fence = { _id: row._id, status: "processing", claimedAt: row.claimedAt };
  const setItem = (set: Record<string, unknown>) => StudyItem.updateOne({ _id: row.itemId, userId: row.userId }, { $set: set });
  try {
    if (row.attempts > JOB_MAX_ATTEMPTS) throw new JobError("JOB_GAVE_UP", `Gave up after ${JOB_MAX_ATTEMPTS} attempts`);
    const item = await StudyItem.findOne({ _id: row.itemId, userId: row.userId }, { type: 1, video: 1 }).lean<IStudyItem>();
    if (!item || item.type !== "video" || !item.video?.videoId) throw new JobError("NOT_A_VIDEO", "This item is not a video");
    const out = await withTmp("study-tr-", (dir) => transcribeYouTube(item.video!.videoId, dir, spend));
    if (out.durationSec) await setItem({ "video.durationSec": out.durationSec });
    if (!out.segments.length) throw new JobError("NO_SPEECH", "No speech was found in this video");
    const { summary, keyPoints } = await summaryOrNothing(out.segments, spend, { itemId: String(row.itemId) });
    const done = await StudyTranscript.updateOne(fence, {
      $set: { status: "ready", claimedAt: null, error: null, segments: out.segments, summary, keyPoints, source: out.source, lang: "en", durationSec: out.durationSec },
    });
    if (done.modifiedCount) await setItem({ "video.transcriptStatus": "ready" });
    await recordStudyUsage(row.userId, "transcribe", spend, startedAt, "done", { itemId: row.itemId });
  } catch (e) {
    const err = errOf(e);
    if (err.code === AI_QUOTA_CODE) await logAiFailure("study transcript job failed", e, { itemId: String(row.itemId) }, err.code);
    else if (!(e instanceof JobError) && !(e instanceof MediaToolError)) await logger.error("study transcript job failed", e as Error, { itemId: String(row.itemId) });
    const failed = await StudyTranscript.updateOne(fence, { $set: { status: "failed", claimedAt: null, error: err } });
    if (failed.modifiedCount) await setItem({ "video.transcriptStatus": "failed" });
    await recordStudyUsage(row.userId, "transcribe", spend, startedAt, "error", { itemId: row.itemId, error: `${err.code} ${err.message}`, errorCode: err.code });
  }
}

// ─── lecture ────────────────────────────────────────────────────────────────────────────

/**
 * Chunks → one mono opus file. MediaRecorder timeslice chunks are fragments of ONE stream (only
 * chunk 0 has the header), so webm is byte-joined first; if that decodes to clearly less than
 * the recorded duration (chunks were separate recordings) the concat demuxer is tried and the
 * longer result wins. m4a chunks are always separate files → concat demuxer.
 */
export async function concatLectureAudio(files: string[], ext: string, out: string, dir: string, expectedSec: number): Promise<number> {
  const encode = ["-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "webm"];
  const demux = async (target: string) => {
    const list = path.join(dir, "list.txt");
    await fs.promises.writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, ...encode, target]);
    return (await probeDurationSec(target)) ?? 0;
  };
  if (ext !== "webm" || files.length === 1) {
    if (files.length === 1) {
      await ffmpeg(["-i", files[0], ...encode, out]);
      return (await probeDurationSec(out)) ?? 0;
    }
    return demux(out);
  }
  const joined = path.join(dir, `joined.${ext}`);
  await fs.promises.writeFile(joined, "");
  for (const f of files) await fs.promises.appendFile(joined, await fs.promises.readFile(f));
  let joinedSec = 0;
  try {
    await ffmpeg(["-i", joined, ...encode, out]);
    joinedSec = (await probeDurationSec(out)) ?? 0;
  } catch {
    joinedSec = 0;
  }
  if (joinedSec > 0 && (!expectedSec || joinedSec >= expectedSec * 0.8)) return joinedSec;
  const alt = path.join(dir, "demux.webm");
  const altSec = await demux(alt).catch(() => 0);
  if (altSec > joinedSec) {
    await fs.promises.rename(alt, out);
    return altSec;
  }
  if (!joinedSec) throw new JobError("AUDIO_UNREADABLE", "The recorded audio could not be decoded");
  return joinedSec;
}

export const NO_SPEECH_WARNING = { code: "NO_SPEECH", message: "No speech was found in this recording — the ink and audio are still saved" };

export async function processLectureJob(lec: IStudyLecture): Promise<void> {
  const startedAt = Date.now();
  const spend = newSpend();
  const userId = String(lec.userId);
  const lectureId = String(lec._id);
  const fence = { _id: lec._id, status: "processing", claimedAt: lec.claimedAt };
  try {
    if (lec.attempts > JOB_MAX_ATTEMPTS) throw new JobError("JOB_GAVE_UP", `Gave up after ${JOB_MAX_ATTEMPTS} attempts`);
    const n = lec.chunks ?? 0;
    const ext = lec.chunkExt ?? "webm";
    const reuse = lec.reuseAudio === true && !!lec.audio?.key;
    if (!reuse && n < 1) throw new JobError("CHUNKS_MISSING", "No audio chunks were uploaded");

    const { segments, durationSec } = await withTmp("study-lec-", async (dir) => {
      if (reuse) {
        // Retranscribe: the final audio is already stored — no re-join, no re-upload.
        const f = path.join(dir, `audio.${LECTURE_AUDIO_EXT}`);
        await fs.promises.writeFile(f, await getStudyObject(lec.audio!.key));
        const sec = (await probeDurationSec(f)) ?? 0;
        const r = await transcribeAudioFile(f, dir, spend, { durationSec: sec || lec.durationSec });
        return { segments: r.segments, durationSec: Math.round(sec || r.durationSec) };
      }
      const files: string[] = [];
      for (let i = 0; i < n; i++) {
        const f = path.join(dir, `c_${String(i).padStart(5, "0")}.${ext}`);
        await fs.promises.writeFile(f, await getStudyObject(lectureChunkKey(userId, lectureId, i, ext)));
        files.push(f);
      }
      const out = path.join(dir, `audio.${LECTURE_AUDIO_EXT}`);
      const sec = await concatLectureAudio(files, ext, out, dir, lec.durationSec);
      for (const f of files) await fs.promises.rm(f, { force: true });
      const key = lectureAudioKey(userId, lectureId, LECTURE_AUDIO_EXT);
      await putStudyObject(key, await fs.promises.readFile(out), LECTURE_AUDIO_MIME);
      await StudyLecture.updateOne(fence, { $set: { audio: { key, mime: LECTURE_AUDIO_MIME } } });
      const r = await transcribeAudioFile(out, dir, spend, { durationSec: sec || lec.durationSec });
      return { segments: r.segments, durationSec: Math.round(sec || r.durationSec) };
    });
    if (!segments.length) {
      // Ink + audio playback is still worth having: ready with an empty transcript and a
      // warning, no summary and no question extraction.
      await StudyTranscript.findOneAndUpdate(
        { userId: lec.userId, lectureId: lec._id },
        { $set: { status: "ready", claimedAt: null, error: null, segments: [], summary: null, keyPoints: [], source: "asr", lang: "en", durationSec, itemId: null } },
        { upsert: true }
      );
      await StudyLecture.updateOne(fence, {
        $set: { status: "ready", claimedAt: null, error: null, reuseAudio: false, warning: NO_SPEECH_WARNING, questionCount: 0, durationSec: durationSec || lec.durationSec },
      });
      await recordStudyUsage(lec.userId, "lecture", spend, startedAt, "done", { lectureId: lec._id });
      return;
    }

    const { summary, keyPoints } = await summaryOrNothing(segments, spend, { lectureId });
    await StudyTranscript.findOneAndUpdate(
      { userId: lec.userId, lectureId: lec._id },
      { $set: { status: "ready", claimedAt: null, error: null, segments, summary, keyPoints, source: "asr", lang: "en", durationSec, itemId: null } },
      { upsert: true }
    );

    let questionCount = 0;
    const cls = await StudyClass.findOne({ _id: lec.classId, userId: lec.userId }, { name: 1 }).lean<IStudyClass>();
    if (cls) {
      try {
        questionCount = await withClassGuide(lec.userId, cls._id, () => // P-CM: class guide as system context
          extractFromTranscript(
            lec.userId,
            cls,
            transcriptText(segments),
            { kind: "lecture", itemId: null, pageId: null, lectureId: lec._id, ref: null },
            spend,
            () => {}
          )
        );
      } catch (e) {
        await logger.error("study lecture question extraction failed", e as Error, { lectureId });
      }
    }
    await StudyLecture.updateOne(fence, {
      $set: { status: "ready", claimedAt: null, error: null, reuseAudio: false, warning: null, questionCount, durationSec: durationSec || lec.durationSec },
    });
    await recordStudyUsage(lec.userId, "lecture", spend, startedAt, "done", { lectureId: lec._id });
  } catch (e) {
    const err = errOf(e);
    if (err.code === AI_QUOTA_CODE) await logAiFailure("study lecture job failed", e, { lectureId }, err.code);
    else if (!(e instanceof JobError) && !(e instanceof MediaToolError)) await logger.error("study lecture job failed", e as Error, { lectureId });
    await StudyLecture.updateOne(fence, { $set: { status: "failed", claimedAt: null, error: err, reuseAudio: false } });
    await recordStudyUsage(lec.userId, "lecture", spend, startedAt, "error", { lectureId: lec._id, error: `${err.code} ${err.message}`, errorCode: err.code });
  }
}

// ─── requeue ────────────────────────────────────────────────────────────────────────────

/**
 * (Re)queue a video's transcript. A run in flight (claimed < 60 min ago) is left alone. A ready
 * transcript keeps its segments until the new run replaces them.
 */
export async function queueVideoTranscript(userId: Types.ObjectId, itemId: Types.ObjectId, now = new Date()): Promise<"queued" | "running"> {
  try {
    await StudyTranscript.findOneAndUpdate(
      {
        userId,
        itemId,
        $or: [{ status: { $ne: "processing" } }, { claimedAt: null }, { claimedAt: { $lt: staleCutoff(now) } }],
      },
      { $set: { status: "pending", claimedAt: null, attempts: 0, error: null }, $setOnInsert: { lectureId: null } },
      { upsert: true }
    );
  } catch (e: any) {
    if (e?.code === 11000) return "running"; // the row exists and is being processed right now
    throw e;
  }
  await StudyItem.updateOne({ _id: itemId, userId }, { $set: { "video.transcriptStatus": "pending" } });
  kickStudyJobs();
  return "queued";
}

// ─── uploaded (on-device) transcripts: summary ──────────────────────────────────────────

export const UPLOAD_SUMMARY_LEASE_MS = 10 * 60 * 1000;

/**
 * Summary + keyPoints for a transcript the tablet uploaded (`PUT /videos/:itemId/transcript`
 * writes it `ready` with `summary: null, attempts: 0`). The claim is a lease on `claimedAt`
 * (a crashed run is re-claimable after 10 min); `attempts` 0 → 1 on the way out makes it
 * one-shot, so a model failure is not retried forever (and server-fetched rows, attempts ≥ 1,
 * are never touched). Returns whether a row was processed.
 */
export async function summariseUploadedTranscript(opts: { itemId?: Types.ObjectId; userId?: Types.ObjectId; minAgeMs?: number } = {}, now = new Date()): Promise<boolean> {
  const filter: Record<string, unknown> = {
    itemId: opts.itemId ?? { $type: "objectId" },
    status: "ready",
    summary: null,
    attempts: 0,
    "segments.0": { $exists: true },
    $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - UPLOAD_SUMMARY_LEASE_MS) } }],
  };
  if (opts.userId) filter.userId = opts.userId;
  if (opts.minAgeMs) filter.updatedAt = { $lt: new Date(now.getTime() - opts.minAgeMs) };
  const row = await StudyTranscript.findOneAndUpdate(filter, { $set: { claimedAt: now } }, { new: true, sort: { updatedAt: 1 } }).lean<IStudyTranscript>();
  if (!row) return false;
  const startedAt = Date.now();
  const spend = newSpend();
  let status: "done" | "error" = "done";
  let result: { summary: string | null; keyPoints: string[] } = { summary: null, keyPoints: [] };
  try {
    result = await summariseTranscript(transcriptText(row.segments), spend);
  } catch (e) {
    status = "error";
    await logger.error("study uploaded transcript summary failed", e as Error, { itemId: String(row.itemId) });
  }
  await StudyTranscript.updateOne(
    { _id: row._id, status: "ready", claimedAt: now },
    { $set: { summary: result.summary, keyPoints: result.keyPoints, claimedAt: null, attempts: 1 } }
  );
  await recordStudyUsage(row.userId, "transcribe", spend, startedAt, status, { itemId: row.itemId });
  return true;
}

/** Fire-and-forget for the request that just stored an upload. */
export function kickUploadedTranscriptSummary(userId: Types.ObjectId, itemId: Types.ObjectId): void {
  if (!autoKick) return;
  void summariseUploadedTranscript({ userId, itemId }).catch((e) => logger.error("study upload summary crashed", e as Error));
}

/**
 * Recovery sweep: uploads whose in-process summary never ran (process died). Bounded per tick.
 * `minAgeMs` (default 3 min) keeps the sweep off rows the request's own kick is about to take;
 * a separate worker process (API kicks disabled) passes 0 so uploads are summarised promptly.
 */
export async function sweepUploadedSummaries(max = 5, minAgeMs = 3 * 60 * 1000): Promise<number> {
  let n = 0;
  while (n < max && (await summariseUploadedTranscript(minAgeMs > 0 ? { minAgeMs } : {}))) n++;
  return n;
}
