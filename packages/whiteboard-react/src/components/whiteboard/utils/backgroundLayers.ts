import type { BackgroundType } from '../types';

import { boardBaseColor, boardPatternColor, LIGHT_BOARD_BASE_COLOR, LIGHT_BOARD_PATTERN_COLOR } from './darkBoard';

const GRID_SIZE = 30;
const DOT_RADIUS = 1.5;
const LINE_SPACING = 30;

interface BackgroundViewportOptions {
  viewportTransform?: [number, number, number, number, number, number] | number[];
  /** Line / cell spacing in board px (utils/paperSpacing). Absent = the original 30 px. */
  spacing?: number;
  /** Paint paper colours even on a dark board (the pattern multiplied over a white PDF sheet). */
  paper?: boolean;
}

interface VisibleBounds {
  bottom: number;
  left: number;
  right: number;
  scaleX: number;
  scaleY: number;
  top: number;
}

interface FittedImagePlacement {
  height: number;
  left: number;
  scale: number;
  top: number;
  width: number;
}

function getVisibleBounds(
  width: number,
  height: number,
  viewportTransform?: [number, number, number, number, number, number] | number[],
): VisibleBounds {
  const scaleX = viewportTransform?.[0] || 1;
  const scaleY = viewportTransform?.[3] || 1;
  const offsetX = viewportTransform?.[4] || 0;
  const offsetY = viewportTransform?.[5] || 0;
  const left = Math.min(-offsetX / scaleX, (width - offsetX) / scaleX);
  const right = Math.max(-offsetX / scaleX, (width - offsetX) / scaleX);
  const top = Math.min(-offsetY / scaleY, (height - offsetY) / scaleY);
  const bottom = Math.max(-offsetY / scaleY, (height - offsetY) / scaleY);

  return {
    bottom,
    left,
    right,
    scaleX,
    scaleY,
    top,
  };
}

function getAlignedStart(value: number, spacing: number): number {
  return Math.floor(value / spacing) * spacing;
}

/** Degrees → [0, 360); NaN/undefined → 0. Rotation is degrees CLOCKWISE in screen space, which is
 * the positive direction of `ctx.rotate` under the canvas's y-down coordinate system. */
export function normalizeRotationDeg(rotationDeg: number | undefined): number {
  const deg = Number(rotationDeg ?? 0);

  if (!Number.isFinite(deg)) return 0;

  return ((deg % 360) + 360) % 360;
}

/** Axis-aligned bounding box of a w×h rect rotated by any angle. */
export function getRotatedBoundingSize(
  width: number,
  height: number,
  rotationDeg: number,
): { height: number; width: number } {
  const rad = (normalizeRotationDeg(rotationDeg) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));

  return {
    height: width * sin + height * cos,
    width: width * cos + height * sin,
  };
}

/**
 * `getScreenFitPlacement` for a rotated background: the fit (and therefore the page's ink coordinate
 * frame) is computed from the rotated image's BOUNDING BOX, so the returned rect is the bbox and
 * `scale` is the uniform factor applied to the UNROTATED image drawn rotated about the bbox center.
 * At rotation 0 this is exactly `getScreenFitPlacement`.
 */
export function getRotatedScreenFitPlacement(
  canvasWidth: number,
  canvasHeight: number,
  imageWidth: number,
  imageHeight: number,
  rotationDeg: number,
): FittedImagePlacement {
  const bbox = getRotatedBoundingSize(Math.max(1, imageWidth), Math.max(1, imageHeight), rotationDeg);

  return getScreenFitPlacement(canvasWidth, canvasHeight, bbox.width, bbox.height);
}

export function getScreenFitPlacement(
  canvasWidth: number,
  canvasHeight: number,
  imageWidth: number,
  imageHeight: number,
): FittedImagePlacement {
  const safeCanvasWidth = Math.max(1, canvasWidth);
  const safeCanvasHeight = Math.max(1, canvasHeight);
  const safeImageWidth = Math.max(1, imageWidth);
  const safeImageHeight = Math.max(1, imageHeight);
  const scale = safeCanvasWidth / safeImageWidth;
  const fittedWidth = safeImageWidth * scale;
  const fittedHeight = safeImageHeight * scale;

  // Fill the width, then center on the vertical axis. A page shorter than the screen gets equal
  // top/bottom margin; a taller page extends symmetrically past both edges (centered, pan to reach
  // the rest) instead of hugging the top. NOTE: this is the page's coordinate frame that ink is
  // anchored to — do NOT change it to top-align (that would shift the PDF under existing annotations).
  // To open a new PDF page at its top, set the page's initial viewport offset instead.
  return {
    height: fittedHeight,
    left: (safeCanvasWidth - fittedWidth) / 2,
    scale,
    top: (safeCanvasHeight - fittedHeight) / 2,
    width: fittedWidth,
  };
}

