import mongoose, { Schema, Types } from "mongoose";

/**
 * One per (user, class): the syllabus we found, its extracted text, and the AI-extracted
 * ClassPolicy (services/study/a-plan/policy.ts). The policy is re-extracted only when the
 * syllabus text hash changes (`policyTextHash !== syllabus.textHash`).
 */
export const SYLLABUS_SOURCE_KINDS = ["body", "body_file", "module_file", "module_page", "none"] as const;
export type SyllabusSourceKind = (typeof SYLLABUS_SOURCE_KINDS)[number];

export interface ClassPolicyQuote {
  field: string;
  text: string;
}

export interface PolicySlot {
  day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  /** 24h "HH:mm", course local time. */
  start: string;
  end: string | null;
  place: string | null;
}

export interface ClassPolicy {
  gradingCategories: { name: string; weight: number | null; canvasGroupId: number | null; rules: string; unit?: "credits" | "questions" | "points" | null }[];
  aRequirement: { text: string; kind: "weighted" | "all_categories_min" | "points" | "other"; min: number | null; categories: string[] } | null;
  scale: { letter: string; min: number }[];
  lateWork: string | null;
  makeupAndRevisions: string | null;
  drops: string | null;
  attendance: string | null;
  exams: { name: string; date: string | null; week: string | null; topics: string[]; format: string | null; allowed: string | null }[];
  extraCredit: string | null;
  instructor: { name: string | null; email: string | null; officeHours: string | null };
  requiredMaterials: string[];
  keyDates: { date: string; label: string }[];
  /** Class meeting times (syllabus). `creditsPerMeeting` = engagement/participation credits earned per meeting. */
  meetings?: { slots: PolicySlot[]; creditsPerMeeting: number | null } | null;
  /** Mastery-style re-earning rules (retries / revisions), when the syllabus has them. */
  recovery?: {
    newAttempts: { perWeek: number | null; formLeadHours: number | null; formName: string | null; slots: PolicySlot[] } | null;
    revisionDays: number | null;
    /** True when the syllabus counts the day the work is returned as day 1. */
    revisionReturnDayIsDayOne: boolean | null;
    revisionFormName: string | null;
    rules: string[];
  } | null;
  /** Campus-closed / no-class dates stated in the syllabus (YYYY-MM-DD). */
  closedDates?: string[];
  quotes: ClassPolicyQuote[];
  /** Model quotes that were NOT verbatim in the syllabus and were removed. */
  quotesDropped: number;
}

export interface ClassEmphasis {
  text: string;
  exam: string | null;
  itemId: Types.ObjectId;
  postedAt: Date | null;
}

export interface IStudyClassPolicy {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  syllabus: {
    kind: SyllabusSourceKind;
    itemId: Types.ObjectId | null;
    title: string | null;
    text: string;
    textHash: string | null;
    /** e.g. "no_text_layer" when a PDF syllabus is a scan. */
    note: string | null;
    checkedAt: Date | null;
  };
  /** IANA zone of the Canvas course — announcements' local dates are read in it. */
  timeZone: string | null;
  policy: ClassPolicy | null;
  policyTextHash: string | null;
  /** Non-verbatim quotes the model returned (kept for audit, never exposed as quotes). */
  droppedQuotes: ClassPolicyQuote[];
  policyExtractedAt: Date | null;
  policyError: string | null;
  /** "Know X for the exam" lines from announcement digests — feeds the exam scope. */
  emphasis: ClassEmphasis[];
  createdAt: Date;
  updatedAt: Date;
}

const StudyClassPolicySchema = new Schema<IStudyClassPolicy>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    syllabus: {
      kind: { type: String, enum: SYLLABUS_SOURCE_KINDS, default: "none" },
      itemId: { type: Schema.Types.ObjectId, default: null },
      title: { type: String, default: null },
      text: { type: String, default: "" },
      textHash: { type: String, default: null },
      note: { type: String, default: null },
      checkedAt: { type: Date, default: null },
    },
    timeZone: { type: String, default: null },
    policy: { type: Schema.Types.Mixed, default: null },
    policyTextHash: { type: String, default: null },
    droppedQuotes: { type: [{ field: String, text: String, _id: false }], default: [] },
    policyExtractedAt: { type: Date, default: null },
    policyError: { type: String, default: null },
    emphasis: {
      type: [{ text: String, exam: { type: String, default: null }, itemId: Schema.Types.ObjectId, postedAt: { type: Date, default: null }, _id: false }],
      default: [],
    },
  },
  { timestamps: true }
);

StudyClassPolicySchema.index({ userId: 1, classId: 1 }, { unique: true });

export const StudyClassPolicy = mongoose.model<IStudyClassPolicy>("StudyClassPolicy", StudyClassPolicySchema, "study_class_policies");
