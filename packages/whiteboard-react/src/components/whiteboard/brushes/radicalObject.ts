import { Control, controlsUtils, FabricObject as FabricObjectClass, Point, Polyline, Shadow, util } from 'fabric';

import type { FabricObject, TPointerEvent, Transform } from 'fabric';

import { normalizeRadicalParams, radicalLocalPoints } from '../utils/radicalSign';
import type { RadicalParams, RadicalShape } from '../utils/radicalSign';

/**
 * The committed square-root sign: a plain Fabric `Polyline` (serif → tick top → bottom → stem top →
 * bar end) carrying `wbShape: 'radical'` and its {@link RadicalParams} under {@link RADICAL_PARAMS_PROP}.
 *
 * WHY A PLAIN POLYLINE, not a registered subclass: boards are shared with older whiteboard builds
 * (desktop, the teacher APK) that have no such class, and an unknown `type` makes Fabric's
 * `enlivenObjects` reject — the whole page would fail to load there. A Polyline loads everywhere (old
 * builds just see a line), every eraser already handles it, and old boards need no migration.
 *
 * STRETCHING regenerates the polyline from the params; the object is never scaled, so the tick keeps its
 * size and the line its width. Two handles replace the scale/rotate box:
 *   bar     at the vinculum's end — drag right/left to lengthen/shorten the bar
 *   depth   at the stem's bottom  — drag down/up to make the radical deeper/shallower
 * The stem top (where the bar starts) stays put on the page through both.
 */

/** The persisted parameters of a radical. */
export const RADICAL_PARAMS_PROP = 'wbRadical';

/** Index of the stem top in the radical's polyline (see `radicalLocalPoints`). */
const TOP_INDEX = 3;
const BOTTOM_INDEX = 2;
const BAR_END_INDEX = 4;

// A radical stretch IS a polyline edit — the same Fabric action (and `object:modifyPoly` event) as a vertex drag.
const RADICAL_ACTION = 'modifyPoly';

type RadicalObject = Polyline & { [RADICAL_PARAMS_PROP]?: RadicalParams };

export interface RadicalStyle {
  color: string;
  width: number;
  opacity: number;
  /** Marker halo, scene px; 0 = none. */
  blur: number;
}

/** True when `object` is a committed radical with usable params. */
export function isRadicalObject(object: FabricObject | null | undefined): object is RadicalObject {
  if (!(object instanceof Polyline)) return false;

  const params = (object as RadicalObject)[RADICAL_PARAMS_PROP];

  return !!params && Number.isFinite(params.height) && Number.isFinite(params.bar) && Number.isFinite(params.tick) && object.points.length === 5;
}

/** Build the committed radical. The marker prop (`wbShape`) is set by the caller (`shapeSnap`). */
export function createRadicalPolyline(shape: RadicalShape, style: RadicalStyle): Polyline {
  const params = normalizeRadicalParams(shape.params);
  const points = radicalLocalPoints(params).map((p) => ({ x: p.x + shape.anchor.x, y: p.y + shape.anchor.y }));
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

  (object as RadicalObject)[RADICAL_PARAMS_PROP] = params;

  return object;
}

/**
 * Regenerate a radical with new params, keeping its stem top where it is on the page (whatever the
 * object's position, angle or group). Returns false when nothing changed.
 */
export function setRadicalParams(object: FabricObject, next: RadicalParams): boolean {
  if (!isRadicalObject(object)) return false;

  const params = normalizeRadicalParams({ ...next, tick: object[RADICAL_PARAMS_PROP]!.tick });
  const current = object[RADICAL_PARAMS_PROP]!;

  if (params.height === current.height && params.bar === current.bar) return false;

  const top = new Point(object.points[TOP_INDEX]);
  const before = top.subtract(object.pathOffset).transform(object.calcOwnMatrix());

  object.points = radicalLocalPoints(params).map((p) => new Point(p.x + top.x, p.y + top.y));
  object[RADICAL_PARAMS_PROP] = params;
  object.setDimensions();

  const after = top.subtract(object.pathOffset).transform(object.calcOwnMatrix());

  object.set({ left: object.left - (after.x - before.x), top: object.top - (after.y - before.y), dirty: true });
  object.setCoords();

  return true;
}

/** Where a radical's own point `index` sits on screen (the control's position). */
const pointPosition =
  (index: number) =>
  (_dim: Point, _finalMatrix: unknown, object: FabricObject): Point => {
    const poly = object as Polyline;

    return new Point(poly.points[index])
      .subtract(poly.pathOffset)
      .transform(util.multiplyTransformMatrices(poly.getViewportTransform(), poly.calcTransformMatrix()));
  };

