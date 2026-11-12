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
 * `place` finds empty space for a box (null = none): the whole block must fit, else it is tried a
 * size smaller and narrower; with no room at all nothing is written (the panel still lists the steps).
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
  place?: (wanted: SceneRect) => SceneRect | null;
}

export interface WorkedStepsBuild {
  objects: FabricObject[];
  reveal: Array<Extract<PenRevealStep, { kind: 'picture' }>>;
}

/** Space between two steps, as a share of the text height. */
const STEP_GAP = 0.55;

export async function buildWorkedSteps(options: WorkedStepsOptions): Promise<WorkedStepsBuild | null> {
  const { steps, page, anchor } = options;

  if (steps.length === 0) return null;

  for (const [scale, share] of [
    [1, 0.62],
    [0.85, 0.5],
    [0.72, 0.42],
  ] as const) {
    const fontSize = options.fontSize * scale;
    const width = Math.min(page.width * share, page.left + page.width - anchor.left - fontSize);

    if (width < fontSize * 8) continue;

    const lines = await Promise.all(steps.map((step, index) => buildTypeset(options.numbered === false ? step : `${index + 1}. ${step}`, { fontSize, color: options.color, weight: 500, lineHeight: 1.4 }, width)));
    const gap = fontSize * STEP_GAP;
    const height = lines.reduce((sum, line) => sum + line.height, 0) + gap * (lines.length - 1);
    const wanted = { left: anchor.left, top: anchor.top, width, height };
    const fits = wanted.top + height <= page.top + page.height;
    const box = options.place ? options.place(wanted) : fits ? wanted : null;

    if (!box) continue;

    const objects: FabricObject[] = [];
    const reveal: WorkedStepsBuild['reveal'] = [];
    let top = box.top;

    lines.forEach((line, index) => {
      const object = line.object;

      object.set({ left: box.left, top });
      object.setCoords();
      (object as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = { kind: 'pen-note', source: steps[index]!, batch: options.batch } satisfies AiObjectTag;

      const bounds = object.getBoundingRect();

      objects.push(object);
      // Twice the size: sharp when the board is zoomed in.
      reveal.push({ kind: 'picture', box: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }, image: object.toCanvasElement({ multiplier: 2 }), objects: [object] });
      top += line.height + gap;
    });

    return { objects, reveal };
  }

  return null;
}
