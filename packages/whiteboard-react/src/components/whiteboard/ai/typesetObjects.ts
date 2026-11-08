import { Circle, FabricImage, FabricText, Group, IText, Line, Rect, StaticCanvas, Textbox } from 'fabric';

import type { FabricObject } from 'fabric';

import { breakHandLines } from './handwritingLayout';
import { inlineMathToText } from './latexText';
import { stripInlineMarkdown } from './markdownBlocks';
import { BOARD_TEXT_FONT, ensureBoardFonts, renderMathImage } from './rasterize';
import {
  bboxToRect,
  choiceLine,
  fitFontSize,
  groupOverlayBlocks,
  layoutChoices,
  needsTypesetMath,
  placeImageLabels,
  resolveOverlayGroup,
  tokenizeTypeset,
} from './typesetLayout';

import type { TokenMetrics } from './handwritingLayout';
import type { RasterResult } from './rasterize';
import type { ImageLabelInput, TypesetToken } from './typesetLayout';
import type { RemakeOverlayBlock, SceneRect } from './types';

/**
 * «Typed» AI text on the board, in IBM Plex Sans with KaTeX math:
 *  - prose with only plain formulas → one editable Textbox (formulas as readable text);
 *  - prose with a real formula (fraction, root, script, Greek…) → a line-broken paragraph where each
 *    run of words is an editable IText and each formula a KaTeX picture sitting on the
 *    run's baseline, grouped (interactive: every piece can still be picked and edited);
 *  - a box to fill (the remake overlay) → the largest size whose layout fits, shrunk step by step.
 * Every builder awaits the font gate first, so Fabric never caches fallback-font metrics.
 */

export type TypesetWeight = 400 | 500 | 600 | 700;
export type TypesetAlign = 'right' | 'center' | 'left';

export interface TypesetStyle {
  /** Scene units. */
  fontSize: number;
  weight?: TypesetWeight;
  color: string;
  align?: TypesetAlign;
  /** Line pitch as a multiple of the font size. */
  lineHeight?: number;
}

const TOP_LEFT = { originX: 'left' as const, originY: 'top' as const };

/**
 * A cached object is drawn into an offscreen canvas the size of its MEASURED box, which clips any
 * paint past it (italic overhangs, KaTeX pictures). Text, and every group holding text, skips the cache.
 */
const NO_CACHE = { objectCaching: false } as const;

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null = null;

/** One-line width of `text` in the board font, scene units. */
export function measureBoardText(text: string, fontSize: number, weight: number = 400): number {
  if (typeof document === 'undefined') return text.length * fontSize * 0.5;

  measureCtx ??= document.createElement('canvas').getContext('2d');

  if (!measureCtx) return text.length * fontSize * 0.5;

  // Measured at the size it is drawn at: advances are NOT linear in the size (hinting), and this is
  // the width the canvas really paints.
  const size = Math.max(1, fontSize);

  measureCtx.font = `${weight} ${size}px ${BOARD_TEXT_FONT}`;
  measureCtx.direction = 'ltr';

  return (measureCtx.measureText(text).width * fontSize) / size;
}

/** Where Fabric draws a single line's baseline, below the text object's top (lineHeight-independent). */
export function fabricBaselineOffset(text: FabricText): number {
  const internals = text as unknown as { _fontSizeMult?: number; _fontSizeFraction?: number };

  return (text.fontSize ?? 16) * (internals._fontSizeMult ?? 1.13) * (1 - (internals._fontSizeFraction ?? 0.222));
}

// IBM Plex Sans's ink above / below the baseline, per font-size unit.
const WORD_ASCENT = 0.95;
const WORD_DESCENT = 0.42;
/** KaTeX at this fraction of the text size matches Plex's x-height (KaTeX itself scales by 1.21). */
const MATH_SCALE = 0.86;

interface PreparedMath {
  raster: RasterResult;
  image: FabricImage;
  /** The size it was rasterised for. */
  refSize: number;
}

interface PreparedRich {
  tokens: TypesetToken[];
  maths: Map<number, PreparedMath>;
  weight: TypesetWeight;
}