/** The pointer in the radical's own frame, relative to its stem top. */
function pointerFromTop(object: Polyline, x: number, y: number): Point {
  const local = util.sendPointToPlane(new Point(x, y), undefined, object.calcOwnMatrix()).add(object.pathOffset);

  return local.subtract(new Point(object.points[TOP_INDEX]));
}

const stretchBar = (_e: TPointerEvent, transform: Transform, x: number, y: number): boolean => {
  const object = transform.target;

  if (!isRadicalObject(object)) return false;

  const params = object[RADICAL_PARAMS_PROP]!;

  return setRadicalParams(object, { ...params, bar: pointerFromTop(object, x, y).x });
};

const stretchDepth = (_e: TPointerEvent, transform: Transform, x: number, y: number): boolean => {
  const object = transform.target;

  if (!isRadicalObject(object)) return false;

  const params = object[RADICAL_PARAMS_PROP]!;

  return setRadicalParams(object, { ...params, height: pointerFromTop(object, x, y).y });
};

/** Halo around the stroke, CSS px on each side. */
const OUTLINE_HALO_PX = 4;

/**
 * Fabric calls this with the context translated to the object's centre (viewport px) and rotated by its
 * angle — see `InteractiveObject._renderControls`. Map the polyline into that frame and stroke a
 * translucent accent halo along it, a few px wider than the sign's own stroke.
 */
function drawRadicalOutline(this: Polyline, ctx: CanvasRenderingContext2D, options: { translateX: number; translateY: number }): void {
  const matrix = util.multiplyTransformMatrices(this.getViewportTransform(), this.calcTransformMatrix());
  const angle = util.degreesToRadians(this.group ? util.qrDecompose(matrix).angle : this.angle);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const zoom = this.canvas?.getZoom() ?? 1;
  const points = this.points.map((p) => {
    const v = new Point(p).subtract(this.pathOffset).transform(matrix);
    const dx = v.x - options.translateX;
    const dy = v.y - options.translateY;

    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  });

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = this.borderColor;
  ctx.setLineDash([]);
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.globalAlpha *= 0.28;
  ctx.lineWidth = this.strokeWidth * zoom + OUTLINE_HALO_PX * 2;
  ctx.stroke();
  ctx.restore();
}

const HANDLE = { sizeX: 18, sizeY: 18, touchSizeX: 44, touchSizeY: 44 } as const;

/** The radical's two stretch handles, and nothing that would scale or skew it. Idempotent. */
/**
 * Safety net: Fabric 7 runs `findControl` on every hovered object and reads `controls[key]` for each
 * `oCoords` key. If anything ever swaps an object's controls without `setCoords()`, that read is
 * undefined and the board crashes on a plain hover. Resync once instead of throwing.
 */
function installFindControlGuard(): void {
  const proto = FabricObjectClass.prototype as FabricObject & { __wbFindControlGuard?: boolean };

  if (proto.__wbFindControlGuard) return;
  proto.__wbFindControlGuard = true;
  const original = proto.findControl;

  proto.findControl = function findControlGuarded(this: FabricObject, ...args: Parameters<FabricObject['findControl']>) {
    const coords = this.oCoords as Record<string, unknown> | undefined;

    if (coords && Object.keys(coords).some((key) => !this.controls[key])) this.setCoords();

    return original.apply(this, args);
  };
}

installFindControlGuard();

export function applyRadicalControls(object: FabricObject): void {
  if (!isRadicalObject(object)) return;

  object.set({
    lockScalingX: true,
    lockScalingY: true,
    lockSkewingX: true,
    lockSkewingY: true,
    lockScalingFlip: true,
    hasBorders: true,
  });

  // The selection outline follows the sign itself instead of its bounding box (which would frame the
  // whole empty area under the bar). Not serialised: re-applied on every `object:added`.
  object.drawBorders = drawRadicalOutline;

  object.controls = {
    bar: new Control({
      ...HANDLE,
      actionName: RADICAL_ACTION,
      cursorStyle: 'ew-resize',
      positionHandler: pointPosition(BAR_END_INDEX),
      actionHandler: controlsUtils.wrapWithFireEvent(RADICAL_ACTION, stretchBar),
    }),
    depth: new Control({
      ...HANDLE,
      actionName: RADICAL_ACTION,
      cursorStyle: 'ns-resize',
      positionHandler: pointPosition(BOTTOM_INDEX),
      actionHandler: controlsUtils.wrapWithFireEvent(RADICAL_ACTION, stretchDepth),
    }),
  };
  // The handle positions (`oCoords`) are keyed by control name; left on the old box's keys, Fabric's
  // hover check looks up `controls.tl` etc. and throws — hovering the sign with Select crashed the board.
  object.setCoords();
}
