import { shapeWord } from './latin';
import { strokesBbox } from './normalize';
import { hashSeed, seededRandom } from '../handwritingLayout';

import type { ResolvedGlyph } from './latin';
import type { GlyphBank, GlyphKey, GlyphPoint, GlyphSample } from './types';

/**
 * «My handwriting» — write text with the owner's own letters. Pure: text + bank → stroked centerlines
 * in scene units. Per word: pick a glyph sample per letter (seeded) → place the letters left to right
 * → wobble, slant, scale. Words then flow into lines. A word with any letter the bank cannot write gets
 * NO strokes and is listed in `missing`; the caller draws it with the font pipeline. Coverage is the
 * fraction of words written here.
 */

export interface ComposeOptions {
  /** x-height in scene units (normalised 1 → this). */
  letterHeight: number;
  /** Lean of the up-strokes in degrees; positive = the top leans right (same sign as HandStyle). */
  slantDeg?: number;
  /** Pen width in scene units, carried on every output stroke. */
  strokeWidth: number;
  /** Variation seed — same seed, same ink. */
  seed?: number;
  /** Wrap width in scene units; unset = one line per paragraph. */
  maxWidth?: number;
  /** Space between words, in x-heights. */
  wordSpacing?: number;
  /** Baseline to baseline, in x-heights. */
  lineHeight?: number;
}

export interface ComposedStroke {
  points: GlyphPoint[];
  width: number;
}

export interface ComposedGlyph {
  char: string;
  form: ResolvedGlyph['form'];
  key: GlyphKey;
  /** Scene units, in the line's coordinate space. */
  bbox: Bbox;
}

export interface ComposedWord {
  text: string;
  /** Left edge in the line's coordinate space (scene units). */
  x: number;
  width: number;
  /** No strokes — draw it with the font pipeline at (x, baseline). */
  missing: boolean;
  glyphs: ComposedGlyph[];
}

export interface ComposedLine {
  strokes: ComposedStroke[];
  width: number;
  /** Words the bank could not write (reading order). */
  missing: string[];
  words: ComposedWord[];
  /** Baseline y of this line (scene units from the block top). */
  baselineY: number;
}

export interface Composition {
  lines: ComposedLine[];
  /** Fraction of words written with bank glyphs (1 when there are no words). */
  coverage: number;
  width: number;
  height: number;
}

type Bbox = GlyphSample['bbox'];
type Point = GlyphPoint;

/** Tuning, all in x-heights. */
export const LETTER_GAP = 0.3;
export const DOT_GAP = 0.18;
export const MISSING_LETTER_ADVANCE = 0.8;
export const DEFAULT_WORD_SPACING = 0.7;
export const DEFAULT_LINE_HEIGHT = 3.6;
export const MIN_FIRST_ASCENT = 2.4;
const SCALE_JITTER = 0.04;
const ROTATION_JITTER_DEG = 1.5;
const POINT_JITTER = 0.012;

// ---------------------------------------------------------------------------
// Geometry helpers (normalised space)
// ---------------------------------------------------------------------------

const translate = (strokes: Point[][], dx: number, dy: number): Point[][] => strokes.map((stroke) => stroke.map(([x, y, p]): Point => [x + dx, y + dy, p]));

const translateBbox = (bbox: Bbox, dx: number, dy: number): Bbox => ({ x: bbox.x + dx, y: bbox.y + dy, w: bbox.w, h: bbox.h });

