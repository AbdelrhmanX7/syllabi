/**
 * When may the PDF background canvas skip or postpone a repaint?
 *
 * The PDF page lives on its own canvas as a ~7 MP decoded raster. A viewport commit used to repaint it
 * THREE times: the synchronous 'low' pass inside the commit, a duplicate rAF 'low' pass scheduled by
 * the after:render signature diff (the commit's own renderAll fires it), and the 160 ms 'high' settle
 * pass. On an IR touch panel stray palm contacts commit viewports WHILE the teacher writes, so those
 * three full-page resamples landed in the middle of pen strokes on a 2015 integrated GPU.
 *
 * Policy, in one place so it can be tested without a canvas:
 *  - the cheap 'low' pass is never withheld — it is what keeps the page glued under the ink;
 *  - the expensive 'high' pass waits for pen-up while a stroke is in progress;
 *  - the rAF 'low' pass is dropped when the commit already painted that exact viewport;
 *  - a pre-scaled bitmap replaces the full raster whenever it would be SMALLER than the source, so
 *    every pass becomes a 1:1 blit instead of a 7 MP resample.
 */

export type BackgroundRedrawQuality = 'high' | 'low';

/**
 * A pen-down that never sees its pen-up (pointercancel, a stranded touch) must not silence crisp
 * redraws forever. Longer than any handwriting stroke, shorter than a teacher would notice.
 */
export const STROKE_IN_PROGRESS_MAX_MS = 8000;

/** Never allocate a pre-scaled bitmap with a side over this or an area over the total below. */
const MAX_SCALED_RASTER_SIDE = 8192;
const MAX_SCALED_RASTER_AREA = 16 * 1024 * 1024;

/**
 * Whether a freehand stroke is being drawn right now.
 *
 * `isDrawingMode` comes from the live Fabric canvas: the hook flips it off for a pan/eraser override,
 * which is exactly when the background MUST follow the viewport again.
 */
export function isStrokeInProgress(downAtMs: number | null, isDrawingMode: boolean, nowMs: number): boolean {
  if (downAtMs === null || !isDrawingMode) {
    return false;
  }

  return nowMs - downAtMs < STROKE_IN_PROGRESS_MAX_MS;
}

/** What a requested pass becomes while a stroke is (or is not) in progress. */
export function resolveBackgroundRedrawQuality(
  requested: BackgroundRedrawQuality,
  strokeInProgress: boolean,
): BackgroundRedrawQuality | 'defer' {
  if (strokeInProgress && requested === 'high') {
    return 'defer';
  }

  return requested;
}

/**
 * The commit paints 'low' synchronously and its own renderAll queues a second 'low' for the next
 * frame. Skip that second pass only when it would paint the very same viewport.
 */
export function shouldSkipDuplicateLowPass(signature: string, committedLowSignature: string | null): boolean {
  return committedLowSignature !== null && signature === committedLowSignature;
}

/**
 * Device-pixel size a pre-scaled copy of the page raster should have for the current placement, or
 * `null` when a copy would not help: the target is at least as large as the source (zoomed in — the
 * browser is upscaling anyway), the frame is degenerate, or the copy would breach the bitmap ceiling.
 */
export function getScaledRasterTarget(
  placementWidth: number,
  placementHeight: number,
  zoom: number,
  pixelRatio: number,
  sourceWidth: number,
  sourceHeight: number,
): { height: number; width: number } | null {
  const width = Math.round(placementWidth * zoom * pixelRatio);
  const height = Math.round(placementHeight * zoom * pixelRatio);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  if (width >= sourceWidth || height >= sourceHeight) {
    return null;
  }

  if (width > MAX_SCALED_RASTER_SIDE || height > MAX_SCALED_RASTER_SIDE || width * height > MAX_SCALED_RASTER_AREA) {
    return null;
  }

  return { height, width };
}
