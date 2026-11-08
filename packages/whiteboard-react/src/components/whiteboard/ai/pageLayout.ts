import { wbT, type WbLocale, type WbStringKey } from '../../../i18n/strings';

import { choiceLetters, CONTENT_LABELS, extractJsonObject } from './markdownBlocks';
import type { ContentLang } from './markdownBlocks';
import { sanitizeBox } from './pageAnalysis';

import type { NormalizedBox, SceneRect } from './types';

/**
 * «Make a similar page» — the page as a LAYOUT, not pixels.
 *
 * Image models garble text and math, so the page is never regenerated as a picture. The model (or
 * the teacher endpoint) returns where every block sits on the page (normalised boxes), how it is set
 * (size, weight, alignment, colour) and what it says — with the content already rewritten in the
 * requested mode. The board re-renders it as editable objects at the same places; figures are cut
 * from the ORIGINAL page image and placed unchanged.
 */

export type PageLayoutBlockKind = 'header' | 'question' | 'choices' | 'text' | 'math' | 'figure' | 'answer_lines' | 'table';

export interface PageLayoutStyle {
  /** Font size in px of the analysed image (the `page.w × page.h` the model saw). */
  fontSize?: number;
  weight?: 'normal' | 'bold';
  align?: 'right' | 'center' | 'left';
  color?: string;
}

export interface PageLayoutBlock {
  kind: PageLayoutBlockKind;
  bbox: NormalizedBox;
  style?: PageLayoutStyle;
  /** Text (markdown + `$…$` math) for text kinds; LaTeX without delimiters for `math`. */
  content?: string;
  /** `choices`: the options, letter-less. */
  choices?: string[];
  /** `table`. */
  header?: string[];
  rows?: string[][];
  /** `answer_lines`: how many ruled lines. */
  lines?: number;
  /** Question number this block belongs to («Edit one question» keeps the others byte-identical). */
  n?: string;
  /** `question` blocks: the NEW question's type, and what the ORIGINAL question was (owner rule:
   *  they must match — see {@link enforceQuestionTypes}). */
  type?: QuestionType;
  originalType?: QuestionType;
  /** `question` blocks: how many choices the original had (MCQ keeps the same count). */
  originalChoiceCount?: number;
}

/** The kinds of question a sheet has. A remade question keeps its original's kind. */
export type QuestionType = 'written' | 'mcq' | 'true_false' | 'fill_blank';

const QUESTION_TYPE_ALIASES: Record<string, QuestionType> = {
  written: 'written', essay: 'written', free: 'written', short: 'written', open: 'written',
  mcq: 'mcq', multiple_choice: 'mcq', choice: 'mcq', choices: 'mcq',
  true_false: 'true_false', truefalse: 'true_false', tf: 'true_false', boolean: 'true_false',
  fill_blank: 'fill_blank', fill: 'fill_blank', blank: 'fill_blank', cloze: 'fill_blank',
};

export function normalizeQuestionType(value: unknown): QuestionType | undefined {
  return typeof value === 'string' ? QUESTION_TYPE_ALIASES[value.trim().toLowerCase().replace(/[\s-]+/g, '_')] : undefined;
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, WbStringKey> = {
  written: 'ai.qtype.written',
  mcq: 'ai.qtype.mcq',
  true_false: 'ai.qtype.true_false',
  fill_blank: 'ai.qtype.fill_blank',
};

export interface PageLayout {
  page: { w: number; h: number; bg?: string };
  blocks: PageLayoutBlock[];
}

export type RemakeMode = 'similar' | 'edit_question' | 'fix_errors';

const KINDS: PageLayoutBlockKind[] = ['header', 'question', 'choices', 'text', 'math', 'figure', 'answer_lines', 'table'];
const KIND_ALIASES: Record<string, PageLayoutBlockKind> = {
  title: 'header',
  heading: 'header',
  paragraph: 'text',
  instruction: 'text',
  image: 'figure',
  diagram: 'figure',
  lines: 'answer_lines',
  answer: 'answer_lines',
  options: 'choices',
};
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const str = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);

  return undefined;
};

const strings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const list = value.map((item) => str(item) ?? '').filter((item) => item !== '');

  return list.length ? list : undefined;
};

function parseStyle(value: unknown): PageLayoutStyle | undefined {
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const style: PageLayoutStyle = {};
  const fontSize = Number(record.fontSize ?? record.size);
  const weight = str(record.weight ?? record.fontWeight)?.toLowerCase();
  const align = str(record.align ?? record.textAlign)?.toLowerCase();
  const color = str(record.color)?.toLowerCase();

  if (Number.isFinite(fontSize) && fontSize > 0) style.fontSize = fontSize;
  if (weight === 'bold' || weight === '700' || weight === '600') style.weight = 'bold';
  else if (weight) style.weight = 'normal';
  if (align === 'right' || align === 'center' || align === 'left') style.align = align;
  if (color && HEX_RE.test(color)) style.color = color;

  return Object.keys(style).length ? style : undefined;
}

