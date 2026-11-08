import mongoose, { Schema, Types } from "mongoose";

/**
 * One vision transcription of ONE committed version of a notebook page (`study_page_reads`).
 * Versions are immutable (services/study/storage.ts), so `(pageId, version)` is a permanent
 * cache key: an unchanged page never costs a second vision call. A new version is a new row.
 */
export interface IStudyPageRead {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  pageId: Types.ObjectId;
  version: number;
  text: string;
  tiles: number;
  models: string[];
  costUsd: number;
  createdAt: Date;
}

const StudyPageReadSchema = new Schema<IStudyPageRead>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    pageId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    text: { type: String, default: "" },
    tiles: { type: Number, default: 0 },
    models: { type: [String], default: [] },
    costUsd: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

StudyPageReadSchema.index({ userId: 1, pageId: 1, version: 1 }, { unique: true });

export const StudyPageRead = mongoose.model<IStudyPageRead>("StudyPageRead", StudyPageReadSchema, "study_page_reads");
