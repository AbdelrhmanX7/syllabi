import mongoose, { Schema, Types } from "mongoose";

/**
 * Class library (P-CM): documents imported from the owner's local class folder
 * (services/study/library-import.ts) — markdown notes, PDFs (file + text layer) and images.
 *
 * Ownership is two-stage. The import knows the owner only by Canvas user id (`canvasUserId`);
 * `userId` stays null ("pending") until a study Canvas connection for that Canvas user is saved,
 * when `attachPendingImports` stamps it. Rows never carry a classId: they key on
 * `canvasCourseId`, and the class is resolved lazily from `study_classes` at read time, so the
 * import works before the first Canvas sync and survives a class being re-created.
 */
export const LIBRARY_KINDS = ["note", "pdf", "image"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export interface IStudyLibraryDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId | null;
  canvasUserId: number;
  canvasCourseId: number;
  /** Path relative to the course folder (the import's upsert identity, with canvasUserId). */
  relPath: string;
  title: string;
  kind: LibraryKind;
  week: number | null;
  /** Notes only: the markdown as written; image refs are rewritten to signed urls on read. */
  markdown: string | null;
  /** Stored file (pdf/image). Null for notes, and for a PDF over the file cap (text only). */
  file: { storageKey: string; mime: string; size: number; sha256: string } | null;
  /** Source size and hash, also for files that were too big to store. */
  size: number;
  sha256: string;
  /** PDFs: page count of the text layer; notes: chunk count. */
  pages: number | null;
  textChars: number;
  createdAt: Date;
  updatedAt: Date;
}

const StudyLibraryDocSchema = new Schema<IStudyLibraryDoc>(
  {
    userId: { type: Schema.Types.ObjectId, default: null },
    canvasUserId: { type: Number, required: true },
    canvasCourseId: { type: Number, required: true },
    relPath: { type: String, required: true },
    title: { type: String, default: "" },
    kind: { type: String, enum: LIBRARY_KINDS, required: true },
    week: { type: Number, default: null },
    markdown: { type: String, default: null },
    file: {
      type: new Schema({ storageKey: String, mime: String, size: Number, sha256: String }, { _id: false }),
      default: null,
    },
    size: { type: Number, default: 0 },
    sha256: { type: String, default: "" },
    pages: { type: Number, default: null },
    textChars: { type: Number, default: 0 },
  },
  { timestamps: true }
);

StudyLibraryDocSchema.index({ canvasUserId: 1, canvasCourseId: 1, relPath: 1 }, { unique: true });
StudyLibraryDocSchema.index({ userId: 1, canvasCourseId: 1, week: 1 });

export const StudyLibraryDoc = mongoose.model<IStudyLibraryDoc>("StudyLibraryDoc", StudyLibraryDocSchema, "study_library_docs");

/**
 * Retrieval unit: one PDF page, or one ~4k-char slice of a note. Keyword retrieval only
 * (services/study/library.ts) — no vector index.
 */
export interface IStudyLibraryChunk {
  _id: Types.ObjectId;
  docId: Types.ObjectId;
  userId: Types.ObjectId | null;
  canvasUserId: number;
  canvasCourseId: number;
  week: number | null;
  /** 1-based page (PDF) or slice index (note). */
  page: number;
  text: string;
}

const StudyLibraryChunkSchema = new Schema<IStudyLibraryChunk>({
  docId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: Schema.Types.ObjectId, default: null },
  canvasUserId: { type: Number, required: true },
  canvasCourseId: { type: Number, required: true },
  week: { type: Number, default: null },
  page: { type: Number, required: true },
  text: { type: String, default: "" },
});

StudyLibraryChunkSchema.index({ docId: 1, page: 1 }, { unique: true });
StudyLibraryChunkSchema.index({ userId: 1, canvasCourseId: 1, week: 1 });
StudyLibraryChunkSchema.index({ canvasUserId: 1, userId: 1 });

export const StudyLibraryChunk = mongoose.model<IStudyLibraryChunk>("StudyLibraryChunk", StudyLibraryChunkSchema, "study_library_chunks");

/**
 * Per-class guide (system context for every AI call of that class) + the exam schedule.
 * Seeded by the import (pending → attach like library docs); owner-editable. A row the owner
 * has edited (`editedAt` set) is never overwritten by a re-import.
 */
export interface ExamScheduleEntry {
  name: string;
  week: number | null;
  date: string | null;
  chapters: string[];
  topics: string[];
}

/**
 * A class's real-exam structure, used by `POST /study/exams {blueprint:'class'}`. Sections run in
 * order; `type: "any"` takes any question type (e.g. a bonus). `optional` sections are bank-only
 * (skipped and reported when the bank has none); `from: "concept_map"` draws short answers from
 * concept-map questions; `preferImage` favours questions with an image (labeled diagrams).
 */