async function imageFrom(dataUrl: string): Promise<FabricImage | null> {
  try {
    return await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
  } catch {
    return null;
  }
}

async function prepareRich(markdown: string, style: TypesetStyle): Promise<PreparedRich> {
  const tokens = tokenizeTypeset(markdown);
  const maths = new Map<number, PreparedMath>();
  // Rasterised once, big enough to stay crisp at the largest size a fit may try; scaled after.
  const refPx = 40;

  await Promise.all(
    tokens.map(async (token, index) => {
      if (token.kind !== 'math' || !token.tex) return;

      const raster = await renderMathImage(token.tex, { fontPx: refPx * MATH_SCALE, color: style.color, display: false, pixelRatio: 3 });
      const image = raster ? await imageFrom(raster.dataUrl) : null;

      if (raster && image) maths.set(index, { raster, image, refSize: refPx });
    }),
  );

  return { tokens, maths, weight: style.weight ?? 400 };
}

function tokenMetrics(prepared: PreparedRich, fontSize: number): TokenMetrics[] {
  return prepared.tokens.map((token, index) => {
    const math = prepared.maths.get(index);

    if (math) {
      const k = fontSize / math.refSize;
      const baseline = math.raster.baseline ?? math.raster.height * 0.72;

      return { width: math.raster.width * k, ascent: baseline * k, descent: Math.max(0, (math.raster.height - baseline) * k) };
    }

    return { width: measureBoardText(token.text, fontSize, prepared.weight), ascent: fontSize * WORD_ASCENT, descent: fontSize * WORD_DESCENT };
  });
}

interface RichLayout {
  lines: Array<{ placed: Array<{ index: number; x: number; width: number }>; top: number; baseline: number; width: number }>;
  width: number;
  height: number;
}

