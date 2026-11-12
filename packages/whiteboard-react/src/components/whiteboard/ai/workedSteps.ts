import { Path } from 'fabric';

import { AI_OBJECT_PROP } from './boardObjects';
import { buildHandwritingObjects } from './handwritingObjects';

import type { AiObjectTag } from './boardObjects';
import type { WriteOnStroke } from './handwritingObjects';
import type { HandStyle } from './handStyle';
import type { PenRevealStep } from './penActionObjects';
import type { SceneRect } from './types';
import type { FabricObject } from 'fabric';

/**
 * «Solve it» / «Explain»: the answer WRITTEN on the page in pen, under the question — the same
 * handwriting the rest of the board's AI writes in (real maths traced from KaTeX), one written step
 * after the other.
 *
 * It lands as INK, in small pieces: every letter (and every formula part) is its own object, so the
 * student can rub out one character, lasso a part and move or recolour it — never «touch one thing,
 * lose the sentence». On ruled paper each written line rests on a ruled line.
 *
 * `place` finds empty space for a box (null = none): the whole block must fit on screen, else it is
 * tried smaller and narrower, then further down the page; with no room at all nothing is written
 * (the panel still lists the steps).
 */
export interface WorkedStepsOptions {
  steps: string[];
  /** Numbered lines («1. …»); false = plain paragraphs (an explanation). */
  numbered?: boolean;
  /** Where the block would like to start: under the question it solves. */
  anchor: { left: number; top: number };
  page: SceneRect;
  /** Height of a written letter, scene units (the student's own, when known). */
  letterHeight: number;
  color: string;
  /** Pen width, scene units. */
  strokeWidth: number;
  /** The student's hand (slant, width), when it was read from their ink. */
  hand?: HandStyle | null;
  zoom: number;
  batch: string;
  /** `anywhere`: the box may lie outside the part of the page on screen. */
  place?: (wanted: SceneRect, anywhere: boolean) => SceneRect | null;
  /** Ruled paper (scene units): the lines' spacing and the y of one of them. The writing then sits on the lines. */
  ruling?: { pitch: number; at: number } | null;
}

export interface WorkedStepsBuild {
  objects: FabricObject[];
  reveal: Array<Extract<PenRevealStep, { kind: 'write' }>>;
}

/** More pieces than this and the answer is kept word by word instead (old tablets). */
export const PIECES_MAX = 900;
/** Ruled paper: a written line's pitch is ~1.85 × its font, and the font ~2 × the letter height. */
const RULED_LETTER = 0.27;
/** Ruled paper: the writing rests this far above its line (share of the spacing). */
const RULE_REST = 0.13;

interface Sub {
  d: string;
  minX: number;
  maxX: number;
}

const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

/** `d` moved by (dx, dy). The traced paths use absolute M / Q / Z only, so every number pair is a point. */
export function translatePath(d: string, dx: number, dy: number): string {
  let index = 0;

  return d.replace(NUMBER, (value) => {
    const moved = Number(value) + (index % 2 === 0 ? dx : dy);

    index += 1;

    return String(Math.round(moved * 100) / 100);
  });
}

/**
 * A written word's outline → its letters: the closed shapes that overlap sideways belong together (an
 * «o» and its hole, an «i» and its dot, the two bars of «=», a fraction's top, bar and bottom). A
 * joined-up word stays one piece.
 */
export function splitGlyphs(d: string): string[] {
  const subs: Sub[] = (d.match(/M[^M]*/g) ?? []).map((part) => {
    const numbers = (part.match(NUMBER) ?? []).map(Number);
    let minX = Infinity;
    let maxX = -Infinity;

    for (let i = 0; i < numbers.length; i += 2) {
      minX = Math.min(minX, numbers[i]!);
      maxX = Math.max(maxX, numbers[i]!);
    }

    return { d: part.trim(), minX, maxX };
  });

  subs.sort((a, b) => a.minX - b.minX);

  const groups: Sub[] = [];

  for (const sub of subs) {
    const last = groups[groups.length - 1];
    const overlap = last ? Math.min(last.maxX, sub.maxX) - Math.max(last.minX, sub.minX) : -1;
    const narrow = last ? Math.min(last.maxX - last.minX, sub.maxX - sub.minX) : 0;

    if (last && overlap > 0 && overlap >= narrow * 0.25) {
      last.d += ` ${sub.d}`;
      last.maxX = Math.max(last.maxX, sub.maxX);
    } else {
      groups.push({ ...sub });
    }
  }

  return groups.map((group) => group.d);
}

