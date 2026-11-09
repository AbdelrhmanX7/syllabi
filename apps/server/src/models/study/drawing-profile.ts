import mongoose, { Schema, Types } from "mongoose";

export const PEN_MODES = ["free", "hold", "always"] as const;
export type PenMode = (typeof PEN_MODES)[number];
export const CALIBRATION_SOURCES = ["card", "device", "fallback"] as const;
export type CalibrationSource = (typeof CALIBRATION_SOURCES)[number];

/**
 * The owner's drawing profile: the device + ruler calibration + page scale that let Claude give and
 * draw real-size diagrams. One row per user. The FE ruler PATCHes `calibration`; the Study MCP
 * (`get_drawing_profile`, `draw_on_notebook_page`) reads it. `guide` is markdown shown to Claude.
 */
export interface IStudyDrawingProfile {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  device: { name: string; diagonalIn: number; screenPx: [number, number]; ppi: number };
  calibration: { cssPxPerMm: number | null; source: CalibrationSource; updatedAt: Date | null };
  /** Board units per paper mm: 1 unit = 1 CSS px at zoom 1, paper at 96 dpi → 96/25.4. */
  pageUnitsPerMm: number;
  usablePageMm: { w: number; h: number };
  penModes: PenMode[];
  dashed: boolean;
  /** Notebook paper ruling in mm (Settings → Notebook paper), so Claude's PDFs and worksheets line up. */
  paper: { linedMm: number | null; gridMm: number | null };
  guide: string;
  createdAt: Date;
  updatedAt: Date;
}

const StudyDrawingProfileSchema = new Schema<IStudyDrawingProfile>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    device: {
      type: new Schema({ name: String, diagonalIn: Number, screenPx: [Number], ppi: Number }, { _id: false }),
      required: true,
    },
    calibration: {
      type: new Schema(
        { cssPxPerMm: { type: Number, default: null }, source: { type: String, enum: CALIBRATION_SOURCES, required: true }, updatedAt: { type: Date, default: null } },
        { _id: false }
      ),
      required: true,
    },
    pageUnitsPerMm: { type: Number, required: true },
    usablePageMm: { type: new Schema({ w: Number, h: Number }, { _id: false }), required: true },
    penModes: { type: [{ type: String, enum: PEN_MODES }], default: [...PEN_MODES] },
    dashed: { type: Boolean, default: false },
    paper: {
      type: new Schema({ linedMm: { type: Number, default: null }, gridMm: { type: Number, default: null } }, { _id: false }),
      default: () => ({ linedMm: null, gridMm: null }),
    },
    guide: { type: String, default: "" },
  },
  { timestamps: true }
);
StudyDrawingProfileSchema.index({ userId: 1 }, { unique: true });

export const StudyDrawingProfile = mongoose.model<IStudyDrawingProfile>("StudyDrawingProfile", StudyDrawingProfileSchema, "study_drawing_profiles");
