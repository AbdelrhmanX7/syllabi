/**
 * Eraser geometry — the maths behind "only what is inside the ring goes".
 *
 * Two contracts live here, both pure so they can be unit-tested without a canvas:
 *
 *   1. SCREEN → SCENE. The eraser's size is a SCREEN diameter: the slider, the preview disc in the
 *      settings popover and the cursor ring over the board are all CSS px, and none of them change when
 *      the board is zoomed. The brush that erases and the hit-test that deletes both work in SCENE
 *      units, which Fabric scales by the viewport zoom when it draws — so a screen size handed to them
 *      unchanged erased `zoom`× the ring. At the 2-3× a tablet is usually pinched to, a 24px ring wiped
 *      a 48-72px swath. (The whole-hand eraser already divided; the normal one never did.)
 *
 *   2. RING vs GEOMETRY. The object eraser used to delete whatever Fabric's bounding-box target find
 *      returned under the pointer, plus a handful of points near the centre. A pen stroke's box is the
 *      whole rectangle it spans, so a long diagonal stroke vanished when the ring crossed EMPTY space
 *      inside its box — ink the teacher never touched. These helpers test the ring (or the capsule it
 *      sweeps between two pointer samples) against the stroke's actual polyline, inflated by half its
 *      stroke width, so an object is a hit only when some DRAWN part of it is really inside the ring.
 */
export type Vec = { x: number; y: number };

/** A ring swept from `a` to `b` — everything within `r` of the segment ab. `a === b` is a plain ring. */
export type EraserCapsule = { a: Vec; b: Vec; r: number };

export type BBox = { minX: number; minY: number; maxX: number; maxY: number };

/** Below this the zoom is not a zoom — a transient 0/NaN from a half-built viewport reads as 1. */
const MIN_ZOOM = 1e-3;

const safeZoom = (zoom: number): number => (Number.isFinite(zoom) && zoom > MIN_ZOOM ? zoom : 1);

/** Scene-unit brush width for a screen-px eraser diameter at the live zoom. */
export function eraserSceneDiameter(screenDiameterPx: number, zoom: number): number {
  return Math.max(0, screenDiameterPx) / safeZoom(zoom);
}

/** Scene-unit hit radius for a screen-px eraser diameter at the live zoom. */
export function eraserSceneRadius(screenDiameterPx: number, zoom: number): number {
  return eraserSceneDiameter(screenDiameterPx, zoom) / 2;
}

export function distancePointToSegment(p: Vec, a: Vec, b: Vec): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;

  if (lengthSq === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq));

  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

const orientation = (a: Vec, b: Vec, c: Vec): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const onSegment = (a: Vec, b: Vec, p: Vec): boolean =>
  Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);

export function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }

  // Collinear touches count: a stroke lying exactly along the sweep is under it.
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
  );
}

export function distanceSegmentToSegment(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (segmentsIntersect(a, b, c, d)) {
    return 0;
  }

  return Math.min(
    distancePointToSegment(a, c, d),
    distancePointToSegment(b, c, d),
    distancePointToSegment(c, a, b),
    distancePointToSegment(d, a, b),
  );
}

/** The axis-aligned box the capsule can touch, padded by `pad` (half the thickest stroke in play). */
export function capsuleBBox(capsule: EraserCapsule, pad = 0): BBox {
  const reach = capsule.r + pad;

  return {
    minX: Math.min(capsule.a.x, capsule.b.x) - reach,
    minY: Math.min(capsule.a.y, capsule.b.y) - reach,
    maxX: Math.max(capsule.a.x, capsule.b.x) + reach,
    maxY: Math.max(capsule.a.y, capsule.b.y) + reach,
  };
}

/**
 * Does the capsule reach any segment of this polyline, treating the line as `halfStroke` thick on each
 * side? A single point is a dot. `closed` adds the last→first edge.
 */
export function polylineHitsCapsule(points: readonly Vec[], capsule: EraserCapsule, halfStroke = 0, closed = false): boolean {
  if (points.length === 0) {
    return false;
  }

  const reach = capsule.r + halfStroke;

  if (points.length === 1) {
    return distancePointToSegment(points[0], capsule.a, capsule.b) <= reach;
  }

  for (let index = 1; index < points.length; index += 1) {
    if (distanceSegmentToSegment(points[index - 1], points[index], capsule.a, capsule.b) <= reach) {
      return true;
    }
  }

  return closed && distanceSegmentToSegment(points[points.length - 1], points[0], capsule.a, capsule.b) <= reach;
}

