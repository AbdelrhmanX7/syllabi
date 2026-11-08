import { digitKey, dotKey, latinKey } from './latin';

import type { GlyphForm, GlyphKey } from './types';

/**
 * «My handwriting» — the calibration sheet: every cell the owner fills, in order. A cell names the
 * bank key it produces, what to show as the prompt, and the writing direction normalize needs.
 * Grouped into pages of about twenty cells.
 */

export interface SheetCell {
  key: GlyphKey;
  /** Label shown under the cell. */
  label: string;
  /** What to write — rendered in a font as the model to copy. */
  prompt: string;
  form: GlyphForm;
  dir: 'ltr';
  /** Cells that belong together (the dot, the digits, the letters…). */
  group: string;
}

export interface SheetPage {
  index: number;
  title: string;
  cells: SheetCell[];
}

export const TARGET_CELLS_PER_PAGE = 20;

export const FORM_LABEL: Record<GlyphForm, string> = {
  isol: 'Alone',
  init: 'Start of word',
  medi: 'Middle of word',
  fina: 'End of word',
};

const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** Every cell, in sheet order. */
export function sheetCells(): SheetCell[] {
  const cells: SheetCell[] = [{ key: dotKey(1), label: 'A dot', prompt: '•', form: 'isol', dir: 'ltr', group: 'dots' }];

  Array.from(DIGITS).forEach((digit) => cells.push({ key: digitKey(digit), label: `Digit ${digit}`, prompt: digit, form: 'isol', dir: 'ltr', group: 'digits' }));
  Array.from(LOWER).forEach((letter) => cells.push({ key: latinKey(letter), label: `Letter ${letter}`, prompt: letter, form: 'isol', dir: 'ltr', group: 'latin' }));

  return cells;
}

const PAGE_TITLES: Record<string, string> = {
  dots: 'Dot',
  digits: 'Digits',
  latin: 'Letters',
};

/**
 * Pages of about `target` cells. Groups are kept whole when they fit; a group larger than the target
 * (the alphabet) is split into even chunks.
 */
export function paginate(cells: SheetCell[], target = TARGET_CELLS_PER_PAGE): SheetPage[] {
  const groups: SheetCell[][] = [];

  cells.forEach((cell) => {
    const last = groups[groups.length - 1];

    if (last && last[0]!.group === cell.group) last.push(cell);
    else groups.push([cell]);
  });

  const pages: SheetCell[][] = [];
  let current: SheetCell[] = [];
  const slack = Math.ceil(target * 0.15);

  const flush = () => {
    if (current.length > 0) pages.push(current);
    current = [];
  };

  groups.forEach((group) => {
    if (group.length > target) {
      flush();

      const chunks = Math.ceil(group.length / target);
      const size = Math.ceil(group.length / chunks);

      for (let start = 0; start < group.length; start += size) pages.push(group.slice(start, start + size));

      return;
    }

    if (current.length + group.length > target + slack) flush();
    current.push(...group);
  });
  flush();

  return pages.map((pageCells, index) => {
    const families = Array.from(new Set(pageCells.map((cell) => cell.group))).map((family) => PAGE_TITLES[family] ?? family);

    return { index, title: families.join(' & '), cells: pageCells };
  });
}

export function sheetPages(target = TARGET_CELLS_PER_PAGE): SheetPage[] {
  return paginate(sheetCells(), target);
}

/** All keys the sheet can produce. */
export function sheetKeys(): Set<GlyphKey> {
  return new Set(sheetCells().map((cell) => cell.key));
}
