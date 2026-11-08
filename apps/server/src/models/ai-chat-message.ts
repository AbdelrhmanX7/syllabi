import mongoose, { Schema, Document } from "mongoose";

export type AiChatMessageStatus = "streaming" | "done" | "stopped" | "error";
export type AiChatRole = "user" | "assistant";
export type AiChatFeedbackRating = "up" | "down";

export interface AiChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  reasoning_tokens?: number;
}

export interface AiChatGeneration {
  content: string;
  status: AiChatMessageStatus;
  /** When this generation finished. Immune to later writes, unlike `updatedAt`. */
  completedAt?: Date | null;
  error?: string | null;
  model?: string | null;
  usage?: AiChatUsage | null;
  finishReason?: string | null;
  latencyMs?: number | null;
  /** The replaced generation's own trace. Absent on a persona answer, which has none. */
  reasoning?: string | null;
  steps?: AiChatStep[];
  solver?: AiChatSolver | null;
  solverRuns?: AiChatSolverRun[];
  createdAt: Date;
  replacedAt: Date;
}

// `model` is a field on this schema, but `Document` declares an inherited
// `model()` method of the same name — extend `Omit<Document, "model">` so the
// field wins in the type without touching the actual Mongoose instance, which
// exposes `model` as a plain property (Mongoose documents shadow the method
// with the schema path at runtime).
/** One tool step of a solver run (PR B); the persona path has none. Mirrors the SSE tool-call/tool-result pair. */
export interface AiChatStep {
  id: string;
  name: string;
  label: string;
  args?: unknown;
  ok: boolean;
  summary: string;
  citations?: Array<{ bookLabel: string; page: number }>;
  ms?: number | null;
  startedAt: Date;
}

/** The physics solver's machine-readable verdict (PR B). Null on the persona path. */
export interface AiChatSolver {
  letter: string;
  value: string;
  decline: boolean;
  confidence: number;
  citations: Array<{ bookLabel: string; page: number }>;
  toolsUsed: string[];
  costUsd: number;
  turns: number;
  error: string;
  /**
   * What the solver attempt itself spent. Kept HERE and not folded into the row's `usage`,
   * because a declined run hands the turn to the persona, whose usage then owns that field —
   * the attempt was still billed, and the cost views add both.
   */
  usage?: AiChatUsage | null;
  /**
   * The model ladder this answer came off, cheapest first. Length 1 when tier 1 was
   * enough. Set on a SINGLE-question turn only: a page's aggregate has no one ladder,
   * for the same reason its `letter` is empty — every question climbed its own, and the
   * per-question ladders live in `solverRuns[].tiers`.
   */
  tiers?: AiChatSolverTier[];
  /** True when the cheap tier's answer was not the one returned. */
  escalated?: boolean;
}

/**
 * One rung of the model cascade, as the row records it.
 *
 * A mirror of the agent's `TierRecord` and deliberately NOT an import of it: this is a
 * STORED shape, and a field the agent renames later must not silently change what a
 * year-old row is read as. Jev's own forced-choice answer is left out — it is never shown
 * to anybody, and it is not what answered.
 *
 * ABSENT on every row written before the cascade shipped. A reader must treat missing as
 * "unknown", never as "no model ran".
 */
export interface AiChatSolverTier {
  model: string;
  provider: string;
  letter: string;
  value: string;
  decline: boolean;
  confidence: number;
  costUsd: number;
  ms: number;
  error: string;
  /** Why the ladder climbed PAST this tier. Null on the tier that answered. */
  reason?: string | null;
}

/**
 * ONE question's run when a whole photographed page was solved.
 *
 * The row's `solver` is the page's aggregate (and, on a single-question page, still the run
 * itself). Without this array a page of twelve questions recorded one confidence, one cost
 * and one union of citations — and nothing could say WHICH question declined.
 */
export interface AiChatSolverRun {
  /** The question's number for this TURN — global across every page the student sent. */
  question: number | string;
  /** What that page actually printed beside it, kept even when the turn renumbered it. */
  printedNumber?: string | null;
  /** Which attachment it came from, 1-based. Null on a single-page turn. */
  page?: number | null;
  letter: string;
  value: string;
  decline: boolean;
  confidence: number;
  citations: Array<{ bookLabel: string; page: number }>;
  toolsUsed: string[];
  costUsd: number;
  turns: number;
  ms: number;
  error: string;
  /** This question's model ladder, cheapest first. Absent on rows written before it existed. */
  tiers?: AiChatSolverTier[];
  /** True when this question's answer came from an escalation rather than tier 1. */
  escalated?: boolean;
}

