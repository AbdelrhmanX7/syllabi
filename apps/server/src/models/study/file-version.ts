import mongoose, { Schema, Types } from "mongoose";

/** Every stored version of a Canvas file. Old versions are never deleted by the sync. */
export interface IStudyFileVersion {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  itemId: Types.ObjectId;
  version: number;
  sha256: string;
  size: number;
  mime: string;
  storageKey: string;
  canvasUpdatedAt: Date | null;
  createdAt: Date;
}

const StudyFileVersionSchema = new Schema<IStudyFileVersion>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    itemId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    sha256: { type: String, required: true },
    size: { type: Number, required: true },
    mime: { type: String, default: "application/octet-stream" },
    storageKey: { type: String, required: true },
    canvasUpdatedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

StudyFileVersionSchema.index({ itemId: 1, version: 1 }, { unique: true });
StudyFileVersionSchema.index({ userId: 1 });

export const StudyFileVersion = mongoose.model<IStudyFileVersion>(
  "StudyFileVersion",
  StudyFileVersionSchema,
  "study_file_versions"
);
