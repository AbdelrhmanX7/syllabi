import mongoose, { Schema, Types } from "mongoose";

export const TRANSCRIPT_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * One transcript per video item (`itemId`) or lecture (`lectureId`) — exactly one of the two.
 *
 * For a video the row is ALSO the job: `status` pending → processing is the atomic claim
 * (services/study/jobs.ts), `claimedAt` the fencing token every final write is guarded by, and a
 * `processing` row whose claim is older than 60 min is re-claimable. A lecture's job lives on the
 * lecture row; its transcript row is written once, already `ready`.
 */
export interface IStudyTranscript {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  itemId: Types.ObjectId | null;
  lectureId: Types.ObjectId | null;
  status: TranscriptStatus;
  claimedAt: Date | null;
  attempts: number;
  error: { code: string; message: string } | null;
  segments: TranscriptSegment[];
  summary: string | null;
  keyPoints: string[];
  source: "captions" | "asr" | null;
  lang: string;
  durationSec: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyTranscriptSchema = new Schema<IStudyTranscript>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    itemId: { type: Schema.Types.ObjectId, default: null },
    lectureId: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: TRANSCRIPT_STATUSES, default: "pending" },
    claimedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    error: { type: new Schema({ code: String, message: String }, { _id: false }), default: null },
    segments: { type: [new Schema({ start: Number, end: Number, text: String }, { _id: false })], default: [] },
    summary: { type: String, default: null },
    keyPoints: { type: [String], default: [] },
    source: { type: String, enum: ["captions", "asr", null], default: null },
    lang: { type: String, default: "en" },
    durationSec: { type: Number, default: null },
  },
  { timestamps: true }
);

StudyTranscriptSchema.index({ userId: 1, itemId: 1 }, { unique: true, partialFilterExpression: { itemId: { $type: "objectId" } } });
StudyTranscriptSchema.index({ userId: 1, lectureId: 1 }, { unique: true, partialFilterExpression: { lectureId: { $type: "objectId" } } });
StudyTranscriptSchema.index({ status: 1, claimedAt: 1 });

export const StudyTranscript = mongoose.model<IStudyTranscript>("StudyTranscript", StudyTranscriptSchema, "study_transcripts");