/** A model / endpoint answer (object or text with a ```json block) → layout, or null. Never throws. */
export function parsePageLayout(input: unknown): PageLayout | null {
  const value = typeof input === 'string' ? extractJsonObject(input) : input;

  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const source = record.layout && typeof record.layout === 'object' ? (record.layout as Record<string, unknown>) : record;
  const pageRaw = (source.page ?? {}) as Record<string, unknown>;
  const w = Number(pageRaw.w ?? pageRaw.width);
  const h = Number(pageRaw.h ?? pageRaw.height);
  const blocks: PageLayoutBlock[] = [];

  for (const raw of Array.isArray(source.blocks) ? source.blocks : []) {
    if (!raw || typeof raw !== 'object') continue;

    const item = raw as Record<string, unknown>;
    const kindRaw = str(item.kind ?? item.type)?.toLowerCase() ?? '';
    const kind = (KINDS as string[]).includes(kindRaw) ? (kindRaw as PageLayoutBlockKind) : KIND_ALIASES[kindRaw];
    const bbox = sanitizeBox(item.bbox ?? item.box);

    if (!kind || !bbox) continue;

    const block: PageLayoutBlock = { kind, bbox };
    const style = parseStyle(item.style);
    const content = str(item.content ?? item.text);
    const choices = strings(item.choices ?? item.options);
    const n = str(item.n ?? item.number);

    if (style) block.style = style;
    if (content) block.content = content;
    if (choices) block.choices = choices;
    if (n) block.n = n;

    const type = normalizeQuestionType(item.type ?? item.questionType);
    const originalType = normalizeQuestionType(item.originalType ?? item.original_type);
    const originalChoiceCount = Number(item.originalChoiceCount ?? item.original_choice_count);

    if (type) block.type = type;
    if (originalType) block.originalType = originalType;
    if (Number.isFinite(originalChoiceCount) && originalChoiceCount >= 0) block.originalChoiceCount = Math.round(originalChoiceCount);

    if (kind === 'table') {
      const header = strings(item.header);
      const rows = Array.isArray(item.rows) ? item.rows.map((row) => strings(row) ?? []).filter((row) => row.length) : [];

      if (!header && rows.length === 0) continue;
      block.header = header ?? rows.shift() ?? [];
      block.rows = rows.map((row) => block.header!.map((_, column) => row[column] ?? ''));
    }

    if (kind === 'answer_lines') {
      const lines = Number(item.lines ?? item.count);

      block.lines = Number.isFinite(lines) && lines > 0 ? Math.min(20, Math.round(lines)) : undefined;
    }

    // Text kinds without text say nothing — drop them rather than draw an empty box.
    if (['header', 'question', 'text', 'math'].includes(kind) && !content) continue;
    if (kind === 'choices' && !choices && !content) continue;

    blocks.push(block);
  }

  if (blocks.length === 0) return null;

  return {
    page: {
      w: Number.isFinite(w) && w > 0 ? w : 1000,
      h: Number.isFinite(h) && h > 0 ? h : 1414,
      ...(typeof pageRaw.bg === 'string' && HEX_RE.test(pageRaw.bg) ? { bg: pageRaw.bg } : {}),
    },
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Layout → placement plan (pure; the object builder turns it into Fabric objects)
// ---------------------------------------------------------------------------

export type LayoutPlacement =
  | {
      kind: 'text';
      block: PageLayoutBlock['kind'];
      rect: SceneRect;
      text: string;
      fontSize: number;
      bold: boolean;
      align: 'right' | 'center' | 'left';
      color?: string;
    }
  | { kind: 'math'; rect: SceneRect; tex: string; fontSize: number; color?: string }
  | { kind: 'figure'; rect: SceneRect; source: NormalizedBox }
  | { kind: 'lines'; rect: SceneRect; count: number }
  | { kind: 'table'; rect: SceneRect; header: string[]; rows: string[][]; fontSize: number };


/** Typical font size per kind, as a fraction of the page width — used when the model gave none. */
const DEFAULT_FONT_RATIO: Record<PageLayoutBlockKind, number> = {
  header: 0.03,
  question: 0.022,
  choices: 0.02,
  text: 0.02,
  math: 0.024,
  figure: 0.02,
  answer_lines: 0.02,
  table: 0.018,
};

/**
 * Maps every block's normalised box onto `target` (the scene rectangle the original page occupies,
 * so the copy lands where the original sits), converting font sizes from the analysed image's px.
 * Font sizes are clamped to what fits the block height, so a mis-estimated size never spills over
 * the next block.
 */
export function layoutToPlacements(layout: PageLayout, target: SceneRect, lang: ContentLang = 'en'): LayoutPlacement[] {
  const letters = choiceLetters(lang);
  const scale = target.width / layout.page.w;
  const placements: LayoutPlacement[] = [];

  for (const block of layout.blocks) {
    const rect: SceneRect = {
      left: target.left + block.bbox.x * target.width,
      top: target.top + block.bbox.y * target.height,
      width: Math.max(4, block.bbox.w * target.width),
      height: Math.max(4, block.bbox.h * target.height),
    };
    const fromModel = block.style?.fontSize ? block.style.fontSize * scale : DEFAULT_FONT_RATIO[block.kind] * target.width;
    const fontSize = Math.max(6, fromModel);
    const align = block.style?.align ?? (block.kind === 'header' ? 'center' : 'left');
    const bold = block.style?.weight ? block.style.weight === 'bold' : block.kind === 'header';
    const color = block.style?.color;

    switch (block.kind) {
      case 'figure':
        placements.push({ kind: 'figure', rect, source: block.bbox });
        break;
      case 'answer_lines':
        placements.push({ kind: 'lines', rect, count: block.lines ?? Math.max(1, Math.round(rect.height / (fontSize * 1.8))) });
        break;
      case 'table':
        placements.push({ kind: 'table', rect, header: block.header ?? [], rows: block.rows ?? [], fontSize });
        break;
      case 'math':
        placements.push({ kind: 'math', rect, tex: block.content ?? '', fontSize: Math.min(fontSize, rect.height * 0.8), color });
        break;
      case 'choices': {
        const choices = block.choices ?? [];
        // A one-line box (the printed sheet's «a) 10   b) 20 …») stays one line, shrinking to fit the
        // width; a tall box stacks the options. Option text is measured without its TeX markup.
        const inline = choices.length > 0 && rect.width / rect.height > 4;
        const text = choices.length
          ? choices.map((choice, index) => `${letters[index] ?? index + 1}) ${choice}`).join(inline ? '      ' : '\n')
          : (block.content ?? '');
        const visible = text.replace(/\\[a-zA-Z]+|[{}$\\]/g, '');
        const lines = inline ? 1 : Math.max(1, text.split('\n').length);
        const widthCap = inline ? rect.width / Math.max(1, visible.length * 0.55) : Infinity;

        placements.push({
          kind: 'text',
          block: block.kind,
          rect,
          text,
          fontSize: Math.max(6, Math.min(fontSize, (rect.height / lines) * 0.8, widthCap)),
          bold,
          align,
          color,
        });
        break;
      }
      default: {
        const lines = Math.max(1, (block.content ?? '').split('\n').length);

        placements.push({
          kind: 'text',
          block: block.kind,
          rect,
          text: block.content ?? '',
          fontSize: Math.min(fontSize, (rect.height / lines) * 0.85),
          bold,
          align,
          color,
        });
      }
    }
  }

  return placements;
}

/**
 * Pins a model's guessed boxes to the ink actually on the page. The guest model reads the page as
 * text and estimates positions; `lines` are the ink bands measured from the pixels. A figure takes
 * the box of the band it overlaps most (so the cut-out is the real drawing); a text block keeps its
 * width but takes the vertical extent of the bands it overlaps. Blocks with no convincing overlap
 * are left alone.
 */
export function snapLayoutToLines(layout: PageLayout, lines: NormalizedBox[]): PageLayout {
  if (lines.length === 0) return layout;

  const overlapY = (a: NormalizedBox, b: NormalizedBox) => Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const overlapX = (a: NormalizedBox, b: NormalizedBox) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const heights = lines.map((line) => line.h).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] ?? 0;

  return {
    ...layout,
    blocks: layout.blocks.map((block) => {
      const box = block.bbox;

      if (block.kind === 'figure') {
        let best: NormalizedBox | null = null;
        let bestArea = 0;

        for (const line of lines) {
          const area = overlapY(box, line) * Math.max(overlapX(box, line), 1e-6);

          if (line.h >= typical * 1.8 && area > bestArea) {
            best = line;
            bestArea = area;
          }
        }

        return best && bestArea > 0 ? { ...block, bbox: { ...best } } : block;
      }

      if (block.kind === 'answer_lines' || block.kind === 'table') return block;

      const hits = lines.filter((line) => overlapY(box, line) >= Math.min(box.h, line.h) * 0.3 && line.h < typical * 1.8);

      if (hits.length === 0) return block;

      const top = Math.min(...hits.map((line) => line.y));
      const bottom = Math.max(...hits.map((line) => line.y + line.h));

      return { ...block, bbox: { ...box, y: top, h: bottom - top } };
    }),
  };
}

// ---------------------------------------------------------------------------
// Owner rule: a remade question keeps its original's TYPE (and an MCQ its number of choices).
// ---------------------------------------------------------------------------

export interface TypeViolation {
  n: string;
  expected: QuestionType;
  got: QuestionType;
  expectedChoices?: number;
  gotChoices: number;
}


/** What a question's blocks actually ARE: choices present → mcq (or T/F when they are True/False). */
function observedType(question: PageLayoutBlock, choices: PageLayoutBlock | undefined): QuestionType {
  const options = choices?.choices ?? [];

  if (options.length === 2 && options.every((o) => /^(true|false)$/i.test(o.trim()))) return 'true_false';
  if (options.length >= 2) return 'mcq';
  if (/_{3,}|\.{4,}|…{2,}|\(\s*\)/.test(question.content ?? '')) return 'fill_blank';

  return question.type && question.type !== 'mcq' ? question.type : 'written';
}

/**
 * The questions whose new form does not match the original's type / choice count. Only questions
 * the model described (`originalType` present) can be checked; the rest pass.
 */
export function findTypeViolations(layout: PageLayout): TypeViolation[] {
  const violations: TypeViolation[] = [];

  for (const question of layout.blocks) {
    if (question.kind !== 'question' || !question.n || !question.originalType) continue;

    const choices = layout.blocks.find((block) => block.kind === 'choices' && block.n === question.n);
    const got = observedType(question, choices);
    const gotChoices = choices?.choices?.length ?? 0;
    const countWrong =
      question.originalType === 'mcq' && question.originalChoiceCount !== undefined && gotChoices !== question.originalChoiceCount;

    if (got !== question.originalType || countWrong) {
      violations.push({ n: question.n, expected: question.originalType, got, expectedChoices: question.originalChoiceCount, gotChoices });
    }
  }

  return violations;
}

/**
 * Last resort after one re-ask: force each violating question back into its original's shape —
 * written / fill-blank lose their choices block, true/false gets exactly «True / False», an MCQ keeps
 * at most its original count (a short list is left as is rather than padded with invented options).
 */
export function enforceQuestionTypes(
  layout: PageLayout,
  violations = findTypeViolations(layout),
  lang: ContentLang = 'en',
): PageLayout {
  if (violations.length === 0) return layout;

  const byN = new Map(violations.map((violation) => [violation.n, violation]));
  const blocks: PageLayoutBlock[] = [];

  for (const block of layout.blocks) {
    const violation = block.n ? byN.get(block.n) : undefined;

    if (!violation) {
      blocks.push(block);
      continue;
    }

    if (block.kind === 'question') {
      blocks.push({ ...block, type: violation.expected });
      continue;
    }

    if (block.kind !== 'choices') {
      blocks.push(block);
      continue;
    }

    if (violation.expected === 'written' || violation.expected === 'fill_blank') continue;
    if (violation.expected === 'true_false') blocks.push({ ...block, choices: [...CONTENT_LABELS.trueFalse] });
    else if (violation.expectedChoices !== undefined && (block.choices?.length ?? 0) > violation.expectedChoices) {
      blocks.push({ ...block, choices: block.choices!.slice(0, violation.expectedChoices) });
    } else blocks.push(block);
  }

  // An original MCQ / T-F the model turned written: its choices block is gone — nothing to rebuild
  // from but the label set, so T/F gets one, an MCQ stays as the model wrote it (flagged).
  return { ...layout, blocks };
}

/** One line per violation, for the re-ask instruction and the panel. */
export function describeTypeViolation(violation: TypeViolation, locale: WbLocale = 'en'): string {
  const where = wbT(locale, 'ai.violation.where', { n: violation.n });

  if (violation.expected === 'written' && violation.got === 'mcq') return wbT(locale, 'ai.violation.choicesOnWritten', { where });
  if (violation.expected === violation.got && violation.expected === 'mcq') {
    return wbT(locale, 'ai.violation.choiceCount', {
      expected: violation.expectedChoices ?? wbT(locale, 'ai.violation.unknownCount'),
      got: violation.gotChoices,
      where,
    });
  }

  return wbT(locale, 'ai.violation.typeChanged', {
    from: wbT(locale, QUESTION_TYPE_LABELS[violation.expected]),
    to: wbT(locale, QUESTION_TYPE_LABELS[violation.got]),
    where,
  });
}
