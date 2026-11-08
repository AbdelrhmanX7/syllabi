import mongoose, { Schema, Types } from "mongoose";

export const CONCEPT_MAP_SOURCES = ["import", "canvas", "practice"] as const;
export type ConceptMapSource = (typeof CONCEPT_MAP_SOURCES)[number];
export const SCORE_SOURCES = ["canvas", "manual"] as const;
export type ScoreSource = (typeof SCORE_SOURCES)[number];
export const PROMPT_TERMS_SOURCES = ["canvas", "manual"] as const;
export type PromptTermsSource = (typeof PROMPT_TERMS_SOURCES)[number];

/**
 * One concept-map prompt (`study_concept_maps`). `import` rows come from the class folder's
 * CONCEPT-MAPS.md (pending → attach like library docs, keyed by canvasCourseId); `canvas` rows
 * are created lazily from a synced "Concept Map N" assignment; `practice` rows by the owner.
 */
export interface IStudyConceptMap {
  _id: Types.ObjectId;
  userId: Types.ObjectId | null;
  canvasUserId: number | null;
  canvasCourseId: number;
  source: ConceptMapSource;
  number: number | null;
  week: number | null;
  lecture: string | null;
  dueAt: Date | null;
  promptTerms: string[];
  /** Who set promptTerms: 'canvas' = extracted from the linked assignment, 'manual' = the owner (PATCH, wins); null = the folder import / none. */
  promptTermsSource: PromptTermsSource | null;
  /** Cache of the model fallback that read terms from the Canvas description (+ attachments); `hash` = of that text. */
  termsExtraction: { hash: string; terms: string[]; at: Date } | null;
  /** `canvasAttachmentId` = the Canvas upload `imageKey` was copied from (Canvas sync); null = the folder import / none. */
  submission: { imageKey: string | null; transcription: string | null; canvasAttachmentId?: string | null } | null;
  instructor: { comment: string | null; modelAnswer: string | null } | null;
  /** Effective score: the manual override when set, else Canvas, else the import's value. */
  score: number | null;
  /** Where `score` came from; null = the folder import (or none yet). */
  scoreSource: ScoreSource | null;
  /** Last graded score seen on the linked Canvas submission — a change of THIS value is what lets Canvas beat a manual score. */
  canvasScore: number | null;
  /** The owner's override (PATCH /study/concept-maps/:id); null = none. */
  manualScore: number | null;
  /** Set when a Canvas change replaced a manual score ("Canvas changed the score to 9.5 — replaced your manual 8"). */
  scoreNote: string | null;
  maxScore: number;
  canvasItemId: Types.ObjectId | null;
  /** Canvas assignment id from the import's "Source:" link — exact link to the synced item. */
  canvasAssignmentId: string | null;
  /** Practice maps: the map it was made from. Its lecture is the base map's (lectureScope); the practice map itself stays un-linked so score sync never takes it for the Canvas map. */
  baseMapId?: Types.ObjectId | null;
  /** The owner's notebook pages for this lecture (PATCH /study/concept-maps/:id {notesPageIds}), in order; ≤ NOTES_PAGES_MAX. */
  notesPageIds: Types.ObjectId[];
  /** Cached digest of those pages (POST /:id/notes-digest); `hash` = page ids+versions + prompt terms + instructor. */
  notesDigest: NotesDigestCache | null;
  createdAt: Date;
  updatedAt: Date;
}

export const NOTES_PAGES_MAX = 20;

/** What the owner's lecture notes say about the map's concepts — "professor wording wins". */
export interface NotesDigest {
  concepts: Array<{ term: string; definitionFromNotes: string; matchesProfessor: boolean; professorWording?: string }>;
  questions: Array<{ q: string; answerFromNotes?: string }>;
  missingFromNotes: string[];
  conflicts: Array<{ term: string; notes: string; professor: string }>;
}
export interface NotesDigestCache {
  hash: string;
  pages: Array<{ pageId: string; version: number }>;
  digest: NotesDigest;
  /** The model that wrote the digest (absent on digests built before the concept-map text chain). */
  model?: string | null;
  /** What the digest was built from (absent on digests built before sources were tracked). */
  sources?: Array<{ kind: string; title: string; itemId?: string }>;
  createdAt: Date;
}

