import mongoose, { Schema, Types } from "mongoose";

export const STUDY_AI_ENDPOINTS = ["extract", "attempt", "similar", "flashcards", "transcribe", "lecture", "code_review", "mcp_explain", "mcp_plan", "concept_map_grade", "concept_map_predict", "concept_map_reference", "concept_map_short_answers", "concept_map_notes", "concept_map_terms", "concept_map_from_terms", "policy", "digest", "a_plan", "ask", "ask_vision", "board_actions", "ink_classify", "dictate", "image_gen", "page_describe", "page_cover"] as const;
export type StudyAiEndpoint = (typeof STUDY_AI_ENDPOINTS)[number];

/**
 * One row per study AI call (extract / attempt / similar / flashcards) or background job
 * (transcribe = a video transcript, lecture = a lecture run), written when it settles —
 * the same audit shape as `whiteboard-ai-usages`, kept in the study module's own collection.
 */
export interface IStudyAiUsage {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  endpoint: StudyAiEndpoint;
  questionId: Types.ObjectId | null;
  itemId: Types.ObjectId | null;
  lectureId: Types.ObjectId | null;
  status: "done" | "error" | "stopped";
  error: string | null;
  /** Machine code of the failure (AI_QUOTA, AI_FAILED, …); null on success. */
  errorCode?: string | null;
  models: string[];
  visionCostUsd: number;
  textCostUsd: number;
  audioCostUsd: number;
  /** image_gen: OpenRouter-reported image generation cost. */
  imageCostUsd: number;
  costUsd: number;
  latencyMs: number;
  /** ink_classify: lines sent upstream (never the text). */
  lineCount?: number;
  createdAt: Date;
}

const StudyAiUsageSchema = new Schema<IStudyAiUsage>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    endpoint: { type: String, enum: STUDY_AI_ENDPOINTS, required: true },
    questionId: { type: Schema.Types.ObjectId, default: null },
    itemId: { type: Schema.Types.ObjectId, default: null },
    lectureId: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: ["done", "error", "stopped"], required: true },
    error: { type: String, default: null, maxlength: 500 },
    errorCode: { type: String, default: null },
    models: { type: [String], default: [] },
    visionCostUsd: { type: Number, default: 0 },
    textCostUsd: { type: Number, default: 0 },
    audioCostUsd: { type: Number, default: 0 },
    imageCostUsd: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
    lineCount: { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

StudyAiUsageSchema.index({ userId: 1, createdAt: -1 });

export const StudyAiUsage = mongoose.model<IStudyAiUsage>("StudyAiUsage", StudyAiUsageSchema, "study_ai_usages");
