import mongoose, { Schema, Types } from "mongoose";

/** A Canvas module (ordered group of items) inside one class. */
export interface IStudyModule {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  canvasId: number;
  name: string;
  position: number;
}

const StudyModuleSchema = new Schema<IStudyModule>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    canvasId: { type: Number, required: true },
    name: { type: String, required: true },
    position: { type: Number, default: 0 },
  },
  { timestamps: true }
);

StudyModuleSchema.index({ userId: 1, classId: 1, canvasId: 1 }, { unique: true });

export const StudyModule = mongoose.model<IStudyModule>("StudyModule", StudyModuleSchema, "study_modules");