const StudyConceptMapSchema = new Schema<IStudyConceptMap>(
  {
    userId: { type: Schema.Types.ObjectId, default: null },
    canvasUserId: { type: Number, default: null },
    canvasCourseId: { type: Number, required: true },
    source: { type: String, enum: CONCEPT_MAP_SOURCES, required: true },
    number: { type: Number, default: null },
    week: { type: Number, default: null },
    lecture: { type: String, default: null },
    dueAt: { type: Date, default: null },
    promptTerms: { type: [String], default: [] },
    promptTermsSource: { type: String, enum: [...PROMPT_TERMS_SOURCES, null], default: null },
    termsExtraction: { type: Schema.Types.Mixed, default: null },
    submission: {
      type: new Schema({ imageKey: { type: String, default: null }, transcription: { type: String, default: null }, canvasAttachmentId: { type: String, default: null } }, { _id: false }),
      default: null,
    },
    instructor: { type: new Schema({ comment: { type: String, default: null }, modelAnswer: { type: String, default: null } }, { _id: false }), default: null },
    score: { type: Number, default: null },
    scoreSource: { type: String, enum: [...SCORE_SOURCES, null], default: null },
    canvasScore: { type: Number, default: null },
    manualScore: { type: Number, default: null },
    scoreNote: { type: String, default: null },
    maxScore: { type: Number, default: 10 },
    canvasItemId: { type: Schema.Types.ObjectId, default: null },
    canvasAssignmentId: { type: String, default: null },
    baseMapId: { type: Schema.Types.ObjectId, default: null },
    notesPageIds: { type: [Schema.Types.ObjectId], default: [] },
    notesDigest: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

StudyConceptMapSchema.index({ userId: 1, canvasCourseId: 1, number: 1 });
StudyConceptMapSchema.index({ canvasUserId: 1, canvasCourseId: 1, source: 1, number: 1 });

export const StudyConceptMap = mongoose.model<IStudyConceptMap>("StudyConceptMap", StudyConceptMapSchema, "study_concept_maps");

export interface ConceptReading {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label: string }>;
}
export interface CriterionScore {
  name: string;
  score: number;
  max: number;
  note: string;
}
export interface ConceptVerdict {
  /** Calibrated to the professor's scale (see CM_CALIBRATION); the criteria sum is `rawScore`. */
  score: number;
  rawScore?: number;
  max: number;
  missingTerms: string[];
  unlabeledArrows: number;
  wrongLinks: Array<{ from: string; to: string; label: string; why: string }>;
  suggestions: string[];
}

/** One graded attempt at a map (`study_concept_map_attempts`). */
export interface IStudyConceptMapAttempt {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  mapId: Types.ObjectId;
  promptTerms: string[];
  imageKey: string | null;
  reading: ConceptReading;
  criteria: CriterionScore[];
  verdict: ConceptVerdict;
  /** The text model that graded it (null on attempts graded before this was recorded). */
  model: string | null;
  /** What grounded the grade (services/study/concept-map-context CmSource). */
  sources: Array<{ kind: string; title: string; itemId?: string }>;
  createdAt: Date;
}

const StudyConceptMapAttemptSchema = new Schema<IStudyConceptMapAttempt>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    mapId: { type: Schema.Types.ObjectId, required: true },
    promptTerms: { type: [String], default: [] },
    imageKey: { type: String, default: null },
    reading: { type: Schema.Types.Mixed, default: { nodes: [], edges: [] } },
    criteria: { type: [Schema.Types.Mixed] as any, default: [] },
    verdict: { type: Schema.Types.Mixed, default: null },
    model: { type: String, default: null },
    sources: { type: [Schema.Types.Mixed] as any, default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

StudyConceptMapAttemptSchema.index({ userId: 1, mapId: 1, createdAt: -1 });

export const StudyConceptMapAttempt = mongoose.model<IStudyConceptMapAttempt>(
  "StudyConceptMapAttempt",
  StudyConceptMapAttemptSchema,
  "study_concept_map_attempts"
);
