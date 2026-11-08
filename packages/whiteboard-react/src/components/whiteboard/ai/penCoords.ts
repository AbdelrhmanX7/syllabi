import type { NormalizedBox, PagePoint, SceneRect } from './types';

/**
 * «Explain on my page» coordinates. The model never sees a scene unit: every point and box it reads
 * or writes is `{x, y}` in 0..1 of the PAGE SHEET (origin top-left, the `NormalizedBox` convention),
 * so zoom, device and layout do not matter to it. This module is the one place that converts through
 * the sheet's scene rectangle — the current page's export bounds in the paged layout, the sheet entry
 * (`{top, height}` at x = 0, `layout.width` wide) in the continuous scroll layout.
 */

export interface ScenePt {
  x: number;
  y: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** A sheet rect the conversions can divide by (a degenerate page becomes 1 × 1 so nothing is NaN). */
const safe = (page: SceneRect): SceneRect => ({
  left: page.left,
  top: page.top,
  width: page.width > 0 ? page.width : 1,
  height: page.height > 0 ? page.height : 1,
});

export function toScenePoint(point: PagePoint, page: SceneRect): ScenePt {
  const sheet = safe(page);

  return { x: sheet.left + clamp01(point.x) * sheet.width, y: sheet.top + clamp01(point.y) * sheet.height };
}

export function toPagePoint(point: ScenePt, page: SceneRect): PagePoint {
  const sheet = safe(page);

  return { x: clamp01((point.x - sheet.left) / sheet.width), y: clamp01((point.y - sheet.top) / sheet.height) };
}

/** A normalised box → scene rect, clipped to the sheet. */
export function toSceneBox(box: NormalizedBox, page: SceneRect): SceneRect {
  const sheet = safe(page);
  const x = clamp01(box.x);
  const y = clamp01(box.y);
  const w = Math.max(0, Math.min(box.w, 1 - x));
  const h = Math.max(0, Math.min(box.h, 1 - y));

  return { left: sheet.left + x * sheet.width, top: sheet.top + y * sheet.height, width: w * sheet.width, height: h * sheet.height };
}

/** A scene rect → normalised box, clipped to the sheet (rounded to 1/10000 like `clusterBoxes`). */
export function toPageBox(rect: SceneRect, page: SceneRect): NormalizedBox {
  const sheet = safe(page);
  const round = (value: number) => Math.round(clamp01(value) * 10000) / 10000;
  const x = (rect.left - sheet.left) / sheet.width;
  const y = (rect.top - sheet.top) / sheet.height;

  return {
    x: round(x),
    y: round(y),
    w: round(Math.min(rect.width / sheet.width, 1 - clamp01(x))),
    h: round(Math.min(rect.height / sheet.height, 1 - clamp01(y))),
  };
}

/** A length given as a fraction of the page HEIGHT (letter sizes, widths) → scene units. */
export const pageLength = (fraction: number, page: SceneRect): number => Math.max(0, fraction) * safe(page).height;

/**
 * The sheet under scene `y` in the continuous scroll layout: pages are stacked at x = 0, every one
 * `width` wide. The gap below a page belongs to it; above the first page is the first, below the
 * last is the last (the `findPdfScrollPageAt` rule). Null for an empty layout.
 */
export function scrollSheetAt(
  layout: { width: number; entries: ReadonlyArray<{ top: number; height: number }> },
  y: number,
): SceneRect | null {
  const { entries } = layout;

  if (entries.length === 0) return null;

  let index = 0;

  while (index + 1 < entries.length && entries[index + 1]!.top <= y) index += 1;

  const entry = entries[index]!;

  return { left: 0, top: entry.top, width: layout.width, height: entry.height };
}

/** The sheet of page `index` in the continuous scroll layout. */
export function scrollSheetOf(layout: { width: number; entries: ReadonlyArray<{ top: number; height: number }> }, index: number): SceneRect | null {
  const entry = layout.entries[index];

  return entry ? { left: 0, top: entry.top, width: layout.width, height: entry.height } : null;
}

/** The sheet in the paged layout: one page at a time, its export bounds ARE the sheet. */
export const pagedSheet = (bounds: SceneRect): SceneRect => ({ ...bounds });
