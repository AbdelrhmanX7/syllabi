import mongoose, { Schema, Types } from "mongoose";

/** Client-generated project id (`PUT /study/code/projects/:id` upserts by it). */
export const CODE_PROJECT_ID_RE = /^cp_[A-Za-z0-9_-]{6,64}$/;

/**
 * A C++ code project (contract "Code (C++ class)"). The id is the CLIENT's `cp_…` id, unique
 * per user — two users may hold the same client id without seeing each other's project.
 */
export interface IStudyCodeProject {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  clientId: string;
  classId: Types.ObjectId | null;
  title: string;
  files: { name: string; content: string }[];
  createdAt: Date;
  updatedAt: Date;
}

const StudyCodeProjectSchema = new Schema<IStudyCodeProject>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    clientId: { type: String, required: true },
    classId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, default: "" },
    files: { type: [{ _id: false, name: { type: String, required: true }, content: { type: String, default: "" } }], default: [] },
  },
  { timestamps: true }
);

StudyCodeProjectSchema.index({ userId: 1, clientId: 1 }, { unique: true });
StudyCodeProjectSchema.index({ userId: 1, classId: 1, updatedAt: -1 });

export const StudyCodeProject = mongoose.model<IStudyCodeProject>("StudyCodeProject", StudyCodeProjectSchema, "study_code_projects");
