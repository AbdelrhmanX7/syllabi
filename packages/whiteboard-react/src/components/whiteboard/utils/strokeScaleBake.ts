import { ActiveSelection, Point, util } from 'fabric';

import type { Canvas, FabricObject, Path, TMat2D } from 'fabric';

/**
 * Stretching ink never changes how thick it is.
 *
 * Fabric scales an object by keeping its geometry and multiplying its matrix, and a stroke's width is
 * painted under that matrix: stretching a horizontal line to twice its length painted it twice as
 * thick, and a sideways stretch turned a round pen into a flat nib. Two halves fix it:
 *
 *   live    when a transform starts, every stroked object being transformed gets `strokeUniform`
 *           (Fabric then paints its stroke in screen units, whatever the scale) — an object that was
 *           saved already scaled keeps the width it shows, folded into `strokeWidth`;
 *   final   when the gesture ends (`object:modified`), a Path's scale, flip and skew are BAKED into its
 *           points and the object goes back to scale 1. What is saved is the stretched geometry with
 *           the original width — every reader (old app versions, exports, the erasers and hit tests)
 *           sees a plain stroke, nothing depends on `strokeUniform` surviving a round trip.
 *
 * A multi-selection is scaled as one group; its members' transforms are relative to it. It is
 * dissolved (members take the group transform), each member is baked, and it is rebuilt over the same
 * objects — the same dance `straightenSelection` does.
 *
 * Only stroked ink keeps its width. A FILLED outline (the calligraphy nib's swept shape) has its width
 * in its geometry: a stretch still stretches it.
 */

export interface DimensionTransform {
  scaleX?: number;
  scaleY?: number;
  flipX?: boolean;
  flipY?: boolean;
  skewX?: number;
  skewY?: number;
}

type PathCommand = (string | number)[];

const EPSILON = 1e-9;

/** The linear part of an object's transform that is NOT its rotation: scale × flip × skew. */
export function dimensionMatrix(t: DimensionTransform): TMat2D {
  return util.calcDimensionsMatrix({
    scaleX: t.scaleX ?? 1,
    scaleY: t.scaleY ?? 1,
    flipX: Boolean(t.flipX),
    flipY: Boolean(t.flipY),
    skewX: t.skewX ?? 0,
    skewY: t.skewY ?? 0,
  } as Parameters<typeof util.calcDimensionsMatrix>[0]);
}

export function isIdentityDimensions(t: DimensionTransform): boolean {
  const m = dimensionMatrix(t);

  return Math.abs(m[0] - 1) < EPSILON && Math.abs(m[1]) < EPSILON && Math.abs(m[2]) < EPSILON && Math.abs(m[3] - 1) < EPSILON;
}

/**
 * Every coordinate pair of an absolute, simplified path (M / L / C / Q / Z — what Fabric keeps after
 * `makePathSimpler`) moved into object space (`- offset`) and through the linear map `m`.
 */
export function bakeLinearIntoPath(path: ReadonlyArray<ReadonlyArray<string | number>>, offset: { x: number; y: number }, m: TMat2D): PathCommand[] {
  return path.map((command) => {
    const out: PathCommand = [command[0]!];

    for (let i = 1; i + 1 < command.length; i += 2) {
      const x = Number(command[i]) - offset.x;
      const y = Number(command[i + 1]) - offset.y;

      out.push(m[0] * x + m[2] * y, m[1] * x + m[3] * y);
    }

    // An odd trailing number (never produced by makePathSimpler) is kept as is.
    if (command.length % 2 === 0) out.push(command[command.length - 1]!);

    return out;
  });
}

function isPath(object: FabricObject): object is Path {
  return object.isType('Path');
}

function isStroked(object: FabricObject): boolean {
  return Boolean(object.stroke) && (object.strokeWidth ?? 0) > 0;
}

/**
 * Bakes a Path's scale / flip / skew into its points: same look, same centre, same angle, scale 1.
 * The stroke width is the one the stroke SHOWS (strokeUniform: as set; otherwise scaled with it, folded
 * in). Returns false when there was nothing to bake. The object must not be inside a group.
 */
export function bakePathScale(path: Path): boolean {
  if (isIdentityDimensions(path)) return false;

  const center = path.getRelativeCenterPoint();
  const m = dimensionMatrix(path);
  const baked = bakeLinearIntoPath(path.path as never, path.pathOffset, m);
  // Fabric paints a non-uniform stroke as an ellipse pen; its area-equivalent round pen is the honest single width.
  const widthFactor = path.strokeUniform ? 1 : Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

  path.set({ scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 });
  path._setPath(baked as never, false);
  if (isStroked(path) && widthFactor !== 1) path.set('strokeWidth', path.strokeWidth * widthFactor);

  // The baked points are centred where the old centre was (object space origin), offset by the new
  // bounding box centre; carry that offset through the (unchanged) rotation.
  const angle = util.degreesToRadians(path.angle ?? 0);
  const off = path.pathOffset;
  const shifted = new Point(center.x + off.x * Math.cos(angle) - off.y * Math.sin(angle), center.y + off.x * Math.sin(angle) + off.y * Math.cos(angle));

  path.setPositionByOrigin(shifted, 'center', 'center');
  path.set('dirty', true);
  path.setCoords();

  return true;
}

