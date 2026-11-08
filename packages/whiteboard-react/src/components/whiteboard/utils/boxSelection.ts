import { Point, util } from 'fabric';

import type { FabricObject, Group, Line, Path, Polyline } from 'fabric';

import type { Vec } from './eraserGeometry';
import { flattenPath, segmentsIntersect } from './eraserGeometry';

/**
 * The select tool's BOX selection (`selectionShape="box"`): a rectangle dragged from empty canvas
 * selects every object whose PAINT it touches — partial strokes included, like GoodNotes. A pen stroke
 * is tested by its polyline, not its bounding box, so a long diagonal stroke is not caught by a box
 * dragged in the empty corner of its bounds.
 */

export interface SceneBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The box two drag corners span, whichever way the drag went. */
export function normalizeBox(a: Vec, b: Vec): SceneBox {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

export function inflateBox(box: SceneBox, pad: number): SceneBox {
  return { left: box.left - pad, top: box.top - pad, right: box.right + pad, bottom: box.bottom + pad };
}

export function boxesIntersect(a: SceneBox, b: SceneBox): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

export function pointInBox(p: Vec, box: SceneBox): boolean {
  return p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
}

function boxCorners(box: SceneBox): Vec[] {
  return [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.right, y: box.bottom },
    { x: box.left, y: box.bottom },
  ];
}

/** Does the segment a→b touch the box (an end inside, or crossing an edge)? */
export function segmentHitsBox(a: Vec, b: Vec, box: SceneBox): boolean {
  if (pointInBox(a, box) || pointInBox(b, box)) return true;

  const corners = boxCorners(box);

  for (let i = 0; i < 4; i += 1) {
    if (segmentsIntersect(a, b, corners[i]!, corners[(i + 1) % 4]!)) return true;
  }

  return false;
}

/** Does any piece of this polyline touch the box? `closed` adds the last→first edge. */
export function polylineHitsBox(points: readonly Vec[], box: SceneBox, closed = false): boolean {
  if (points.length === 0) return false;
  if (points.length === 1) return pointInBox(points[0]!, box);

  for (let i = 1; i < points.length; i += 1) {
    if (segmentHitsBox(points[i - 1]!, points[i]!, box)) return true;
  }

  return closed && segmentHitsBox(points[points.length - 1]!, points[0]!, box);
}

/** Ray-cast point-in-polygon. */
function pointInPolygon(p: Vec, polygon: readonly Vec[]): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;

    if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
  }

  return inside;
}

/**
 * A solid (filled) convex-or-not polygon — an image, text, a sticky note: hit when the box touches its
 * outline, sits inside it, or contains it.
 */
export function solidPolygonHitsBox(polygon: readonly Vec[], box: SceneBox): boolean {
  if (polylineHitsBox(polygon, box, true)) return true;

  return polygon.length >= 3 && pointInPolygon({ x: box.left, y: box.top }, polygon);
}

function isPathOnlyGroup(group: Group): boolean {
  const children = group.getObjects();

  return children.length > 0 && children.every((child) => child.isType('Path') || (child.isType('Group') && isPathOnlyGroup(child as Group)));
}

/** Does the scene-space box touch what this object paints? */
export function objectHitsBox(obj: FabricObject, box: SceneBox): boolean {
  const bounds = obj.getBoundingRect();

  if (!boxesIntersect(box, { left: bounds.left, top: bounds.top, right: bounds.left + bounds.width, bottom: bounds.top + bounds.height })) {
    return false;
  }

  const matrix = obj.calcTransformMatrix();
  const toScene = (p: Vec): Vec => util.transformPoint(new Point(p.x, p.y), matrix);
  const { scaleX, scaleY } = util.qrDecompose(matrix);
  const strokeScale = obj.strokeUniform ? 1 : Math.max(Math.abs(scaleX), Math.abs(scaleY));
  const halfStroke = obj.stroke ? ((obj.strokeWidth ?? 0) * strokeScale) / 2 : 0;
  const reach = inflateBox(box, halfStroke);

  if (obj.isType('Path')) {
    const { path, pathOffset } = obj as Path;

    return flattenPath(path as never).some((polyline) =>
      polylineHitsBox(
        polyline.map((p) => toScene({ x: p.x - pathOffset.x, y: p.y - pathOffset.y })),
        reach,
      ),
    );
  }

  if (obj.isType('Polyline')) {
    const { points, pathOffset } = obj as Polyline;

    return polylineHitsBox(
      points.map((p) => toScene({ x: p.x - pathOffset.x, y: p.y - pathOffset.y })),
      reach,
    );
  }

  if (obj.isType('Line')) {
    const { x1, y1, x2, y2 } = (obj as Line).calcLinePoints();

    return polylineHitsBox([toScene({ x: x1, y: y1 }), toScene({ x: x2, y: y2 })], reach);
  }

  if (obj.isType('Group') && isPathOnlyGroup(obj as Group)) {
    return (obj as Group).getObjects().some((child) => objectHitsBox(child, box));
  }

  // Everything else paints (or reads as) its whole transformed box.
  obj.setCoords();

  return solidPolygonHitsBox(obj.getCoords(), box);
}