const unionBbox = (boxes: Bbox[]): Bbox => {
  const real = boxes.filter((box) => box.w > 0 || box.h > 0 || box.x !== 0 || box.y !== 0);

  if (real.length === 0) return { x: 0, y: 0, w: 0, h: 0 };

  const minX = Math.min(...real.map((box) => box.x));
  const minY = Math.min(...real.map((box) => box.y));
  const maxX = Math.max(...real.map((box) => box.x + box.w));
  const maxY = Math.max(...real.map((box) => box.y + box.h));

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

interface PlacedGlyph {
  strokes: Point[][];
  entry: [number, number];
  exit: [number, number];
  bbox: Bbox;
}

/**
 * One sample with this instance's wobble: ±4 % scale and ±1.5° rotation about the entry anchor, then
 * a little jitter on every point. Anchors move with the glyph so the chain stays closed.
 */
function wobbleSample(sample: GlyphSample, random: () => number, scaleBy = 1): PlacedGlyph {
  const scale = scaleBy * (1 + (random() - 0.5) * 2 * SCALE_JITTER);
  const angle = ((random() - 0.5) * 2 * ROTATION_JITTER_DEG * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [ex, ey] = sample.entry;
  const map = (x: number, y: number): [number, number] => {
    const dx = (x - ex) * scale;
    const dy = (y - ey) * scale;

    return [ex + dx * cos - dy * sin, ey + dx * sin + dy * cos];
  };
  const strokes = sample.strokes.map((stroke) =>
    stroke.map(([x, y, p]): Point => {
      const [mx, my] = map(x, y);

      return [mx + (random() - 0.5) * 2 * POINT_JITTER, my + (random() - 0.5) * 2 * POINT_JITTER, p];
    }),
  );

  return { strokes, entry: [ex, ey], exit: map(sample.exit[0], sample.exit[1]), bbox: strokesBbox(strokes) };
}

// ---------------------------------------------------------------------------
// Bank lookup
// ---------------------------------------------------------------------------

function lookup(bank: GlyphBank, keys: GlyphKey[]): { key: GlyphKey; samples: GlyphSample[] } | null {
  for (const key of keys) {
    const entry = bank.glyphs[key];

    if (entry && entry.samples.length > 0) return { key, samples: entry.samples };
  }

  return null;
}

const pickSample = (samples: GlyphSample[], random: () => number): GlyphSample => samples[Math.min(samples.length - 1, Math.floor(random() * samples.length))]!;

/** Can the bank write every glyph of the word? */
export function wordIsWritable(word: string, bank: GlyphBank): boolean {
  const glyphs = shapeWord(word);

  if (glyphs.length === 0) return false;

  return glyphs.every((glyph) => glyph.candidates.length > 0 && lookup(bank, glyph.candidates) !== null);
}

// ---------------------------------------------------------------------------
// Synthesised punctuation
// ---------------------------------------------------------------------------

/** Place a decoration sample by its bbox: centred on `cx`, resting on (`above`) or hanging from (`below`) `edgeY`. */
function placeDecor(placed: PlacedGlyph, cx: number, edgeY: number, position: 'above' | 'below'): PlacedGlyph {
  const dx = cx - (placed.bbox.x + placed.bbox.w / 2);
  const dy = position === 'above' ? edgeY - DOT_GAP - (placed.bbox.y + placed.bbox.h) : edgeY + DOT_GAP - placed.bbox.y;

  return { strokes: translate(placed.strokes, dx, dy), entry: placed.entry, exit: placed.exit, bbox: translateBbox(placed.bbox, dx, dy) };
}

/** `.` `,` `:` from the owner's own dot: on the baseline, hanging under it, or two stacked. */
function synthPunctuation(kind: NonNullable<ResolvedGlyph['synth']>, dot: GlyphSample, random: () => number): PlacedGlyph {
  const one = wobbleSample(dot, random);
  const w = one.bbox.w;
  // placeDecor keeps DOT_GAP from the edge it is given; cancel it so the dot lands exactly where asked.
  const bottomAt = (y: number) => placeDecor(one, -w / 2, y + DOT_GAP, 'above');
  const topAt = (y: number) => placeDecor(one, -w / 2, y - DOT_GAP, 'below');

  if (kind === 'colon') {
    const low = bottomAt(0.05);
    const high = bottomAt(-0.55);

    return { strokes: [...low.strokes, ...high.strokes], entry: [-w, 0], exit: [0, 0], bbox: unionBbox([low.bbox, high.bbox]) };
  }

  const placed = kind === 'period' ? bottomAt(0.05) : topAt(0.08);

  return { ...placed, entry: [-w, 0], exit: [0, 0] };
}

// ---------------------------------------------------------------------------
// One word → strokes in word-local normalised space (starts at x = 0)
// ---------------------------------------------------------------------------

interface WordResult {
  strokes: Point[][];
  bbox: Bbox;
  glyphs: Array<{ glyph: ResolvedGlyph; key: GlyphKey; bbox: Bbox }>;
}

function composeWord(word: string, bank: GlyphBank, random: () => number): WordResult | null {
  const glyphs = shapeWord(word);

  if (glyphs.length === 0) return null;

  const strokes: Point[][] = [];
  const info: WordResult['glyphs'] = [];
  const boxes: Bbox[] = [];
  let penX = 0;

  for (const glyph of glyphs) {
    const found = lookup(bank, glyph.candidates);

    if (!found) return null;

    const sample = pickSample(found.samples, random);
    let placed = glyph.synth ? synthPunctuation(glyph.synth, sample, random) : wobbleSample(sample, random);
    // Horizontal only: the baseline is the glyph's own and must not move. The ink starts at the pen.
    const dx = penX - Math.min(placed.entry[0], placed.bbox.x);

    placed = { strokes: translate(placed.strokes, dx, 0), entry: [placed.entry[0] + dx, placed.entry[1]], exit: [placed.exit[0] + dx, placed.exit[1]], bbox: translateBbox(placed.bbox, dx, 0) };
    placed.strokes.forEach((stroke) => strokes.push(stroke));
    boxes.push(placed.bbox);
    info.push({ glyph, key: found.key, bbox: placed.bbox });
    penX = Math.max(placed.exit[0], placed.bbox.x + placed.bbox.w) + LETTER_GAP;
  }

  return { strokes, bbox: unionBbox(boxes), glyphs: info };
}

// ---------------------------------------------------------------------------
// Text → lines
// ---------------------------------------------------------------------------

interface MeasuredWord {
  text: string;
  /** Normalised, slanted, unscaled. Null = missing. */
  result: WordResult | null;
  /** Scene units. */
  width: number;
  ascent: number;
  descent: number;
}

const shear = (strokes: Point[][], tan: number): Point[][] => strokes.map((stroke) => stroke.map(([x, y, p]): Point => [x - y * tan, y, p]));

const shearBbox = (bbox: Bbox, tan: number): Bbox => {
  const xs = [bbox.x - bbox.y * tan, bbox.x - (bbox.y + bbox.h) * tan, bbox.x + bbox.w - bbox.y * tan, bbox.x + bbox.w - (bbox.y + bbox.h) * tan];
  const minX = Math.min(...xs);

  return { x: minX, y: bbox.y, w: Math.max(...xs) - minX, h: bbox.h };
};

export function composeText(text: string, bank: GlyphBank, options: ComposeOptions): Composition {
  const { letterHeight, strokeWidth, slantDeg = 0, seed = 0, maxWidth, wordSpacing = DEFAULT_WORD_SPACING, lineHeight = DEFAULT_LINE_HEIGHT } = options;
  const tan = Math.tan((slantDeg * Math.PI) / 180);
  const words = text.split(/\s+/).filter(Boolean);

  const measured: MeasuredWord[] = words.map((word, index) => {
    const random = seededRandom(hashSeed(`${seed}:${index}:${word}`) ^ (seed >>> 0));
    const result = composeWord(word, bank, random);

    if (!result) {
      return { text: word, result: null, width: Array.from(word).length * MISSING_LETTER_ADVANCE * letterHeight, ascent: 0, descent: 0 };
    }

    const slantedStrokes = shear(result.strokes, tan);
    const slanted: WordResult = {
      strokes: slantedStrokes,
      // The word's box comes from the sheared ink itself (a sheared rectangle over-estimates it).
      bbox: tan === 0 ? result.bbox : strokesBbox(slantedStrokes),
      glyphs: result.glyphs.map((glyph) => ({ ...glyph, bbox: shearBbox(glyph.bbox, tan) })),
    };

    return {
      text: word,
      result: slanted,
      width: slanted.bbox.w * letterHeight,
      ascent: Math.max(0, -slanted.bbox.y) * letterHeight,
      descent: Math.max(0, slanted.bbox.y + slanted.bbox.h) * letterHeight,
    };
  });

  // Greedy line breaking in reading order.
  const space = wordSpacing * letterHeight;
  const limit = maxWidth ?? Infinity;
  const lineIndexes: number[][] = [];
  let current: number[] = [];
  let width = 0;

  measured.forEach((word, index) => {
    const added = current.length === 0 ? word.width : width + space + word.width;

    if (current.length > 0 && added > limit) {
      lineIndexes.push(current);
      current = [index];
      width = word.width;
    } else {
      current.push(index);
      width = added;
    }
  });

  if (current.length > 0) lineIndexes.push(current);

  const scalePoints = (strokes: Point[][], dx: number, baselineY: number): Point[][] => strokes.map((stroke) => stroke.map(([x, y, p]): Point => [x * letterHeight + dx, y * letterHeight + baselineY, p]));
  const scaleBbox = (bbox: Bbox, dx: number, baselineY: number): Bbox => ({ x: bbox.x * letterHeight + dx, y: bbox.y * letterHeight + baselineY, w: bbox.w * letterHeight, h: bbox.h * letterHeight });

  let baselineY = 0;
  let blockWidth = 0;
  const lines: ComposedLine[] = lineIndexes.map((indexes, lineNumber) => {
    const ascent = Math.max(MIN_FIRST_ASCENT * letterHeight, ...indexes.map((index) => measured[index]!.ascent));

    baselineY = lineNumber === 0 ? ascent : baselineY + lineHeight * letterHeight;

    const lineWidth = indexes.reduce((sum, index, position) => sum + measured[index]!.width + (position > 0 ? space : 0), 0);
    const strokes: ComposedStroke[] = [];
    const placedWords: ComposedWord[] = [];
    let x = 0;

    indexes.forEach((index) => {
      const word = measured[index]!;
      const left = x;

      if (word.result) {
        const dx = left - word.result.bbox.x * letterHeight;

        scalePoints(word.result.strokes, dx, baselineY).forEach((points) => strokes.push({ points, width: strokeWidth }));
        placedWords.push({
          text: word.text,
          x: left,
          width: word.width,
          missing: false,
          glyphs: word.result.glyphs.map((glyph) => ({
            char: glyph.glyph.char,
            form: glyph.glyph.form,
            key: glyph.key,
            bbox: scaleBbox(glyph.bbox, dx, baselineY),
          })),
        });
      } else {
        placedWords.push({ text: word.text, x: left, width: word.width, missing: true, glyphs: [] });
      }

      x += word.width + space;
    });

    blockWidth = Math.max(blockWidth, lineWidth);

    return {
      strokes,
      width: lineWidth,
      missing: indexes.filter((index) => !measured[index]!.result).map((index) => measured[index]!.text),
      words: placedWords,
      baselineY,
    };
  });

  const written = measured.filter((word) => word.result).length;
  const lastDescent = lines.length > 0 ? Math.max(0, ...lineIndexes[lineIndexes.length - 1]!.map((index) => measured[index]!.descent)) : 0;

  return {
    lines,
    coverage: measured.length === 0 ? 1 : written / measured.length,
    width: blockWidth,
    height: lines.length > 0 ? baselineY + Math.max(lastDescent, letterHeight) : 0,
  };
}