function layoutRich(prepared: PreparedRich, fontSize: number, maxWidth: number, align: TypesetAlign, lineHeight: number): RichLayout {
  const metrics = tokenMetrics(prepared, fontSize);
  const space = fontSize * 0.28;
  const lines = breakHandLines(prepared.tokens, metrics, { maxWidth, space, align: align === 'center' ? 'center' : 'start' });
  let y = 0;
  let widest = 0;
  const laid = lines.map((line) => {
    const ascent = Math.max(fontSize * WORD_ASCENT, line.ascent);
    const descent = Math.max(fontSize * WORD_DESCENT, line.descent);
    const pitch = Math.max(fontSize * lineHeight, ascent + descent + fontSize * 0.12);
    const top = y;
    const baseline = top + (pitch - ascent - descent) / 2 + ascent;
    // `right` alignment: the line hugs the right edge instead of the left.
    const shift = align === 'right' ? maxWidth - line.width : 0;

    y += pitch;
    widest = Math.max(widest, line.width);

    return { placed: line.placed.map((placed) => ({ ...placed, x: placed.x + shift })), top, baseline, width: line.width };
  });

  return { lines: laid, width: widest, height: y };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** The plain path: an editable Textbox, formulas as readable text. */
function plainTextbox(markdown: string, style: TypesetStyle, width: number): Textbox {
  const text = inlineMathToText(stripInlineMarkdown(markdown));
  const align = style.align ?? 'left';

  return new Textbox(text, {
    ...TOP_LEFT,
    ...NO_CACHE,
    left: 0,
    width,
    fontSize: style.fontSize,
    fontFamily: BOARD_TEXT_FONT,
    fontWeight: style.weight ?? 400,
    fill: style.color,
    textAlign: align,
    lineHeight: style.lineHeight ?? 1.3,
    editable: true,
    selectable: true,
    evented: true,
  });
}

/** Re-sizes a {@link plainTextbox} for another font size / outer width. */
function resizePlain(box: Textbox, fontSize: number, width: number, _align?: TypesetAlign): void {
  box.set({ fontSize, width, left: 0 });
  box.initDimensions();
}

/** Laid-out rich paragraph → pieces at (0,0)-relative scene coordinates. */
function richPieces(prepared: PreparedRich, layout: RichLayout, style: TypesetStyle): FabricObject[] {
  const pieces: FabricObject[] = [];
  const fontSize = style.fontSize;

  for (const line of layout.lines) {
    // Runs of words between formulas, left to right, become one IText each.
    let run: Array<{ index: number; x: number; width: number }> = [];
    const flush = () => {
      if (run.length === 0) return;

      const logical = [...run].sort((a, b) => a.index - b.index);
      const text = logical.map((token) => prepared.tokens[token.index]!.text).join(' ');
      const piece = new IText(text, {
        ...TOP_LEFT,
        ...NO_CACHE,
        fontSize,
        fontFamily: BOARD_TEXT_FONT,
        fontWeight: style.weight ?? 400,
        fill: style.color,
        textAlign: 'left',
        lineHeight: 1,
      });

      piece.set({ left: run[0]!.x, top: line.baseline - fabricBaselineOffset(piece) });
      pieces.push(piece);
      run = [];
    };

    for (const placed of line.placed) {
      const token = prepared.tokens[placed.index]!;
      const math = prepared.maths.get(placed.index);

      if (math) {
        flush();

        const k = fontSize / math.refSize;
        const scale = (math.raster.width / (math.image.width || 1)) * k;
        const baseline = math.raster.baseline ?? math.raster.height * 0.72;
        const image = math.image;

        image.set({ ...TOP_LEFT, left: placed.x, top: line.baseline - baseline * k, scaleX: scale, scaleY: scale });
        (image as unknown as Record<string, unknown>).wbAi = { kind: 'math', source: token.tex };
        pieces.push(image);
        continue;
      }

      run.push(placed);
    }

    flush();
  }

  return pieces;
}

/** Wraps rich pieces in one interactive group: it moves as a paragraph, each piece stays editable. */
function richGroup(pieces: FabricObject[]): Group {
  return new Group(pieces, { ...TOP_LEFT, ...NO_CACHE, interactive: true, subTargetCheck: true });
}

export interface TypesetResult {
  object: FabricObject;
  width: number;
  height: number;
}

/**
 * Markdown (one paragraph, `$…$` inline math) → a board object `maxWidth` wide (scene units), its
 * top-left at (0, 0). A Textbox when no formula needs KaTeX, otherwise a typeset group.
 */
export async function buildTypeset(markdown: string, style: TypesetStyle, maxWidth: number): Promise<TypesetResult> {
  await ensureBoardFonts();

  if (!needsTypesetMath(markdown)) {
    const box = plainTextbox(markdown, style, maxWidth);

    return { object: box, width: maxWidth, height: box.height ?? style.fontSize };
  }

  const prepared = await prepareRich(markdown, style);
  const layout = layoutRich(prepared, style.fontSize, maxWidth, style.align ?? 'left', style.lineHeight ?? 1.45);
  const pieces = richPieces(prepared, layout, style);

  if (pieces.length === 0) {
    const box = plainTextbox(markdown, style, maxWidth);

    return { object: box, width: maxWidth, height: box.height ?? style.fontSize };
  }

  const group = richGroup(pieces);

  return { object: group, width: maxWidth, height: layout.height };
}

/**
 * Markdown fitted into `box` (scene): the largest size ≤ `style.fontSize` (never below `minFontSize`)
 * whose wrapped layout fits, placed at the box's top-left, vertically centred in it. Left-aligned
 * by default.
 */
export async function buildFittedTypeset(
  markdown: string,
  style: TypesetStyle,
  box: SceneRect,
  { minFontSize, verticalAlign = 'center' }: { minFontSize: number; verticalAlign?: 'top' | 'center' },
): Promise<TypesetResult & { fontSize: number; fits: boolean }> {
  await ensureBoardFonts();

  const lineHeight = style.lineHeight ?? 1.25;
  let result: { object: FabricObject; height: number };
  let fontSize: number;
  let fits: boolean;

  if (!needsTypesetMath(markdown)) {
    const align = style.align ?? 'left';
    const textbox = plainTextbox(markdown, { ...style, lineHeight }, box.width);
    const fit = fitFontSize(
      (size) => {
        resizePlain(textbox, size, box.width, align);

        // A word longer than the box widens a Textbox: that counts as not fitting.
        return { width: textbox.width ?? 0, height: textbox.height ?? 0 };
      },
      box,
      { start: style.fontSize, min: minFontSize },
    );

    resizePlain(textbox, fit.fontSize, box.width, align);
    result = { object: textbox, height: textbox.height ?? fit.size.height };
    fontSize = fit.fontSize;
    fits = fit.fits;
  } else {
    const prepared = await prepareRich(markdown, style);
    const fit = fitFontSize(
      (size) => {
        const layout = layoutRich(prepared, size, box.width, style.align ?? 'left', lineHeight);

        return { width: layout.width, height: layout.height };
      },
      box,
      { start: style.fontSize, min: minFontSize },
    );
    const layout = layoutRich(prepared, fit.fontSize, box.width, style.align ?? 'left', lineHeight);
    const pieces = richPieces(prepared, layout, { ...style, fontSize: fit.fontSize });

    result = { object: richGroup(pieces), height: layout.height };
    fontSize = fit.fontSize;
    fits = fit.fits;
  }

  const offsetY = verticalAlign === 'center' ? Math.max(0, (box.height - result.height) / 2) : 0;
  // Built in a frame whose origin is the box's top-left: move the frame onto the box.
  result.object.set({ left: box.left + (result.object.left ?? 0), top: box.top + offsetY + (result.object.top ?? 0) });
  result.object.setCoords();

  return { object: result.object, width: box.width, height: result.height, fontSize, fits };
}

/** `size → wrapped height` for one paragraph at `width` — formulas rasterised once, not per size. */
export async function heightMeasurer(markdown: string, style: TypesetStyle, width: number): Promise<(size: number) => number> {
  await ensureBoardFonts();

  if (!needsTypesetMath(markdown)) {
    const probe = plainTextbox(markdown, style, width);

    return (size) => {
      resizePlain(probe, size, width, style.align ?? 'left');

      return probe.height ?? size;
    };
  }

  const prepared = await prepareRich(markdown, style);

  return (size) => layoutRich(prepared, size, width, style.align ?? 'left', style.lineHeight ?? 1.25).height;
}

// ---------------------------------------------------------------------------
// Remake overlay
// ---------------------------------------------------------------------------

export interface OverlayBuildOptions {
  color?: string;
  batch?: string;
  /** «Write the questions in my handwriting»: the text is written with the handwriting engine instead of Plex. */
  handwriting?: { penWidth?: number } | null;
}

const WEIGHT: Record<string, TypesetWeight> = { regular: 400, medium: 500, semibold: 600, bold: 700 };

type Tagger = (object: FabricObject, kind: 'remake-text' | 'remake-lines', source?: string) => FabricObject;

async function handwrittenInto(
  markdown: string,
  box: SceneRect,
  color: string,
  fontSize: number,
  penWidth: number | undefined,
  verticalAlign: 'top' | 'center' = 'center',
): Promise<FabricObject | null> {
  const { buildHandwritingObjects } = await import('./handwritingObjects');
  // Written at zoom 1 in a column as wide as the box, then scaled to fit it.
  const built = await buildHandwritingObjects([{ type: 'paragraph', text: markdown }], {
    zoom: 1,
    color,
    withAnswers: false,
    widthPx: Math.max(40, box.width * (32 / Math.max(6, fontSize))),
    penWidth,
  });

  if (built.objects.length === 0) return null;

  const group = new Group(built.objects, { ...TOP_LEFT });
  const width = group.width || 1;
  const height = group.height || 1;
  const scale = Math.min(box.width / width, box.height / height, (fontSize * 1.25) / 32);

  group.set({
    scaleX: scale,
    scaleY: scale,
    // The writing starts at the left edge of its box, vertically centred.
    left: box.left,
    top: box.top + (verticalAlign === 'center' ? Math.max(0, (box.height - height * scale) / 2) : 0),
  });
  group.setCoords();

  return group;
}

async function textInto(
  markdown: string,
  box: SceneRect,
  style: TypesetStyle,
  minFontSize: number,
  options: OverlayBuildOptions,
  verticalAlign: 'top' | 'center' = 'center',
  overflowRight = 0,
): Promise<FabricObject | null> {
  if (!markdown.trim()) return null;

  if (options.handwriting) return handwrittenInto(markdown, box, style.color, style.fontSize, options.handwriting.penWidth, verticalAlign);

  const display = markdown.trim().match(/^\$\$([\s\S]+)\$\$$/);

  if (display && !display[1]!.includes('$$')) {
    const centred = await displayMathInto(display[1]!.trim(), box, style);

    if (centred) return centred;
  }

  const fitted = await buildFittedTypeset(markdown, style, box, { minFontSize });

  // New text is often longer than the erased one: rather than shrinking it far, let the lines run
  // a little past the box's right edge (into the margin) when that keeps it noticeably bigger.
  if (overflowRight > 1 && fitted.fontSize < style.fontSize * 0.85) {
    const wider = await buildFittedTypeset(markdown, style, { ...box, width: box.width + overflowRight }, { minFontSize });

    if (wider.fontSize > fitted.fontSize * 1.04) return wider.object;
  }

  return fitted.object;
}

/** A block that is one `$$…$$` formula: KaTeX display style, as large as fits, centred in its box. */
async function displayMathInto(tex: string, box: SceneRect, style: TypesetStyle): Promise<FabricObject | null> {
  const raster = await renderMathImage(tex, { fontPx: 40, color: style.color, display: true, pixelRatio: 3 });
  const image = raster ? await imageFrom(raster.dataUrl) : null;

  if (!raster || !image) return null;

  // CSS px at 40 px → scene, capped at the block's own text size and at the box.
  const natural = style.fontSize / 40;
  const scale = Math.min(natural * 1.15, box.width / raster.width, box.height / raster.height);
  const k = (raster.width / (image.width || 1)) * scale;

  image.set({
    ...TOP_LEFT,
    left: box.left + (box.width - raster.width * scale) / 2,
    top: box.top + (box.height - raster.height * scale) / 2,
    scaleX: k,
    scaleY: k,
  });
  (image as unknown as Record<string, unknown>).wbAi = { kind: 'remake-math', source: tex };

  return image;
}

function answerLines(box: SceneRect, fontSize: number, page: SceneRect): FabricObject {
  const count = Math.max(1, Math.round(box.height / Math.max(8, fontSize * 1.9)));
  const gap = box.height / count;
  const lines: FabricObject[] = [];

  for (let index = 0; index < count; index += 1) {
    const y = box.top + gap * (index + 1) - gap * 0.2;

    lines.push(
      new Line([box.left, y, box.left + box.width, y], {
        stroke: 'rgba(24, 32, 74, 0.45)',
        strokeWidth: Math.max(1, page.width / 900),
        strokeDashArray: [4, 4],
      }),
    );
  }

  return new Group(lines, { ...TOP_LEFT });
}

/**
 * One block → its objects inside its bbox. A question with `choices` keeps its stem at the top of the
 * box and lays the choices out under it (inline / 2×2 / stacked, first choice on the left); the
 * size shrinks until stem + choices fit together.
 */
async function overlayBlockObjects(block: RemakeOverlayBlock, page: SceneRect, options: OverlayBuildOptions, tag: Tagger): Promise<FabricObject[]> {
  const rect = bboxToRect(block.bbox, page);
  const color = block.style?.color || options.color || '#18204a';
  const weight = WEIGHT[block.style?.weight ?? 'regular'] ?? 400;
  const align: TypesetAlign = block.style?.align ?? 'left';
  const rel = block.style?.fontSizeRel;
  const start = rel && rel > 0 ? rel * page.height : Math.min(rect.height * 0.8, page.height * 0.03);
  const minFontSize = Math.max(page.height * 0.008, start * 0.5);
  const style: TypesetStyle = { fontSize: start, weight, color, align, lineHeight: 1.25 };
  // How far a line may spill right: up to 15 % of the box, never past the page's own margin.
  const overflowRight = Math.max(0, Math.min(rect.width * 0.15, page.left + page.width * 0.97 - (rect.left + rect.width)));

  if (block.kind === 'answer_line') {
    const objects: FabricObject[] = [tag(answerLines(rect, start, page), 'remake-lines')];
    const text = await textInto(block.text, rect, style, minFontSize, options);

    if (text) objects.unshift(tag(text, 'remake-text', block.text));

    return objects;
  }

  const choices = block.choices?.filter((choice) => choice.text.trim() || choice.label.trim()) ?? [];

  if (choices.length === 0) {
    const text = await textInto(block.text, rect, style, minFontSize, options, 'center', overflowRight);

    return text ? [tag(text, 'remake-text', block.text)] : [];
  }

  // Stem + choices: find the size where both fit the box.
  await ensureBoardFonts();

  const lines = choices.map((choice) => choiceLine(choice.label, choice.text));
  const stemHeightAt = block.text.trim() ? await heightMeasurer(block.text, style, rect.width) : () => 0;
  const choiceWidths = (size: number) =>
    lines.map((line) => measureBoardText(inlineMathToText(stripInlineMarkdown(line)), size, 400) + size * 0.6);
  const preferred = block.choiceLayout === 'stacked' ? 'stacked' : 'inline';
  let size = start;
  let stemHeight = 0;
  let arranged = layoutChoices(choiceWidths(size), { width: rect.width, height: rect.height }, { preferred, lineHeight: size * 1.35, gap: size });

  for (let guard = 0; guard < 24; guard += 1) {
    stemHeight = stemHeightAt(size);
    arranged = layoutChoices(choiceWidths(size), { width: rect.width, height: Math.max(1, rect.height - stemHeight) }, { preferred, lineHeight: size * 1.35, gap: size });

    if (stemHeight + arranged.height <= rect.height * 1.03 || size <= minFontSize) break;

    size = Math.max(minFontSize, size * 0.92);
  }

  const objects: FabricObject[] = [];
  let choicesTop = rect.top + stemHeight;

  if (block.text.trim()) {
    // Handwriting runs wider than Plex: it may take the room the choices leave, not just Plex's height.
    const stemBox = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: options.handwriting ? Math.max(stemHeight, rect.height - arranged.height) : stemHeight || size * 1.3,
    };
    const stem = await textInto(block.text, stemBox, { ...style, fontSize: size }, size * 0.9, options, 'top');

    if (stem) {
      objects.push(tag(stem, 'remake-text', block.text));

      if (options.handwriting) {
        stem.setCoords();

        const drawn = stem.getBoundingRect();

        choicesTop = Math.max(rect.top, drawn.top + drawn.height + size * 0.3);
      }
    }
  }

  for (const cell of arranged.cells) {
    const cellBox = { left: rect.left + cell.left, top: choicesTop + cell.top, width: cell.width, height: cell.height };
    const text = await textInto(lines[cell.index]!, cellBox, { ...style, fontSize: size, weight: 400, align: 'left' }, size * 0.7, options);

    if (text) objects.push(tag(text, 'remake-text', lines[cell.index]));
  }

  return objects;
}