export interface ExamBlueprintSection {
  section: string;
  type: string;
  count: number;
  /** Optional section weight (FE computes a weighted section score from it). */
  points?: number;
  bonus?: boolean;
  optional?: boolean;
  preferImage?: boolean;
  from?: "concept_map" | null;
}
export interface ExamBlueprint {
  minutes: number | null;
  sections: ExamBlueprintSection[];
}

export interface IStudyClassGuide {
  _id: Types.ObjectId;
  userId: Types.ObjectId | null;
  canvasUserId: number | null;
  canvasCourseId: number;
  markdown: string;
  examsSchedule: ExamScheduleEntry[];
  /** The concept-map rubric page text (grounding for the concept-map grader). */
  conceptMapRubric: string | null;
  /** Owner-set blueprint; null → the code default for the course (services/study/exam-blueprint.ts) or none. */
  examBlueprint: ExamBlueprint | null;
  editedAt: Date | null;
  scheduleEditedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ScheduleSchema = new Schema<ExamScheduleEntry>(
  {
    name: { type: String, required: true },
    week: { type: Number, default: null },
    date: { type: String, default: null },
    chapters: { type: [String], default: [] },
    topics: { type: [String], default: [] },
  },
  { _id: false }
);

const StudyClassGuideSchema = new Schema<IStudyClassGuide>(
  {
    userId: { type: Schema.Types.ObjectId, default: null },
    canvasUserId: { type: Number, default: null },
    canvasCourseId: { type: Number, required: true },
    markdown: { type: String, default: "" },
    examsSchedule: { type: [ScheduleSchema], default: [] },
    conceptMapRubric: { type: String, default: null },
    examBlueprint: { type: Schema.Types.Mixed, default: null },
    editedAt: { type: Date, default: null },
    scheduleEditedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

StudyClassGuideSchema.index({ userId: 1, canvasCourseId: 1 });
StudyClassGuideSchema.index({ canvasUserId: 1, canvasCourseId: 1 });

export const StudyClassGuide = mongoose.model<IStudyClassGuide>("StudyClassGuide", StudyClassGuideSchema, "study_class_guides");

/** Lab kit specimens (e.g. mineral kit #1 talc … #20 limonite, #21–30 unknowns) — a future ID-drill source. */
export interface IStudyLabSpecimen {
  _id: Types.ObjectId;
  userId: Types.ObjectId | null;
  canvasUserId: number;
  canvasCourseId: number;
  kit: string;
  number: number;
  name: string | null;
  unknown: boolean;
  properties: { luster: string | null; hardness: string | null; streak: string | null; cleavage: string | null; notes: string | null };
  /** Library image docs that show this specimen's mineral. */
  photoDocIds: Types.ObjectId[];
}

const StudyLabSpecimenSchema = new Schema<IStudyLabSpecimen>(
  {
    userId: { type: Schema.Types.ObjectId, default: null },
    canvasUserId: { type: Number, required: true },
    canvasCourseId: { type: Number, required: true },
    kit: { type: String, required: true },
    number: { type: Number, required: true },
    name: { type: String, default: null },
    unknown: { type: Boolean, default: false },
    properties: {
      luster: { type: String, default: null },
      hardness: { type: String, default: null },
      streak: { type: String, default: null },
      cleavage: { type: String, default: null },
      notes: { type: String, default: null },
    },
    photoDocIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true }
);

StudyLabSpecimenSchema.index({ canvasUserId: 1, canvasCourseId: 1, kit: 1, number: 1 }, { unique: true });
StudyLabSpecimenSchema.index({ userId: 1, canvasCourseId: 1 });

export const StudyLabSpecimen = mongoose.model<IStudyLabSpecimen>("StudyLabSpecimen", StudyLabSpecimenSchema, "study_lab_specimens");

/** Real exam results per class (`study_exam_results`). `seedKey` = the import's upsert identity. */
export interface IStudyExamResult {
  _id: Types.ObjectId;
  userId: Types.ObjectId | null;
  canvasUserId: number | null;
  canvasCourseId: number;
  seedKey: string | null;
  name: string;
  date: string | null;
  score: number;
  maxScore: number;
  chapters: string[];
  sections: Array<{ name: string; score: number; max: number }>;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyExamResultSchema = new Schema<IStudyExamResult>(
  {
    userId: { type: Schema.Types.ObjectId, default: null },
    canvasUserId: { type: Number, default: null },
    canvasCourseId: { type: Number, required: true },
    seedKey: { type: String, default: null },
    name: { type: String, required: true },
    date: { type: String, default: null },
    score: { type: Number, required: true },
    maxScore: { type: Number, required: true },
    chapters: { type: [String], default: [] },
    sections: { type: [new Schema({ name: String, score: Number, max: Number }, { _id: false })], default: [] },
    notes: { type: String, default: null },
  },
  { timestamps: true }
);

StudyExamResultSchema.index({ userId: 1, canvasCourseId: 1, date: -1 });
StudyExamResultSchema.index({ canvasUserId: 1, canvasCourseId: 1, seedKey: 1 });

export const StudyExamResult = mongoose.model<IStudyExamResult>("StudyExamResult", StudyExamResultSchema, "study_exam_results");
