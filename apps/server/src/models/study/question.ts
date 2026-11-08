import mongoose, { Schema, Types } from "mongoose";
import { EditedBySchema, IEditedBy } from "@/models/share";

export const STUDY_QUESTION_SOURCE_KINDS = ["canvas_quiz", "derivita", "pdf", "slides", "video", "lecture", "photo", "manual", "ai_similar", "mock"] as const;
export type QuestionSourceKind = (typeof STUDY_QUESTION_SOURCE_KINDS)[number];
export const STUDY_QUESTION_TYPES = ["free", "mcq", "code_output", "code_write", "label_image", "matching", "fill_blank"] as const;
export type StudyQuestionType = (typeof STUDY_QUESTION_TYPES)[number];
export const ATTEMPT_RESULTS = ["right", "wrong", "partial"] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

/**
 * One question in the personal bank (contract "Question bank"). `stemHash` + `shingles` are
 * internal (services/study/dedupe.ts) and never serialised; `srs.lastReviewAt` is the FSRS
 * clock (elapsed days) and also stays internal.
 */
export interface IStudyQuestion {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  topic: string;
  subtopic: string | null;
  difficulty: number;
  source: {
    kind: QuestionSourceKind;
    itemId: Types.ObjectId | null;
    pageId: Types.ObjectId | null;
    lectureId: Types.ObjectId | null;
    ref: string | null;
  };
  type: StudyQuestionType;
  stem: string;
  imageUrl: string | null;
  choices: string[];
  /** matching only: the key, in display order. `choices` = the rights (+ distractors), shuffled. */
  pairs: Array<{ left: string; right: string }>;
  /**
   * Markdown for most types. matching: JSON `{"<left>":"<right>"}` (derived from `pairs`);
   * fill_blank: JSON `["word|alt1|alt2", …]`, one entry per `___` in the stem.
   */
  answer: string;
  solutionSteps: string[];
  tags: string[];
  stats: { attempts: number; correct: number; lastResult: AttemptResult | null; mastery: number };
  srs: { dueAt: Date; stability: number; difficulty: number; reps: number; lapses: number; lastReviewAt: Date | null };
  stemHash: string;
  shingles: string[];
  /** Set when someone the owner shared this with (an editor) last changed it. */
  editedBy?: IEditedBy | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyQuestionSchema = new Schema<IStudyQuestion>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    topic: { type: String, required: true },
    subtopic: { type: String, default: null },
    difficulty: { type: Number, min: 1, max: 5, default: 3 },
    source: {
      kind: { type: String, enum: STUDY_QUESTION_SOURCE_KINDS, default: "manual" },
      itemId: { type: Schema.Types.ObjectId, default: null },
      pageId: { type: Schema.Types.ObjectId, default: null },
      lectureId: { type: Schema.Types.ObjectId, default: null },
      ref: { type: String, default: null },
    },
    type: { type: String, enum: STUDY_QUESTION_TYPES, default: "free" },
    stem: { type: String, required: true },
    imageUrl: { type: String, default: null },
    choices: { type: [String], default: [] },
    pairs: { type: [new Schema({ left: { type: String, required: true }, right: { type: String, required: true } }, { _id: false })], default: [] },
    answer: { type: String, default: "" },
    solutionSteps: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    stats: {
      attempts: { type: Number, default: 0 },
      correct: { type: Number, default: 0 },
      lastResult: { type: String, enum: [...ATTEMPT_RESULTS, null], default: null },
      mastery: { type: Number, default: 0 },
    },
    srs: {
      dueAt: { type: Date, default: () => new Date() },
      stability: { type: Number, default: 0 },
      difficulty: { type: Number, default: 0 },
      reps: { type: Number, default: 0 },
      lapses: { type: Number, default: 0 },
      lastReviewAt: { type: Date, default: null },
    },
    stemHash: { type: String, required: true },
    shingles: { type: [String], default: [] },
    editedBy: { type: EditedBySchema, default: null },
  },
  { timestamps: true }
);

StudyQuestionSchema.index({ userId: 1, createdAt: -1, _id: -1 });
StudyQuestionSchema.index({ userId: 1, classId: 1, topic: 1 });
StudyQuestionSchema.index({ userId: 1, "srs.dueAt": 1 });
StudyQuestionSchema.index({ userId: 1, classId: 1, stemHash: 1 });
StudyQuestionSchema.index({ userId: 1, classId: 1, shingles: 1 });

export const StudyQuestion = mongoose.model<IStudyQuestion>("StudyQuestion", StudyQuestionSchema, "study_questions");
