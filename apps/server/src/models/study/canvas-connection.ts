import mongoose, { Schema, Types } from "mongoose";

/**
 * One Canvas LMS connection per study user (an admin id). The personal access token is
 * stored ONLY as an AES-256-GCM blob (services/study/crypto.ts) and is never serialised
 * into a response. Deleting the connection leaves every synced class/item in place.
 */
export interface IStudyCanvasConnection {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  baseUrl: string;
  tokenEnc: string;
  canvasUser: { id: number; name: string };
  tokenExpiresAt: Date | null;
  lastSyncAt: Date | null;
  syncing: boolean;
  syncStartedAt: Date | null;
  lastError: { code: string; message: string } | null;
  /** Per-course failures of the last run — one failing course never aborts the others. */
  courseErrors: { courseId: number; code: string; message: string }[];
  /** Files the last run did not store (too big, locked, download failed). */
  skippedFiles: { courseId: number; fileId: number; name: string; size: number | null; reason: string }[];
  lastSyncStats: Record<string, number> | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyCanvasConnectionSchema = new Schema<IStudyCanvasConnection>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },
    baseUrl: { type: String, required: true },
    tokenEnc: { type: String, required: true },
    canvasUser: { id: { type: Number }, name: { type: String } },
    tokenExpiresAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
    syncing: { type: Boolean, default: false },
    syncStartedAt: { type: Date, default: null },
    lastError: { type: new Schema({ code: String, message: String }, { _id: false }), default: null },
    courseErrors: { type: [new Schema({ courseId: Number, code: String, message: String }, { _id: false })], default: [] },
    skippedFiles: {
      type: [new Schema({ courseId: Number, fileId: Number, name: String, size: Number, reason: String }, { _id: false })],
      default: [],
    },
    lastSyncStats: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export const StudyCanvasConnection = mongoose.model<IStudyCanvasConnection>(
  "StudyCanvasConnection",
  StudyCanvasConnectionSchema,
  "study_canvas_connections"
);
