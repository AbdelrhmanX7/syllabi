import { mmToBoardPx, boardPxToMm } from './paperSpacing';

import type { StrokeSettings } from '../types';

/**
 * Pen sizes in real millimetres, like a 0.5 mm or 0.7 mm pen.
 *
 * `StrokeSettings.width` stays in board px (the unit every brush, saved stroke and export already
 * uses); millimetres live only in the picker. The scale is the paper's, never the screen's: the same
 * fixed 96 dpi board scale the paper ruling, the PDF export and the server's mm drawings use
 * (`BOARD_PX_PER_MM`), so a 0.5 mm line is 0.5 mm on the page at 100 % zoom and grows with zoom like
 * every other stroke. The plain pen draws exactly this width; brush, marker and script apply their own
 * nib scale on top, as they always have.
 */
export const PEN_SIZES_MM = [0.3, 0.5, 0.7, 1, 1.5, 2] as const;
/** The highlighter's own sizes (a chisel tip is much wider than a pen). */
export const HIGHLIGHTER_SIZES_MM = [3, 4, 6, 8] as const;

export const penMmToPx = (mm: number): number => mmToBoardPx(mm);
export const penPxToMm = (px: number): number => boardPxToMm(px);

/** Width a pen had before sizes existed (4 px ≈ 1.06 mm), so a new device keeps the old look. */
export const LEGACY_DEFAULT_PEN_WIDTH_PX = 4;
export const DEFAULT_PEN_SIZE_MM = nearestSizeMm(LEGACY_DEFAULT_PEN_WIDTH_PX, PEN_SIZES_MM);
/** The highlighter used to be max(pen width × 4, 24) px: 24 px ≈ 6.35 mm at the default pen. */
export const DEFAULT_HIGHLIGHTER_SIZE_MM = 6;

/** The size in `sizes` closest to `px` (board px). */
export function nearestSizeMm(px: number, sizes: readonly number[]): number {
  const mm = penPxToMm(px);
  let best = sizes[0]!;

  for (const size of sizes) {
    if (Math.abs(size - mm) < Math.abs(best - mm)) best = size;
  }

  return best;
}

/**
 * The chip to show as picked for a width: the nearest size, but only when the width is within
 * `tolerance` of it (relative). An older custom width (say 12 px) highlights no chip rather than
 * claiming a size it isn't.
 */
export function selectedSizeMm(px: number, sizes: readonly number[], tolerance = 0.12): number | null {
  if (!Number.isFinite(px) || px <= 0) return null;
  const best = nearestSizeMm(px, sizes);
  const bestPx = penMmToPx(best);

  return Math.abs(px - bestPx) / bestPx <= tolerance ? best : null;
}

/** "0.5", "1.0", "6" — pen sizes read like the number printed on a pen. */
export function formatSizeMm(mm: number): string {
  if (mm >= 3) return String(Math.round(mm * 10) / 10);

  return mm.toFixed(1);
}

/** The width the highlighter was drawn at before it had its own size. */
export const legacyHighlighterWidthPx = (penWidthPx: number): number => Math.max(penWidthPx * 4, 24);

/** The highlighter's width in board px: its own size, else exactly what it drew before sizes existed. */
export function highlighterWidthPx(settings: Pick<StrokeSettings, 'width' | 'highlighterWidth'>): number {
  const own = settings.highlighterWidth;

  return typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : legacyHighlighterWidthPx(settings.width);
}

/** Bounds a stored highlighter width is kept within (board px). */
export const MIN_HIGHLIGHTER_WIDTH_PX = penMmToPx(1);
export const MAX_HIGHLIGHTER_WIDTH_PX = penMmToPx(20);

/** A stored highlighter width, or undefined when absent / unusable. */
export function normalizeHighlighterWidth(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;

  return Math.min(MAX_HIGHLIGHTER_WIDTH_PX, Math.max(MIN_HIGHLIGHTER_WIDTH_PX, value));
}
