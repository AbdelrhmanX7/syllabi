import mongoose, { Schema, Types } from "mongoose";

/**
 * Study app perf telemetry (POST /study/telemetry/perf). One row per client batch; the
 * events are stored exactly as sent. `t` is SERVER receipt time — the TTL field, so a
 * skewed device clock can neither expire a batch instantly nor keep it forever.
 */
export const PERF_SCHEMA = "study-perf/v1";
export const PERF_KINDS = ["loaf", "longtask", "event", "gesture", "gsum", "error", "pen", "span", "nav", "mem"] as const;
export const PERF_TTL_SEC = 30 * 24 * 3600;

export interface IStudyPerfBatch {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  batchId: string;
  session: string;
  sentAt: unknown;
  device: { id: string } & Record<string, unknown>;
  app: Record<string, unknown> | null;
  dropped: number;
  events: Array<{ k: string; t: number } & Record<string, unknown>>;
  /** Events dropped server-side (unknown `k` or non-numeric `t`) — the rest of the batch is kept. */
  rejectedEvents: number;
  bytes: number;
  t: Date;
}

const StudyPerfBatchSchema = new Schema<IStudyPerfBatch>(
  {
    user: { type: Schema.Types.ObjectId, required: true },
    batchId: { type: String, required: true },
    session: { type: String, default: "" },
    sentAt: { type: Schema.Types.Mixed, default: null },
    device: { type: Schema.Types.Mixed, required: true },
    app: { type: Schema.Types.Mixed, default: null },
    dropped: { type: Number, default: 0 },
    events: { type: [Schema.Types.Mixed] as any, default: [] },
    rejectedEvents: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
    t: { type: Date, required: true },
  },
  { versionKey: false, minimize: false }
);
StudyPerfBatchSchema.index({ user: 1, batchId: 1 }, { unique: true });
StudyPerfBatchSchema.index({ user: 1, "device.id": 1, t: -1 });
StudyPerfBatchSchema.index({ t: -1 }, { expireAfterSeconds: PERF_TTL_SEC });

export const StudyPerfBatch = mongoose.model<IStudyPerfBatch>("StudyPerfBatch", StudyPerfBatchSchema, "study_perf_batches");

/** Fixed-window quota counters (`key` = "h:<hour>" | "d:<day>"); TTL'd past their window. */
export interface IStudyPerfQuota {
  user: Types.ObjectId;
  key: string;
  count: number;
  bytes: number;
  expireAt: Date;
}

const StudyPerfQuotaSchema = new Schema<IStudyPerfQuota>(
  {
    user: { type: Schema.Types.ObjectId, required: true },
    key: { type: String, required: true },
    count: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
    expireAt: { type: Date, required: true },
  },
  { versionKey: false }
);
StudyPerfQuotaSchema.index({ user: 1, key: 1 }, { unique: true });
StudyPerfQuotaSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const StudyPerfQuota = mongoose.model<IStudyPerfQuota>("StudyPerfQuota", StudyPerfQuotaSchema, "study_perf_quotas");
