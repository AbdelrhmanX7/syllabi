import { Point, util } from 'fabric';

import type { Circle, Ellipse, FabricObject, Group, Line, Path, Polyline } from 'fabric';

import type { EraserCapsule, Vec } from './eraserGeometry';
import { ellipsePoints, pathHitsCapsule, polygonHitsCapsule, polylineHitsCapsule } from './eraserGeometry';

/**
 * Does the eraser's swept ring touch the DRAWN part of this object?
 *
 * Fabric's own target find answers a different question — "is the pointer inside the bounding box" —
 * and for a pen stroke that box is the whole rectangle the stroke spans. The object eraser deleted
 * strokes the ring never came near, because it crossed the empty space inside their box. Here each
 * shape is reduced to the geometry it actually paints, in scene space, and tested against the capsule
 * with the maths in `eraserGeometry`:
 *
 *   path / polyline / polygon / line   the polyline, half a stroke width thick on each side
 *   ellipse / circle / triangle        the outline (plus the inside when filled)
 *   rect / text / image / group / …    the transformed box — for these the box IS the paint
 *
 * The object's full transform (position, scale, rotation, group nesting) is applied through
 * `calcTransformMatrix`, so a stroke that was moved or resized after it was drawn is tested where it
 * is now, not where its points say it was drawn.
 */
export function objectHitsEraser(obj: FabricObject, capsule: EraserCapsule): boolean {
  const matrix = obj.calcTransformMatrix();
  const toScene = (p: Vec): Vec => util.transformPoint(new Point(p.x, p.y), matrix);
  const { scaleX, scaleY } = util.qrDecompose(matrix);
  const strokeScale = obj.strokeUniform ? 1 : Math.max(Math.abs(scaleX), Math.abs(scaleY));
  const halfStroke = obj.stroke ? ((obj.strokeWidth ?? 0) * strokeScale) / 2 : 0;
  const filled = isVisibleFill(obj.fill);

  if (obj.isType('Path')) {
    const { path, pathOffset } = obj as Path;

    return pathHitsCapsule(
      path,
      capsule,
      halfStroke,
      (p) => toScene({ x: p.x - pathOffset.x, y: p.y - pathOffset.y }),
      filled,
    );
  }

  if (obj.isType('Polyline', 'Polygon')) {
    const { points, pathOffset } = obj as Polyline;
    const scenePoints = points.map((p) => toScene({ x: p.x - pathOffset.x, y: p.y - pathOffset.y }));

    return obj.isType('Polygon')
      ? polygonHitsCapsule(scenePoints, capsule, halfStroke, filled)
      : polylineHitsCapsule(scenePoints, capsule, halfStroke);
  }

  if (obj.isType('Line')) {
    const { x1, y1, x2, y2 } = (obj as Line).calcLinePoints();

    return polylineHitsCapsule([toScene({ x: x1, y: y1 }), toScene({ x: x2, y: y2 })], capsule, halfStroke);
  }

  if (obj.isType('Ellipse')) {
    const { rx, ry } = obj as Ellipse;

    return polygonHitsCapsule(ellipsePoints(rx, ry).map(toScene), capsule, halfStroke, filled);
  }

  if (obj.isType('Circle')) {
    const { radius } = obj as Circle;

    return polygonHitsCapsule(ellipsePoints(radius, radius).map(toScene), capsule, halfStroke, filled);
  }

  if (obj.isType('Triangle')) {
    const halfWidth = obj.width / 2;
    const halfHeight = obj.height / 2;
    const corners = [
      { x: -halfWidth, y: halfHeight },
      { x: 0, y: -halfHeight },
      { x: halfWidth, y: halfHeight },
    ].map(toScene);

    return polygonHitsCapsule(corners, capsule, halfStroke, filled);
  }

  // A group made only of paths (a handwritten line of the board AI: one traced word per path) is hit
  // where its words are painted, not across the empty space between them and around the line.
  if (obj.isType('Group') && isPathOnlyGroup(obj as Group)) {
    return (obj as Group).getObjects().some((child) => objectHitsEraser(child, capsule));
  }

  // Everything else paints its whole box: a rect, text, an image, a sticky note, a group. `getCoords`
  // serves a cached box, so refresh it first — the object may have moved since the last render.
  obj.setCoords();

  return polygonHitsCapsule(obj.getCoords(), capsule, 0, true);
}

function isPathOnlyGroup(group: Group): boolean {
  const children = group.getObjects();

  return children.length > 0 && children.every((child) => child.isType('Path') || (child.isType('Group') && isPathOnlyGroup(child as Group)));
}

function isVisibleFill(fill: FabricObject['fill']): boolean {
  if (fill == null) {
    return false;
  }

  if (typeof fill !== 'string') {
    // A gradient or a pattern — paint.
    return true;
  }

  const normalized = fill.trim().toLowerCase();

  return normalized !== '' && normalized !== 'transparent' && normalized !== 'none' && !isZeroAlphaColor(normalized);
}

const isZeroAlphaColor = (color: string): boolean => /^(rgba|hsla)\([^)]*,\s*0(\.0+)?\s*\)$/.test(color);
