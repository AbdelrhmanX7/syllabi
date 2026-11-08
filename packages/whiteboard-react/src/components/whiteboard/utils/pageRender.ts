import type { BackgroundType, MergePageManifestEntry, WhiteboardPage } from '../types';

/**
 * CSS px (96dpi) -> PDF points (72dpi) conversion factor. The merge manifest the backend consumes
 * is expressed in PDF points; the board measures everything in CSS px, so every length crosses this.
 */
const CSS_PX_TO_PT = 72 / 96;

// Pattern geometry — kept identical to `drawBackgroundPattern` in ./backgroundLayers so the overlay
// PNG is pixel-faithful to the live board. The ONLY difference here is that we never paint the
// opaque white background fill: the overlay must stay transparent so the backend can composite it
// over the vector source PDF (any opaque fill would hide the PDF underneath). Keep these in sync.
const GRID_SIZE = 30;
const DOT_RADIUS = 1.5;
const LINE_SPACING = 30;
const PATTERN_COLOR = '#e0e0e0';

/** Source-PDF placement rect inside the export bounds — CSS px, top-left origin. */
export interface PdfPlacementCss {
  height: number;
  left: number;
  top: number;
  width: number;
}

/**
 * Result of `createPageOverlaySnapshot`: a full-page TRANSPARENT overlay PNG (everything EXCEPT the
 * source PDF — background pattern + ink + shared bg-image overlay) plus the geometry the merge
 * manifest needs to place the ink over the vector PDF on the backend.
 */
export interface PageOverlaySnapshot {
  /** export-bounds height in CSS px (the overlay's logical page height; -> heightPt). */
  contentHeightCss: number;
  /** export-bounds width in CSS px (the overlay's logical page width; -> widthPt). */
  contentWidthCss: number;
  /** image/png data URL; transparent wherever the source PDF would show through. */
  dataUrl: string;
  /** source-PDF placement within the export bounds (CSS px, top-left origin); absent on blank pages.
   * With `pdfRotationDeg` set this is the rotated page's BOUNDING BOX. */
  pdfPlacementCss?: PdfPlacementCss;
  /** background rotation in degrees clockwise (screen sense); absent/0 = unrotated. */
  pdfRotationDeg?: number;
  /** overlay bitmap height in device px (contentHeightCss * multiplier). */
  pixelHeight: number;
  /** overlay bitmap width in device px (contentWidthCss * multiplier). */
  pixelWidth: number;
}

/**
 * Paint the page background PATTERN (grid/lined/dotted) onto a TRANSPARENT canvas at identity scale.
 * Mirrors `drawBackgroundPattern`'s no-viewport path but WITHOUT its opaque white fill, so the
 * overlay stays transparent for backend compositing over the vector PDF. `blank` => no-op (fully
 * transparent). The export path renders at identity (no pan/zoom), so this draws the pattern in
 * device px starting from the origin, exactly like `drawBackgroundPattern(canvas, type, w, h)`.
 */
export function paintOverlayPattern(
  patternCanvas: HTMLCanvasElement,
  type: BackgroundType,
  width: number,
  height: number,
  spacing?: number,
): void {
  const ctx = patternCanvas.getContext('2d');

  if (!ctx) return;

  if (patternCanvas.width !== width || patternCanvas.height !== height) {
    patternCanvas.width = width;
    patternCanvas.height = height;
  }

  ctx.clearRect(0, 0, width, height);

  if (type === 'blank') return;

  const gridSize = spacing !== undefined && spacing > 0 ? spacing : GRID_SIZE;
  const lineSpacing = spacing !== undefined && spacing > 0 ? spacing : LINE_SPACING;

  ctx.strokeStyle = PATTERN_COLOR;
  ctx.fillStyle = PATTERN_COLOR;
  ctx.lineWidth = 1;

  switch (type) {
    case 'grid':
      ctx.beginPath();

      for (let x = 0; x <= width + gridSize; x += gridSize) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
      }

      for (let y = 0; y <= height + gridSize; y += gridSize) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
      }

      ctx.stroke();
      break;

    case 'lined':
      ctx.beginPath();

      for (let y = 0; y <= height + lineSpacing; y += lineSpacing) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
      }

      ctx.stroke();
      break;

    case 'dotted':
      for (let x = 0; x <= width + gridSize; x += gridSize) {
        for (let y = 0; y <= height + gridSize; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      break;
  }
}

/**
 * PURE conversion of one page's overlay geometry from CSS px (96dpi, top-left origin) to PDF points
 * (72dpi, pdf-lib **bottom-left** origin) for the merge manifest. Returns the entry MINUS
 * `overlayKey` (filled in after the overlay PNG is uploaded). A blank page (no source PDF) omits
 * `pdf` together with `pdfAssetId`/`pdfPageIndex` — the backend rejects a `pdf` rect without a
 * `pdfAssetId`.
 *
 * Conversion rules:
 * - `widthPt  = contentWidthCss  * 72/96`
 * - `heightPt = contentHeightCss * 72/96`
 * - PDF page (`pdfPlacementCss` present AND `page.pdfAssetId` set):
 *   - `pdf.x      = pdfPlacementCss.left   * 72/96`  (left, relative to the export bounds)
 *   - `pdf.width  = pdfPlacementCss.width  * 72/96`
 *   - `pdf.height = pdfPlacementCss.height * 72/96`
 *   - `pdf.y      = heightPt - (pdfPlacementCss.top * 72/96) - pdf.height`  (flip Y to bottom-left)
 */
export function buildMergeManifestEntry(
  page: Pick<WhiteboardPage, 'pdfAssetId' | 'pdfPageIndex'>,
  index: number,
  snap: Pick<PageOverlaySnapshot, 'contentHeightCss' | 'contentWidthCss' | 'pdfPlacementCss' | 'pdfRotationDeg'>,
): Omit<MergePageManifestEntry, 'overlayKey'> {
  const widthPt = snap.contentWidthCss * CSS_PX_TO_PT;
  const heightPt = snap.contentHeightCss * CSS_PX_TO_PT;

  const entry: Omit<MergePageManifestEntry, 'overlayKey'> = {
    heightPt,
    index,
    widthPt,
  };

  // A `pdf` placement rect requires a source-PDF asset on the page; blank/overlay-only pages leave
  // every PDF field unset (the overlay PNG itself carries the pattern, and the backend draws it on
  // a blank page of widthPt x heightPt).
  if (snap.pdfPlacementCss && page.pdfAssetId) {
    const pdfHeightPt = snap.pdfPlacementCss.height * CSS_PX_TO_PT;

    entry.pdfAssetId = page.pdfAssetId;

    if (page.pdfPageIndex !== undefined) {
      entry.pdfPageIndex = page.pdfPageIndex;
    }

    entry.pdf = {
      height: pdfHeightPt,
      width: snap.pdfPlacementCss.width * CSS_PX_TO_PT,
      x: snap.pdfPlacementCss.left * CSS_PX_TO_PT,
      y: heightPt - snap.pdfPlacementCss.top * CSS_PX_TO_PT - pdfHeightPt,
    };

    // Angles are degrees-clockwise on screen; the rect above is the rotated page's bounding box.
    // Emitted only when meaningful so unrotated boards keep the exact pre-rotation payload shape.
    const rotation = ((Number(snap.pdfRotationDeg ?? 0) % 360) + 360) % 360;

    if (rotation !== 0) {
      entry.pdfRotation = rotation;
    }
  }

  return entry;
}