/**
 * The overlay layout → board objects over the text-free page that fills `page` (scene). One
 * interactive group per question number (stem + choices + answer lines move together, each piece
 * still editable); blocks without a number stand alone.
 */
export async function buildOverlayObjects(blocks: RemakeOverlayBlock[], page: SceneRect, options: OverlayBuildOptions = {}): Promise<FabricObject[]> {
  await ensureBoardFonts();

  const batch = options.batch;
  const tag: Tagger = (object, kind, source) => {
    (object as unknown as Record<string, unknown>).wbAi = { kind, ...(source ? { source } : {}), ...(batch ? { batch } : {}), ...(options.handwriting ? { hand: true } : {}) };

    return object;
  };
  const objects: FabricObject[] = [];

  for (const group of groupOverlayBlocks(blocks)) {
    const parts: FabricObject[] = [];

    // Number before the question text, «label) text» choices in the question's style, fallback choices.
    const resolved = resolveOverlayGroup(group);

    for (const block of resolved) parts.push(...(await overlayBlockObjects(block, page, options, tag)));

    if (parts.length > 1) {
      const source = resolved
        .map((block) => [block.text, ...(block.choices ?? []).map((choice) => choiceLine(choice.label, choice.text))].filter(Boolean).join('\n'))
        .join('\n');

      objects.push(tag(new Group(parts, { ...TOP_LEFT, ...NO_CACHE, interactive: true, subTargetCheck: true }), 'remake-text', source));
    } else if (parts[0]) {
      objects.push(parts[0]);
    }
  }

  return objects;
}

