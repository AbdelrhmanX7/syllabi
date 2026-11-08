import { ActiveSelection, Point, util } from 'fabric';

import type { Canvas, FabricObject, Path } from 'fabric';

import { flattenPath } from './eraserGeometry';
import { invalidateInkBake } from './inkBake';
import { selectedObjects } from './selectionActions';
import { rotatePoint, straightenInk } from './straightenInk';

import type { InkStroke, RuleGrid, Vec } from './straightenInk';

/**
 * «Straighten» — the Fabric half. Reads the selected pen strokes in scene space, asks
 * `straightenInk` for the moves, applies them as plain rotate + translate and announces each through
 * `object:modified`, exactly as `restyleSelection` does: the editor's mutation → checkpoint path
 * coalesces the burst into ONE undo step.
 */

const isEraserMark = (object: FabricObject) =>
  (object as FabricObject & { globalCompositeOperation?: string }).globalCompositeOperation === 'destination-out';

/** A pen stroke: a Path that is not a pixel-eraser mark. Shapes, text and images are not handwriting. */
export const isInkStroke = (object: FabricObject): boolean => object.isType('Path') && !isEraserMark(object);

export function selectedInkStrokes(canvas: Canvas): FabricObject[] {
  return selectedObjects(canvas).filter(isInkStroke);
}

/** The stroke's points in scene space (its path flattened, then put through its own transform). */
function scenePointsOf(object: FabricObject): Vec[] {
  const { path, pathOffset } = object as Path;
  const matrix = object.calcTransformMatrix();
  const out: Vec[] = [];

  for (const polyline of flattenPath(path as never)) {
    for (const point of polyline) {
      const scene = util.transformPoint(new Point(point.x - pathOffset.x, point.y - pathOffset.y), matrix);

      out.push({ x: scene.x, y: scene.y });
    }
  }

  return out;
}

export interface StraightenSelectionOptions {
  /** The paper's rules under the selection; null = level only. */
  rules: RuleGrid | null;
  /** Only strokes whose centre lies in this scene y range take part (one page of a continuous layout). */
  within?: { top: number; bottom: number };
}

/**
 * Straightens the selected ink in place and returns how many strokes moved. The selection survives:
 * a multi-selection's members carry group-relative coordinates, so it is dissolved while the strokes
 * are read and moved in scene space, then rebuilt over the same objects.
 */
export function straightenSelection(canvas: Canvas, { rules, within }: StraightenSelectionOptions): number {
  const members = canvas.getActiveObjects();
  const ink = selectedInkStrokes(canvas);

  if (ink.length < 2) return 0;

  const wasMulti = members.length > 1;

  if (wasMulti) canvas.discardActiveObject();

  const candidates = within
    ? ink.filter((object) => {
        const y = object.getCenterPoint().y;

        return y >= within.top && y <= within.bottom;
      })
    : ink;
  const strokes: InkStroke[] = candidates.map((object, index) => ({ id: String(index), points: scenePointsOf(object) }));
  const transforms = straightenInk(strokes, { rules });
  let changed = 0;

  for (const transform of transforms) {
    const object = candidates[Number(transform.id)];

    if (!object) continue;

    // Rotating about the object's own centre and carrying that centre around the pivot IS a rotation
    // about the pivot; the shift then rides on top.
    const centre = object.getCenterPoint();
    const moved = rotatePoint({ x: centre.x, y: centre.y }, transform.pivot, transform.rotateDeg);

    object.set({ angle: (object.angle ?? 0) + transform.rotateDeg });
    object.setPositionByOrigin(new Point(moved.x + transform.dx, moved.y + transform.dy), 'center', 'center');
    object.setCoords();
    object.set('dirty', true);
    changed += 1;
    canvas.fire('object:modified', { target: object } as never);
  }

  if (wasMulti) canvas.setActiveObject(new ActiveSelection(members, { canvas }));

  if (changed > 0) {
    // The bake checks `dirty` too, but a group member's flag does not reach the top-level object.
    invalidateInkBake(canvas);
  }

  canvas.requestRenderAll();

  return changed;
}
