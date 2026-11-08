/**
 * Making a lassoed region readable for a vision model — pure pixel maths (RGBA buffers), so every
 * step is unit-tested; `rasterize.ts#prepareForVision` runs it on a canvas.
 *
 * What goes wrong with a raw crop of handwriting (owner report 2026-10-04, «f(x) = x², f'(x) = ?» on
 * the tablet read as nothing): thin pen strokes a few px wide, light nibs (yellow/white) that vanish
 * on white, a dark backdrop, and handwriting that is small in absolute pixels once the model
 * downsamples. So: opaque white backdrop, ink pushed to ≥ 4.5:1 contrast while KEEPING its hue,
 * strokes thickened when they are hairlines, a margin, and a scale where a line of writing is ≥ 40 px.
 */

const luminance = (r: number, g: number, b: number) => {
  const channel = (value: number) => {
    const c = value / 255;

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** WCAG contrast ratio of a colour against white. */
export const contrastOnWhite = (r: number, g: number, b: number) => 1.05 / (luminance(r, g, b) + 0.05);

/** Median luminance of the outermost pixel ring — what the board is, under the ink. */
export function borderLuminance(data: Uint8ClampedArray, width: number, height: number): number {
  const values: number[] = [];
  const push = (x: number, y: number) => {
    const o = (y * width + x) * 4;

    values.push(data[o + 3]! < 16 ? 1 : luminance(data[o]!, data[o + 1]!, data[o + 2]!));
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }

  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  values.sort((a, b) => a - b);

  return values[Math.floor(values.length / 2)] ?? 1;
}

/** Target luminance for ink: 1.05 / (0.15 + 0.05) = 5.25 : 1 on white. */
const INK_LUMINANCE = 0.15;

/**
 * In place: transparent → white; a dark board is inverted (light chalk → dark ink on white); the
 * board colour itself becomes pure white; every inked pixel is darkened toward ≥ 4.5:1 while keeping
 * its hue. A pixel's «inkness» is its distance from the board colour, so anti-aliased edges blend
 * smoothly into the paper. Returns whether the board was inverted.
 */
export function normalizeInk(data: Uint8ClampedArray, width: number, height: number): { inverted: boolean } {
  const inverted = borderLuminance(data, width, height) < 0.35;

  // Pass 1: composite onto white (a transparent pixel is paper, not black) and invert a dark board.
  for (let o = 0; o < data.length; o += 4) {
    const alpha = data[o + 3]! / 255;

    for (let c = 0; c < 3; c += 1) {
      const value = data[o + c]! * alpha + 255 * (1 - alpha);

      data[o + c] = inverted ? 255 - value : value;
    }

    data[o + 3] = 255;
  }

  // The board colour = per-channel median of the border ring.
  const ring: number[][] = [[], [], []];
  const sample = (x: number, y: number) => {
    const o = (y * width + x) * 4;

    for (let c = 0; c < 3; c += 1) ring[c]!.push(data[o + c]!);
  };

  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    sample(x, height - 1);
  }

  for (let y = 0; y < height; y += 1) {
    sample(0, y);
    sample(width - 1, y);
  }

  const board = ring.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 255);

  // Pass 2: board → white, ink → dark (hue kept), blended by inkness.
  for (let o = 0; o < data.length; o += 4) {
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const inkness = Math.max(Math.abs(r - board[0]!), Math.abs(g - board[1]!), Math.abs(b - board[2]!)) / 255;

    if (inkness < 0.06) {
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      continue;
    }

    // Faint GREY (grid lines, a pattern, anti-aliasing) stays as it is: darkening it would draw the
    // grid as ink. Faint COLOUR is a light nib and is darkened.
    const maxC = Math.max(r, g, b);
    const saturation = maxC === 0 ? 0 : (maxC - Math.min(r, g, b)) / maxC;

    if (saturation < 0.2 && inkness < 0.25) continue;

    let k = 1;

    for (let step = 0; step < 14 && luminance(r * k, g * k, b * k) > INK_LUMINANCE; step += 1) k *= 0.8;

    const mix = Math.min(1, inkness * 2.5);

    data[o] = 255 * (1 - mix) + r * k * mix;
    data[o + 1] = 255 * (1 - mix) + g * k * mix;
    data[o + 2] = 255 * (1 - mix) + b * k * mix;
  }

  return { inverted };
}

const isInk = (data: Uint8ClampedArray, o: number) => Math.min(data[o]!, data[o + 1]!, data[o + 2]!) < 160;

/** Median horizontal run of ink pixels — a cheap stroke-width estimate (px). 0 = no ink. */
export function strokeWidthEstimate(data: Uint8ClampedArray, width: number, height: number): number {
  const runs: number[] = [];

  for (let y = 0; y < height; y += 2) {
    let run = 0;

    for (let x = 0; x < width; x += 1) {
      if (isInk(data, (y * width + x) * 4)) run += 1;
      else if (run > 0) {
        runs.push(run);
        run = 0;
      }
    }

    if (run > 0) runs.push(run);
  }

  if (runs.length === 0) return 0;

  runs.sort((a, b) => a - b);

  return runs[Math.floor(runs.length / 2)]!;
}

/** One 3×3 «darkest neighbour» pass: hairline strokes gain ~2 px. Returns a new buffer. */
export function thickenInk(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = (y * width + x) * 4;
      let bestSum = data[best]! + data[best + 1]! + data[best + 2]!;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;

          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const o = (ny * width + nx) * 4;
          const sum = data[o]! + data[o + 1]! + data[o + 2]!;

          if (sum < bestSum) {
            bestSum = sum;
            best = o;
          }
        }
      }

      const o = (y * width + x) * 4;

      out[o] = data[best]!;
      out[o + 1] = data[best + 1]!;
      out[o + 2] = data[best + 2]!;
      out[o + 3] = 255;
    }
  }

  return out;
}

/**
 * The output scale for a crop whose writing lines are `lineHeight` px tall: lines ≥ `minLine` px,
 * long edge within [minEdge, maxEdge] (the edge bounds win over the line target).
 */
export function visionScale(
  size: { width: number; height: number },
  lineHeight: number,
  { minLine = 40, minEdge = 512, maxEdge = 1600 }: { minLine?: number; minEdge?: number; maxEdge?: number } = {},
): number {
  const longest = Math.max(size.width, size.height, 1);
  let scale = lineHeight > 0 ? Math.max(1, minLine / lineHeight) : 1;

  scale = Math.max(scale, minEdge / longest);
  scale = Math.min(scale, maxEdge / longest);

  return scale;
}
