import mongoose, { Schema, Types } from "mongoose";
import { EditedBySchema, IEditedBy } from "@/models/share";

export const STUDY_PAGE_KINDS = ["note", "pdf", "lecture", "solve"] as const;
export type StudyPageKind = (typeof STUDY_PAGE_KINDS)[number];

/**
 * One board page rendered to an image by the client after a sync (ink over its PDF/paper
 * background — only the device has the background), so the MCP can SHOW Claude the page.
 * `index` is 0-based into the board's page array; `version` is the content version it reflects.
 */
export interface IStudyPageRender {
  index: number;
  boardPageId: string | null;
  key: string;
  /** Client-chosen, opaque; echoed back so the client can skip unchanged pages. */
  hash: string;
  version: number;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  renderedAt: Date;
}

/** Feedback an AI agent left on a board page (MCP annotate_notebook_page). `page` is 1-based. */
export interface IStudyPageAnnotation {
  _id: Types.ObjectId;
  page: number;
  markdown: string;
  author: "claude";
  createdAt: Date;
}

export interface IPageVersionEntry {
  version: number;
  userId: Types.ObjectId;
  name: string;
  at: Date;
  /** Set when this version restored an earlier one. */
  restoredFrom?: number | null;
  /** Where this version's board is stored, when not the usual `v<n>.json` (written without the cross-fork lock). */
  key?: string | null;
}
export const PAGE_VERSION_LOG_MAX = 100;

export const STUDY_GROUND_UNITS = ["ft", "m", "km", "mi"] as const;
export type StudyGroundUnit = (typeof STUDY_GROUND_UNITS)[number];

/**
 * How the owner's on-screen ruler opens on one board page (services/study/page-ruler.ts).
 * Lengths are paper mm; `zeroAt` is measured from the page's top-left.
 */
export interface IStudyPageRuler {
  /** Tick-spacing multiplier over paper scale (3.7795 board units/mm), 0.2..10. */
  pageFactor?: number;
  angleDeg?: number;
  zeroAt?: { xMm: number; yMm: number };
  /** N of 1:N. */
  mapScale?: number;
  groundUnit?: StudyGroundUnit;
  setBy: "claude" | "user";
  updatedAt: Date;
}

/**
 * A handwritten notebook page. The board JSON itself lives in object storage at
 * `study/<userId>/pages/<pageId>/v<version>.json` (services/study/storage.ts) — this row only
 * points at the CURRENT version. Versions are written by presigned PUT and made current by
 * the commit endpoint, never overwritten in place by the BE, and never deleted (storage lifecycle
 * fuse). `DELETE` is a soft delete (`deletedAt`), so a mistaken delete is recoverable.
 */
export interface IStudyPage {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  classId: Types.ObjectId | null;
  /** Annotating a Canvas file item. */
  itemId: Types.ObjectId | null;
  /** The lecture this page was written during (P3; `POST /study/pages {lectureId}`). */
  lectureId: Types.ObjectId | null;
  title: string;
  kind: StudyPageKind;
  /** 0 = nothing committed yet. */
  version: number;
  /** Storage key of the current version; null before the first commit. */
  contentKey: string | null;
  /** Handwriting OCR text the client sends (PUT /study/pages/:id/ocr) — feeds search + extract. */
  ocrText: string | null;
  ocrUpdatedAt: Date | null;
  thumbUrl: string | null;
  /** Course week 1..30 (organisation metadata; PATCH /study/pages/:id). */
  week: number | null;
  /** An owned StudyModule of this page's class. */
  moduleId: Types.ObjectId | null;
  /** The recorded lecture this page belongs to: client-built key (e.g. "bio101-2026-10-05"), date YYYY-MM-DD. */
  lecture: { number: number | null; key: string; date: string } | null;
  /** Client page renders (PUT /study/pages/:id/renders/:index). Never moves `updatedAt`. */
  renders: IStudyPageRender[];
  /** Board page count at the last render commit; null = never committed. */
  rendersPageCount: number | null;
  /** Content version of the last render commit; an older commit is refused (two devices). */
  rendersCommitVersion: number | null;
  annotations: IStudyPageAnnotation[];
  /** Ruler presets keyed by 1-based board page number ("1", "2", …). */
  rulers?: Record<string, IStudyPageRuler>;
  /** Who committed the current version (sharing: an editor, or the owner). null = before authors were recorded. */
  editedBy?: IEditedBy | null;
  /**
   * Author of each recent version (newest last, at most PAGE_VERSION_LOG_MAX). Versions are immutable
   * objects in storage, so this log is how "Earlier versions" says who wrote which one.
   */
  versionLog?: IPageVersionEntry[];
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const StudyPageSchema = new Schema<IStudyPage>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    classId: { type: Schema.Types.ObjectId, default: null },
    itemId: { type: Schema.Types.ObjectId, default: null },
    lectureId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, default: "" },
    kind: { type: String, enum: STUDY_PAGE_KINDS, required: true },
    version: { type: Number, default: 0 },
    contentKey: { type: String, default: null },
    ocrText: { type: String, default: null },
    ocrUpdatedAt: { type: Date, default: null },
    thumbUrl: { type: String, default: null },
    week: { type: Number, default: null },
    moduleId: { type: Schema.Types.ObjectId, default: null },
    lecture: {
      type: new Schema({ number: { type: Number, default: null }, key: { type: String, required: true }, date: { type: String, required: true } }, { _id: false }),
      default: null,
    },
    renders: {
      type: [
        new Schema(
          {
            index: { type: Number, required: true },
            boardPageId: { type: String, default: null },
            key: { type: String, required: true },
            hash: { type: String, required: true },
            version: { type: Number, required: true },
            width: { type: Number, required: true },
            height: { type: Number, required: true },
            mime: { type: String, required: true },
            bytes: { type: Number, required: true },
            renderedAt: { type: Date, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    rendersPageCount: { type: Number, default: null },
    rendersCommitVersion: { type: Number, default: null },
    annotations: {
      type: [
        new Schema({
          page: { type: Number, required: true },
          markdown: { type: String, required: true },
          author: { type: String, enum: ["claude"], default: "claude" },
          createdAt: { type: Date, default: () => new Date() },
        }),
      ],
      default: [],
    },
    rulers: {
      type: Map,
      of: new Schema(
        {
          pageFactor: { type: Number },
          angleDeg: { type: Number },
          zeroAt: { type: new Schema({ xMm: { type: Number, required: true }, yMm: { type: Number, required: true } }, { _id: false }) },
          mapScale: { type: Number },
          groundUnit: { type: String, enum: STUDY_GROUND_UNITS },
          setBy: { type: String, enum: ["claude", "user"], required: true },
          updatedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
    editedBy: { type: EditedBySchema, default: null },
    versionLog: {
      type: [
        new Schema(
          {
            version: { type: Number, required: true },
            userId: { type: Schema.Types.ObjectId, required: true },
            name: { type: String, default: "" },
            at: { type: Date, required: true },
            restoredFrom: { type: Number, default: null },
            key: { type: String, default: null },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

StudyPageSchema.index({ userId: 1, classId: 1, updatedAt: -1 });
StudyPageSchema.index({ userId: 1, itemId: 1 });
StudyPageSchema.index({ userId: 1, lectureId: 1 });
StudyPageSchema.index({ userId: 1, classId: 1, week: 1 });
StudyPageSchema.index({ userId: 1, "lecture.key": 1 });

export const StudyPage = mongoose.model<IStudyPage>("StudyPage", StudyPageSchema, "study_pages");
