import { blocksToMarkdown, choiceLetters, CONTENT_LABELS, stripInlineMarkdown } from './markdownBlocks';
import type { ContentLang } from './markdownBlocks';
import { latexToText, splitInlineMath } from './latexText';

import type { BoardAiBlock } from './types';

/**
 * «Write it by hand» — the pure half: answer blocks → paragraphs of word/formula tokens, line
 * breaking, and the seeded "human" wobble (baseline, slope, size) every word gets. No DOM: the renderer measures each token by drawing
 * it, then hands the measurements back here to be laid out.
 */

export type HandBlockKind = 'heading' | 'paragraph' | 'list' | 'math' | 'question';

export interface HandToken {
  /** `word`: drawn with the handwriting font. `math`: a KaTeX formula traced from its picture. */
  kind: 'word' | 'math';
  /** The word itself, or the formula's readable text (the fallback when KaTeX cannot draw). */
  text: string;
  tex?: string;
  /** `ltr` for letters and digits; `neutral` for punctuation-only tokens (=, :, -, •). */
  dir: 'ltr' | 'neutral';
}

export interface HandParagraph {
  kind: HandBlockKind;
  /** Markdown / LaTeX the paragraph came from — rides on the objects for copy and re-render. */
  source: string;
  /** Font size in on-screen px before the size variation. */
  size: number;
  align: 'start' | 'center';
  tokens: HandToken[];
  /** Index of the block it came from (paragraphs of one block share it). */
  blockIndex: number;
  /** Extra space above, in multiples of the line gap (a new block breathes a little). */
  spaceBefore: number;
}

export type HandItem = { type: 'hand'; paragraph: HandParagraph } | { type: 'typed'; block: BoardAiBlock; blockIndex: number };

const LTR_RE = /[A-Za-z0-9\u00C0-\u024F\u0370-\u03FF²³¹]/;
const BIDI_CONTROLS_RE = /[‎‏‪-‮⁦-⁩]/g;

/**
 * What the bundled handwriting font can draw itself (Latin, digits, ASCII punctuation and a few
 * signs). A formula outside this set goes to KaTeX instead, so a `√` or an arrow never falls back to
 * a system font in the middle of a handwritten line.
 */
