import mongoose, { Schema, Types } from "mongoose";

export const TUTOR_MODES = ["explain", "quiz"] as const;
export type TutorMode = (typeof TUTOR_MODES)[number];

export const TUTOR_SOURCE_KINDS = ["library", "item", "transcript", "page", "guide"] as const;
export type TutorSourceKind = (typeof TUTOR_SOURCE_KINDS)[number];

/** One cited source, exactly as the `sources` SSE frame carries it. */
export interface TutorSource {
  kind: TutorSourceKind;
  id: string;
  title: string;
  snippet: string;
  week?: number | null;
  /** transcript only: segment start (s) to seek to. */
  t?: number | null;
}

export interface TutorMessage {
  role: "user" | "assistant";
  text: string;
  mode: TutorMode;
  sources?: TutorSource[];
  createdAt: Date;
}

/**
 * The question the tutor is waiting on in quiz mode. `kind: "bank"` = a `study_questions` row
 * (graded with services/study/attempt-grading.ts, FSRS/mastery updated); `"free"` = generated
 * for this conversation (graded by the text model only, nothing stored in the bank).
 */
export interface PendingQuizQuestion {
  /** Random token: grading claims the pending question atomically by it (no double grading). */
  token: string;
  kind: "bank" | "free";
  questionId: Types.ObjectId | null;
  stem: string;
  choices: string[];
  answer: string;
  topic: string | null;
  askedAt: Date;
}

export interface TutorQuizState {
  /** What the student asked to be quizzed on (the first quiz turn's text). */
  topic: string | null;
  pending: PendingQuizQuestion | null;
  asked: number;
  right: number;
  partial: number;
  wrong: number;
  /** Bank questions already asked in this conversation (never asked twice in a row of turns). */
  bankAsked: Types.ObjectId[];
}

/**
 * A class-tutor conversation (POST /study/ai/ask). Messages are embedded; the model sees the
 * rolling `summary` of everything before `summarizedUpTo` plus the last few turns verbatim.
 */
export interface IStudyConversation {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId | null;
  title: string;
  messages: TutorMessage[];
  summary: string | null;
  /** messages[0 .. summarizedUpTo) are folded into `summary`. */
  summarizedUpTo: number;
  quiz: TutorQuizState;
  createdAt: Date;
  updatedAt: Date;
}

const SourceSchema = new Schema<TutorSource>(
  {
    kind: { type: String, enum: TUTOR_SOURCE_KINDS, required: true },
    id: { type: String, required: true },
    title: { type: String, default: "" },
    snippet: { type: String, default: "" },
    week: { type: Number, default: null },
    t: { type: Number, default: null },
  },
  { _id: false }
);

const MessageSchema = new Schema<TutorMessage>(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    text: { type: String, default: "" },
    mode: { type: String, enum: TUTOR_MODES, default: "explain" },
    sources: { type: [SourceSchema], default: undefined },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const PendingSchema = new Schema<PendingQuizQuestion>(
  {
    token: { type: String, required: true },
    kind: { type: String, enum: ["bank", "free"], required: true },
    questionId: { type: Schema.Types.ObjectId, default: null },
    stem: { type: String, required: true },
    choices: { type: [String], default: [] },
    answer: { type: String, default: "" },
    topic: { type: String, default: null },
    askedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const StudyConversationSchema = new Schema<IStudyConversation>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, default: "" },
    messages: { type: [MessageSchema], default: [] },
    summary: { type: String, default: null },
    summarizedUpTo: { type: Number, default: 0 },
    quiz: {
      topic: { type: String, default: null },
      pending: { type: PendingSchema, default: null },
      asked: { type: Number, default: 0 },
      right: { type: Number, default: 0 },
      partial: { type: Number, default: 0 },
      wrong: { type: Number, default: 0 },
      bankAsked: { type: [Schema.Types.ObjectId], default: [] },
    },
  },
  { timestamps: true }
);

StudyConversationSchema.index({ userId: 1, classId: 1, updatedAt: -1 });
StudyConversationSchema.index({ userId: 1, updatedAt: -1 });

export const StudyConversation = mongoose.model<IStudyConversation>("StudyConversation", StudyConversationSchema, "study_conversations");