/**
 * The text-free page + its overlay text → one picture the size of `image`: what the dissolve reveals,
 * so the page and its words appear together. `objects` are borrowed (added and removed again).
 */
export function composeOverlayPicture(image: CanvasImageSource, size: { width: number; height: number }, objects: FabricObject[], page: SceneRect): HTMLCanvasElement {
  const out = document.createElement('canvas');

  out.width = Math.max(1, Math.round(size.width));
  out.height = Math.max(1, Math.round(size.height));

  const ctx = out.getContext('2d');

  if (!ctx) return out;

  ctx.drawImage(image, 0, 0, out.width, out.height);

  const scale = out.width / Math.max(1, page.width);
  const layer = new StaticCanvas(document.createElement('canvas'), { width: out.width, height: out.height, renderOnAddRemove: false });

  layer.setViewportTransform([scale, 0, 0, scale, -page.left * scale, -page.top * scale]);
  objects.forEach((object) => layer.add(object));
  layer.renderAll();
  ctx.drawImage(layer.getElement(), 0, 0);
  objects.forEach((object) => layer.remove(object));
  layer.dispose();

  return out;
}

// ---------------------------------------------------------------------------
// Picture labels
// ---------------------------------------------------------------------------

/**
 * A generated picture + its labels → one interactive group: the picture, an editable Plex label
 * per entry, and a thin leader line in the pen colour from each label to the point it names (with a
 * dot at the end). Everything moves with the picture; each label can still be picked and edited.
 */
