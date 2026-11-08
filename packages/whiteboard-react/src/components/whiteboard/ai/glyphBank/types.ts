/**
 * «My handwriting» glyph bank — the owner's own letters, captured as strokes. Shared contract between
 * the calibration sheet (capture) and compose (writing). Coordinates are NORMALISED per glyph:
 * x-height = 1, baseline at y = 0, y grows DOWN (canvas convention, so ascenders are negative),
 * x grows right. `entry` is where the pen comes in (left side), `exit` where it leaves (right side).
 * `advance` is the horizontal distance from entry to exit.
 */

export type GlyphForm = 'isol' | 'init' | 'medi' | 'fina';

/** [x, y, pressure 0..1] */
export type GlyphPoint = [number, number, number];

export interface GlyphSample {
  strokes: GlyphPoint[][];
  advance: number;
  entry: [number, number];
  exit: [number, number];
  bbox: { x: number; y: number; w: number; h: number };
  source: 'sheet' | 'passive';
  createdAt: number;
}

export interface GlyphEntry {
  key: GlyphKey;
  samples: GlyphSample[];
}

/**
 * Keys:
 * - `ar-dot:1` — the owner's dot (period, comma and colon are built from it; legacy key name).
 * - `digit:<char>` — 0-9.
 * - `lat:<char>` — a-z, A-Z.
 */
export type GlyphKey = string;

export interface GlyphBank {
  /** Bumped on every write (optimistic concurrency with the backend ETag). */
  version: number;
  updatedAt: number;
  glyphs: Record<GlyphKey, GlyphEntry>;
}

export const EMPTY_GLYPH_BANK: GlyphBank = { version: 0, updatedAt: 0, glyphs: {} };
