/**
 * Whole-hand (palm) eraser geometry — the pure math behind the on-screen erase circle.
 *
 * The eraser is a CIRCLE that COVERS all the touch contacts of the palm: centred on their centroid
 * and sized to span them (the widest distance across the contacts) plus a finger-radius pad on each
 * side. Spreading the fingers grows it; pinching shrinks it. The diameter is floored by a configured
 * minimum (so a near-pinch still has a usable eraser) and capped for sanity.
 *
 * Kept pure + dependency-free so it's unit-testable and shared by the live canvas hook.
 */

export interface WholeHandEraserPoint {
  x: number;
  y: number;
}

export interface WholeHandEraserCircleOptions {
  /** Minimum diameter (floor) — the configured eraser size when the fingers are close together. */
  minSize: number;
  /** Extra radius added per side to account for a fingertip's own footprint. */
  fingerPadding: number;
  /** Hard cap on the diameter. */
  maxSize: number;
}

export interface WholeHandEraserCircle {
  /** Centroid x (same coordinate space as the input contacts). */
  x: number;
  /** Centroid y. */
  y: number;
  /** Diameter — guaranteed >= 2 * (max distance from centroid to any contact), so the circle covers
   *  every contact (unless clamped UP by minSize, which only makes it larger). */
  size: number;
}

/**
 * Compute the erase circle (centroid + diameter) for a set of palm contacts, or `null` for none.
 */
export function computeWholeHandEraserCircle(
  contacts: readonly WholeHandEraserPoint[],
  options: WholeHandEraserCircleOptions,
): WholeHandEraserCircle | null {
  if (contacts.length === 0) {
    return null;
  }

  let centerX = 0;
  let centerY = 0;

  for (const point of contacts) {
    centerX += point.x;
    centerY += point.y;
  }

  centerX /= contacts.length;
  centerY /= contacts.length;

  let maxDist = 0;

  for (const point of contacts) {
    const dist = Math.hypot(point.x - centerX, point.y - centerY);

    if (dist > maxDist) {
      maxDist = dist;
    }
  }

  const spanDiameter = 2 * maxDist + 2 * options.fingerPadding;
  const size = Math.min(options.maxSize, Math.max(options.minSize, spanDiameter));

  return { x: centerX, y: centerY, size };
}