export async function buildLabeledImage(
  image: FabricImage,
  labels: ImageLabelInput[],
  { color, unit }: { color: string; unit: number },
): Promise<Group> {
  await ensureBoardFonts();

  const left = image.left ?? 0;
  const top = image.top ?? 0;
  const width = (image.width || 1) * (image.scaleX ?? 1);
  const height = (image.height || 1) * (image.scaleY ?? 1);
  const placed = placeImageLabels(labels, { width, height }, (text, size) => measureBoardText(text, size, 500), {
    minFont: 14 * unit,
    maxFont: 40 * unit,
  });
  const parts: FabricObject[] = [image];
  const leaders: FabricObject[] = [];
  const chips: FabricObject[] = [];
  const texts: FabricObject[] = [];

  for (const label of placed) {
    const source = labels[label.index]!.text.trim();
    const box = new Textbox(source, {
      ...TOP_LEFT,
      ...NO_CACHE,
      left: left + label.left,
      top: top + label.top + label.fontSize * 0.12,
      width: label.width,
      fontSize: label.fontSize,
      fontFamily: BOARD_TEXT_FONT,
      fontWeight: 500,
      fill: color,
      textAlign: 'center',
      lineHeight: 1.15,
      editable: true,
    });

    (box as unknown as Record<string, unknown>).wbAi = { kind: 'image-label', source };
    chips.push(
      new Rect({
        ...TOP_LEFT,
        left: left + label.left,
        top: top + label.top,
        width: label.width,
        height: label.height,
        rx: label.fontSize * 0.25,
        ry: label.fontSize * 0.25,
        fill: 'rgba(255, 255, 255, 0.85)',
        strokeWidth: 0,
      }),
    );
    texts.push(box);

    if (label.leader) {
      const stroke = Math.max(1, 1.6 * unit);

      leaders.push(
        new Line([left + label.leader.x1, top + label.leader.y1, left + label.leader.x2, top + label.leader.y2], {
          stroke: color,
          strokeWidth: stroke,
          strokeLineCap: 'round',
        }),
        new Circle({
          originX: 'center',
          originY: 'center',
          left: left + label.leader.x2,
          top: top + label.leader.y2,
          radius: Math.max(1.5, 2.6 * unit),
          fill: color,
          strokeWidth: 0,
        }),
      );
    }
  }

  // Leaders under the labels, so a line never crosses a word.
  parts.push(...leaders, ...chips, ...texts);

  return new Group(parts, { ...TOP_LEFT, ...NO_CACHE, interactive: true, subTargetCheck: true });
}
