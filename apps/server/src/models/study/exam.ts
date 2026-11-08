import mongoose, { Schema, Types } from "mongoose";

/**
 * A mock exam (contract "Mock exams"). `questions` is a FROZEN snapshot of the question DTOs
 * (answer + solution included — stripped by the API until `submittedAt` is set); `results` is
 * filled by the submit stream. `gradingStartedAt` is the submit lease: set while a submit is
 * grading so a second submit cannot double-count attempts.
 */
export interface IStudyExam {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  topics: string[];
  scopeItemIds: Types.ObjectId[];
  count: number;
  minutes: number;
  startedAt: Date;
  submittedAt: Date | null;
  gradingStartedAt: Date | null;
  late: boolean;
  questions: any[];
  /** Blueprint exams: the blueprint name ("class"); null for a plain count/topics exam. */
  blueprint: string | null;
  /** Blueprint exams: sections in order, with the ids of their questions. [] otherwise. */
  sections: Array<{ name: string; bonus?: boolean; points?: number; questionIds: string[] }>;
  results: Array<{ questionId: string; topic: string; section?: string | null; bonus?: boolean; result: "right" | "wrong" | "partial"; steps: any[]; firstErrorStep: number | null; hint: string | null; solution: string | null; answered: boolean }>;
  score: number | null;
  byTopic: Array<{ topic: string; score: number }>;
  bySection: Array<{ section: string; score: number }>;
  createdAt: Date;
  updatedAt: Date;
}

const StudyExamSchema = new Schema<IStudyExam>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    topics: { type: [String], default: [] },
    scopeItemIds: { type: [Schema.Types.ObjectId], default: [] },
    count: { type: Number, required: true },
    minutes: { type: Number, required: true },
    startedAt: { type: Date, required: true },
    submittedAt: { type: Date, default: null },
    gradingStartedAt: { type: Date, default: null },
    late: { type: Boolean, default: false },
    questions: { type: [Schema.Types.Mixed] as any, default: [] },
    results: { type: [Schema.Types.Mixed] as any, default: [] },
    score: { type: Number, default: null },
    byTopic: { type: [Schema.Types.Mixed] as any, default: [] },
    blueprint: { type: String, default: null },
    sections: { type: [Schema.Types.Mixed] as any, default: [] },
    bySection: { type: [Schema.Types.Mixed] as any, default: [] },
  },
  { timestamps: true }
);

StudyExamSchema.index({ userId: 1, classId: 1, createdAt: -1 });
StudyExamSchema.index({ userId: 1, createdAt: -1 });

export const StudyExam = mongoose.model<IStudyExam>("StudyExam", StudyExamSchema, "study_exams");
