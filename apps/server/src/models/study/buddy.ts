import mongoose, { Schema, Types } from "mongoose";

/**
 * The study buddy's memory (`study_buddy_memory`): short facts about the student, one row per
 * account + class (classId null = no class). Written by the experts («remember») and by quick
 * checks; read into every turn. Bounded: BUDDY_MEMORY_MAX notes, oldest dropped.
 */
export const BUDDY_MEMORY_MAX = 40;
export interface BuddyMemoryNote {
  text: string;
  at: Date;
  /** Which expert (or «quiz») wrote it. */
  by: string;
}
export interface IStudyBuddyMemory {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId | null;
  notes: BuddyMemoryNote[];
  updatedAt: Date;
}
const MemorySchema = new Schema<IStudyBuddyMemory>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, default: null },
    notes: { type: [{ _id: false, text: { type: String, maxlength: 200 }, at: Date, by: String }], default: [] },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);
MemorySchema.index({ userId: 1, classId: 1 }, { unique: true });
export const StudyBuddyMemory = mongoose.model<IStudyBuddyMemory>("StudyBuddyMemory", MemorySchema, "study_buddy_memory");

/** One thing the buddy did during a turn, in order — what the student and the owner can inspect. */
export interface BuddyTraceStep {
  /** page = what the app did with the written answer (wrote it on the page, or why not), reported by the app. pick = choosing the expert; memory / knowledge = what was read; expert = the answer; remember = what was saved. */
  kind: "pick" | "memory" | "knowledge" | "expert" | "remember" | "page";
  name: string;
  /** Models that ran in this step (empty for reads). */
  models: string[];
  ms: number;
  costUsd: number;
  /** Plain words: what was read / decided / written. */
  detail: string;
}

/**
 * One buddy turn (`study_buddy_turns`): the question, the expert that answered, every step it took
 * (trace), the answer, and the student's rating. The page as the model saw it is kept as a small
 * JPEG (`imageKey`) so an answer can be reviewed later.
 */
export interface IStudyBuddyTurn {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId | null;
  pageId: Types.ObjectId | null;
  question: string;
  /** The question was handwritten on the pad. */
  handwritten: boolean;
  skill: string;
  pickedBy: "button" | "picker" | "fallback";
  route: string;
  status: "done" | "error";
  error: string | null;
  trace: BuddyTraceStep[];
  /** The reply as sent (marks counted, not stored). */
  reply: { say?: string; verdict?: string; steps?: string[]; quiz?: unknown; similar?: unknown; marks: number } | null;
  /** Quick check: the choice the student tapped, and whether it was right. */
  quizAnswer: { choice: number; correct: boolean; at: Date } | null;
  rating: "up" | "down" | null;
  ratingNote: string | null;
  imageKey: string | null;
  models: string[];
  costUsd: number;
  latencyMs: number;
  createdAt: Date;
}
const TurnSchema = new Schema<IStudyBuddyTurn>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, default: null },
    pageId: { type: Schema.Types.ObjectId, default: null },
    question: { type: String, default: "" },
    handwritten: { type: Boolean, default: false },
    skill: { type: String, required: true },
    pickedBy: { type: String, enum: ["button", "picker", "fallback"], required: true },
    route: { type: String, default: "" },
    status: { type: String, enum: ["done", "error"], required: true },
    error: { type: String, default: null, maxlength: 500 },
    trace: { type: [{ _id: false, kind: String, name: String, models: [String], ms: Number, costUsd: Number, detail: { type: String, maxlength: 1200 } }], default: [] },
    reply: { type: Schema.Types.Mixed, default: null },
    quizAnswer: { type: Schema.Types.Mixed, default: null },
    rating: { type: String, enum: ["up", "down", null], default: null },
    ratingNote: { type: String, default: null, maxlength: 500 },
    imageKey: { type: String, default: null },
    models: { type: [String], default: [] },
    costUsd: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
TurnSchema.index({ userId: 1, createdAt: -1 });
export const StudyBuddyTurn = mongoose.model<IStudyBuddyTurn>("StudyBuddyTurn", TurnSchema, "study_buddy_turns");

/**
 * A student's own expert, or their edit of a built-in one (`study_buddy_experts`, one row per
 * account + expert id). A row whose `id` is a built-in's replaces that built-in for this account;
 * deleting it brings the built-in back. See services/study/buddy/experts.ts.
 */
export const BUDDY_CUSTOM_EXPERTS_MAX = 20;
export interface IStudyBuddyExpert {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  id: string;
  name: string;
  when: string;
  /** The rules, one per line. */
  job: string[];
  gives: "steps" | "quiz" | "similar" | null;
  weakTopics: boolean;
  /** Off = the picker never chooses it and it has no button. */
  enabled: boolean;
  updatedAt: Date;
}
const ExpertSchema = new Schema<IStudyBuddyExpert>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    id: { type: String, required: true },
    name: { type: String, required: true, maxlength: 40 },
    when: { type: String, default: "", maxlength: 300 },
    job: { type: [String], default: [] },
    gives: { type: String, enum: ["steps", "quiz", "similar", null], default: null },
    weakTopics: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);
ExpertSchema.index({ userId: 1, id: 1 }, { unique: true });
export const StudyBuddyExpert = mongoose.model<IStudyBuddyExpert>("StudyBuddyExpert", ExpertSchema, "study_buddy_experts");