/**
 * A file that rides a USER message. Denormalised from `AiChatUpload` on purpose: the
 * thread must still render an attachment whose upload row was cleaned up later.
 */
export interface AiChatAttachment {
  id: string;
  kind: "image" | "pdf";
  name: string;
  url: string;
  thumbUrl?: string | null;
  width?: number | null;
  height?: number | null;
  pages?: number | null;
}

export interface IAiChatMessage extends Omit<Document, "model"> {
  conversationId: mongoose.Types.ObjectId;
  visitorId: string;
  role: AiChatRole;
  content: string;
  status: AiChatMessageStatus;
  error: string | null;
  clientMessageId?: string;
  replyToMessageId: mongoose.Types.ObjectId | null;
  feedback: AiChatFeedbackRating | null;
  model: string | null;
  usage: AiChatUsage | null;
  finishReason: string | null;
  latencyMs: number | null;
  /**
   * The instant this answer finished streaming, stamped once by the chat controller's
   * `finalize`. `updatedAt` cannot serve: a feedback vote rewrites it, which moved a turn's
   * recorded spend onto whatever day someone clicked. Null on rows written before this field.
   */
  completedAt: Date | null;
  history: AiChatGeneration[];
  /** Full model thinking (DeepSeek reasoning_content), capped at 8k chars. */
  reasoning: string | null;
  steps: AiChatStep[];
  solver: AiChatSolver | null;
  /** One entry per question answered this turn. Length 1 on an ordinary single question. */
  solverRuns: AiChatSolverRun[];
  scope: { phase: string; subject: string | null } | null;
  /** User rows only. Empty on assistant rows. */
  attachments: AiChatAttachment[];
  /**
   * USD actually spent reading this turn's attachments, summed over them once they have been
   * understood. Unlike every other cost in this product it is STORED, not derived: the crop
   * readers are paid per call and the provider returns the real price, which no rate table
   * here could reproduce. Zero on a turn with no attachments, and on files read by Gemini.
   */
  attachmentsCostUsd: number;
  /**
   * The user turn AS THE MODEL SAW IT — the typed message plus the attachment transcripts.
   * Null when there was nothing to add, which is almost every row.
   *
   * It exists because history is replayed from stored rows: a follow-up like "solve part b"
   * two turns after a photo would otherwise reach the model with the photo's turn reduced to
   * the six words the student typed, and the model would answer about nothing. Kept separate
   * from `content` so the thread still renders what the student actually wrote.
   */
  modelContent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const UsageSchema = new Schema<AiChatUsage>(
  {
    prompt_tokens: Number,
    completion_tokens: Number,
    prompt_cache_hit_tokens: Number,
    prompt_cache_miss_tokens: Number,
    reasoning_tokens: Number,
  },
  { _id: false }
);

const StepSchema = new Schema<AiChatStep>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    label: { type: String, default: "" },
    args: { type: Schema.Types.Mixed, default: null },
    ok: { type: Boolean, default: true },
    summary: { type: String, default: "" },
    citations: { type: [new Schema({ bookLabel: String, page: Number }, { _id: false })], default: undefined },
    ms: { type: Number, default: null },
    startedAt: { type: Date, required: true },
  },
  { _id: false }
);

const AttachmentSchema = new Schema<AiChatAttachment>(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: ["image", "pdf"], required: true },
    name: { type: String, default: "" },
    url: { type: String, default: "" },
    thumbUrl: { type: String, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    pages: { type: Number, default: null },
  },
  { _id: false }
);

const CitationSchema = new Schema({ bookLabel: String, page: Number }, { _id: false });

/**
 * `default: undefined` on both tier arrays, never `[]`: a row written before the cascade
 * shipped must read back as "we do not know what ran", and a stored empty array would
 * claim — wrongly — that no model did.
 */
const SolverTierSchema = new Schema<AiChatSolverTier>(
  {
    model: { type: String, default: "" },
    provider: { type: String, default: "" },
    letter: { type: String, default: "" },
    value: { type: String, default: "" },
    decline: { type: Boolean, default: false },
    confidence: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    ms: { type: Number, default: 0 },
    error: { type: String, default: "" },
    reason: { type: String, default: null },
  },
  { _id: false }
);

