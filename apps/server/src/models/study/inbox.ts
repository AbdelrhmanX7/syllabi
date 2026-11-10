import mongoose, { Schema, Types } from "mongoose";

/**
 * Phone inbox: images/PDFs the owner sends from his phone to the Study app on his tablet.
 * services/study/inbox/* is the only writer.
 */

// ─── drop tokens (`sk_drop_…`) ──────────────────────────────────────────────────────────

export interface IStudyInboxToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  label: string;
  /** First chars of the token (`sk_drop_XXXXXXXX`) — shown in lists, and the lookup index. */
  prefix: string;
  /** sha256 hex of the whole token. The plaintext is never stored. */
  tokenHash: string;
  lastUsedAt: Date | null;
  /**
   * One-shot upload link (MCP `get_inbox_upload_link`): set ⇒ the token stops working at this time
   * AND after its first upload (`consumedAt`). Null = a permanent phone token. One-shot rows are
   * never listed and never count toward the per-user cap.
   */
  expiresAt: Date | null;
  consumedAt: Date | null;
  /** One-shot only: note/class/page bound at mint time, applied to the upload (not taken from the body). */
  note: string | null;
  classId: Types.ObjectId | null;
  pageId: Types.ObjectId | null;
  createdAt: Date;
}

const StudyInboxTokenSchema = new Schema<IStudyInboxToken>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    label: { type: String, required: true, maxlength: 100 },
    prefix: { type: String, required: true },
    tokenHash: { type: String, required: true },
    lastUsedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
    note: { type: String, default: null, maxlength: 500 },
    classId: { type: Schema.Types.ObjectId, default: null },
    pageId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
StudyInboxTokenSchema.index({ tokenHash: 1 }, { unique: true });
// Cleanup only — expiry is enforced in authenticateDropToken. A day of slack keeps used links inspectable.
StudyInboxTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });
StudyInboxTokenSchema.index({ prefix: 1 });
StudyInboxTokenSchema.index({ userId: 1, createdAt: -1 });

export const StudyInboxToken = mongoose.model<IStudyInboxToken>("StudyInboxToken", StudyInboxTokenSchema, "study_inbox_tokens");

// ─── inbox items ────────────────────────────────────────────────────────────────────────

export const INBOX_KINDS = ["image", "pdf"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface IStudyInboxItem {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  kind: InboxKind;
  /** `study/<userId>/inbox/<uuid>.<ext>` */
  key: string;
  contentType: string;
  thumbKey: string | null;
  thumbContentType: string | null;
  width: number | null;
  height: number | null;
  /** Bytes of the STORED object (after re-encoding). */
  bytes: number;
  note: string | null;
  classId: Types.ObjectId | null;
  /**
   * The notebook page this item is waiting to go on (MCP `add_inbox_to_page`, or a `pageId` bound to
   * the upload). The board JSON is the tablet's to write, so the BE only records the target: the
   * notebook appends the item when that page opens, then sets `usedAt`.
   */
  pageId: Types.ObjectId | null;
  /** Set when the tablet placed it somewhere (a page); null = still in the inbox. */
  usedAt: Date | null;
  /** Soft delete — the stored object is kept. */
  deletedAt: Date | null;
  /** The drop token that uploaded it; null = uploaded with the admin JWT. */
  tokenId: Types.ObjectId | null;
  /**
   * Where it came from (services/study/inbox/source.ts): phone | claude | codex | shared | upload | other.
   * Null on items made before the field existed (the app shows them as «Other»).
   */
  source: string | null;
  createdAt: Date;
}

const StudyInboxItemSchema = new Schema<IStudyInboxItem>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: INBOX_KINDS, required: true },
    key: { type: String, required: true },
    contentType: { type: String, required: true },
    thumbKey: { type: String, default: null },
    thumbContentType: { type: String, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    bytes: { type: Number, required: true },
    note: { type: String, default: null, maxlength: 500 },
    classId: { type: Schema.Types.ObjectId, default: null },
    pageId: { type: Schema.Types.ObjectId, default: null },
    usedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    tokenId: { type: Schema.Types.ObjectId, default: null },
    source: { type: String, default: null, maxlength: 20 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
StudyInboxItemSchema.index({ userId: 1, deletedAt: 1, createdAt: -1 });

export const StudyInboxItem = mongoose.model<IStudyInboxItem>("StudyInboxItem", StudyInboxItemSchema, "study_inbox_items");
