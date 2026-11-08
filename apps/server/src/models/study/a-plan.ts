import mongoose, { Schema, Types } from "mongoose";

/**
 * The cached, synthesized per-class "A plan" (services/study/a-plan/plan.ts). `plan` is the
 * full GET body; `inputsHash` is the hash of everything it was built from — a GET whose
 * current inputs hash differs returns the cached plan marked `stale` and rebuilds in the background.
 */
export interface IStudyAPlan {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  plan: Record<string, any> | null;
  inputsHash: string | null;
  building: boolean;
  buildStartedAt: Date | null;
  lastError: string | null;
  generatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyAPlanSchema = new Schema<IStudyAPlan>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    plan: { type: Schema.Types.Mixed, default: null },
    inputsHash: { type: String, default: null },
    building: { type: Boolean, default: false },
    buildStartedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    generatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

StudyAPlanSchema.index({ userId: 1, classId: 1 }, { unique: true });

export const StudyAPlan = mongoose.model<IStudyAPlan>("StudyAPlan", StudyAPlanSchema, "study_a_plans");
