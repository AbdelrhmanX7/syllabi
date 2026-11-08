import type { PdfPlacementRect } from './types';

/**
 * Validators for the per-page canvas geometry a snapshot records for the server-side ink
 * renderer ({@link WhiteboardPage.canvasWidthPx} / {@link WhiteboardPage.pdfPlacement}).
 *
 * The rule everywhere: a value that is not a real measurement is dropped, never repaired to 0.
 * The backend treats an ABSENT field as "fall back to heuristics" and a PRESENT one as truth, so a
 * zero or a NaN written here would silently outrank a working heuristic.
 */

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A recorded canvas width is only meaningful when it is a finite, strictly positive number. */
export function normalizeCanvasWidthPx(value: unknown): number | undefined {
  const width = asFiniteNumber(value);

  return width !== undefined && width > 0 ? width : undefined;
}

/** An inserted sheet's aspect (height ÷ width): finite, positive and sane (1:20 … 20:1), else absent. */
export function normalizeSheetAspect(value: unknown): number | undefined {
  const aspect = asFiniteNumber(value);

  return aspect !== undefined && aspect >= 0.05 && aspect <= 20 ? aspect : undefined;
}

/** Paper spacing the board accepts, in mm (inclusive); anything else is dropped to «absent». */
export const PAPER_SPACING_MM_MIN = 3;
export const PAPER_SPACING_MM_MAX = 15;

export interface PaperSpacingPreset {
  /** Stable id (an i18n key suffix in the editor). */
  id: string;
  mm: number;
}

/** Ruled-paper presets: narrow / college / wide rule. */
export const LINED_SPACING_PRESETS: readonly PaperSpacingPreset[] = [
  { id: 'narrow', mm: 6 },
  { id: 'college', mm: 7.1 },
  { id: 'wide', mm: 8.7 },
];

/** Grid (and dot-grid) presets. */
export const GRID_SPACING_PRESETS: readonly PaperSpacingPreset[] = [
  { id: 'small', mm: 5 },
  { id: 'medium', mm: 7 },
  { id: 'large', mm: 10 },
];

/** A page's paper spacing in mm: finite and within the accepted range (rounded to 0.1 mm), else absent. */
export function normalizePaperSpacingMm(value: unknown): number | undefined {
  const mm = asFiniteNumber(value);

  if (mm === undefined || mm < PAPER_SPACING_MM_MIN || mm > PAPER_SPACING_MM_MAX) return undefined;

  return Math.round(mm * 10) / 10;
}

/**
 * A recorded placement is only meaningful when all four sides are finite and the rect has area.
 * `x`/`y` MAY be negative: the fit centres the page vertically, so a page taller than the canvas
 * starts above the top edge (a portrait PDF on a landscape screen — the common case).
 */
export function normalizePdfPlacement(value: unknown): PdfPlacementRect | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const x = asFiniteNumber(source.x);
  const y = asFiniteNumber(source.y);
  const width = asFiniteNumber(source.width);
  const height = asFiniteNumber(source.height);

  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }

  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return { height, width, x, y };
}

/**
 * Value equality for two optional placements; two absences are equal. `tolerance` (CSS px, default 0
 * = exact) lets a caller treat sub-pixel drift as "the same rect": a raster re-rendered at another
 * resolution rounds its size differently, which moves the fitted height by a fraction of a pixel.
 */
export function isSamePdfPlacement(
  a: PdfPlacementRect | undefined,
  b: PdfPlacementRect | undefined,
  tolerance = 0,
): boolean {
  if (!a || !b) {
    return a === b;
  }

  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}
