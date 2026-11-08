import mongoose, { Schema, Types } from "mongoose";

/**
 * One image embedded in synced Canvas HTML (`<img src="…/files/:id/preview?verifier=…">`), cached in
 * study storage once per (owner, Canvas file id). The item html stays the truth for WHICH images an
 * item shows and where; this is only the bytes. `skipped` rows are permanent refusals (not an
 * image, too large) so a sync never re-downloads them; a transient failure leaves no row and the
 * next sync tries again.
 */
export interface IStudyCanvasImage {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  canvasFileId: number;
  status: "stored" | "skipped";
  reason: string | null;
  storageKey: string | null;
  contentType: string | null;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyCanvasImageSchema = new Schema<IStudyCanvasImage>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    canvasFileId: { type: Number, required: true },
    status: { type: String, enum: ["stored", "skipped"], required: true },
    reason: { type: String, default: null },
    storageKey: { type: String, default: null },
    contentType: { type: String, default: null },
    bytes: { type: Number, default: 0 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    sha256: { type: String, default: null },
  },
  { timestamps: true }
);

StudyCanvasImageSchema.index({ userId: 1, canvasFileId: 1 }, { unique: true });

export const StudyCanvasImage = mongoose.model<IStudyCanvasImage>("StudyCanvasImage", StudyCanvasImageSchema, "study_canvas_images");