export async function buildWorkedSteps(options: WorkedStepsOptions): Promise<WorkedStepsBuild | null> {
  const { steps, page, anchor } = options;

  if (steps.length === 0) return null;

  const ruling = options.ruling && options.ruling.pitch > 0 ? options.ruling : null;

  // On screen first (full size, then smaller); only then further down the page, at full size again.
  for (const [scale, share, anywhere] of [
    [1, 0.62, false],
    [0.85, 0.5, false],
    [0.72, 0.42, false],
    [1, 0.62, true],
    [0.85, 0.5, true],
  ] as const) {
    // On ruled paper the hand is sized to the lines (one written line per ruled line).
    const letterHeight = ruling ? ruling.pitch * RULED_LETTER : options.letterHeight * scale;
    const width = Math.min(page.width * share, page.left + page.width - anchor.left - letterHeight);

    if (width < letterHeight * 10) continue;

    const style: HandStyle = {
      slantDeg: options.hand?.slantDeg ?? 0,
      strokeWidth: options.hand?.strokeWidth ?? options.strokeWidth,
      letterHeight,
      color: options.color,
      samples: options.hand?.samples ?? 0,
    };
    const built = await Promise.all(
      steps.map((step, index) =>
        buildHandwritingObjects([{ type: 'paragraph', text: options.numbered === false ? step : `${index + 1}. ${step}` }], {
          zoom: options.zoom,
          color: options.color,
          withAnswers: false,
          widthPx: Math.max(120, width * options.zoom),
          batch: options.batch,
          lang: 'en',
          style,
          seed: index + 1,
        }),
      ),
    );
    // Each step's written lines, top to bottom: their strokes, where they rest and how tall they are.
    const stepLines = built.map((step) => {
      const byLine = new Map<number, WriteOnStroke[]>();

      for (const stroke of step.strokes) byLine.set(stroke.line, [...(byLine.get(stroke.line) ?? []), stroke]);

      return [...byLine.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, strokes]) => {
          const top = Math.min(...strokes.map((stroke) => stroke.bounds.top));
          const bottom = Math.max(...strokes.map((stroke) => stroke.bounds.top + stroke.bounds.height));

          return { strokes, top, bottom, baseline: strokes[0]!.baseline ?? bottom };
        });
    });
    const flat = stepLines.flatMap((lines, stepIndex) => lines.map((line, lineIndex) => ({ ...line, stepIndex, lineIndex })));

    if (flat.length === 0) return null;

    // Where each written line rests, measured down from the block's top. A line never climbs into the
    // one above: a tall line (a fraction, big brackets) takes the room it needs — on ruled paper, a
    // whole extra ruled line.
    const pitch = ruling ? ruling.pitch : letterHeight * 3.1;
    const stepGap = ruling ? 0 : letterHeight * 0.7;
    const clear = letterHeight * 0.35;
    const rests: number[] = [];
    let previousBottom = 0;

    flat.forEach((line, index) => {
      const above = line.baseline - line.top;
      const first = index === 0;
      const natural = first ? Math.max(above, pitch * 0.72) : rests[index - 1]! + pitch + (line.lineIndex === 0 ? stepGap : 0);
      const needed = first ? above : previousBottom + clear + above;
      let rest = Math.max(natural, needed);

      if (ruling) rest = Math.ceil((rest - 0.001) / pitch) * pitch;
      rests.push(rest);
      previousBottom = rest + (line.bottom - line.baseline);
    });

    const height = previousBottom + (ruling ? pitch : 0);
    const wanted = { left: anchor.left, top: anchor.top, width, height };
    const fits = wanted.top + height <= page.top + page.height;
    const box = options.place ? options.place(wanted, anywhere) : fits ? wanted : null;

    if (!box) continue;

    // Ruled paper: the block starts so that its lines rest just above ruled lines.
    const origin = ruling ? ruling.at + Math.ceil((box.top - ruling.at) / pitch) * pitch - pitch * RULE_REST : box.top;
    const pieces: Array<{ d: string; stroke: WriteOnStroke; step: number }> = [];
    const reveal: WorkedStepsBuild['reveal'] = [];
    const objects: FabricObject[] = [];
    const moved: WriteOnStroke[][] = stepLines.map(() => []);

    flat.forEach((line, index) => {
      const dx = box.left;
      const dy = origin + rests[index]! - line.baseline;

      for (const stroke of line.strokes) {
        const d = translatePath(stroke.d, dx, dy);
        const next = { ...stroke, d, line: line.lineIndex, bounds: { ...stroke.bounds, left: stroke.bounds.left + dx, top: stroke.bounds.top + dy } };

        moved[line.stepIndex]!.push(next);
        pieces.push({ d, stroke: next, step: line.stepIndex });
      }
    });

    // Letters when there are few enough of them, whole words otherwise.
    const letters = pieces.map((piece) => ({ ...piece, parts: splitGlyphs(piece.d) }));
    const fine = letters.reduce((sum, piece) => sum + piece.parts.length, 0) <= PIECES_MAX;
    const perStep: FabricObject[][] = stepLines.map(() => []);

    for (const piece of letters) {
      for (const d of fine ? piece.parts : [piece.d]) {
        const fill = piece.stroke.color ?? built[piece.step]!.fill;
        const path = new Path(d, {
          fill,
          stroke: fill,
          strokeWidth: piece.stroke.formula ? built[piece.step]!.strokeWidth * 0.55 : built[piece.step]!.strokeWidth,
          strokeLineJoin: 'round',
          strokeLineCap: 'round',
          fillRule: 'evenodd',
        });

        (path as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = { kind: 'pen-note', source: steps[piece.step]!, batch: options.batch, hand: true } satisfies AiObjectTag;
        perStep[piece.step]!.push(path);
        objects.push(path);
      }
    }

    moved.forEach((strokes, stepIndex) => {
      if (strokes.length === 0) return;

      reveal.push({
        kind: 'write',
        strokes,
        fill: built[stepIndex]!.fill,
        strokeWidth: built[stepIndex]!.strokeWidth,
        transform: { scale: 1, dx: 0, dy: 0 },
        objects: perStep[stepIndex]!,
      });
    });

    return { objects, reveal };
  }

  return null;
}
