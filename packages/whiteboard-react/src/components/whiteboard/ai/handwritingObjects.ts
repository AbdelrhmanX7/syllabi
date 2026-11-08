import { Group, Path } from 'fabric';

import type { FabricObject } from 'fabric';

import { AI_OBJECT_PROP, buildBlockObjects, objectsBounds, registerAiObjectPersistence, translateObjects } from './boardObjects';
import { BOARD_TEXT_FONT, renderMathImage } from './rasterize';
import { breakHandLines, glyphJitter, handItemsFromBlocks, hashSeed, seededRandom, wordWobbles } from './handwritingLayout';
import { ringsToPathData, traceToRings } from './inkTrace';
import { toneInk } from './tones';

import type { AiObjectTag, BuildOptions } from './boardObjects';
import type { HandStyle } from './handStyle';
import type { HandParagraph, HandToken, TokenMetrics } from './handwritingLayout';
import type { TracePoint } from './inkTrace';
import type { BoardAiBlock } from './types';

/**
 * «Write it by hand» — the answer WRITTEN on the board: every word drawn with a bundled
 * handwriting font, traced into a filled vector outline (`inkTrace`), wobbled a little like a hand
 * does (`handwritingLayout`), and filled with the teacher's pen colour plus a thin same-colour stroke
 * as wide as the nib suggests. Formulas KaTeX draws go through the same tracing, so `\frac` and `√`
 * look written too. One Group per written line — movable, erasable, one undo step, saved as plain
 * Fabric paths — with the source text on the line's `wbAi` tag so copying the answer still works.
 */

/** Aref Ruqaa (SIL OFL 1.1) — bundled with the app under `public/font`, so it works offline. */
export const HAND_FONT_FAMILY = 'WB Hand Ruqaa';
let handFontUrl = '/font/ArefRuqaa-Regular.woff2';

/** Host apps that serve the font somewhere else point the board at it before the first insert. */
export function setHandwritingFontUrl(url: string): void {
  handFontUrl = url;
  fontPromise = null;
}

let fontPromise: Promise<boolean> | null = null;

/** Loads the handwriting font once. False = not available (the board font is traced instead). */
export function ensureHandFont(): Promise<boolean> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return Promise.resolve(false);

  if (!fontPromise) {
    fontPromise = (async () => {
      try {
        const face = new FontFace(HAND_FONT_FAMILY, `url(${handFontUrl}) format('woff2')`, { display: 'block' });

        await Promise.race([face.load(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))]);
        document.fonts.add(face);

        return true;
      } catch {
        fontPromise = null;

        return false;
      }
    })();
  }

  return fontPromise;
}

/** Raster px per on-screen px when a word is drawn for tracing. */
const RASTER = 3;
/** What the tracer works on: a word, its pixel origin and baseline, and its size in on-screen px. */
interface TracedToken {
  rings: TracePoint[][];
  /** Raster px of the advance's left edge and of the baseline. */
  originX: number;
  baselineY: number;
  metrics: TokenMetrics;
}

function scratchContext(width: number, height: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas');

  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));

  return canvas.getContext('2d', { willReadFrequently: true });
}

function alphaOf(ctx: CanvasRenderingContext2D): Uint8Array {
  const { width, height } = ctx.canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);

  for (let index = 0; index < alpha.length; index += 1) alpha[index] = data[index * 4 + 3]!;

  return alpha;
}

/** One word → traced outline, drawn letter by letter with a little baseline jitter each. */
function traceWord(text: string, fontPx: number, family: string, jitter: number[] | null): TracedToken | null {
  const px = fontPx * RASTER;
  const font = `${px}px ${family}`;
  const probe = scratchContext(1, 1);

  if (!probe) return null;

  probe.font = font;

  const metrics = probe.measureText(text);
  const ascent = Math.max(metrics.actualBoundingBoxAscent, px * 0.2);
  const descent = Math.max(metrics.actualBoundingBoxDescent, 0);
  const left = Math.max(0, metrics.actualBoundingBoxLeft);
  const right = Math.max(metrics.width, metrics.actualBoundingBoxRight);
  const pad = Math.ceil(px * 0.12) + 4;
  const ctx = scratchContext(left + right + pad * 2, ascent + descent + pad * 2 + px * 0.1);

  if (!ctx) return null;

  const originX = pad + left;
  const baselineY = pad + ascent + px * 0.05;

  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';

  if (jitter) {
    const chars = Array.from(text);
    let prefix = '';

    chars.forEach((char, index) => {
      const x = originX + ctx.measureText(prefix).width;

      ctx.fillText(char, x, baselineY + (jitter[index] ?? 0) * px);
      prefix += char;
    });
  } else {
    ctx.fillText(text, originX, baselineY);
  }

  const rings = traceToRings(alphaOf(ctx), ctx.canvas.width, ctx.canvas.height, { epsilon: 1.1, minArea: 3 });

  return { rings, originX, baselineY, metrics: { width: metrics.width / RASTER, ascent: ascent / RASTER, descent: descent / RASTER } };
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  const image = new Image();

  image.decoding = 'async';
  image.src = src;

  try {
    await image.decode();

    return image;
  } catch {
    return null;
  }
}

