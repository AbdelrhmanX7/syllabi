/**
 * Non-destructive image crop — the math, with no Fabric or DOM so it can be tested on its own.
 *
 * A Fabric image keeps its whole source element; `cropX` / `cropY` / `width` / `height` choose the part
 * of it that is drawn (all in ELEMENT pixels, before the object's scale). So a crop never throws pixels
 * away: re-cropping can widen the frame back out to the full picture.
 *
 * Coordinates:
 *   element px  (ex, ey)  a pixel of the full source picture, 0…source.width / 0…source.height.
 *   local       (u, v)    the object's own plane: centred on what is drawn now,
 *                         u = ex − cropX − width/2, v = ey − cropY − height/2, whatever the flip.
 *   scene                 the object's `calcTransformMatrix()` applied to local (angle, scale, flip).
 *
 * The crop is decided in element px, which is why a rotated, flipped or scaled picture needs nothing
 * special: the frame is drawn in the picture's own plane and the result is mapped back through its matrix.
 */

/** A 2D affine matrix `[a, b, c, d, e, f]`, Fabric's / the canvas' convention. */
export type Mat2D = readonly [number, number, number, number, number, number] | readonly number[];

/** A rectangle in ELEMENT pixels. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceSize {
  width: number;
  height: number;
}

/** What is cropped now: the image's own `cropX` / `cropY` / `width` / `height`. */
export interface CurrentCrop {
  cropX: number;
  cropY: number;
  width: number;
  height: number;
}

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

export const CROP_HANDLES: readonly Exclude<CropHandle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The crop frame can never get smaller than this on screen, CSS px (room for its grips and a grab). */
export const CROP_MIN_SCREEN_PX = 40;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** The current crop as a frame. */
export function cropRectOf(crop: CurrentCrop): CropRect {
  return { x: crop.cropX, y: crop.cropY, width: crop.width, height: crop.height };
}

/** The smallest frame side in element px: `CROP_MIN_SCREEN_PX` on screen, never more than the picture. */
export function minCropSize(screenScale: number, source: SourceSize, minScreenPx = CROP_MIN_SCREEN_PX): { width: number; height: number } {
  const perPx = screenScale > 0 && Number.isFinite(screenScale) ? minScreenPx / screenScale : minScreenPx;

  return { width: Math.min(Math.max(1, perPx), source.width), height: Math.min(Math.max(1, perPx), source.height) };
}

/** `rect` kept inside the picture and at least `min` in each side. */
export function clampCropRect(rect: CropRect, source: SourceSize, min: { width: number; height: number }): CropRect {
  const width = clamp(rect.width, min.width, source.width);
  const height = clamp(rect.height, min.height, source.height);

  return {
    x: clamp(rect.x, 0, source.width - width),
    y: clamp(rect.y, 0, source.height - height),
    width,
    height,
  };
}

/**
 * The frame after dragging `handle` by (dx, dy) element px from `start`. An edge moves only itself (the
 * opposite edge stays put, even when it hits the minimum or the picture's border); `move` slides the
 * whole frame, its size unchanged, stopping at the border.
 */
export function dragCropRect(
  start: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  source: SourceSize,
  min: { width: number; height: number },
): CropRect {
  if (handle === 'move') {
    return {
      x: clamp(start.x + dx, 0, source.width - start.width),
      y: clamp(start.y + dy, 0, source.height - start.height),
      width: start.width,
      height: start.height,
    };
  }

  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (handle.includes('w')) left = clamp(start.x + dx, 0, right - min.width);
  if (handle.includes('e')) right = clamp(right + dx, left + min.width, source.width);
  if (handle.includes('n')) top = clamp(start.y + dy, 0, bottom - min.height);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + min.height, source.height);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

function apply(m: Mat2D, x: number, y: number): { x: number; y: number } {
  return { x: m[0]! * x + m[2]! * y + m[4]!, y: m[1]! * x + m[3]! * y + m[5]! };
}

export function multiplyMat(a: Mat2D, b: Mat2D): [number, number, number, number, number, number] {
  return [
    a[0]! * b[0]! + a[2]! * b[1]!,
    a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!,
    a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
    a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ];
}

/**
 * Element px → screen (the canvas' CSS px): viewport ∘ object ∘ (element → local). Used as the CSS
 * transform of the crop overlay, whose box is the full picture at 1 element px per CSS px.
 */
export function elementToScreenMatrix(viewport: Mat2D, objectMatrix: Mat2D, crop: CurrentCrop): [number, number, number, number, number, number] {
  const elementToLocal = [1, 0, 0, 1, -crop.cropX - crop.width / 2, -crop.cropY - crop.height / 2] as const;

  return multiplyMat(multiplyMat(viewport, objectMatrix), elementToLocal);
}

/** A screen-px delta as an element-px delta under `m` (its linear part only). */
export function screenDeltaToElement(m: Mat2D, dx: number, dy: number): { x: number; y: number } {
  const det = m[0]! * m[3]! - m[1]! * m[2]!;

  if (!det) return { x: 0, y: 0 };

  return { x: (m[3]! * dx - m[2]! * dy) / det, y: (-m[1]! * dx + m[0]! * dy) / det };
}

/** How many screen px one element px spans along the picture's x and y, under `m`. */
export function matrixAxisScales(m: Mat2D): { x: number; y: number } {
  return { x: Math.hypot(m[0]!, m[1]!), y: Math.hypot(m[2]!, m[3]!) };
}

/** The four corners of `rect` (element px) on screen under `m`, as the axis-aligned box around them. */
export function screenBoxOf(m: Mat2D, rect: CropRect): { left: number; top: number; width: number; height: number } {
  const corners = [
    apply(m, rect.x, rect.y),
    apply(m, rect.x + rect.width, rect.y),
    apply(m, rect.x + rect.width, rect.y + rect.height),
    apply(m, rect.x, rect.y + rect.height),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);

  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export interface CropResult {
  cropX: number;
  cropY: number;
  width: number;
  height: number;
  /** Where the kept region's centre is in the scene — the new object centre, so it does not move. */
  center: { x: number; y: number };
}

/**
 * The image properties that crop it to `rect`, with the kept region left exactly where it was on the
 * board: its centre (in the current local plane) is mapped through the object's current matrix, and the
 * object is re-centred there. Angle, scale and flip are untouched, so they carry over as they are.
 */
export function cropResult(objectMatrix: Mat2D, current: CurrentCrop, rect: CropRect): CropResult {
  const u = rect.x + rect.width / 2 - current.cropX - current.width / 2;
  const v = rect.y + rect.height / 2 - current.cropY - current.height / 2;

  return { cropX: rect.x, cropY: rect.y, width: rect.width, height: rect.height, center: apply(objectMatrix, u, v) };
}

/** Same frame as the current crop (nothing to do), to a hundredth of an element px. */
export function isSameCrop(current: CurrentCrop, rect: CropRect): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

  return near(current.cropX, rect.x) && near(current.cropY, rect.y) && near(current.width, rect.width) && near(current.height, rect.height);
}
