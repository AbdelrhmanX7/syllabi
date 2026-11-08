import mongoose, { Schema, Types } from "mongoose";

/**
 * Sharing (docs/accounts.md, "Sharing and collaboration"). One row per shared resource of one owner.
 *
 * Resources (no clean model exists for two of them, so they are scoped queries):
 *   notebook    one StudyPage row (board JSON in object storage)          resourceId = page id
 *   deck        flashcard-tagged StudyQuestion rows of a class (+ topic)  resourceId = class id, topic
 *   questions   the other StudyQuestion rows of a class (+ topic)         resourceId = class id, topic
 *   conceptMap  one StudyConceptMap row                                   resourceId = map id
 *
 * Roles: phase 1 hands out only "viewer"; the enum already has "editor" for phase 2 (edits together),
 * so adding it is an API change, not a migration. The link token is 32 random bytes (base64url),
 * stored as is so the owner can copy the link again; turning the link off and on makes a new one.
 *
 * Collection `shares` (not `study_*`): the account-deletion sweep keys study rows by `userId`;
 * shares are keyed by `ownerId` and cleaned up explicitly (services/share/access.ts deleteSharesOf).
 */
export const SHARE_RESOURCE_TYPES = ["notebook", "deck", "questions", "conceptMap"] as const;
export type ShareResourceType = (typeof SHARE_RESOURCE_TYPES)[number];
export const SHARE_ROLES = ["viewer", "editor"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export interface IShareGrant {
  userId: Types.ObjectId | null;
  email: string;
  role: ShareRole;
  addedAt: Date;
}

export interface IShare {
  _id: Types.ObjectId;
  resourceType: ShareResourceType;
  resourceId: Types.ObjectId;
  /** deck / questions: the topic inside the class; null = the whole class. Always null otherwise. */
  topic: string | null;
  ownerId: Types.ObjectId;
  /** Cached for "Shared with me" (refreshed on every owner write and view). */
  title: string;
  grants: IShareGrant[];
  link: { token: string; role: ShareRole } | null;
  createdAt: Date;
  updatedAt: Date;
}

const ShareSchema = new Schema<IShare>(
  {
    resourceType: { type: String, enum: SHARE_RESOURCE_TYPES, required: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    topic: { type: String, default: null },
    ownerId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, default: "" },
    grants: {
      type: [
        new Schema(
          {
            userId: { type: Schema.Types.ObjectId, default: null },
            email: { type: String, required: true, lowercase: true, trim: true },
            role: { type: String, enum: SHARE_ROLES, default: "viewer" },
            addedAt: { type: Date, default: () => new Date() },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    link: {
      type: new Schema({ token: { type: String, required: true }, role: { type: String, enum: SHARE_ROLES, default: "viewer" } }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true }
);

ShareSchema.index({ ownerId: 1, resourceType: 1, resourceId: 1, topic: 1 }, { unique: true });
ShareSchema.index({ "grants.userId": 1 });
ShareSchema.index({ "grants.email": 1 });
// Partial, not sparse: an explicit null would still be indexed by a sparse unique index.
ShareSchema.index({ "link.token": 1 }, { unique: true, partialFilterExpression: { "link.token": { $type: "string" } } });

export const Share = mongoose.model<IShare>("Share", ShareSchema, "shares");

/**
 * Where a forked copy came from. `study_*` + `userId`, so deleting the account sweeps it.
 * resourceId (+ topic) is the NEW resource in the caller's account.
 */
export interface IShareFork {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  resourceType: ShareResourceType;
  resourceId: Types.ObjectId;
  topic: string | null;
  forkedFrom: { shareId: Types.ObjectId; ownerName: string; title: string; resourceType: ShareResourceType; resourceId: Types.ObjectId };
  createdAt: Date;
}

const ShareForkSchema = new Schema<IShareFork>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    resourceType: { type: String, enum: SHARE_RESOURCE_TYPES, required: true },
    resourceId: { type: Schema.Types.ObjectId, required: true },
    topic: { type: String, default: null },
    forkedFrom: {
      shareId: { type: Schema.Types.ObjectId, required: true },
      ownerName: { type: String, default: "" },
      title: { type: String, default: "" },
      resourceType: { type: String, enum: SHARE_RESOURCE_TYPES, required: true },
      resourceId: { type: Schema.Types.ObjectId, required: true },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ShareForkSchema.index({ userId: 1, resourceType: 1, resourceId: 1 });

export const ShareFork = mongoose.model<IShareFork>("ShareFork", ShareForkSchema, "study_share_forks");
