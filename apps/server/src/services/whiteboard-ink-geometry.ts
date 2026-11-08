/**
 * Pure geometry for rendering board ink (Fabric vectors) into merge overlays.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 * The physical board app pushes DRAFT SNAPSHOTS (vector Fabric JSON per page) but
 * only produces the rendered overlay PNGs the merge pipeline needs when a teacher
 * explicitly publishes from the board. To serve an on-demand download that
 * contains the CURRENT drawings, the server has to rasterise that vector ink
 * itself — and to do that it must reproduce the board's coordinate convention
 * exactly, because ink drawn 800px off is worse than no ink at all.
 *
 * ─── The convention, derived empirically ─────────────────────────────────────
 * Nothing here was specified by the board team; every rule below was recovered by
 * comparing published overlays against the snapshot they were rendered from, and
 * `scripts/calibrate-whiteboard-ink.ts` re-runs that comparison against real data.
 * Change nothing in this file without re-running it.
 * Fabric object coordinates live in a WORLD space that is NOT the page. The page
 * the board emits is
 *
 *     pageRect = union(baseRect, inkBoundingBox)
 *
 * where `baseRect` is the source-PDF background's rect in world coordinates (or,
 * for a blank page, the page itself). The overlay is that union, so the world →
 * page translation is `t = -pageRect.topLeft`, i.e. ink at the union's top-left
 * lands at overlay pixel (0,0). This is why a teacher who draws above or left of
 * the PDF gets a TALLER/WIDER output page rather than clipped ink.
 *
 * `baseRect.topLeft` — the world position of the background — is the one quantity
 * that cannot be read off a single page, because a page whose ink stays inside the
 * background never reveals it (the union is just the background). It is recovered
 * by `solveWorldOrigin` from pages that DID grow: on a page that grew leftward the
 * board tells us `pdf.x > 0`, and since that growth was caused by the ink,
 * `baseLeft = pdfRectPx.left + ink.minX`. Growth on the other three sides gives the
 * same information from the opposite edge.
 *
 * Units: the board works in CSS pixels; the manifest is in PDF points at exactly
 * 0.75 pt/px (96dpi → 72dpi). pdf-lib's rect is y-UP from the page bottom, while
 * canvas/world coordinates are y-DOWN from the top, so every conversion of `pdf.y`
 * flips through the page height.
 */

/** PDF points per board CSS pixel (72/96). The board's own conversion factor. */
export const PT_PER_PX = 0.75;

/**
 * Longest overlay edge the board itself emits, reproduced here so a server render
 * is the same resolution as a board render. Measured on every published overlay of
 * a production board: each is exactly 2400px on its long side.
 */
export const MAX_OVERLAY_EDGE_PX = 2400;

