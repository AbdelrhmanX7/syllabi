/**
 * The calibration sheet as pages of cells, and what the bank says about each cell. Pure; the cell
 * list and page size come from the glyph-bank package (one import, swapped there when the real
 * sheet lands).
 */
import type { HandwritingStringKey } from './strings';
import type { GlyphBank, SheetCell } from '@repo/whiteboard-react';

import { bankCoveredKeys, MAX_SAMPLES_PER_GLYPH, SHEET_CELLS, SHEET_PAGE_SIZE } from '@repo/whiteboard-react';

export type { SheetCell };

export const PAGE_STORAGE_KEY = 'study_handwriting_page';

export function sheetCells(): readonly SheetCell[] {
  return SHEET_CELLS;
}

export function pageCount(cells: readonly SheetCell[] = SHEET_CELLS, size = SHEET_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(cells.length / size));
}

export function cellsOnPage(
  page: number,
  cells: readonly SheetCell[] = SHEET_CELLS,
  size = SHEET_PAGE_SIZE,
): readonly SheetCell[] {
  const index = Math.min(Math.max(0, page), pageCount(cells, size) - 1);

  return cells.slice(index * size, (index + 1) * size);
}

export function pageOfCell(key: string, cells: readonly SheetCell[] = SHEET_CELLS, size = SHEET_PAGE_SIZE): number {
  const index = cells.findIndex((cell) => cell.key === key);

  return index < 0 ? 0 : Math.floor(index / size);
}

export interface SheetProgress {
  total: number;
  done: number;
  /** 0..100, whole number. */
  percent: number;
  /** Keys with no sample yet, in sheet order. */
  missing: string[];
}

export function sheetProgress(bank: GlyphBank, cells: readonly SheetCell[] = SHEET_CELLS): SheetProgress {
  const covered = bankCoveredKeys(bank);
  const missing = cells.filter((cell) => !covered.has(cell.key)).map((cell) => cell.key);
  const total = cells.length;
  const done = total - missing.length;

  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100), missing };
}

/** How many samples a cell holds, capped at what the bank keeps. */
export function cellSampleCount(bank: GlyphBank, key: string): number {
  return Math.min(MAX_SAMPLES_PER_GLYPH, bank.glyphs[key]?.samples.length ?? 0);
}

/** The first page (from `fromPage` on, wrapping) that still has a missing cell; null = none left. */
export function nextPageWithMissing(
  progress: SheetProgress,
  fromPage: number,
  cells: readonly SheetCell[] = SHEET_CELLS,
  size = SHEET_PAGE_SIZE,
): number | null {
  if (progress.missing.length === 0) return null;
  const pages = progress.missing.map((key) => pageOfCell(key, cells, size));
  const ahead = pages.filter((page) => page > fromPage);

  return ahead.length > 0 ? Math.min(...ahead) : Math.min(...pages);
}

/** The i18n key for a cell's instruction (by key family, then by form). */
export function cellPromptKey(cell: SheetCell): HandwritingStringKey {
  if (cell.key.startsWith('ar-dot:')) return 'promptDots';
  if (cell.key.startsWith('digit:')) return 'promptDigit';
  if (cell.key.startsWith('lat:')) return 'promptLatin';
  if (cell.form === 'init') return 'promptInit';
  if (cell.form === 'medi') return 'promptMedi';
  if (cell.form === 'fina') return 'promptFina';

  return 'promptIsol';
}

/** Which join tails a cell shows for a connected-script form (right = joins the previous letter). */
export function cellTails(cell: SheetCell): { right: boolean; left: boolean } {
  return {
    right: cell.form === 'medi' || cell.form === 'fina',
    left: cell.form === 'medi' || cell.form === 'init',
  };
}

export function readSavedPage(): number {
  if (typeof window === 'undefined') return 0;

  try {
    const raw = window.localStorage.getItem(PAGE_STORAGE_KEY);
    const page = raw === null ? 0 : Number(raw);

    return Number.isInteger(page) && page >= 0 ? page : 0;
  } catch {
    return 0;
  }
}

export function savePage(page: number): void {
  try {
    window.localStorage.setItem(PAGE_STORAGE_KEY, String(page));
  } catch {
    // private mode — the page is still open on screen
  }
}
