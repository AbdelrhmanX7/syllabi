import mongoose, { Schema, Types } from "mongoose";

export const LECTURE_STATUSES = ["recording", "uploading", "processing", "ready", "failed"] as const;
export type LectureStatus = (typeof LECTURE_STATUSES)[number];

/**
 * An in-class recording (contract "Lectures"). Audio arrives as numbered chunks at
 * `study/<userId>/lectures/<id>/chunks/<00000>.<ext>`; `finish` flips the row to `processing`
 * and the job (services/study/jobs.ts) concatenates, transcribes, summarises and extracts.
 *
 * The row is the job: `status: 'processing'` + `claimedAt: null` = queued; the claim sets
 * `claimedAt` atomically, and a claim older than 60 min is re-claimable (a crashed process).
 */
export interface IStudyLecture {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  title: string;
  startedAt: Date;
  durationSec: number;
  status: LectureStatus;
  uploadId: string;
  /** Extension every chunk of this lecture is stored with (set by the first chunk). */
  chunkExt: "webm" | "m4a" | null;
  chunks: number | null;
  audio: { key: string; mime: string } | null;
  claimedAt: Date | null;
  attempts: number;
  error: { code: string; message: string } | null;
  /** Set on a `ready` lecture that is usable but incomplete, e.g. NO_SPEECH (ink + audio only). */
  warning: { code: string; message: string } | null;
  /** The queued run transcribes the stored final `audio` instead of re-joining the chunks (retranscribe). */
  reuseAudio: boolean;
  questionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const StudyLectureSchema = new Schema<IStudyLecture>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, default: "" },
    startedAt: { type: Date, required: true },
    durationSec: { type: Number, default: 0 },
    status: { type: String, enum: LECTURE_STATUSES, default: "recording" },
    uploadId: { type: String, required: true },
    chunkExt: { type: String, enum: ["webm", "m4a", null], default: null },
    chunks: { type: Number, default: null },
    audio: { type: new Schema({ key: String, mime: String }, { _id: false }), default: null },
    claimedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    error: { type: new Schema({ code: String, message: String }, { _id: false }), default: null },
    warning: { type: new Schema({ code: String, message: String }, { _id: false }), default: null },
    reuseAudio: { type: Boolean, default: false },
    questionCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

StudyLectureSchema.index({ userId: 1, classId: 1, startedAt: -1 });
StudyLectureSchema.index({ status: 1, claimedAt: 1 });

export const StudyLecture = mongoose.model<IStudyLecture>("StudyLecture", StudyLectureSchema, "study_lectures");