/** Axis-aligned rect, y-DOWN from the top-left (canvas/world convention). */
export interface RectPx {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Bounding box of a page's ink in WORLD coordinates; null when the page is empty. */
export interface InkBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** pdf-lib placement rect as stored on a merge manifest page (points, y-UP). */
export interface PdfPlacementPt {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The subset of a merge-manifest page this module reads. Deliberately structural
 * (not the mongoose document) so the transform stays unit-testable without a DB.
 */
export interface ReferencePage {
  index: number;
  widthPt: number;
  heightPt: number;
  pdf?: PdfPlacementPt | null;
}

/** World coordinates of the page background's top-left corner. */
export interface WorldOrigin {
  x: number;
  y: number;
}

const px = (pt: number) => pt / PT_PER_PX;
const pt = (value: number) => value * PT_PER_PX;

/**
 * Where the page's background sits INSIDE the output page, in page pixels.
 *
 * For a PDF-backed page this is the manifest's `pdf` rect converted out of
 * pdf-lib's y-up frame; for a blank page the background IS the page, so the rect
 * is the whole page at the origin.
 */
export function basePageRectPx(page: ReferencePage): RectPx {
  const pageHeightPx = px(page.heightPt);
  if (!page.pdf) {
    return { left: 0, top: 0, width: px(page.widthPt), height: pageHeightPx };
  }
  const width = px(page.pdf.width);
  const height = px(page.pdf.height);
  return {
    left: px(page.pdf.x),
    // pdf.y is the background's BOTTOM edge measured up from the page bottom;
    // flipping it through the page height gives the top edge measured down from
    // the page top, which is the frame the ink is in.
    top: pageHeightPx - px(page.pdf.y) - height,
    width,
    height,
  };
}

/**
 * What one already-published page reveals about the world origin.
 *
 * A page only constrains an axis if the output page GREW on that axis, because
 * growth is what ties the ink's world coordinates to the background's. Growth
 * before the background (`base.left > 0`) means the ink's leftmost point defines
 * the page edge, so `baseLeft = base.left + ink.minX`; growth after it means the
 * ink's rightmost point does, so `baseLeft = ink.maxX - pageWidth`. A page that
 * did not grow on an axis returns `null` for it and must not be averaged in — its
 * translation is exactly the unknown we are solving for, so including it would
 * feed the answer back into itself.
 *
 * `epsilonPx` absorbs the board's own sub-pixel rounding of the page rect (its
 * page sizes are integral pixels), so a page that grew by less than a pixel is
 * treated as not having grown.
 */
export function worldOriginSample(
  page: ReferencePage,
  ink: InkBbox | null,
  epsilonPx = 1
): { x: number | null; y: number | null } {
  if (!ink) return { x: null, y: null };

  const base = basePageRectPx(page);
  const pageWidthPx = px(page.widthPt);
  const pageHeightPx = px(page.heightPt);

  let x: number | null = null;
  if (base.left > epsilonPx) {
    x = base.left + ink.minX;
  } else if (pageWidthPx - (base.left + base.width) > epsilonPx) {
    x = ink.maxX - pageWidthPx;
  }

  let y: number | null = null;
  if (base.top > epsilonPx) {
    y = base.top + ink.minY;
  } else if (pageHeightPx - (base.top + base.height) > epsilonPx) {
    y = ink.maxY - pageHeightPx;
  }

  return { x, y };
}

/** Median — chosen over a mean so one mis-measured page cannot drag the origin. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Recover the background's world position from a published manifest and the
 * snapshot it was minted from.
 *
 * Returns null on an axis with no growing page — the caller must then fall back to
 * the board's default viewport (see `worldOriginFromViewport`) or decline to
 * render. Guessing zero here would silently place every stroke wrong.
 */
export function solveWorldOrigin(
  samples: Array<{ x: number | null; y: number | null }>
): { x: number | null; y: number | null; sampleCount: { x: number; y: number } } {
  const xs = samples.map((s) => s.x).filter((v): v is number => v != null);
  const ys = samples.map((s) => s.y).filter((v): v is number => v != null);
  return {
    x: xs.length ? median(xs) : null,
    y: ys.length ? median(ys) : null,
    sampleCount: { x: xs.length, y: ys.length },
  };
}

/**
 * The board's default view places the background's top-left at the viewport's
 * top-left, so a page the teacher never panned carries `pan = -baseTopLeft`.
 *
 * This is the fallback when no published page grew (nothing to solve against). It
 * agrees with `solveWorldOrigin` to ~1.5px on the calibration document, which is
 * the board's own rounding, but it is the WEAKER source: it assumes the untouched
 * pages really are at the default view, so it is only consulted second.
 */
export function worldOriginFromViewport(
  pages: Array<{ viewportOffsetX?: number; viewportOffsetY?: number; viewportZoom?: number }>
): WorldOrigin | null {
  // Only pages still at zoom 1 can be read this way: a zoomed page's pan is in
  // screen units and no longer equals the negated world origin.
  const counts = new Map<string, { n: number; x: number; y: number }>();
  for (const p of pages) {
    if (p.viewportZoom != null && Math.abs(p.viewportZoom - 1) > 1e-9) continue;
    const x = p.viewportOffsetX ?? 0;
    const y = p.viewportOffsetY ?? 0;
    const key = `${x}|${y}`;
    const entry = counts.get(key) ?? { n: 0, x, y };
    entry.n += 1;
    counts.set(key, entry);
  }
  if (!counts.size) return null;
  // The modal pan across untouched pages — a handful of panned pages must not
  // outvote the default the rest of the document still sits at.
  const modal = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return { x: -modal.x, y: -modal.y };
}

/** Everything the rasteriser and the manifest need for one rendered page. */
export interface OverlayPlan {
  index: number;
  /** Output page size, PDF points — the union of background and ink. */
  widthPt: number;
  heightPt: number;
  /** Background placement inside the output page, pdf-lib frame; null when blank. */
  pdf: PdfPlacementPt | null;
  /** Output page size in board pixels. */
  pageWidthPx: number;
  pageHeightPx: number;
  /** World → page translation: pageX = worldX + tx. */
  tx: number;
  ty: number;
  /** Page px → overlay px, capped so the long edge is MAX_OVERLAY_EDGE_PX. */
  exportScale: number;
  /** Overlay raster size. */
  pixelWidth: number;
  pixelHeight: number;
  /** False when the page has no ink and therefore needs no overlay at all. */
  hasInk: boolean;
}

/**
 * Build the render plan for one page: union the background with the ink, then
 * derive the translation, the output page size and the raster size.
 *
 * `worldOrigin` is the background's top-left in world coordinates. The page grows
 * to contain any ink outside the background — matching the board, which is why a
 * re-render of an unchanged page reproduces the published page size.
 */
export function computeOverlayPlan(
  page: ReferencePage,
  ink: InkBbox | null,
  worldOrigin: WorldOrigin
): OverlayPlan {
  const base = basePageRectPx(page);
  // `worldOrigin` locates the SOURCE-PDF background, so it only applies to a page
  // that has one. A blank page has no PDF to anchor to — the board creates it at
  // the canvas origin, so its own rect is its background and sits at world (0,0).
  // Anchoring a blank page to the PDF origin instead stretches it by that offset:
  // on the calibration document it turned page 0 from 789.75pt tall into 1407pt,
  // which is exactly how this was caught.
  const anchor: WorldOrigin = page.pdf ? worldOrigin : { x: 0, y: 0 };
  const baseWorld: RectPx = {
    left: anchor.x,
    top: anchor.y,
    width: base.width,
    height: base.height,
  };

  let minX = baseWorld.left;
  let minY = baseWorld.top;
  let maxX = baseWorld.left + baseWorld.width;
  let maxY = baseWorld.top + baseWorld.height;

  if (ink) {
    minX = Math.min(minX, ink.minX);
    minY = Math.min(minY, ink.minY);
    maxX = Math.max(maxX, ink.maxX);
    maxY = Math.max(maxY, ink.maxY);
  }

  // The board's page sizes are whole pixels; rounding the same way keeps a
  // re-render of an unchanged page byte-comparable in size to the published one.
  const pageWidthPx = Math.round(maxX - minX);
  const pageHeightPx = Math.round(maxY - minY);
  const tx = -minX;
  const ty = -minY;

  const exportScale = Math.min(
    1,
    MAX_OVERLAY_EDGE_PX / Math.max(pageWidthPx, pageHeightPx)
  );

  // The background's placement inside the (possibly grown) page, converted back
  // into pdf-lib's y-up frame for the merge.
  const baseLeftPx = baseWorld.left + tx;
  const baseTopPx = baseWorld.top + ty;
  const pdf: PdfPlacementPt | null = page.pdf
    ? {
        x: pt(baseLeftPx),
        y: pt(pageHeightPx - baseTopPx - baseWorld.height),
        width: page.pdf.width,
        height: page.pdf.height,
      }
    : null;

  return {
    index: page.index,
    widthPt: pt(pageWidthPx),
    heightPt: pt(pageHeightPx),
    pdf,
    pageWidthPx,
    pageHeightPx,
    tx,
    ty,
    exportScale,
    pixelWidth: Math.max(1, Math.floor(pageWidthPx * exportScale)),
    pixelHeight: Math.max(1, Math.floor(pageHeightPx * exportScale)),
    hasInk: ink != null,
  };
}