/** A KaTeX formula → its traced outline, centred on the line's math axis. Null where KaTeX cannot draw. */
async function traceMath(tex: string, fontPx: number): Promise<TracedToken | null> {
  const raster = await renderMathImage(tex, { fontPx, color: '#000', pixelRatio: RASTER });
  const image = raster ? await loadImage(raster.dataUrl) : null;

  if (!raster || !image) return null;

  const ctx = scratchContext(image.naturalWidth, image.naturalHeight);

  if (!ctx) return null;

  ctx.drawImage(image, 0, 0);

  let alpha: Uint8Array;

  try {
    alpha = alphaOf(ctx);
  } catch {
    return null; // a tainted canvas (WebKit foreignObject): the caller writes the readable text instead
  }

  const rings = traceToRings(alpha, ctx.canvas.width, ctx.canvas.height, { epsilon: 1.1, minArea: 3 });
  // The formula's middle sits on the math axis, about a third of the font size above the baseline.
  const axis = fontPx * 0.32;
  const half = raster.height / 2;

  return {
    rings,
    originX: 0,
    baselineY: (half + axis) * (ctx.canvas.height / raster.height),
    metrics: { width: raster.width, ascent: half + axis, descent: Math.max(0, half - axis) },
  };
}

export interface HandwritingOptions extends BuildOptions {
  /** The teacher's pen width in on-screen px — the outline's stroke follows it. */
  penWidth?: number;
  /** «Match my handwriting»: slant / size / width / colour read from the teacher's own ink. */
  style?: HandStyle | null;
  /** Same seed → same handwriting (tests, re-renders). Defaults to a hash of the answer. */
  seed?: number;
}

/** One written word, for the write-on animation (scene coordinates, before the caller moves it). */
export interface WriteOnStroke {
  d: string;
  line: number;
  bounds: { left: number; top: number; width: number; height: number };
  /** Its ink when not the build's `fill` (a toned callout, tones.ts). */
  color?: string;
}

export interface HandwritingBuild {
  objects: FabricObject[];
  strokes: WriteOnStroke[];
  fill: string;
  strokeWidth: number;
}

