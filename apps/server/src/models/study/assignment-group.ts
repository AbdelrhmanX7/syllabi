import mongoose, { Schema, Types } from "mongoose";
import type { StudyCanvasType } from "./item";

/**
 * A Canvas assignment group mirrored for one study user (grade plan). One row per group, its
 * assignments embedded with exactly what the grade calculation needs. Replaced wholesale on
 * every sync; groups that disappear from Canvas are deleted.
 */
export interface IStudyAssignmentGroupAssignment {
  canvasAssignmentId: number;
  name: string;
  points: number | null;
  dueAt: Date | null;
  omit: boolean;
  published: boolean;
  gradingType: string | null;
  /** Identity of the matching StudyItem (see canvas-mapping `assignmentIdentity`). */
  canvasType: StudyCanvasType;
  canvasId: string;
  /** Visible score (null = ungraded or hidden from the student). */
  score: number | null;
  excused: boolean;
  workflowState: string | null;
}

export interface IStudyAssignmentGroup {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  canvasGroupId: number;
  name: string;
  position: number;
  weight: number;
  rules: { dropLowest: number; dropHighest: number; neverDrop: number[] };
  assignments: IStudyAssignmentGroupAssignment[];
  createdAt: Date;
  updatedAt: Date;
}

const AssignmentSchema = new Schema<IStudyAssignmentGroupAssignment>(
  {
    canvasAssignmentId: { type: Number, required: true },
    name: { type: String, default: "" },
    points: { type: Number, default: null },
    dueAt: { type: Date, default: null },
    omit: { type: Boolean, default: false },
    published: { type: Boolean, default: true },
    gradingType: { type: String, default: null },
    canvasType: { type: String, required: true },
    canvasId: { type: String, required: true },
    score: { type: Number, default: null },
    excused: { type: Boolean, default: false },
    workflowState: { type: String, default: null },
  },
  { _id: false }
);

const StudyAssignmentGroupSchema = new Schema<IStudyAssignmentGroup>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    canvasGroupId: { type: Number, required: true },
    name: { type: String, default: "" },
    position: { type: Number, default: 0 },
    weight: { type: Number, default: 0 },
    rules: {
      dropLowest: { type: Number, default: 0 },
      dropHighest: { type: Number, default: 0 },
      neverDrop: { type: [Number], default: [] },
    },
    assignments: { type: [AssignmentSchema], default: [] },
  },
  { timestamps: true }
);

StudyAssignmentGroupSchema.index({ userId: 1, classId: 1, canvasGroupId: 1 }, { unique: true });

export const StudyAssignmentGroup = mongoose.model<IStudyAssignmentGroup>(
  "StudyAssignmentGroup",
  StudyAssignmentGroupSchema,
  "study_assignment_groups"
);
