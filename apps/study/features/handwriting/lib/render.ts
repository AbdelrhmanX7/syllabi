/**
 * Draw bank samples as SVG paths: the Settings preview line (single glyphs side by side, left to
 * right — compose is not here yet) and the sheet cells' thumbnails. Pure, so it is tested without a DOM.
 *
 * A sample is in contract space (baseline y = 0, x-height = 1, y down). `xHeightPx` is the scale.
 */
import type { GlyphPoint, GlyphSample } from '@repo/whiteboard-react';

export interface RenderedGlyph {
  /** One SVG `d` per stroke, already translated to its slot. */
  paths: string[];
  /** The slot's left edge in the line's px space. */
  x: number;
  width: number;
}

export interface RenderedLine {
  glyphs: RenderedGlyph[];
  width: number;
  height: number;
  /** Where the baseline sits, px from the top. */
  baselineY: number;
  strokeWidth: number;
}

const fmt = (value: number) => (Math.round(value * 100) / 100).toString();

/** A smooth polyline: straight to the first point, then quadratic curves through segment midpoints. */
export function strokePath(
  points: readonly GlyphPoint[],
  toX: (x: number) => number,
  toY: (y: number) => number,
): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const [x, y] = points[0];

    // A dot: a zero-length segment with round caps renders as a disc.
    return `M${fmt(toX(x))} ${fmt(toY(y))} L${fmt(toX(x))} ${fmt(toY(y))}`;
  }

  let d = `M${fmt(toX(points[0][0]))} ${fmt(toY(points[0][1]))}`;

  for (let i = 1; i < points.length - 1; i++) {
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];

    d += ` Q${fmt(toX(cx))} ${fmt(toY(cy))} ${fmt(toX((cx + nx) / 2))} ${fmt(toY((cy + ny) / 2))}`;
  }
  const [lx, ly] = points[points.length - 1];

  d += ` L${fmt(toX(lx))} ${fmt(toY(ly))}`;

  return d;
}

/**
 * Lay samples on one line, left to right, each in a slot as wide as its
 * bbox plus `gap`. The line is as tall as the tallest ascender + deepest descender, with `pad` around.
 */
export function renderGlyphLine(
  samples: readonly GlyphSample[],
  {
    xHeightPx = 28,
    gap = 10,
    pad = 8,
    strokeWidth = 2.2,
  }: { xHeightPx?: number; gap?: number; pad?: number; strokeWidth?: number } = {},
): RenderedLine {
  const widths = samples.map((sample) => Math.max(sample.bbox.w, 0.2) * xHeightPx);
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, samples.length - 1) + pad * 2;
  // Ascenders are negative y; a sample with no ink above the baseline still gets one x-height of room.
  const top = Math.min(-1, ...samples.map((sample) => sample.bbox.y));
  const bottom = Math.max(0.4, ...samples.map((sample) => sample.bbox.y + sample.bbox.h));
  const baselineY = pad - top * xHeightPx;
  const height = (bottom - top) * xHeightPx + pad * 2;
  const glyphs: RenderedGlyph[] = [];
  let cursor = pad;

  samples.forEach((sample, index) => {
    const width = widths[index];
    const x = cursor;
    const toX = (value: number) => x + (value - sample.bbox.x) * xHeightPx;
    const toY = (value: number) => baselineY + value * xHeightPx;

    glyphs.push({ x, width, paths: sample.strokes.map((stroke) => strokePath(stroke, toX, toY)) });
    cursor = x + width + gap;
  });

  return { glyphs, width: totalWidth, height, baselineY, strokeWidth };
}

/** The newest sample of each glyph the bank has, in the order given (missing keys skipped). */
export function pickPreviewSamples(
  glyphs: Record<string, { samples: GlyphSample[] }>,
  keys: readonly string[],
  max = 8,
): GlyphSample[] {
  const out: GlyphSample[] = [];

  for (const key of keys) {
    const samples = glyphs[key]?.samples;

    if (!samples?.length) continue;
    out.push(samples[samples.length - 1]);
    if (out.length >= max) break;
  }

  return out;
}
