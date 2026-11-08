import mongoose, { Schema, Types } from "mongoose";

export const DIGEST_TAGS = ["exam", "deadline-change", "emphasis", "policy", "resource"] as const;
export type DigestTag = (typeof DIGEST_TAGS)[number];

/** How a deadline change named in an announcement was matched to a class item. */
export interface DigestDeadlineChange {
  itemTitle: string;
  /** The model's local-time string ("2026-10-05" or "2026-10-05T23:59"), resolved against the course zone. */
  rawDue: string | null;
  newDueAt: Date | null;
  matchedItemId: Types.ObjectId | null;
  confidence: number;
  /** applied = effectiveDueAt set; already_in_canvas = Canvas shows that date; low_confidence / no_date / canvas_moved = not applied. */
  outcome: "applied" | "already_in_canvas" | "low_confidence" | "no_date" | "canvas_moved";
}

/**
 * One AI digest per announcement, cached by `version` (hash of the announcement's posted time,
 * title and body — Canvas announcements carry no `updated_at`, so an edit shows up as a body change).
 */
export interface IStudyAnnouncementDigest {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId;
  itemId: Types.ObjectId;
  version: string;
  postedAt: Date | null;
  title: string;
  summary: string;
  actions: { text: string; dueAt: Date | null }[];
  importance: "high" | "normal";
  tags: DigestTag[];
  emphasis: { text: string; exam: string | null }[];
  deadlineChanges: DigestDeadlineChange[];
  createdAt: Date;
  updatedAt: Date;
}

const StudyAnnouncementDigestSchema = new Schema<IStudyAnnouncementDigest>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, required: true },
    itemId: { type: Schema.Types.ObjectId, required: true },
    version: { type: String, required: true },
    postedAt: { type: Date, default: null },
    title: { type: String, default: "" },
    summary: { type: String, default: "" },
    actions: { type: [{ text: String, dueAt: { type: Date, default: null }, _id: false }], default: [] },
    importance: { type: String, enum: ["high", "normal"], default: "normal" },
    tags: { type: [{ type: String, enum: DIGEST_TAGS }], default: [] },
    emphasis: { type: [{ text: String, exam: { type: String, default: null }, _id: false }], default: [] },
    deadlineChanges: {
      type: [
        {
          itemTitle: String,
          rawDue: { type: String, default: null },
          newDueAt: { type: Date, default: null },
          matchedItemId: { type: Schema.Types.ObjectId, default: null },
          confidence: Number,
          outcome: { type: String, enum: ["applied", "already_in_canvas", "low_confidence", "no_date", "canvas_moved"] },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

StudyAnnouncementDigestSchema.index({ userId: 1, itemId: 1 }, { unique: true });
StudyAnnouncementDigestSchema.index({ userId: 1, classId: 1, postedAt: -1 });

export const StudyAnnouncementDigest = mongoose.model<IStudyAnnouncementDigest>(
  "StudyAnnouncementDigest",
  StudyAnnouncementDigestSchema,
  "study_announcement_digests"
);
