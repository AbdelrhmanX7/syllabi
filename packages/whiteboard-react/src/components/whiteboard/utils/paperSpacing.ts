import { GRID_SPACING_PRESETS, LINED_SPACING_PRESETS, normalizePaperSpacingMm } from '../types';

import type { BackgroundType, PaperSpacingPreset, WhiteboardPage } from '../types';

/**
 * Paper spacing (`WhiteboardPage.paperSpacingMm`): real-world millimetres → board units.
 *
 * The scale is FIXED, never the screen's, so a 7.1 mm college rule is the same rule on every device
 * and in every export. Two kinds of page, two scales the engine already uses:
 *
 * - A board page without a PDF (the infinite board, a plain notebook page): its units are Fabric
 *   scene px = CSS px, and the PDF export prints them at 96 dpi (`pdfExport`: 72/96 pt per px). So
 *   1 mm = 96 / 25.4 ≈ 3.78 board px. The pre-existing 30 px spacing is ≈ 7.9 mm on that scale.
 * - An inserted blank sheet in the continuous PDF layout: a page as wide as the PDF page it follows,
 *   which the layout guesses as A4 portrait (`DEFAULT_PDF_PAGE_ASPECT` = 297/210). Its width is taken
 *   as 210 mm, so 1 mm = pageWidth / 210 of the page — the rule keeps its place relative to the page
 *   (and to the ink on it) at any zoom and on any screen. The pre-existing pitch, width / 28, is 7.5 mm.
 *
 * Absent spacing keeps those pre-existing values, so every old page draws exactly what it drew.
 */

/** CSS px per mm at 96 dpi — the scale the board is exported at. */
export const BOARD_PX_PER_MM = 96 / 25.4;
/** A sheet is an A4-wide page. */
export const SHEET_WIDTH_MM = 210;
/** Spacing a page without `paperSpacingMm` keeps (board px) — the old GRID_SIZE / LINE_SPACING. */
export const LEGACY_PATTERN_SPACING_PX = 30;
/** Sheet ruling a page without `paperSpacingMm` keeps: lines per page width. */
export const LEGACY_SHEET_LINES_PER_WIDTH = 28;

export function spacingPresetsFor(type: BackgroundType): readonly PaperSpacingPreset[] {
  if (type === 'lined') return LINED_SPACING_PRESETS;
  if (type === 'grid' || type === 'dotted') return GRID_SPACING_PRESETS;

  return [];
}

export const mmToBoardPx = (mm: number): number => mm * BOARD_PX_PER_MM;
export const boardPxToMm = (px: number): number => px / BOARD_PX_PER_MM;

/** Pattern spacing of a board page, in board px. */
export function boardPatternSpacingPx(page: Pick<WhiteboardPage, 'paperSpacingMm'> | null | undefined): number {
  const mm = normalizePaperSpacingMm(page?.paperSpacingMm);

  return mm === undefined ? LEGACY_PATTERN_SPACING_PX : mmToBoardPx(mm);
}

/** Pitch of an inserted sheet's ruling, in scene px, for a sheet laid out `layoutWidth` wide. */
export function sheetPatternPitch(layoutWidth: number, paperSpacingMm?: number): number {
  const width = Math.max(1, layoutWidth);
  const mm = normalizePaperSpacingMm(paperSpacingMm);

  return mm === undefined ? width / LEGACY_SHEET_LINES_PER_WIDTH : (width * mm) / SHEET_WIDTH_MM;
}

/** The host's default spacing for a new page on `type` paper ('dotted' shares 'grid'); undefined = original. */
export function resolveDefaultPaperSpacingMm(
  defaults: Partial<Record<BackgroundType, number>> | undefined,
  type: BackgroundType,
): number | undefined {
  if (!defaults || type === 'blank') return undefined;

  return normalizePaperSpacingMm(defaults[type] ?? (type === 'dotted' ? defaults.grid : undefined));
}