/**
 * The colour the board itself is, under every pattern and page.
 *
 * Exported because a slide transition slides a page off part of the canvas and has to fill what is
 * briefly behind it: reading the base from here means the gap is always the board's own colour, so
 * a change of board colour never leaves a transition flashing the old one.
 */
export const BOARD_BASE_COLOR = LIGHT_BOARD_BASE_COLOR;

/** The board's base colour right now — dark on a dark board (utils/darkBoard). */
export const currentBoardBaseColor = boardBaseColor;

export function drawBackgroundPattern(
  bgCanvas: HTMLCanvasElement,
  type: BackgroundType,
  width: number,
  height: number,
  options: BackgroundViewportOptions = {},
  pixelRatio = 1,
): void {
  const ctx = bgCanvas.getContext('2d');

  if (!ctx) return;

  // The canvas is CSS-sized to fill its container (w-full h-full). To match the retina-scaled Fabric
  // ink layer, the backing store is sized in DEVICE pixels (CSS px × pixelRatio) and every draw is
  // done in CSS-px coordinates with `pixelRatio` folded into the transform. Without this the PDF/grid
  // rasterizes at 1/DPR resolution and the browser upscales it → soft (the ink over it stays sharp).
  const dpr = pixelRatio > 0 ? pixelRatio : 1;
  const deviceWidth = Math.max(1, Math.round(width * dpr));
  const deviceHeight = Math.max(1, Math.round(height * dpr));

  // Assigning canvas.width/height reallocates AND clears the whole backing store — doing it every
  // pan/zoom frame is a major cost and GC churn. Only resize when the size actually changed; clear
  // via clearRect otherwise.
  if (bgCanvas.width !== deviceWidth || bgCanvas.height !== deviceHeight) {
    bgCanvas.width = deviceWidth;
    bgCanvas.height = deviceHeight;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, deviceWidth, deviceHeight);
  ctx.fillStyle = options.paper ? LIGHT_BOARD_BASE_COLOR : boardBaseColor();
  ctx.fillRect(0, 0, deviceWidth, deviceHeight);

  if (type === 'blank') return;

  const { bottom, left, right, scaleX, scaleY, top } = getVisibleBounds(width, height, options.viewportTransform);
  const spacing = options.spacing !== undefined && options.spacing > 0 ? options.spacing : undefined;
  const gridSize = spacing ?? GRID_SIZE;
  const lineSpacing = spacing ?? LINE_SPACING;

  const patternColor = options.paper ? LIGHT_BOARD_PATTERN_COLOR : boardPatternColor();

  ctx.strokeStyle = patternColor;
  ctx.fillStyle = patternColor;
  ctx.save();
  ctx.setTransform(
    dpr * scaleX,
    0,
    0,
    dpr * scaleY,
    dpr * (options.viewportTransform?.[4] || 0),
    dpr * (options.viewportTransform?.[5] || 0),
  );
  ctx.lineWidth = 1 / Math.max(Math.abs(scaleX) || 1, Math.abs(scaleY) || 1);

  switch (type) {
    case 'grid':
      ctx.beginPath();

      for (let x = getAlignedStart(left, gridSize); x <= right + gridSize; x += gridSize) {
        ctx.moveTo(x + 0.5 / scaleX, top);
        ctx.lineTo(x + 0.5 / scaleX, bottom);
      }

      for (let y = getAlignedStart(top, gridSize); y <= bottom + gridSize; y += gridSize) {
        ctx.moveTo(left, y + 0.5 / scaleY);
        ctx.lineTo(right, y + 0.5 / scaleY);
      }

      ctx.stroke();
      break;

    case 'lined':
      ctx.beginPath();

      for (let y = getAlignedStart(top, lineSpacing); y <= bottom + lineSpacing; y += lineSpacing) {
        ctx.moveTo(left, y + 0.5 / scaleY);
        ctx.lineTo(right, y + 0.5 / scaleY);
      }

      ctx.stroke();
      break;

    case 'dotted':
      for (let x = getAlignedStart(left, gridSize); x <= right + gridSize; x += gridSize) {
        for (let y = getAlignedStart(top, gridSize); y <= bottom + gridSize; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, DOT_RADIUS / Math.max(Math.abs(scaleX) || 1, Math.abs(scaleY) || 1), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      break;
  }

  ctx.restore();
}

export function drawOverlayImage(
  overlayCanvas: HTMLCanvasElement,
  width: number,
  height: number,
  overlayImage: HTMLImageElement | null,
  overlayOpacity: number,
  pixelRatio = 1,
): void {
  const ctx = overlayCanvas.getContext('2d');

  if (!ctx) return;

  // DEVICE-pixel backing store (see drawBackgroundPattern) so the user background image stays crisp
  // on HiDPI panels; draws are in CSS-px coordinates with `pixelRatio` folded into the transform.
  const dpr = pixelRatio > 0 ? pixelRatio : 1;
  const deviceWidth = Math.max(1, Math.round(width * dpr));
  const deviceHeight = Math.max(1, Math.round(height * dpr));

  // Only resize when needed — reassigning width/height every frame reallocates the backing store.
  if (overlayCanvas.width !== deviceWidth || overlayCanvas.height !== deviceHeight) {
    overlayCanvas.width = deviceWidth;
    overlayCanvas.height = deviceHeight;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, deviceWidth, deviceHeight);

  if (!overlayImage) return;

  const imageWidth = overlayImage.naturalWidth || overlayImage.width;
  const imageHeight = overlayImage.naturalHeight || overlayImage.height;
  const scale = Math.min(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = overlayOpacity;
  ctx.drawImage(overlayImage, offsetX, offsetY, drawWidth, drawHeight);
  ctx.restore();
}

export function drawScreenFitImage(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  image: CanvasImageSource | null,
  imageWidth: number,
  imageHeight: number,
  opacity = 1,
  viewportTransform?: [number, number, number, number, number, number] | number[],
  smoothingQuality: ImageSmoothingQuality = 'high',
  pixelRatio = 1,
  rotationDeg = 0,
): FittedImagePlacement | null {
  if (!image) {
    return null;
  }

  const rotation = normalizeRotationDeg(rotationDeg);
  // With rotation the fit frame is the rotated bounding box; the raster itself stays unrotated
  // (native/pdf.js caches untouched) and is drawn turned about the bbox center below.
  const placement =
    rotation === 0
      ? getScreenFitPlacement(canvasWidth, canvasHeight, imageWidth, imageHeight)
      : getRotatedScreenFitPlacement(canvasWidth, canvasHeight, imageWidth, imageHeight, rotation);
  // Fold the device-pixel ratio into the viewport transform so the (high-res) PDF bitmap lands on the
  // device-pixel backing store 1:1 instead of being downsampled to CSS px then upscaled by the browser.
  const dpr = pixelRatio > 0 ? pixelRatio : 1;
  const vt = viewportTransform ?? [1, 0, 0, 1, 0, 0];

  ctx.save();
  // High-quality resampling of a large PDF bitmap is expensive; callers pass 'low' while the user is
  // actively panning/zooming and re-render at 'high' once the gesture settles.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = smoothingQuality;
  ctx.setTransform(
    dpr * (vt[0] || 1),
    dpr * (vt[1] || 0),
    dpr * (vt[2] || 0),
    dpr * (vt[3] || 1),
    dpr * (vt[4] || 0),
    dpr * (vt[5] || 0),
  );
  ctx.globalAlpha = opacity;

  if (rotation === 0) {
    ctx.drawImage(image, placement.left, placement.top, placement.width, placement.height);
  } else {
    const drawWidth = Math.max(1, imageWidth) * placement.scale;
    const drawHeight = Math.max(1, imageHeight) * placement.scale;

    ctx.translate(placement.left + placement.width / 2, placement.top + placement.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  }

  ctx.restore();

  return placement;
}
