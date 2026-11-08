import mongoose, { Schema, Types } from "mongoose";

/**
 * "My handwriting" — the owner's handwriting glyph bank (per-user stroke JSON for each glyph).
 * One row per user. `bank` is the client's JSON, stored stringified (never a Buffer —
 * Buffer paths cannot hydrate). `version` is the optimistic-concurrency counter: every
 * write is a findOneAndUpdate conditioned on it, so two concurrent PUTs cannot both win.
 */
export interface IStudyGlyphBank {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  version: number;
  bank: string;
  bytes: number;
  createdAt: Date;
  updatedAt: Date;
}

const StudyGlyphBankSchema = new Schema<IStudyGlyphBank>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },
    bank: { type: String, required: true },
    bytes: { type: Number, required: true },
  },
  { timestamps: true }
);
StudyGlyphBankSchema.index({ userId: 1 }, { unique: true });

export const StudyGlyphBank = mongoose.model<IStudyGlyphBank>("StudyGlyphBank", StudyGlyphBankSchema, "study_glyph_banks");