const HAND_DRAWABLE_RE = /^[ A-Za-z0-9!-/:-@[-`{-~°²³·×÷±−–—…]*$/;

export function tokenDir(text: string): HandToken['dir'] {
  return LTR_RE.test(text) ? 'ltr' : 'neutral';
}

/** latexToText's output without the bidi controls and no-break spaces it adds for Textbox. */
export function handMathText(tex: string): string {
  return latexToText(tex).replace(BIDI_CONTROLS_RE, '').replace(/ /g, ' ').replace(/[′‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

/** A formula simple enough to WRITE with the handwriting font (no fraction, root, arrow, Greek…). */
export function isHandDrawableMath(tex: string): boolean {
  if (/\\(?:frac|dfrac|tfrac|sqrt|int|sum|prod|lim|begin|over|binom|vec|overline|hat|bar|matrix)/.test(tex)) return false;
  // A superscript/subscript the Unicode table cannot spell (x^{n+1}) is a picture, not text.
  if (/[\^_]\s*\{[^}]{2,}\}/.test(tex)) return false;

  const text = handMathText(tex);

  return text.length > 0 && HAND_DRAWABLE_RE.test(text);
}

/** One line of markdown text → tokens: words split at spaces, `$…$` kept as single formula tokens. */
export function tokenizeHandText(markdown: string): HandToken[] {
  const tokens: HandToken[] = [];

  for (const part of splitInlineMath(markdown)) {
    if (part.kind === 'math') {
      if (!part.value) continue;

      if (isHandDrawableMath(part.value)) {
        // Written like any word, but as one unbreakable left-to-right run.
        for (const word of handMathText(part.value).split(' ')) {
          if (word) tokens.push({ kind: 'word', text: word, dir: 'ltr' });
        }
      } else {
        tokens.push({ kind: 'math', text: handMathText(part.value), tex: part.value, dir: 'ltr' });
      }

      continue;
    }

    for (const word of stripInlineMarkdown(part.value).replace(BIDI_CONTROLS_RE, '').split(/\s+/)) {
      if (word) tokens.push({ kind: 'word', text: word, dir: tokenDir(word) });
    }
  }

  return tokens;
}

// The hand font's letters sit small in their em box: these read like board writing next to typed 22 px text.
const SIZE = { heading: 40, subheading: 35, body: 32, small: 28, math: 34 };

/**
 * Blocks → what gets handwritten and what stays as it is. A table, diagram or picture is drawn the
 * usual way (`typed`); everything made of words is written.
 */
export function handItemsFromBlocks(
  blocks: BoardAiBlock[],
  { withAnswers }: { withAnswers: boolean; lang?: ContentLang },
): HandItem[] {
  const letters = choiceLetters();
  const items: HandItem[] = [];
  const hand = (blockIndex: number, kind: HandBlockKind, source: string, markdown: string, size: number, spaceBefore = 0.35, align: HandParagraph['align'] = 'start') => {
    const tokens = tokenizeHandText(markdown);

    if (tokens.length > 0) items.push({ type: 'hand', paragraph: { kind, source, size, align, tokens, blockIndex, spaceBefore } });
  };

  blocks.forEach((block, blockIndex) => {
    switch (block.type) {
      case 'heading':
        hand(blockIndex, 'heading', block.text, block.text, block.level && block.level >= 3 ? SIZE.subheading : SIZE.heading, 0.5);
        break;
      case 'paragraph':
        hand(blockIndex, 'paragraph', block.text, block.text, SIZE.body);
        break;
      case 'list': {
        const source = blocksToMarkdown([block]);

        block.items.forEach((item, index) => {
          const marker = block.ordered ? `${index + 1}.` : '•';

          hand(blockIndex, 'list', index === 0 ? source : '', `${marker} ${item}`, SIZE.body, index === 0 ? 0.35 : 0);
        });
        break;
      }
      case 'math': {
        const tex = block.text.trim();

        if (!tex) break;

        const tokens: HandToken[] = isHandDrawableMath(tex)
          ? handMathText(tex)
              .split(' ')
              .filter(Boolean)
              .map((word) => ({ kind: 'word' as const, text: word, dir: 'ltr' as const }))
          : [{ kind: 'math', text: handMathText(tex), tex, dir: 'ltr' }];

        items.push({ type: 'hand', paragraph: { kind: 'math', source: tex, size: SIZE.math, align: 'center', tokens, blockIndex, spaceBefore: 0.35 } });
        break;
      }
      case 'question': {
        const source = blocksToMarkdown([block], { withAnswers: true });

        hand(blockIndex, 'question', source, block.stem, SIZE.body, 0.5);
        (block.choices ?? []).forEach((choice, index) => {
          hand(blockIndex, 'question', '', `${letters[index] ?? index + 1}) ${choice}`, SIZE.small, 0);
        });

        if (withAnswers) {
          const answer =
            block.answerIndex !== undefined && block.choices?.[block.answerIndex] !== undefined
              ? `${letters[block.answerIndex]}) ${block.choices[block.answerIndex]}`
              : (block.answer ?? '');

          if (answer) hand(blockIndex, 'question', '', `${CONTENT_LABELS.answer}: ${answer}`, SIZE.small, 0.15);
          if (block.explanation) hand(blockIndex, 'question', '', block.explanation, SIZE.small, 0);
        }

        break;
      }
      default:
        items.push({ type: 'typed', block, blockIndex });
    }
  });

  return items;
}

// ---------------------------------------------------------------------------
// Line breaking
// ---------------------------------------------------------------------------

export interface TokenMetrics {
  /** Advance width (on-screen px at the paragraph size). */
  width: number;
  /** Ink above / below the baseline. */
  ascent: number;
  descent: number;
}

export interface LaidToken {
  index: number;
  /** Left edge, measured from the column's left edge. */
  x: number;
  width: number;
}

export interface LaidLine {
  /** Token indexes in logical (reading) order. */
  tokens: number[];
  /** Same tokens placed left-to-right on the page. */
  placed: LaidToken[];
  width: number;
  ascent: number;
  descent: number;
}

/**
 * Greedy line breaking in reading order, then placement: each line starts at the left edge of the
 * column (`start`) or is centred. A token wider than the column stands alone on its line.
 */
export function breakHandLines(
  tokens: Pick<HandToken, 'dir'>[],
  metrics: TokenMetrics[],
  { maxWidth, space, align = 'start' }: { maxWidth: number; space: number; align?: 'start' | 'center' },
): LaidLine[] {
  const lines: number[][] = [];
  let current: number[] = [];
  let width = 0;

  tokens.forEach((_, index) => {
    const w = metrics[index]?.width ?? 0;
    const added = current.length === 0 ? w : width + space + w;

    if (current.length > 0 && added > maxWidth) {
      lines.push(current);
      current = [index];
      width = w;
    } else {
      current.push(index);
      width = added;
    }
  });

  if (current.length > 0) lines.push(current);

  return lines.map((line) => {
    const order = line;
    const lineWidth = order.reduce((sum, index, position) => sum + (metrics[index]?.width ?? 0) + (position > 0 ? space : 0), 0);
    let x = align === 'center' ? (maxWidth - lineWidth) / 2 : 0;

    const placed: LaidToken[] = order.map((index) => {
      const w = metrics[index]?.width ?? 0;
      const token = { index, x, width: w };

      x += w + space;

      return token;
    });

    return {
      tokens: line,
      placed,
      width: lineWidth,
      ascent: Math.max(0, ...line.map((index) => metrics[index]?.ascent ?? 0)),
      descent: Math.max(0, ...line.map((index) => metrics[index]?.descent ?? 0)),
    };
  });
}

// ---------------------------------------------------------------------------
// Humanising
// ---------------------------------------------------------------------------

/** Deterministic 32-bit hash of a string (FNV-1a) — same answer, same handwriting. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

/** mulberry32: tiny seeded PRNG, uniform in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WordWobble {
  /** Baseline shift, as a fraction of the font size. */
  dy: number;
  /** Rotation in degrees (drifts word to word, never past ±1.5°). */
  rotate: number;
  /** Size multiplier. */
  scale: number;
}

export const MAX_WORD_ROTATION = 1.5;

/** Per-word wobble for `count` words: a slow random walk in slope, small baseline and size noise. */
export function wordWobbles(random: () => number, count: number): WordWobble[] {
  const out: WordWobble[] = [];
  let rotate = (random() - 0.5) * MAX_WORD_ROTATION;

  for (let index = 0; index < count; index += 1) {
    rotate = Math.max(-MAX_WORD_ROTATION, Math.min(MAX_WORD_ROTATION, rotate * 0.55 + (random() - 0.5) * 1.6));
    out.push({ dy: (random() - 0.5) * 0.08, rotate, scale: 1 + (random() - 0.5) * 0.08 });
  }

  return out;
}

/** Per-glyph baseline jitter (fractions of the font size) for left-to-right words written letter by letter. */
export function glyphJitter(random: () => number, count: number): number[] {
  return Array.from({ length: count }, () => (random() - 0.5) * 0.06);
}

// ---------------------------------------------------------------------------
// The teacher's choice, remembered per board
// ---------------------------------------------------------------------------

export interface HandPrefs {
  /** «Write it by hand» — null = never chosen on this board (the action decides). */
  on: boolean | null;
  /** «Match my handwriting». */
  matchHand: boolean;
}

const HAND_PREFS_PREFIX = 'wb-ai-hand:';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const safeStorage = (): StorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function readHandPrefs(boardId: string | undefined, storage: StorageLike | null = safeStorage()): HandPrefs {
  try {
    const raw = storage?.getItem(`${HAND_PREFS_PREFIX}${boardId ?? 'device'}`);
    const parsed = raw ? (JSON.parse(raw) as Partial<HandPrefs>) : {};

    return { on: typeof parsed.on === 'boolean' ? parsed.on : null, matchHand: parsed.matchHand === true };
  } catch {
    return { on: null, matchHand: false };
  }
}

export function writeHandPrefs(boardId: string | undefined, prefs: HandPrefs, storage: StorageLike | null = safeStorage()): void {
  try {
    storage?.setItem(`${HAND_PREFS_PREFIX}${boardId ?? 'device'}`, JSON.stringify(prefs));
  } catch {
    /* convenience only */
  }
}

/** On by default for «Solve» / «Explain» answers until the teacher chooses otherwise on this board. */
export const handwritingDefault = (prefs: HandPrefs, action: string | null | undefined): boolean =>
  prefs.on ?? (action === 'solve' || action === 'explain');
