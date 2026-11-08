/**
 * Exam ink budget. The submit body is capped at 10 MB, and a 20-question exam can carry twenty
 * handwritten PNGs — so exam ink is rasterised smaller than a single attempt's (≤1000 px long side),
 * quantised to a few grey levels (PNG shrinks 3–5× with no loss the grader can see), measured as
 * base64, and shrunk again until each answer is under its target and the whole batch fits.
 *
 * The maths lives in pure functions (unit-tested); only `rasterizeExamInk` / `buildExamInk` touch a
 * canvas.
 */

import type { InkStroke } from './ink';

import { drawStroke, inkBounds, planRaster } from './ink';

export const EXAM_INK_MAX_PX = 1000;
/** Per-answer target, measured as base64 characters. */
export const EXAM_INK_TARGET_B64 = 250_000;
/** Whole-request budget, leaving headroom under the BE's 10 MB. */
export const EXAM_TOTAL_B64 = 9_000_000;
/** Below this the handwriting stops being legible; stop shrinking here. */
export const MIN_SCALE = 0.3;
export const GREY_LEVELS = 4;
const MAX_PASSES = 6;

export const b64Bytes = (b64Length: number): number => Math.floor((b64Length * 3) / 4);

/**
 * Next linear scale multiplier for a PNG that measured `sizeB64` against `targetB64`. PNG bytes
 * grow roughly with pixel count, so the dimension factor is √(target/size); clamped to [0.5, 0.9]
 * so one pass always makes progress and never overshoots into illegibility.
 */
export function shrinkFactor(sizeB64: number, targetB64: number): number {
  if (sizeB64 <= targetB64) return 1;
  const raw = Math.sqrt(targetB64 / sizeB64) * 0.95;

  return Math.min(0.9, Math.max(0.5, raw));
}

/**
 * Uniform linear scale that brings a batch of measured sizes under `totalB64`. 1 when it already
 * fits; otherwise √(0.9·total/sum) (bytes ∝ pixels ∝ scale²), never below MIN_SCALE.
 */
export function fitTotalBudget(sizes: number[], totalB64: number): number {
  const sum = sizes.reduce((acc, size) => acc + size, 0);

  if (sum <= totalB64) return 1;

  return Math.max(MIN_SCALE, Math.sqrt((0.9 * totalB64) / sum));
}

/**
 * Quantises RGBA pixels in place to `levels` grey values and full alpha. Luminance is BT.601; the
 * band edges are placed so a white page stays pure white and pen ink lands on pure black.
 */
export function quantizeGray(data: Uint8ClampedArray | number[], levels = GREY_LEVELS): void {
  const step = 255 / (levels - 1);

  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = (data[i + 3] ?? 255) / 255;
    // Composite onto white first — transparent pixels are page, not ink.
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a);
    const q = Math.round(Math.round(lum / step) * step);

    data[i] = q;
    data[i + 1] = q;
    data[i + 2] = q;
    data[i + 3] = 255;
  }
}

export interface ExamInk {
  b64: string;
  /** Linear scale the PNG ended up at (1 = the plan's preferred 1.5×). */
  scale: number;
  px: { w: number; h: number };
}

function rasterizeAt(strokes: InkStroke[], maxPx: number): ExamInk | null {
  const bounds = inkBounds(strokes, 16);

  if (!bounds) return null;
  const plan = planRaster(bounds, maxPx, 1.5);
  const canvas = document.createElement('canvas');

  canvas.width = plan.outW;
  canvas.height = plan.outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.outW, plan.outH);
  const transform = (x: number, y: number): [number, number] => [(x - plan.x) * plan.scale, (y - plan.y) * plan.scale];

  for (const stroke of strokes) drawStroke(ctx, { ...stroke, color: '#000000' }, 0, transform, plan.scale);
  const image = ctx.getImageData(0, 0, plan.outW, plan.outH);

  quantizeGray(image.data);
  ctx.putImageData(image, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');

  return {
    b64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    scale: maxPx / EXAM_INK_MAX_PX,
    px: { w: plan.outW, h: plan.outH },
  };
}

/** One answer's ink → PNG under `targetB64`, shrinking in passes. Null for empty ink. */
export function rasterizeExamInk(
  strokes: InkStroke[],
  targetB64 = EXAM_INK_TARGET_B64,
  maxPx = EXAM_INK_MAX_PX,
): ExamInk | null {
  let px = maxPx;
  let best: ExamInk | null = null;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const result = rasterizeAt(strokes, px);

    if (!result) return null;
    best = result;
    if (result.b64.length <= targetB64 || px / EXAM_INK_MAX_PX <= MIN_SCALE) break;
    px = Math.max(EXAM_INK_MAX_PX * MIN_SCALE, Math.floor(px * shrinkFactor(result.b64.length, targetB64)));
  }

  return best;
}

/**
 * Every answer's ink, each under its own target, the batch under the request budget. Returns the
 * base64 per question id (questions without ink are absent).
 */
export function buildExamInk(strokesById: Map<string, InkStroke[]>, totalB64 = EXAM_TOTAL_B64): Map<string, string> {
  const out = new Map<string, string>();
  const sizes: number[] = [];

  for (const [id, strokes] of Array.from(strokesById.entries())) {
    if (!strokes.length) continue;
    const ink = rasterizeExamInk(strokes);

    if (ink) {
      out.set(id, ink.b64);
      sizes.push(ink.b64.length);
    }
  }
  let factor = fitTotalBudget(sizes, totalB64);
  let guard = 0;

  while (factor < 1 && guard < 3) {
    const px = Math.max(EXAM_INK_MAX_PX * MIN_SCALE, Math.floor(EXAM_INK_MAX_PX * factor));
    const next: number[] = [];

    for (const id of Array.from(out.keys())) {
      const ink = rasterizeExamInk(strokesById.get(id) ?? [], EXAM_INK_TARGET_B64, px);

      if (ink) {
        out.set(id, ink.b64);
        next.push(ink.b64.length);
      }
    }
    const again = fitTotalBudget(next, totalB64);

    if (again >= 1 || px <= EXAM_INK_MAX_PX * MIN_SCALE) break;
    factor *= again;
    guard += 1;
  }

  return out;
}
