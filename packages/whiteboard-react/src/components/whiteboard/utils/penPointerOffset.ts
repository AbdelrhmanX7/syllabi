/**
 * Convert the pen's nib-lift/tilt correction — a displacement in CLIENT space (CSS px on screen) — into
 * the space Fabric's `_getPointerImpl` hands back to its callers.
 *
 * WHY THIS EXISTS. The correction can only be computed from a real `PointerEvent`, because that is the
 * only place `tiltX`/`tiltY` live. But the whiteboard canvas is deliberately built WITHOUT Fabric's
 * pointer-event mode (so a resting palm can be starved out of the touch stream), which means Fabric
 * reads its coordinates from the raw `TouchEvent.changedTouches[0]` or from the browser's compat
 * `MouseEvent` — different objects from the PointerEvent. Patching the PointerEvent's `clientX/clientY`
 * therefore never moved any ink. The fix is to apply the correction inside Fabric's own pointer
 * resolution instead, which means reproducing what that function does to a coordinate.
 *
 * `_getPointerImpl` (fabric 7.2.0, `src/canvas/SelectableCanvas.ts`) does, in order:
 *
 *   1. subtract the canvas's bounding-rect offset      — a TRANSLATION
 *   2. if the caller wants scene coords, apply the inverse viewport transform
 *   3. divide by the retina scaling
 *   4. multiply by the CSS-to-backing-store scale
 *
 * A displacement is a VECTOR, not a point, so every translation in that list drops out — step 1
 * entirely, and the translation column of step 2. What remains is the inverse of the viewport
 * transform's 2x2 linear part, then the two scales.
 *
 * Deliberately free of any `fabric` import so it can be unit-tested in plain Node.
 */

export interface PenPointerOffsetInput {
  /** The correction in client space (CSS px on screen). */
  clientDelta: { x: number; y: number };
  /** True when the caller asked for viewport coordinates, i.e. the viewport transform is not applied. */
  fromViewport: boolean;
  /** Fabric's `[a, b, c, d, e, f]`, where `x' = a·x + c·y + e` and `y' = b·x + d·y + f`. */
  viewportTransform: readonly number[];
  /** `canvas.getRetinaScaling()`. */
  retinaScaling: number;
  /** `upperCanvasEl.width / bounds.width` and the same for height; `{x: 1, y: 1}` when not measurable. */
  cssScale: { x: number; y: number };
}

export function penOffsetToCanvasDelta({
  clientDelta,
  fromViewport,
  viewportTransform,
  retinaScaling,
  cssScale,
}: PenPointerOffsetInput): { x: number; y: number } {
  let deltaX = clientDelta.x;
  let deltaY = clientDelta.y;

  if (!fromViewport) {
    const [a, b, c, d] = viewportTransform;
    const determinant = a * d - b * c;

    // A singular viewport transform cannot be inverted and should never happen; leaving the delta in
    // client space is closer to right than emitting NaN into the stroke.
    if (determinant !== 0 && Number.isFinite(determinant)) {
      const inverseX = (deltaX * d - deltaY * c) / determinant;
      const inverseY = (deltaY * a - deltaX * b) / determinant;

      deltaX = inverseX;
      deltaY = inverseY;
    }
  }

  if (retinaScaling !== 1 && retinaScaling !== 0 && Number.isFinite(retinaScaling)) {
    deltaX /= retinaScaling;
    deltaY /= retinaScaling;
  }

  return { x: deltaX * cssScale.x, y: deltaY * cssScale.y };
}
