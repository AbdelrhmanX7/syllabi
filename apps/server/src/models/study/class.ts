import mongoose, { Schema, Types } from "mongoose";

export const GRADE_POLICY_KINDS = ["weighted", "all_categories_min"] as const;
export type StudyGradePolicy = {
  kind: (typeof GRADE_POLICY_KINDS)[number];
  /** 0..1 — every category must reach this (all_categories_min). */
  min: number | null;
  /** Canvas assignment-group ids as strings. */
  categories: string[];
};

export const STUDY_CLASS_SOURCES = ["canvas", "manual"] as const;
export type StudyClassSource = (typeof STUDY_CLASS_SOURCES)[number];

/**
 * A Canvas course mirrored for one study user — or (`source: 'manual'`) a class the user
 * created themselves. A manual class carries a unique NEGATIVE sentinel `canvasCourseId`
 * (Canvas ids are positive) so the {userId, canvasCourseId} unique index and every
 * per-course lookup keep working; it must never reach a Canvas API call.
 */
export interface IStudyClass {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** Absent on rows created before manual classes existed — treat as 'canvas'. */
  source?: StudyClassSource;
  canvasCourseId: number;
  name: string;
  code: string;
  term: { id: number | null; name: string | null; startAt: Date | null; endAt: Date | null };
  /** Colour from Canvas `users/self/colors`. */
  canvasColor: string | null;
  /** Owner override via PATCH; wins over `canvasColor` when set. */
  userColor: string | null;
  grade: { score: number | null; letter: string | null; trend: -1 | 0 | 1 };
  hidden: boolean;
  /** Passed the current-term filter on the last successful course listing. */
  current: boolean;
  lastSyncedAt: Date | null;
  /** Grade plan: Canvas weighting flag + grading standard (null scheme = 90/80/70/60 default). */
  grading?: { weighted: boolean; scheme: { name: string; value: number }[] | null } | null;
  /** Grade plan target letter (PATCH); null = "A". */
  targetLetter?: string | null;
  /** Grade plan policy (PATCH; seeded by sync for some classes); null = weighted (Canvas's own rule). */
  gradePolicy?: StudyGradePolicy | null;
  /** Manual class-times override (PATCH); wins over the A-plan syllabus's extracted meetings. */
  meetingsOverride?: { slots: { day: string; start: string; end: string }[]; timeZone: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyClassSchema = new Schema<IStudyClass>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    source: { type: String, enum: STUDY_CLASS_SOURCES, default: "canvas" },
    canvasCourseId: { type: Number, required: true },
    name: { type: String, required: true },
    code: { type: String, default: "" },
    term: {
      id: { type: Number, default: null },
      name: { type: String, default: null },
      startAt: { type: Date, default: null },
      endAt: { type: Date, default: null },
    },
    canvasColor: { type: String, default: null },
    userColor: { type: String, default: null },
    grade: {
      score: { type: Number, default: null },
      letter: { type: String, default: null },
      trend: { type: Number, enum: [-1, 0, 1], default: 0 },
    },
    hidden: { type: Boolean, default: false },
    current: { type: Boolean, default: true },
    lastSyncedAt: { type: Date, default: null },
    grading: {
      type: new Schema(
        { weighted: { type: Boolean, default: false }, scheme: { type: [{ _id: false, name: String, value: Number }], default: null } },
        { _id: false }
      ),
      default: null,
    },
    targetLetter: { type: String, default: null },
    gradePolicy: {
      type: new Schema(
        {
          kind: { type: String, enum: GRADE_POLICY_KINDS, required: true },
          min: { type: Number, default: null },
          categories: { type: [String], default: [] },
        },
        { _id: false }
      ),
      default: null,
    },
    meetingsOverride: {
      type: new Schema(
        { slots: { type: [{ _id: false, day: String, start: String, end: String }], default: [] }, timeZone: { type: String, required: true } },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);

StudyClassSchema.index({ userId: 1, canvasCourseId: 1 }, { unique: true });

export const isManualClass = (c: Pick<IStudyClass, "source"> | null | undefined) => c?.source === "manual";

export const StudyClass = mongoose.model<IStudyClass>("StudyClass", StudyClassSchema, "study_classes");
