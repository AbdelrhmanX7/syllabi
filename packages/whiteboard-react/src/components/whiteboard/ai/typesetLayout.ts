import { handMathText, tokenDir } from './handwritingLayout';
import { splitInlineMath } from './latexText';
import { stripInlineMarkdown } from './markdownBlocks';

import type { HandToken } from './handwritingLayout';
import type { NormalizedBox } from './types';

/**
 * The pure half of «typed» AI text — everything the board writes in IBM Plex Sans with KaTeX math:
 * which formulas need KaTeX, fitting text into a box, multiple-choice layouts, and where
 * picture labels go. No DOM: the renderer (`typesetObjects.ts`) measures and hands numbers back.
 */

// ---------------------------------------------------------------------------
// Inline math: KaTeX or plain Plex text
// ---------------------------------------------------------------------------

/**
 * A formula Plex writes as well as KaTeX would: digits, Latin letters, ASCII operators and the
 * degree/multiply/divide signs — `x = 5`, `F = ma`, `3 + 4`. Anything with a script, fraction, root,
 * Greek letter, arrow or set symbol is typeset by KaTeX.
 */
export function isPlainMath(tex: string): boolean {
  if (!tex.trim()) return true;
  if (/[\\^_{}]/.test(tex.replace(/\\(?:times|div|cdot|circ|degree|,|;|:|!| )/g, ''))) return false;

  return /^[A-Za-z0-9 +\-=<>().,:/*×÷·°|!'%]+$/.test(handMathText(tex));
}

/** Does this markdown hold inline math that must be typeset (and so cannot live in a plain Textbox)? */
export function needsTypesetMath(markdown: string): boolean {
  return splitInlineMath(markdown).some((part) => part.kind === 'math' && part.value !== '' && !isPlainMath(part.value));
}

export interface TypesetToken extends HandToken {
  /** `math` tokens: `$$…$$` written inline, drawn in display style. */
  display?: boolean;
}

/** One line of markdown → word tokens + KaTeX formula tokens (a plain formula is written as words). */
export function tokenizeTypeset(markdown: string): TypesetToken[] {
  const tokens: TypesetToken[] = [];

  for (const part of splitInlineMath(markdown)) {
    if (part.kind === 'math') {
      if (!part.value) continue;

      if (isPlainMath(part.value)) {
        // One unbreakable left-to-right word: `m = 4 kg` never splits across two lines.
        const text = handMathText(part.value).replace(/ /g, '\u00A0');

        if (text) tokens.push({ kind: 'word', text, dir: 'ltr' });
      } else {
        tokens.push({ kind: 'math', text: handMathText(part.value), tex: part.value, dir: 'ltr' });
      }

      continue;
    }

    for (const word of stripInlineMarkdown(part.value)
      .replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .split(/\s+/)) {
      if (word) tokens.push({ kind: 'word', text: word, dir: tokenDir(word) });
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Fitting text into a box
// ---------------------------------------------------------------------------

/** What a layout at one font size takes up. */
export interface MeasuredSize {
  width: number;
  height: number;
}

/**
 * The largest font size ≤ `start` whose layout fits `box` (a hair of slack: 3 %), stepping down by
 * `step` and never below `min`. `measure` lays the text out at a size (wrapping at the box width) and
 * reports its extent. Returns the size and whether it really fits (false = clamped at `min`).
 */
export function fitFontSize(
  measure: (fontSize: number) => MeasuredSize,
  box: { width: number; height: number },
  { start, min, step = 0.92 }: { start: number; min: number; step?: number },
): { fontSize: number; fits: boolean; size: MeasuredSize } {
  const floor = Math.max(1, Math.min(min, start));
  let fontSize = Math.max(floor, start);

  for (let guard = 0; guard < 60; guard += 1) {
    const size = measure(fontSize);

    if (size.width <= box.width * 1.03 && size.height <= box.height * 1.03) return { fontSize, fits: true, size };

    if (fontSize <= floor) return { fontSize, fits: false, size };

    fontSize = Math.max(floor, fontSize * step);
  }

  return { fontSize, fits: false, size: measure(fontSize) };
}

/** Greedy word wrap of `words` (each with its width) at `maxWidth`, `space` between words. Line count. */
export function wrapLineCount(widths: number[], maxWidth: number, space: number): number {
  let lines = widths.length > 0 ? 1 : 0;
  let current = 0;

  widths.forEach((width, index) => {
    const added = index === 0 || current === 0 ? width : current + space + width;

    if (current > 0 && added > maxWidth) {
      lines += 1;
      current = width;
    } else {
      current = added;
    }
  });

  return lines;
}

// ---------------------------------------------------------------------------
// Multiple-choice layouts
// ---------------------------------------------------------------------------

export interface ChoiceCell {
  index: number;
  /** In the box's own coordinates (0,0 = its top-left). */
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ChoiceArrangement = 'inline' | 'grid' | 'stacked';

/**
 * Choices → cells inside `box`. `inline`: one row, the first choice on the left. When the widest
 * choice does not fit its inline column, two columns (a b / c d) and then a stack are tried. `stacked`: one row each, full width, top to bottom.
 *
 * `widths` are the natural one-line widths at the font size being tried, `lineHeight` that size's
 * line pitch, `gap` the space between columns.
 */
export function layoutChoices(
  widths: number[],
  box: { width: number; height: number },
  { preferred, lineHeight, gap }: { preferred: 'inline' | 'stacked'; lineHeight: number; gap: number },
): { arrangement: ChoiceArrangement; cells: ChoiceCell[]; height: number } {
  const count = widths.length;
  const widest = Math.max(0, ...widths);
  const columnsFor = (columns: number) => {
    const rows = Math.ceil(count / columns);
    const columnWidth = (box.width - gap * (columns - 1)) / columns;
    const rowHeight = Math.max(lineHeight, rows > 0 ? Math.min(lineHeight * 1.6, box.height / rows) : lineHeight);
    const cells: ChoiceCell[] = widths.map((_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;

      return {
        index,
        left: column * (columnWidth + gap),
        top: row * rowHeight,
        width: columnWidth,
        height: rowHeight,
      };
    });

    return { cells, height: rows * rowHeight, columnWidth };
  };

  if (count === 0) return { arrangement: preferred === 'inline' ? 'inline' : 'stacked', cells: [], height: 0 };

  if (preferred === 'inline') {
    const inline = columnsFor(count);

    if (widest <= inline.columnWidth) return { arrangement: 'inline', cells: inline.cells, height: inline.height };

    if (count > 2) {
      const grid = columnsFor(2);

      if (widest <= grid.columnWidth) return { arrangement: 'grid', cells: grid.cells, height: grid.height };
    }
  }

  const stacked = columnsFor(1);

  return { arrangement: 'stacked', cells: stacked.cells, height: stacked.height };
}

// ---------------------------------------------------------------------------
// Picture labels («Illustration»)
// ---------------------------------------------------------------------------

export interface ImageLabelInput {
  text: string;
  /** Where the label text sits, 0..1 of the picture. */
  anchor: { x: number; y: number };
  /** The point it names (a leader line goes there), 0..1. */
  target?: { x: number; y: number };
  /** Text height as a fraction of the picture height. */
  sizeRel?: number;
}

export interface PlacedLabel {
  index: number;
  /** Label box, in picture px (0,0 = the picture's top-left). */
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  /** Leader line from the box edge to the target, picture px; null without a target or when they touch. */
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
}

const overlaps = (a: { left: number; top: number; width: number; height: number }, b: { left: number; top: number; width: number; height: number }, pad: number) =>
  a.left < b.left + b.width + pad && b.left < a.left + a.width + pad && a.top < b.top + b.height + pad && b.top < a.top + a.height + pad;

/** Where a ray from the box centre toward `to` leaves the box (pad outside it). */
function boxExit(box: { left: number; top: number; width: number; height: number }, to: { x: number; y: number }, pad: number) {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  const hw = box.width / 2 + pad;
  const hh = box.height / 2 + pad;

  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);

  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Labels → boxes in picture px: centred on their anchor, at `sizeRel` × picture height (clamped to
 * `minFont`..`maxFont`), kept inside the picture, and pushed down/up out of each other's way. A leader
 * runs from the box edge to the target unless the target is inside (or right at) the box.
 *
 * `measure(text, fontSize)` → the label's one-line width.
 */
export function placeImageLabels(
  labels: ImageLabelInput[],
  picture: { width: number; height: number },
  measure: (text: string, fontSize: number) => number,
  { minFont = 12, maxFont = 64, defaultRel = 0.045, padding = 0.3 }: { minFont?: number; maxFont?: number; defaultRel?: number; padding?: number } = {},
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

  labels.forEach((label, index) => {
    const text = label.text.trim();

    if (!text) return;

    const fontSize = clamp((label.sizeRel && label.sizeRel > 0 ? label.sizeRel : defaultRel) * picture.height, minFont, maxFont);
    const padX = fontSize * padding;
    const width = Math.min(picture.width, measure(text, fontSize) + padX * 2);
    const height = fontSize * 1.45;
    const box = {
      left: clamp(label.anchor.x * picture.width - width / 2, 0, Math.max(0, picture.width - width)),
      top: clamp(label.anchor.y * picture.height - height / 2, 0, Math.max(0, picture.height - height)),
      width,
      height,
    };

    // Out of the way of the labels already placed: try below, then above, a step at a time.
    for (let attempt = 1; attempt <= 12 && placed.some((other) => overlaps(box, other, fontSize * 0.15)); attempt += 1) {
      const step = Math.ceil(attempt / 2) * height * 0.6 * (attempt % 2 === 1 ? 1 : -1);

      box.top = clamp(label.anchor.y * picture.height - height / 2 + step, 0, Math.max(0, picture.height - height));
    }

    let leader: PlacedLabel['leader'] = null;

    if (label.target) {
      const target = { x: label.target.x * picture.width, y: label.target.y * picture.height };
      const inside =
        target.x >= box.left - fontSize * 0.4 &&
        target.x <= box.left + box.width + fontSize * 0.4 &&
        target.y >= box.top - fontSize * 0.4 &&
        target.y <= box.top + box.height + fontSize * 0.4;

      if (!inside) {
        const start = boxExit(box, target, fontSize * 0.12);

        leader = { x1: start.x, y1: start.y, x2: target.x, y2: target.y };
      }
    }

    placed.push({ index, ...box, fontSize, leader });
  });

  return placed;
}

// ---------------------------------------------------------------------------
// Remake overlay: blocks → page rectangles
// ---------------------------------------------------------------------------

/** Normalised bbox → a rectangle in `page` (any units). */
export function bboxToRect(bbox: NormalizedBox, page: { left: number; top: number; width: number; height: number }) {
  return {
    left: page.left + bbox.x * page.width,
    top: page.top + bbox.y * page.height,
    width: Math.max(1, bbox.w * page.width),
    height: Math.max(1, bbox.h * page.height),
  };
}

/** Blocks → groups: everything that shares a question number travels together; the rest stand alone. */
export function groupOverlayBlocks<T extends { n?: string }>(blocks: T[]): T[][] {
  const groups: T[][] = [];
  const byNumber = new Map<string, T[]>();

  for (const block of blocks) {
    const n = block.n?.trim();

    if (!n) {
      groups.push([block]);
      continue;
    }

    let group = byNumber.get(n);

    if (!group) {
      group = [];
      byNumber.set(n, group);
      groups.push(group);
    }

    group.push(block);
  }

  return groups;
}

/** A choice line: «a) text» unless the text already starts with its label. */
export function choiceLine(label: string, text: string): string {
  const cleanLabel = label.trim().replace(/[).:\-]+$/, '');
  const body = text.trim();

  if (!cleanLabel) return body;
  if (body.startsWith(cleanLabel)) return body;

  return `${cleanLabel}) ${body}`;
}

/** The fields of an overlay block the group resolver reads (structurally `RemakeOverlayBlock`). */
export interface OverlayBlockLike {
  n?: string;
  kind: string;
  bbox: NormalizedBox;
  text: string;
  number?: string | null;
  label?: string;
  style?: { fontSizeRel?: number } & Record<string, unknown>;
  choices?: Array<{ label: string; text: string }>;
  choiceLayout?: 'inline' | 'stacked';
}

const labelKey = (label: string | undefined) => (label ?? '').trim().replace(/[).:\-\s]+$/, '');

/**
 * One question's blocks (BE #564) → what is drawn, each in its own bbox:
 *  - the question block's text with its printed number in front («1) …»), its choice list dropped;
 *  - every `choice` block as «label) text», in the question's style unless it brings its own;
 *  - a choice listed on the question with NO `choice` block (the fallback) gets a slot of its own:
 *    the next one in the pattern the existing choice blocks make (same step, same size), or — with no
 *    choice block at all — rows under the question (one row inline, a row each stacked).
 */
export function resolveOverlayGroup<T extends OverlayBlockLike>(group: T[]): T[] {
  const question = group.find((block) => block.kind === 'question');
  const choiceBlocks = group.filter((block) => block.kind === 'choice');
  const covered = new Set(choiceBlocks.map((block) => labelKey(block.label)));
  const out: T[] = [];

  for (const block of group) {
    if (block.kind === 'question') {
      const number = block.number?.trim();

      out.push({
        ...block,
        text: number && block.text.trim() && !block.text.trim().startsWith(number) ? `${number} ${block.text.trim()}` : block.text,
        choices: undefined,
      });
    } else if (block.kind === 'choice') {
      out.push({
        ...block,
        text: block.label ? choiceLine(block.label, block.text) : block.text,
        style: { ...(question?.style ?? {}), ...(block.style ?? {}) },
      });
    } else {
      out.push(block);
    }
  }

  const missing = question ? (question.choices ?? []).filter((choice) => !covered.has(labelKey(choice.label))) : [];

  if (!question || missing.length === 0) return out;

  const rel = question.style?.fontSizeRel && question.style.fontSizeRel > 0 ? question.style.fontSizeRel : 0.016;
  const rowHeight = rel * 1.9;
  const clampBox = (box: NormalizedBox): NormalizedBox => {
    const x = Math.max(0, Math.min(1, box.x));
    const y = Math.max(0, Math.min(1, box.y));

    return { x, y, w: Math.max(0.01, Math.min(box.w, 1 - x)), h: Math.max(0.005, Math.min(box.h, 1 - y)) };
  };
  let slots: NormalizedBox[];

  if (choiceBlocks.length > 0) {
    const last = choiceBlocks[choiceBlocks.length - 1]!.bbox;
    const before = choiceBlocks.length > 1 ? choiceBlocks[choiceBlocks.length - 2]!.bbox : null;
    // Continue the pattern: the step between the last two slots, or straight down one row.
    const step = before ? { dx: last.x - before.x, dy: last.y - before.y } : { dx: 0, dy: last.h * 1.15 };
    let dx = step.dx;
    let dy = step.dy;

    slots = missing.map((_, index) => {
      let box = { x: last.x + dx * (index + 1), y: last.y + dy * (index + 1), w: last.w, h: last.h };

      // A row that would run off the page side wraps under the first slot instead.
      if (box.x < 0 || box.x + box.w > 1) {
        dx = 0;
        dy = last.h * 1.15;
        box = { x: choiceBlocks[0]!.bbox.x, y: last.y + dy * (index + 1), w: last.w, h: last.h };
      }

      return clampBox(box);
    });
  } else {
    const q = question.bbox;
    const inline = question.choiceLayout !== 'stacked';

    slots = inline
      ? missing.map((_, index) => {
          const w = q.w / missing.length;

          return clampBox({ x: q.x + w * index, y: q.y + q.h, w, h: rowHeight });
        })
      : missing.map((_, index) => clampBox({ x: q.x, y: q.y + q.h + rowHeight * index, w: q.w, h: rowHeight }));
  }

  missing.forEach((choice, index) => {
    out.push({
      ...question,
      kind: 'choice',
      bbox: slots[index]!,
      label: choice.label,
      number: undefined,
      text: choiceLine(choice.label, choice.text),
      choices: undefined,
      style: { ...(question.style ?? {}) },
    } as T);
  });

  return out;
}
