import mongoose, { Schema, Types } from "mongoose";

export const STUDY_ITEM_TYPES = ["file", "page", "assignment", "quiz", "video", "link", "announcement"] as const;
export type StudyItemType = (typeof STUDY_ITEM_TYPES)[number];

export const SUBMISSION_STATES = ["unsubmitted", "submitted", "graded", "missing", "late"] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/**
 * Canvas object kind that identifies an item. Together with `canvasId` it is the item's
 * identity, so a File/Page/Assignment/Quiz/Discussion reached both from its standalone list
 * and from a module item resolves to ONE row. Pages are keyed by their `page_url` slug (module
 * items carry no page id). Videos are keyed by YouTube id ("Video"), one per class.
 */
export type StudyCanvasType =
  | "File"
  | "Page"
  | "Assignment"
  | "Quiz"
  | "Discussion"
  | "Announcement"
  | "ExternalUrl"
  | "ExternalTool"
  | "Video";

export interface IStudyItem {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  canvasType: StudyCanvasType;
  canvasId: string;
  type: StudyItemType;
  title: string;
  canvasUrl: string | null;
  canvasUpdatedAt: Date | null;
  seenAt: Date | null;
  moduleId: Types.ObjectId | null;
  /** For a video found inside page/assignment/announcement HTML: the item that embeds it. */
  parentItemId: Types.ObjectId | null;
  modulePosition: number | null;
  dueAt: Date | null;
  /**
   * Due date after an announcement moved it (A plan, services/study/a-plan/announcements.ts).
   * `dueAt` stays the Canvas value; every due/overdue rule reads `effectiveDueAt ?? dueAt`.
   */
  effectiveDueAt: Date | null;
  dueChangedBy: {
    announcementItemId: Types.ObjectId;
    postedAt: Date | null;
    text: string;
    /** Canvas `dueAt` when the override was applied — if Canvas later moves it, Canvas wins. */
    canvasDueAtWas: Date | null;
    confidence: number;
  } | null;
  points: number | null;
  submission: { state: SubmissionState; score: number | null } | null;
  /** False for submission types the student never submits online (none / on_paper / not_graded). */
  submittable: boolean;
  external: { tool: string } | null;
  html: string | null;
  file: {
    name: string;
    mime: string;
    size: number;
    version: number;
    sha256: string;
    storageKey: string;
    canvasUpdatedAt: Date | null;
  } | null;
  video: {
    provider: "youtube";
    videoId: string;
    durationSec: number | null;
    transcriptStatus: "none" | "pending" | "ready" | "failed";
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyItemSchema = new Schema<IStudyItem>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    canvasType: { type: String, required: true },
    canvasId: { type: String, required: true },
    type: { type: String, enum: STUDY_ITEM_TYPES, required: true },
    title: { type: String, default: "" },
    canvasUrl: { type: String, default: null },
    canvasUpdatedAt: { type: Date, default: null },
    seenAt: { type: Date, default: null },
    moduleId: { type: Schema.Types.ObjectId, default: null },
    parentItemId: { type: Schema.Types.ObjectId, default: null },
    modulePosition: { type: Number, default: null },
    dueAt: { type: Date, default: null },
    effectiveDueAt: { type: Date, default: null },
    dueChangedBy: {
      type: new Schema(
        {
          announcementItemId: Schema.Types.ObjectId,
          postedAt: { type: Date, default: null },
          text: String,
          canvasDueAtWas: { type: Date, default: null },
          confidence: Number,
        },
        { _id: false }
      ),
      default: null,
    },
    points: { type: Number, default: null },
    submission: {
      type: new Schema({ state: { type: String, enum: SUBMISSION_STATES }, score: { type: Number, default: null } }, { _id: false }),
      default: null,
    },
    submittable: { type: Boolean, default: true },
    external: { type: new Schema({ tool: String }, { _id: false }), default: null },
    html: { type: String, default: null },
    file: {
      type: new Schema(
        {
          name: String,
          mime: String,
          size: Number,
          version: Number,
          sha256: String,
          storageKey: String,
          canvasUpdatedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    video: {
      type: new Schema(
        {
          provider: { type: String, enum: ["youtube"] },
          videoId: String,
          durationSec: { type: Number, default: null },
          transcriptStatus: { type: String, enum: ["none", "pending", "ready", "failed"], default: "none" },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  { timestamps: true }
);

StudyItemSchema.index({ userId: 1, classId: 1, canvasType: 1, canvasId: 1 }, { unique: true });
StudyItemSchema.index({ userId: 1, classId: 1, type: 1 });
StudyItemSchema.index({ userId: 1, dueAt: 1 });
StudyItemSchema.index({ userId: 1, seenAt: 1 });

export const StudyItem = mongoose.model<IStudyItem>("StudyItem", StudyItemSchema, "study_items");
