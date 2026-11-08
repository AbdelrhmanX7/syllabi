// A per-page ruler preset (saved by Claude through the Study MCP, or by the student): where the 0 end sits on
// the PAPER, the tick factor, the angle, and an optional map scale that turns the lower edge into ground distance.
import type { EditorViewport } from '@repo/whiteboard-react';

import { MM_PER_INCH, PAGE_UNITS_PER_PAPER_MM } from '@/lib/ruler/calibration';

export type GroundUnit = 'ft' | 'm' | 'km' | 'mi';

export interface RulerPreset {
  pageFactor?: number;
  angleDeg?: number;
  /** The 0 end, in millimetres of PAPER from the board origin (x right, y down). */
  zeroAt?: { xMm: number; yMm: number };
  /** The map's scale denominator: 24000 = 1:24,000. */
  mapScale?: number;
  groundUnit?: GroundUnit;
  setBy: 'claude' | 'user';
  updatedAt: string;
}

export type BoardViewport = EditorViewport;

const MM_PER_UNIT: Record<GroundUnit, number> = { ft: 304.8, m: 1000, km: 1_000_000, mi: 1_609_344 };

/** Paper mm → the board root's local screen px, through the editor's current viewport transform. */
export function paperToRoot(vp: BoardViewport, rootLeft: number, rootTop: number, xMm: number, yMm: number) {
  return {
    x: vp.originX - rootLeft + vp.offsetX + xMm * PAGE_UNITS_PER_PAPER_MM * vp.zoom,
    y: vp.originY - rootTop + vp.offsetY + yMm * PAGE_UNITS_PER_PAPER_MM * vp.zoom,
  };
}

/** The inverse of {@link paperToRoot}. */
export function rootToPaper(vp: BoardViewport, rootLeft: number, rootTop: number, x: number, y: number) {
  const k = PAGE_UNITS_PER_PAPER_MM * vp.zoom;

  return {
    xMm: (x - (vp.originX - rootLeft + vp.offsetX)) / k,
    yMm: (y - (vp.originY - rootTop + vp.offsetY)) / k,
  };
}

/** Ground units covered by 1 mm of paper at 1:`scale`. */
export const groundPerPaperMm = (scale: number, unit: GroundUnit): number => scale / MM_PER_UNIT[unit];

/** Ground units per inch of paper (1:24000 in ft = 2000). */
export const groundPerInch = (scale: number, unit: GroundUnit): number => groundPerPaperMm(scale, unit) * MM_PER_INCH;

/** A round step (1/2/5 × 10ⁿ) of at least `min`, with the minor-tick count that divides it evenly. */
export function niceStep(min: number): { step: number; minors: number } {
  const exp = Math.floor(Math.log10(min));
  const base = 10 ** exp;

  for (const lead of [1, 2, 5, 10]) {
    if (lead * base >= min) return { step: lead * base, minors: lead === 2 ? 4 : 5 };
  }

  return { step: 10 * base, minors: 5 };
}

export const formatGround = (value: number): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

export const formatScale = (scale: number): string => `1:${Math.round(scale).toLocaleString('en-US')}`;
