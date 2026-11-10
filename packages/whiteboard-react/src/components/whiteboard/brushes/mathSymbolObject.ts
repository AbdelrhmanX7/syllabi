import { Control, controlsUtils, Point, Polyline, Shadow, util } from 'fabric';

import type { FabricObject, TPointerEvent, Transform } from 'fabric';

import { isMathSymbolParams, mathSymbolLocalPoints, mathSymbolStretchIndex, normalizeMathSymbolParams, stretchMathSymbol } from '../utils/mathSymbols';
import type { MathSymbolParams, MathSymbolShape } from '../utils/mathSymbols';
import { drawRadicalOutline, HANDLE } from './radicalObject';
import type { RadicalStyle } from './radicalObject';

/**
 * A committed clean math symbol — bracket, brace, integral or arrow (`utils/mathSymbols`): a plain Fabric
 * `Polyline` carrying `wbShape: <kind>` and its {@link MathSymbolParams} under {@link MATH_SYMBOL_PROP}.
 * The same design as the square root (`radicalObject.ts`), for the same reasons: an older build that has
 * never heard of these symbols still loads the page and just sees a line; erasers already handle it.
 *
 * STRETCHING regenerates the points from the params; the object is never scaled, so serifs, curls and
 * arrow heads keep their size and the line its width. One handle replaces the scale/rotate box, and it
 * shows only while the symbol is selected:
 *   brackets, braces, integral   at the bottom end — drag to make it taller/shorter
 *   arrow                        at the tip — drag to make it longer/shorter (or point it elsewhere)
 * The first point (a bracket's top end, an arrow's tail) stays put on the page.
 */

/** The persisted parameters of a math symbol. */
export const MATH_SYMBOL_PROP = 'wbMathSymbol';

// A stretch IS a polyline edit — the same Fabric action (and `object:modifyPoly` event) as a vertex drag.
const STRETCH_ACTION = 'modifyPoly';

type MathSymbolObject = Polyline & { [MATH_SYMBOL_PROP]?: MathSymbolParams };

/** True when `object` is a committed math symbol with usable params. */
export function isMathSymbolObject(object: FabricObject | null | undefined): object is MathSymbolObject {
  if (!(object instanceof Polyline)) return false;

  const params = (object as MathSymbolObject)[MATH_SYMBOL_PROP];

  return isMathSymbolParams(params) && object.points.length === mathSymbolLocalPoints(params).length;
}

/** Build the committed symbol. The marker prop (`wbShape`) is set by the caller (`shapeSnap`). */
export function createMathSymbolPolyline(shape: MathSymbolShape, style: RadicalStyle): Polyline {
  const params = normalizeMathSymbolParams(shape.params);
  const points = mathSymbolLocalPoints(params).map((p) => ({ x: p.x + shape.anchor.x, y: p.y + shape.anchor.y }));
  const object = new Polyline(points, {
    stroke: style.color,
    strokeWidth: style.width,
    fill: '',
    opacity: style.opacity,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    strokeUniform: true,
    shadow: style.blur > 0 ? new Shadow({ color: style.color, blur: style.blur, offsetX: 0, offsetY: 0, affectStroke: true }) : null,
  });

  (object as MathSymbolObject)[MATH_SYMBOL_PROP] = params;

  return object;
}

/**
 * Regenerate a symbol with new params, keeping its first point where it is on the page (whatever the
 * object's position, angle or group). Returns false when nothing changed.
 */
export function setMathSymbolParams(object: FabricObject, next: MathSymbolParams): boolean {
  if (!isMathSymbolObject(object)) return false;

  const current = object[MATH_SYMBOL_PROP]!;

  if (next.kind !== current.kind) return false;

  const params = normalizeMathSymbolParams(next);

  if (JSON.stringify(params) === JSON.stringify(current)) return false;

  const anchor = new Point(object.points[0]);
  const before = anchor.subtract(object.pathOffset).transform(object.calcOwnMatrix());

  object.points = mathSymbolLocalPoints(params).map((p) => new Point(p.x + anchor.x, p.y + anchor.y));
  object[MATH_SYMBOL_PROP] = params;
  object.setDimensions();

  const after = anchor.subtract(object.pathOffset).transform(object.calcOwnMatrix());

  object.set({ left: object.left - (after.x - before.x), top: object.top - (after.y - before.y), dirty: true });
  object.setCoords();

  return true;
}

/** Where the symbol's stretch point sits on screen (the control's position). */
function stretchPosition(_dim: Point, _finalMatrix: unknown, object: FabricObject): Point {
  const poly = object as MathSymbolObject;
  const params = poly[MATH_SYMBOL_PROP];
  const index = params ? Math.min(mathSymbolStretchIndex(params), poly.points.length - 1) : poly.points.length - 1;

  return new Point(poly.points[index])
    .subtract(poly.pathOffset)
    .transform(util.multiplyTransformMatrices(poly.getViewportTransform(), poly.calcTransformMatrix()));
}

const stretch = (_e: TPointerEvent, transform: Transform, x: number, y: number): boolean => {
  const object = transform.target;

  if (!isMathSymbolObject(object)) return false;

  // The pointer in the symbol's own frame, relative to its first point.
  const local = util.sendPointToPlane(new Point(x, y), undefined, object.calcOwnMatrix()).add(object.pathOffset).subtract(new Point(object.points[0]));

  return setMathSymbolParams(object, stretchMathSymbol(object[MATH_SYMBOL_PROP]!, local));
};

/** The symbol's one stretch handle, and nothing that would scale or skew it. Idempotent. */
export function applyMathSymbolControls(object: FabricObject): void {
  if (!isMathSymbolObject(object)) return;

  const arrow = object[MATH_SYMBOL_PROP]!.kind === 'arrow';

  object.set({
    lockScalingX: true,
    lockScalingY: true,
    lockSkewingX: true,
    lockSkewingY: true,
    lockScalingFlip: true,
    hasBorders: true,
  });

  // The selection outline follows the symbol itself, not its bounding box. Not serialised: re-applied
  // on every `object:added`.
  object.drawBorders = drawRadicalOutline;

  object.controls = {
    stretch: new Control({
      ...HANDLE,
      actionName: STRETCH_ACTION,
      cursorStyle: arrow ? 'crosshair' : 'ns-resize',
      positionHandler: stretchPosition,
      actionHandler: controlsUtils.wrapWithFireEvent(STRETCH_ACTION, stretch),
    }),
  };
  // Keep the handle positions (`oCoords`) keyed like the new controls (see `applyRadicalControls`).
  object.setCoords();
}