/**
 * From here on, the object's stroke keeps its on-screen width under any scale. One saved already
 * scaled (an old board) keeps the width it shows today. Recurses into groups (a traced word).
 */
export function makeStrokeUniform(object: FabricObject): void {
  const children = (object as unknown as { _objects?: FabricObject[] })._objects;

  if (Array.isArray(children)) {
    children.forEach(makeStrokeUniform);

    return;
  }

  if (object.strokeUniform || !isStroked(object)) return;

  const { scaleX, scaleY } = util.qrDecompose(object.calcTransformMatrix());
  const factor = Math.sqrt(Math.abs(scaleX * scaleY)) || 1;

  object.set({ strokeUniform: true, strokeWidth: object.strokeWidth * factor });
}

function isActiveSelection(object: FabricObject): object is ActiveSelection {
  return object instanceof ActiveSelection || object.isType('ActiveSelection', 'activeselection');
}

/**
 * Bakes whatever a finished transform left scaled. A single Path is baked in place; a scaled
 * multi-selection is dissolved, its Path members baked, and rebuilt. Each baked member is announced
 * through `object:modified` (the history and the erase index follow members, not the selection).
 */
export function bakeTransformedInk(canvas: Canvas, target: FabricObject | null | undefined): number {
  if (!target) return 0;

  if (isPath(target) && !target.group) return bakePathScale(target) ? 1 : 0;

  if (!isActiveSelection(target) || isIdentityDimensions(target)) return 0;

  const members = target.getObjects();

  if (!members.some(isPath)) return 0;

  const wasActive = canvas.getActiveObject() === target;
  // Called from `object:modified`, the gesture's transform is still open: Fabric's discard would END it
  // again (a second, nested `object:modified` with the emptied selection). Park it while we rebuild.
  const open = canvas as unknown as { _currentTransform?: { target?: FabricObject } | null };
  const transform = open._currentTransform;

  open._currentTransform = null;

  let baked = 0;

  try {
    canvas.discardActiveObject();

    for (const member of members) {
      if (isPath(member) && !member.group && bakePathScale(member)) {
        baked += 1;
        canvas.fire('object:modified', { target: member } as never);
      }
    }

    if (wasActive) canvas.setActiveObject(new ActiveSelection(members, { canvas }));
  } finally {
    const rebuilt = canvas.getActiveObject();

    if (transform && rebuilt && transform.target === target) transform.target = rebuilt;
    open._currentTransform = transform;
  }

  return baked;
}

const enabledCanvases = new WeakSet<Canvas>();

/** Turns the bake on or off for `canvas` (the modern, Study selection opts in). Returns the undo. */
export function enableStrokeScaleBake(canvas: Canvas): () => void {
  enabledCanvases.add(canvas);

  return () => {
    enabledCanvases.delete(canvas);
  };
}

/**
 * Wires both halves onto `canvas`; they act only while {@link enableStrokeScaleBake} is on for it.
 * Installed when the canvas is created, BEFORE the other `object:modified` listeners (the erase index,
 * the history), so they see the baked object. Returns the uninstaller.
 */
export function installStrokeScaleBake(canvas: Canvas): () => void {
  const onBeforeTransform = ({ transform }: { transform?: { target?: FabricObject; action?: string } }) => {
    const target = transform?.target;

    if (!target || transform?.action === 'drag' || !enabledCanvases.has(canvas)) return;

    makeStrokeUniform(target);
  };
  const onModified = (event: { target?: FabricObject | null }) => {
    const { target } = event;

    if (!enabledCanvases.has(canvas) || bakeTransformedInk(canvas, target) === 0) return;

    // Fabric hands every listener the same options object: the ones after this one (the selection
    // overlays, the action bar) must see the rebuilt selection, not the emptied one.
    if (target && isActiveSelection(target)) event.target = canvas.getActiveObject() ?? target;
    canvas.requestRenderAll();
  };

  canvas.on('before:transform', onBeforeTransform as never);
  canvas.on('object:modified', onModified as never);

  return () => {
    canvas.off('before:transform', onBeforeTransform as never);
    canvas.off('object:modified', onModified as never);
  };
}