const tagObject = <T extends FabricObject>(object: T, value: AiObjectTag): T => {
  (object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = value;

  return object;
};

/**
 * Blocks → handwritten objects stacked from (0, 0), like {@link buildBlockObjects}. Tables, diagrams
 * and pictures are built the usual way in between the written paragraphs.
 */
export async function buildHandwritingObjects(blocks: BoardAiBlock[], options: HandwritingOptions): Promise<HandwritingBuild> {
  registerAiObjectPersistence();

  const hasFont = await ensureHandFont();
  const family = hasFont ? `'${HAND_FONT_FAMILY}', ${BOARD_TEXT_FONT}` : BOARD_TEXT_FONT;
  const unit = 1 / (options.zoom > 0 ? options.zoom : 1);
  const widthPx = options.widthPx ?? 540;
  const style = options.style ?? null;
  const fill = style?.color ?? options.color;
  // Scene letter height → a size multiplier: Ruqaa's letter strokes run ≈ 0.65 em tall.
  const sizeScale = style && style.letterHeight > 0 ? Math.max(0.7, Math.min(1.6, style.letterHeight / unit / (32 * 0.5))) : 1;
  const nibPx = style && style.strokeWidth > 0 ? style.strokeWidth / unit : (options.penWidth ?? 2.5);
  const strokeWidth = Math.max(0.45, Math.min(2.4, nibPx * 0.38)) * unit;
  const slant = Math.tan(((style?.slantDeg ?? 0) * Math.PI) / 180);
  const random = seededRandom(options.seed ?? hashSeed(JSON.stringify(blocks)));
  const items = handItemsFromBlocks(blocks, { withAnswers: options.withAnswers, lang: options.lang });
  const objects: FabricObject[] = [];
  const strokes: WriteOnStroke[] = [];
  const gapPx = 12;
  let y = 0; // on-screen px from the top
  let lineCounter = 0;

  for (const item of items) {
    if (item.type === 'typed') {
      const parts = await buildBlockObjects([item.block], { ...options, color: toneInk(item.block.tone) ?? fill });

      if (parts.length > 0) {
        const bounds = objectsBounds(parts);

        translateObjects(parts, 0, y * unit - bounds.top);
        objects.push(...parts);
        y += bounds.height / unit + gapPx;
      }

      continue;
    }

    const paragraph: HandParagraph = item.paragraph;
    const toneFill = toneInk(blocks[paragraph.blockIndex]?.tone);
    const inkFill = toneFill ?? fill;
    const fontPx = paragraph.size * sizeScale;
    const pitch = fontPx * 1.85;
    const wobbles = wordWobbles(random, paragraph.tokens.length);
    const traced = await Promise.all(
      paragraph.tokens.map(async (token: HandToken, index) => {
        const jitter = glyphJitter(random, Array.from(token.text).length);
        const scale = wobbles[index]!.scale;

        if (token.kind === 'math' && token.tex) {
          // A display formula at full size; an inline one a little smaller so it sits in the line.
          const math = await traceMath(token.tex, fontPx * (paragraph.kind === 'math' ? 0.92 : 0.8) * scale);

          if (math) return math;
        }

        return traceWord(token.text, fontPx * scale, family, jitter);
      }),
    );
    const metrics = traced.map((token) => token?.metrics ?? { width: 0, ascent: 0, descent: 0 });
    const lines = breakHandLines(paragraph.tokens, metrics, { maxWidth: widthPx, space: fontPx * 0.34, align: paragraph.align });

    y += paragraph.spaceBefore * pitch;

    lines.forEach((line, lineIndex) => {
      const baseline = y + Math.max(line.ascent + fontPx * 0.08, pitch * 0.6);
      // The whole line drifts a hair off level, like a line written without a ruler.
      const lineTilt = Math.tan(((random() - 0.5) * 0.8 * Math.PI) / 180);
      const right = widthPx;
      const words: Path[] = [];

      for (const placed of line.placed) {
        const token = traced[placed.index];

        if (!token || token.rings.length === 0) continue;

        const wobble = wobbles[placed.index]!;
        const theta = (wobble.rotate * Math.PI) / 180;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const pivotX = placed.width / 2;
        const pivotY = -fontPx * 0.3;
        const dy = wobble.dy * fontPx + (placed.x + placed.width / 2 - right) * lineTilt;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const d = ringsToPathData(token.rings, (point) => {
          // Raster px → on-screen px around the word's own baseline origin.
          let lx = (point.x - token.originX) / RASTER;
          const ly = (point.y - token.baselineY) / RASTER;

          lx -= ly * slant; // the teacher's lean: above the baseline shifts right for a positive slant
          const rx = pivotX + (lx - pivotX) * cos - (ly - pivotY) * sin;
          const ry = pivotY + (lx - pivotX) * sin + (ly - pivotY) * cos;
          const sx = (placed.x + rx) * unit;
          const sy = (baseline + dy + ry) * unit;

          minX = Math.min(minX, sx);
          minY = Math.min(minY, sy);
          maxX = Math.max(maxX, sx);
          maxY = Math.max(maxY, sy);

          return { x: sx, y: sy };
        });

        if (!d) continue;

        const isFormula = paragraph.tokens[placed.index]!.kind === 'math';

        words.push(
          new Path(d, {
            fill: inkFill,
            stroke: inkFill,
            // KaTeX glyphs are already heavier than the pen font: widen them less.
            strokeWidth: isFormula ? strokeWidth * 0.55 : strokeWidth,
            strokeLineJoin: 'round',
            strokeLineCap: 'round',
            fillRule: 'evenodd',
          }),
        );
        strokes.push({
          d,
          line: lineCounter,
          bounds: { left: minX, top: minY, width: maxX - minX, height: maxY - minY },
          ...(toneFill ? { color: toneFill } : {}),
        });
      }

      if (words.length > 0) {
        const group = new Group(words, { originX: 'left', originY: 'top', subTargetCheck: false });

        objects.push(
          tagObject(group, {
            kind: paragraph.kind,
            source: lineIndex === 0 && paragraph.source ? paragraph.source : undefined,
            batch: options.batch,
            hand: true,
          }),
        );
      }

      lineCounter += 1;
      y = baseline + Math.max(line.descent + fontPx * 0.1, pitch * 0.4);
    });

    y += gapPx * 0.4;
  }

  return { objects, strokes, fill, strokeWidth };
}
