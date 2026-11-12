import { AI_OBJECT_PROP } from './boardObjects';
import { buildTypeset } from './typesetObjects';

import type { AiObjectTag } from './boardObjects';
import type { PenRevealStep } from './penActionObjects';
import type { SceneRect } from './types';
import type { FabricObject } from 'fabric';

/**
 * «Solve it»: the worked solution written on the page — one typeset line per step (numbered, real
 * maths through KaTeX), stacked in the empty space under the question. Each line is a board object
 * (kept with «Keep») and a picture of it for the overlay to fade in, one step after the other.
 *
 * `place` finds empty space for a box (null = none): the whole block must fit on screen, else it is
 * tried a size smaller and narrower, then further down the page; with no room at all nothing is
 * written (the panel still lists the steps).
 */
export interface WorkedStepsOptions {
  steps: string[];
  /** Numbered lines («1. …»); false = plain paragraphs (an explanation). */
  numbered?: boolean;
  /** Where the block would like to start: under the question it solves. */
  anchor: { left: number; top: number };
  page: SceneRect;
  /** Text height, scene units. */
  fontSize: number;
  color: string;
  batch: string;
  /** `anywhere`: the box may lie outside the part of the page on screen. */
  place?: (wanted: SceneRect, anywhere: boolean) => SceneRect | null;
  /** Ruled paper (scene units): the lines' spacing and the y of one of them. The writing then sits on the lines. */
  ruling?: { pitch: number; at: number } | null;
}

export interface WorkedStepsBuild {
  objects: FabricObject[];
  reveal: Array<Extract<PenRevealStep, { kind: 'picture' }>>;
}

/** Space between two steps, as a share of the text height. */
const STEP_GAP = 0.55;
/** Ruled paper: how far down its own line slot a line of text starts, so its letters rest on the rule (share of the spacing). */
const RULE_REST = 0.22;

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
    // On ruled paper the text is sized to the lines (one written line per ruled line), not to the hand.
    const fontSize = ruling ? Math.min(options.fontSize * 1.2, ruling.pitch * 0.5) : options.fontSize * scale;
    const lineHeight = ruling ? ruling.pitch / fontSize : 1.4;
    const width = Math.min(page.width * share, page.left + page.width - anchor.left - fontSize);

    if (width < fontSize * 8) continue;

    const lines = await Promise.all(steps.map((step, index) => buildTypeset(options.numbered === false ? step : `${index + 1}. ${step}`, { fontSize, color: options.color, weight: 500, lineHeight }, width)));
    const gap = ruling ? 0 : fontSize * STEP_GAP;
    // Ruled: every step takes whole lines.
    const slot = (h: number) => (ruling ? Math.max(1, Math.round(h / ruling.pitch)) * ruling.pitch : h);
    const height = lines.reduce((sum, line) => sum + slot(line.height), 0) + gap * (lines.length - 1) + (ruling ? ruling.pitch : 0);
    const wanted = { left: anchor.left, top: anchor.top, width, height };
    const fits = wanted.top + height <= page.top + page.height;
    const box = options.place ? options.place(wanted, anywhere) : fits ? wanted : null;

    if (!box) continue;

    const objects: FabricObject[] = [];
    const reveal: WorkedStepsBuild['reveal'] = [];
    // Ruled: start at the first writing line inside the box, so each line of text rests just above a rule.
    let top = ruling ? ruling.at + Math.ceil((box.top - ruling.at) / ruling.pitch) * ruling.pitch + ruling.pitch * RULE_REST - ruling.pitch : box.top;

    if (ruling && top < box.top) top += ruling.pitch;

    lines.forEach((line, index) => {
      const object = line.object;

      object.set({ left: box.left, top });
      object.setCoords();
      (object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = { kind: 'pen-note', source: steps[index]!, batch: options.batch } satisfies AiObjectTag;

      const bounds = object.getBoundingRect();

      objects.push(object);
      // Twice the size: sharp when the board is zoomed in.
      reveal.push({ kind: 'picture', box: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }, image: object.toCanvasElement({ multiplier: 2 }), objects: [object] });
      top += slot(line.height) + gap;
    });

    return { objects, reveal };
  }

  return null;
}