/** Ray-casting point-in-polygon. Points on an edge are the outline's business, not this one's. */
export function pointInPolygon(p: Vec, polygon: readonly Vec[]): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];

    if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * A closed shape is hit when the capsule reaches its outline — or, if it is FILLED, when the capsule
 * is inside it (a ring entirely within a filled rectangle is still on the rectangle's paint). A hollow
 * shape is hit only through its outline, so sweeping across its empty middle leaves it alone.
 */
export function polygonHitsCapsule(polygon: readonly Vec[], capsule: EraserCapsule, halfStroke = 0, filled = false): boolean {
  if (polylineHitsCapsule(polygon, capsule, halfStroke, true)) {
    return true;
  }

  return filled && polygon.length >= 3 && (pointInPolygon(capsule.a, polygon) || pointInPolygon(capsule.b, polygon));
}

/** One parsed path command as Fabric stores it after `makePathSimpler`: absolute M/L/Q/C/Z only. */
export type PathCommand = ReadonlyArray<string | number>;

const CURVE_STEPS = 8;

/**
 * Walk a simplified path into polylines, one per sub-path, sampling each curve into straight pieces.
 * A `Z` closes by repeating the sub-path's first point, so the closing edge is tested like any other.
 */
export function flattenPath(commands: readonly PathCommand[], curveSteps = CURVE_STEPS): Vec[][] {
  const polylines: Vec[][] = [];
  let current: Vec[] = [];
  let cursor: Vec = { x: 0, y: 0 };
  let start: Vec = { x: 0, y: 0 };

  const flush = () => {
    if (current.length > 0) {
      polylines.push(current);
    }

    current = [];
  };

  for (const command of commands) {
    const op = command[0];

    switch (op) {
      case 'M': {
        flush();
        cursor = { x: Number(command[1]), y: Number(command[2]) };
        start = cursor;
        current.push(cursor);
        break;
      }
      case 'L': {
        cursor = { x: Number(command[1]), y: Number(command[2]) };
        current.push(cursor);
        break;
      }
      case 'Q': {
        const c = { x: Number(command[1]), y: Number(command[2]) };
        const end = { x: Number(command[3]), y: Number(command[4]) };
        const from = cursor;

        for (let step = 1; step <= curveSteps; step += 1) {
          const t = step / curveSteps;
          const mt = 1 - t;

          current.push({
            x: mt * mt * from.x + 2 * mt * t * c.x + t * t * end.x,
            y: mt * mt * from.y + 2 * mt * t * c.y + t * t * end.y,
          });
        }

        cursor = end;
        break;
      }
      case 'C': {
        const c1 = { x: Number(command[1]), y: Number(command[2]) };
        const c2 = { x: Number(command[3]), y: Number(command[4]) };
        const end = { x: Number(command[5]), y: Number(command[6]) };
        const from = cursor;

        for (let step = 1; step <= curveSteps; step += 1) {
          const t = step / curveSteps;
          const mt = 1 - t;

          current.push({
            x: mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * end.x,
            y: mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * end.y,
          });
        }

        cursor = end;
        break;
      }
      case 'Z':
      case 'z': {
        if (current.length > 0) {
          current.push(start);
        }

        cursor = start;
        break;
      }
      default:
        break;
    }
  }

  flush();

  return polylines;
}

/**
 * Does the capsule reach the DRAWN part of a path? `toScene` maps a path-space point into the space the
 * capsule is expressed in (the hook passes the object's transform). A filled path also counts when the
 * capsule sits inside one of its sub-paths — the pen brush never fills, so for ink this is the outline
 * alone, inflated by half the stroke width exactly as it is painted.
 */
export function pathHitsCapsule(
  commands: readonly PathCommand[],
  capsule: EraserCapsule,
  halfStroke = 0,
  toScene: (p: Vec) => Vec = (p) => p,
  filled = false,
): boolean {
  for (const polyline of flattenPath(commands)) {
    const scenePoints = polyline.map(toScene);

    if (filled ? polygonHitsCapsule(scenePoints, capsule, halfStroke, true) : polylineHitsCapsule(scenePoints, capsule, halfStroke)) {
      return true;
    }
  }

  return false;
}

/** `steps` points around an axis-aligned ellipse centred on the origin. */
export function ellipsePoints(rx: number, ry: number, steps = 32): Vec[] {
  const points: Vec[] = [];

  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;

    points.push({ x: rx * Math.cos(angle), y: ry * Math.sin(angle) });
  }

  return points;
}
