import { findFreeSpot } from './lassoGeometry';

import type { SceneRect } from './types';

/**
 * Where a hand-drawn concept map lands on a page, so it never covers what is already there.
 *
 * - A notebook sheet / plain board grows downward: the map goes below everything on the page.
 * - A PDF / slide page has a fixed backdrop whose printed text is not a board object. Its text lines
 *   (`detectInkLines` on the page raster) count as taken: the map goes in the first free spot ON the
 *   page — at the largest size that fits (`sizes`, largest first) — and only when the page has no
 *   room at any size, below the page.
 */
export interface HandMapPlacementInput {
  /** Candidate plan sizes, preferred (largest) first. */
  sizes: Array<{ width: number; height: number }>;
  /** Everything already on the page: board objects + the backdrop's text lines. */
  occupied: SceneRect[];
  /** The PDF / slide page's rect, or null on a sheet / plain board. */
  backdrop: SceneRect | null;
  /** Horizontal extent to centre in when going below (the notebook sheet, or the view). */
  region: { left: number; right: number };
  /** Top of the visible area: an empty page starts the map here. */
  viewTop: number;
  /** Gap kept round the map, scene units. */
  margin: number;
}

export interface HandMapPlacement {
  /** Index into `sizes`. */
  index: number;
  left: number;
  top: number;
  /** Placed on the backdrop page (true) or below everything (false). */
  onPage: boolean;
}

const inflate = (rect: SceneRect, by: number): SceneRect => ({
  left: rect.left - by,
  top: rect.top - by,
  width: rect.width + by * 2,
  height: rect.height + by * 2,
});

export function chooseHandMapPlacement({ sizes, occupied, backdrop, region, viewTop, margin }: HandMapPlacementInput): HandMapPlacement {
  if (backdrop) {
    const taken = occupied.map((rect) => inflate(rect, margin / 2));

    for (let index = 0; index < sizes.length; index += 1) {
      const size = sizes[index]!;
      const spot = findFreeSpot(backdrop, size, taken, { minTop: backdrop.top + margin / 2, step: Math.max(4, margin / 3), margin: margin / 2 });

      if (spot) return { index, left: spot.left, top: spot.top, onPage: true };
    }
  }

  const size = sizes[0]!;
  const below = [...occupied, ...(backdrop ? [backdrop] : [])].reduce(
    (max, rect) => (Number.isFinite(rect.top + rect.height) ? Math.max(max, rect.top + rect.height) : max),
    -Infinity,
  );
  const top = Number.isFinite(below) ? below + margin : viewTop + margin;
  const left = Math.max(region.left + margin / 2, region.left + (region.right - region.left - size.width) / 2);

  return { index: 0, left, top, onPage: false };
}

/** A page raster's text lines (normalised 0..1, `detectInkLines`) → scene rects on the backdrop. */
export function backdropLinesToScene(lines: Array<{ x: number; y: number; w: number; h: number }>, backdrop: SceneRect): SceneRect[] {
  return lines.map((line) => ({
    left: backdrop.left + line.x * backdrop.width,
    top: backdrop.top + line.y * backdrop.height,
    width: line.w * backdrop.width,
    height: line.h * backdrop.height,
  }));
}
