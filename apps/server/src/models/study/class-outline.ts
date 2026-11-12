import mongoose, { Schema, Types } from "mongoose";

/**
 * What a class teaches, read from its own material (`study_class_outlines`, one row per class):
 * the units and the ideas under them, named by a model from the class's module and item titles.
 * `hash` is the fingerprint of those titles — when the professor opens a new unit the titles
 * change, the hash no longer matches, and the outline is read again (services/study/concept-outline).
 */
export interface OutlineConcept {
  label: string;
  /** The unit (another concept's label) this one sits under; null for a unit. */
  parent: string | null;
}
export interface IStudyClassOutline {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  hash: string;
  concepts: OutlineConcept[];
  /** A read is running since (guards against two at once); null when idle. */
  runningSince: Date | null;
  updatedAt: Date;
}
const OutlineSchema = new Schema<IStudyClassOutline>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    hash: { type: String, default: "" },
    concepts: { type: [{ _id: false, label: String, parent: { type: String, default: null } }], default: [] },
    runningSince: { type: Date, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);
OutlineSchema.index({ userId: 1, classId: 1 }, { unique: true });
export const StudyClassOutline = mongoose.model<IStudyClassOutline>("StudyClassOutline", OutlineSchema, "study_class_outlines");