const SolverSchema = new Schema<AiChatSolver>(
  {
    letter: { type: String, default: "" },
    value: { type: String, default: "" },
    decline: { type: Boolean, default: false },
    confidence: { type: Number, default: 0 },
    citations: { type: [CitationSchema], default: [] },
    toolsUsed: { type: [String], default: [] },
    costUsd: { type: Number, default: 0 },
    turns: { type: Number, default: 0 },
    error: { type: String, default: "" },
    usage: { type: UsageSchema, default: null },
    tiers: { type: [SolverTierSchema], default: undefined },
    escalated: { type: Boolean, default: undefined },
  },
  { _id: false }
);

const SolverRunSchema = new Schema<AiChatSolverRun>(
  {
    question: { type: Schema.Types.Mixed, required: true },
    printedNumber: { type: String, default: null },
    page: { type: Number, default: null },
    letter: { type: String, default: "" },
    value: { type: String, default: "" },
    decline: { type: Boolean, default: false },
    confidence: { type: Number, default: 0 },
    citations: { type: [CitationSchema], default: [] },
    toolsUsed: { type: [String], default: [] },
    costUsd: { type: Number, default: 0 },
    turns: { type: Number, default: 0 },
    ms: { type: Number, default: 0 },
    error: { type: String, default: "" },
    tiers: { type: [SolverTierSchema], default: undefined },
    escalated: { type: Boolean, default: undefined },
  },
  { _id: false }
);

const GenerationSchema = new Schema<AiChatGeneration>(
  {
    content: { type: String, default: "" },
    status: { type: String, enum: ["streaming", "done", "stopped", "error"], required: true },
    completedAt: { type: Date, default: null },
    error: { type: String, default: null },
    model: { type: String, default: null },
    usage: { type: UsageSchema, default: null },
    finishReason: { type: String, default: null },
    latencyMs: { type: Number, default: null },
    // A regenerated solver answer keeps its own trace and cost: dropping them would make the
    // replaced run unauditable, and its spend would disappear from the record entirely.
    reasoning: { type: String, default: null },
    steps: { type: [StepSchema], default: undefined },
    solver: { type: SolverSchema, default: null },
    solverRuns: { type: [SolverRunSchema], default: undefined },
    createdAt: { type: Date, required: true },
    replacedAt: { type: Date, required: true },
  },
  { _id: false }
);

const AiChatMessageSchema = new Schema<IAiChatMessage>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "AiChatConversation", required: true },
    visitorId: { type: String, required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, default: "" },
    // user rows are always "done"; the controller sets it explicitly. Assistant rows start streaming.
    status: { type: String, enum: ["streaming", "done", "stopped", "error"], default: "streaming" },
    error: { type: String, default: null },
    clientMessageId: { type: String },
    replyToMessageId: { type: Schema.Types.ObjectId, ref: "AiChatMessage", default: null },
    feedback: { type: String, enum: ["up", "down", null], default: null },
    model: { type: String, default: null },
    usage: { type: UsageSchema, default: null },
    finishReason: { type: String, default: null },
    latencyMs: { type: Number, default: null },
    completedAt: { type: Date, default: null },
    history: { type: [GenerationSchema], default: [] },
    reasoning: { type: String, default: null },
    steps: { type: [StepSchema], default: [] },
    solver: { type: SolverSchema, default: null },
    solverRuns: { type: [SolverRunSchema], default: [] },
    scope: { type: new Schema({ phase: { type: String, required: true }, subject: { type: String, default: null } }, { _id: false }), default: null },
    attachments: { type: [AttachmentSchema], default: [] },
    attachmentsCostUsd: { type: Number, default: 0 },
    modelContent: { type: String, default: null },
  },
  { timestamps: true }
);
AiChatMessageSchema.index({ conversationId: 1, createdAt: 1 });
AiChatMessageSchema.index({ visitorId: 1, createdAt: -1 });
// Idempotency key for user messages only — assistant rows carry no clientMessageId.
AiChatMessageSchema.index(
  { conversationId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $exists: true } } }
);

// One assistant row per user message: regenerate reuses the row, and a concurrent orphan
// heal must lose here (E11000) rather than stream — and bill — a second answer.
AiChatMessageSchema.index(
  { replyToMessageId: 1 },
  { unique: true, partialFilterExpression: { role: "assistant", replyToMessageId: { $type: "objectId" } } }
);

export const AiChatMessage = mongoose.model<IAiChatMessage>("AiChatMessage", AiChatMessageSchema);
