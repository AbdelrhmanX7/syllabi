import type { ShapeGeometry, Vec } from './shapeRecognition';

/**
 * Points along a snapped shape's outline, for sweeping a brush nib over it.
 *
 * A hold-to-snap shape is committed as geometry (a line, a polygon, an ellipse). The plain pen draws
 * that as a uniform stroke, which is what it is; the calligraphy brush, though, derives its mark from
 * the POINTS the pen passed through — so to keep its look on a snapped shape the shape has to become
 * points again, spaced the way a pen stroke's samples are. Pure, so it is unit-tested on its own.
 */

export interface SampleShapeOptions {
  /** Target distance between consecutive samples, scene px. */
  spacing: number;
  /** Upper bound on the number of samples — a huge shape widens the spacing rather than exceeding it. */
  maxPoints?: number;
}

/** Length of the outline (the closing edge included for a closed polygon). */
export function shapeOutlineLength(geometry: ShapeGeometry): number {
  if (geometry.type === 'ellipse') {
    // Ramanujan's approximation — well under 0.1% for any ellipse a hand draws.
    const { rx, ry } = geometry;
    const h = ((rx - ry) / (rx + ry || 1)) ** 2;

    return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  }

  const { points, closed } = geometry;
  let length = 0;

  for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);

  if (closed && points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];

    length += Math.hypot(first.x - last.x, first.y - last.y);
  }

  return length;
}

/**
 * Sample the outline at roughly `spacing` scene px. Every vertex is a sample (a polygon's corners stay
 * sharp); a closed shape's last sample is its first one again, so a nib swept along it closes the loop.
 */
export function sampleShapeOutline(geometry: ShapeGeometry, options: SampleShapeOptions): Vec[] {
  const length = shapeOutlineLength(geometry);
  const maxPoints = Math.max(8, options.maxPoints ?? Number.POSITIVE_INFINITY);
  const spacing = Math.max(0.5, options.spacing, length / maxPoints);

  if (geometry.type === 'ellipse') {
    const { cx, cy, rx, ry, angle } = geometry;
    const steps = Math.max(12, Math.ceil(length / spacing));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const out: Vec[] = [];

    for (let step = 0; step <= steps; step += 1) {
      const t = (2 * Math.PI * (step % steps)) / steps;
      const localX = rx * Math.cos(t);
      const localY = ry * Math.sin(t);

      out.push({ x: cx + localX * cos - localY * sin, y: cy + localX * sin + localY * cos });
    }

    return out;
  }

  const { points, closed } = geometry;

  if (points.length === 0) return [];

  if (points.length === 1) return [{ x: points[0].x, y: points[0].y }];

  const out: Vec[] = [];
  const edgeCount = closed ? points.length : points.length - 1;

  for (let edge = 0; edge < edgeCount; edge += 1) {
    const from = points[edge];
    const to = points[(edge + 1) % points.length];
    const edgeLength = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(edgeLength / spacing));

    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;

      out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }

  // The final vertex: the open shape's end, or the closed shape's start again.
  const last = closed ? points[0] : points[points.length - 1];

  out.push({ x: last.x, y: last.y });

  return out;
}
