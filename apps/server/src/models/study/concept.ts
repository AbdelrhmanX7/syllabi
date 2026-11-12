import mongoose, { Schema, Types } from "mongoose";

export const STUDY_CONCEPT_SOURCES = ["topic", "subtopic", "map-term", "exam-topic"] as const;
export type StudyConceptSource = (typeof STUDY_CONCEPT_SOURCES)[number];
export const STUDY_CONCEPT_EVIDENCE_KINDS = ["question", "exam", "map", "buddy"] as const;
export type StudyConceptEvidenceKind = (typeof STUDY_CONCEPT_EVIDENCE_KINDS)[number];

/**
 * One concept of a class (`study_concepts`) — the class knowledge map (services/study/concepts.ts).
 * Built without a model from what the account already has: question topics and subtopics, concept-map
 * prompt terms, the class guide's exam topics. `norm` is the merge key (one row per class + norm);
 * `sources` says where the concept is found right now and is rewritten by every sync.
 */
export interface IStudyConcept {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  label: string;
  norm: string;
  /** Other spellings seen for the same norm. */
  aliases: string[];
  sources: StudyConceptSource[];
  /** A subtopic's topic; null for everything else. */
  parentId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyConceptSchema = new Schema<IStudyConcept>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    label: { type: String, required: true },
    norm: { type: String, required: true },
    aliases: { type: [String], default: [] },
    sources: { type: [String], enum: STUDY_CONCEPT_SOURCES, default: [] },
    parentId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

StudyConceptSchema.index({ userId: 1, classId: 1, norm: 1 }, { unique: true });

export const StudyConcept = mongoose.model<IStudyConcept>("StudyConcept", StudyConceptSchema, "study_concepts");

/** One right/wrong signal against a concept (`study_concept_evidence`). Append-only. */
export interface IStudyConceptEvidence {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  conceptId: Types.ObjectId;
  kind: StudyConceptEvidenceKind;
  /** 0 = wrong … 1 = right. */
  result: number;
  /** What produced it (a question, an exam, a concept-map attempt), when known. */
  refId: string | null;
  at: Date;
}

const StudyConceptEvidenceSchema = new Schema<IStudyConceptEvidence>({
  userId: { type: Schema.Types.ObjectId, required: true },
  classId: { type: Schema.Types.ObjectId, required: true },
  conceptId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: STUDY_CONCEPT_EVIDENCE_KINDS, required: true },
  result: { type: Number, min: 0, max: 1, required: true },
  refId: { type: String, default: null },
  at: { type: Date, default: () => new Date() },
});

StudyConceptEvidenceSchema.index({ userId: 1, classId: 1, conceptId: 1, at: -1 });

export const StudyConceptEvidence = mongoose.model<IStudyConceptEvidence>("StudyConceptEvidence", StudyConceptEvidenceSchema, "study_concept_evidence");
