import { FabricObject as FabricObjectClass } from 'fabric';

import type { Canvas, Control, FabricObject, Point, TCornerPoint } from 'fabric';

import { setSelectionGrabsByPaint } from './selectionHitTest';
import { enableStrokeScaleBake } from './strokeScaleBake';

/**
 * How a selection is drawn on the board.
 *
 * - `classic` — Fabric's own defaults (1px pale-blue frame, 13px hollow squares), the look every app
 *   shipped with. Untouched.
 * - `modern` — a touch / S Pen selection (opt-in, Study). NO box: the selected ink is traced by a
 *   soft accent HALO that follows the strokes themselves (each stroke painted again, wider and
 *   translucent, under the ink — see `installInkHalo`), so a selected word looks like a highlighted
 *   word, not a game hit box. Small round grips sit just outside the ink's corners; a line-shaped
 *   stroke also gets grips at its two ENDS, so it stretches longer along itself. The handles are
 *   GRIPS, not zones: a pen on Android reaches Fabric as a touch, and the old 44 px touch squares
 *   covered most of a selected word — a drag meant to move it kept scaling it. A handle answers only
 *   on its own small target (24 px for touch) and only outside the (invisible) frame. With no frame
 *   drawn there is nothing to hold in the empty corners of the box either: the selection is grabbed
 *   near its ink (selectionHitTest `setSelectionGrabsByPaint`), and a press in empty space starts a new
 *   selection. Stretching keeps the stroke width (`strokeScaleBake`).
 *
 * The frame is painted on the board's PAPER (white in every theme), so the accent is a literal that
 * reads on white rather than a theme token.
 */
export type SelectionChrome = 'classic' | 'modern';

export const SELECTION_ACCENT = '#2563eb';

/** The marquee a select-tool drag paints (box or lasso), per chrome. */
export const SELECTION_MARQUEE: Record<SelectionChrome, { fill: string; stroke: string }> = {
  classic: { fill: 'rgba(253, 224, 71, 0.14)', stroke: '#18204a' },
  modern: { fill: 'rgba(37, 99, 235, 0.08)', stroke: SELECTION_ACCENT },
};

/** Halo reach (CSS px) on each side of a selected stroke. */
export const HALO_WIDTH_PX = 5;
/** Translucent: where two selected strokes cross, both stay visible through the other's halo. */
export const HALO_COLOR = 'rgba(37, 99, 235, 0.24)';

/** Room (CSS px, outside the object's box) between the ink and its grips: just past the halo. */
export const MODERN_FRAME_PADDING = HALO_WIDTH_PX + 2;
const MODERN_CORNER_SIZE = 12;
/** The modern rotate grip sits this far above the (invisible) frame: by the ink, not floating off it. */
export const ROTATE_HANDLE_REACH = 22;
/** A single stroke whose box is this many times longer than it is tall (or the reverse) is a LINE: grips at its ends. */
const LINE_ASPECT = 4;
/** How far the modern frame's chrome reaches past the selection box: above (rotate handle) and elsewhere. */
export const MODERN_CHROME_REACH = {
  top: MODERN_FRAME_PADDING + ROTATE_HANDLE_REACH + MODERN_CORNER_SIZE / 2,
  other: MODERN_FRAME_PADDING + MODERN_CORNER_SIZE / 2,
} as const;

/** Touch hit square of a handle (CSS px). A finger or S Pen tip; small, so the body stays draggable. */
export const MODERN_TOUCH_CORNER_SIZE = 24;
/** A selection whose shorter screen side is under this many touch grips shows its corners only. */
const SMALL_SELECTION_GRIPS = 3;

const SIDE_HANDLES_OFF = { ml: false, mr: false, mt: false, mb: false } as const;
const SIDE_HANDLES_ON = { ml: true, mr: true, mt: true, mb: true } as const;
const LINE_ENDS_HORIZONTAL = { ml: true, mr: true, mt: false, mb: false } as const;
const LINE_ENDS_VERTICAL = { ml: false, mr: false, mt: true, mb: true } as const;
/** The scale handles the frame guards; vertex handles (a snapped polygon) and rotation are left alone. */
const FRAME_HANDLE_KEYS = ['tl', 'tr', 'bl', 'br', 'ml', 'mr', 'mt', 'mb'] as const;

const FRAME_STYLE = {
  // The halo IS the selection; no rectangle around it.
  hasBorders: false,
  borderColor: SELECTION_ACCENT,
  borderScaleFactor: 2,
  borderOpacityWhenMoving: 0.5,
  borderDashArray: null,
  cornerStyle: 'circle',
  cornerSize: MODERN_CORNER_SIZE,
  touchCornerSize: MODERN_TOUCH_CORNER_SIZE,
  transparentCorners: false,
  cornerColor: '#ffffff',
  cornerStrokeColor: SELECTION_ACCENT,
  padding: MODERN_FRAME_PADDING,
} as const;

/** A member of a multi-selection: no outline of its own; its halo shows it is selected. */
const MEMBER_STYLE = {
  hasBorders: false,
} as const;

function isActiveSelection(object: FabricObject): object is FabricObject & { getObjects: () => FabricObject[] } {
  return (object as { type?: string }).type === 'activeselection' || (object as { type?: string }).type === 'ActiveSelection';
}

/** Ray cast: is `p` inside the closed polygon? */
function insidePolygon(p: { x: number; y: number }, polygon: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;

    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }

  return inside;
}

/**
 * Is the viewport point inside the selection FRAME (the object's box plus its padding)? The frame's
 * corners are where Fabric puts the corner handles (`oCoords`, viewport px).
 */
export function pointerInsideFrame(object: FabricObject, pointer: { x: number; y: number }): boolean {
  const coords = (object as unknown as { oCoords?: Partial<Record<'tl' | 'tr' | 'br' | 'bl', { x: number; y: number }>> }).oCoords;

  if (!coords?.tl || !coords.tr || !coords.br || !coords.bl) return false;

  return insidePolygon(pointer, [coords.tl, coords.tr, coords.br, coords.bl]);
}

const guardedControls = new WeakSet<Control>();

/**
 * A frame handle that answers only OUTSIDE the frame: the part of its target square that overlaps the
 * selection belongs to the body, which moves. Wraps without touching the original (controls can be
 * shared), idempotent.
 */
function guardFrameHandles(object: FabricObject): void {
  const controls = object.controls as Record<string, Control | undefined>;
  let changed = false;
  const next: Record<string, Control> = { ...(controls as Record<string, Control>) };

  for (const key of FRAME_HANDLE_KEYS) {
    const control = controls[key];

    if (!control || guardedControls.has(control)) continue;

    const guarded = Object.create(control) as Control;
    const shouldActivate = control.shouldActivate;

    guarded.shouldActivate = function shouldActivateOutsideFrame(this: Control, controlKey: string, target: FabricObject, pointer: Point, corners: TCornerPoint) {
      return shouldActivate.call(this, controlKey, target as never, pointer, corners) && !pointerInsideFrame(target, pointer);
    } as Control['shouldActivate'];
    guardedControls.add(guarded);
    next[key] = guarded;
    changed = true;
  }

  // The rotate grip, pulled in from Fabric's 40 px so it sits by the ink instead of floating above it.
  const rotate = controls.mtr;

  if (rotate && !guardedControls.has(rotate)) {
    const near = Object.create(rotate) as Control;

    near.offsetY = -ROTATE_HANDLE_REACH;
    near.withConnection = false;
    guardedControls.add(near);
    next.mtr = near;
    changed = true;
  }

  if (changed) object.controls = next as FabricObject['controls'];
}

/** Grips at a line's two ends (along its long axis), or null when the stroke is not line-shaped. */
function lineEndHandles(object: FabricObject): typeof LINE_ENDS_HORIZONTAL | typeof LINE_ENDS_VERTICAL | null {
  const box = object.getBoundingRect();

  if (box.width >= LINE_ASPECT * Math.max(box.height, 1)) return LINE_ENDS_HORIZONTAL;
  if (box.height >= LINE_ASPECT * Math.max(box.width, 1)) return LINE_ENDS_VERTICAL;

  return null;
}

/** Shorter side of the object's frame on screen, CSS px. */
function screenShortSide(object: FabricObject): number {
  const zoom = object.canvas?.getZoom?.() ?? 1;
  const box = object.getBoundingRect();

  return Math.min(box.width, box.height) * zoom + 2 * MODERN_FRAME_PADDING;
}

/** Dress one active object (a single object, or the ActiveSelection and its members) in the modern frame. */
export function applyModernSelectionStyle(object: FabricObject): void {
  object.set(FRAME_STYLE as unknown as Partial<FabricObject>);

  const type = (object as { type?: string }).type;

  // Ink, images and multi-selections scale by their corners only — an image keeps its aspect ratio (a
  // side handle stretched it; cutting a picture down is the crop action's job). A line-shaped stroke
  // also gets grips at its two ends: dragging one makes the line longer, and only longer. A text box
  // keeps its side handles (they set its wrap width) — unless it is too small on screen to have room
  // for them AND a place to grab it.
  if (type === 'path') object.setControlsVisibility(lineEndHandles(object) ?? SIDE_HANDLES_OFF);
  else if (isActiveSelection(object) || type === 'image') object.setControlsVisibility(SIDE_HANDLES_OFF);
  else object.setControlsVisibility(screenShortSide(object) < SMALL_SELECTION_GRIPS * MODERN_TOUCH_CORNER_SIZE ? SIDE_HANDLES_OFF : SIDE_HANDLES_ON);

  guardFrameHandles(object);

  if (isActiveSelection(object)) object.getObjects().forEach((member) => member.set(MEMBER_STYLE as unknown as Partial<FabricObject>));
}

// --- The halo ------------------------------------------------------------------------------------

type HaloCanvas = Canvas & { _activeObject?: FabricObject | null; skipControlsDrawing?: boolean };

const haloCanvases = new WeakSet<object>();

/** Is `object` shown as selected on a halo canvas: the active object, or a member of the active multi-selection? */
export function showsHalo(object: FabricObject): boolean {
  const canvas = object.canvas as HaloCanvas | undefined;

  // `skipControlsDrawing` is set while Fabric renders an export or a thumbnail: the halo never goes in.
  if (!canvas || !haloCanvases.has(canvas) || canvas.skipControlsDrawing) return false;

  const active = canvas._activeObject;

  if (!active) return false;

  return active === object || (object.group === active && isActiveSelection(active));
}

type Traceable = FabricObject & {
  _objects?: FabricObject[];
  _renderPathCommands?: (ctx: CanvasRenderingContext2D) => void;
  points?: { x: number; y: number }[];
  pathOffset?: { x: number; y: number };
  calcLinePoints?: () => { x1: number; y1: number; x2: number; y2: number };
  rx?: number;
  ry?: number;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
};

/** Makes the object's painted outline, in its OWN plane (ctx already transformed to it), the current path. */
export function traceObjectOutline(object: FabricObject, ctx: CanvasRenderingContext2D): void {
  const o = object as Traceable;

  if (o.isType('Path') && o._renderPathCommands) {
    o._renderPathCommands(ctx);

    return;
  }

  ctx.beginPath();

  if (o.isType('Polyline', 'Polygon') && o.points && o.pathOffset) {
    const { x: ox, y: oy } = o.pathOffset;

    o.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x - ox, p.y - oy) : ctx.lineTo(p.x - ox, p.y - oy)));
    if (o.isType('Polygon')) ctx.closePath();

    return;
  }

  if (o.isType('Line') && o.calcLinePoints) {
    const { x1, y1, x2, y2 } = o.calcLinePoints();

    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);

    return;
  }

  if (o.isType('Ellipse')) {
    ctx.ellipse(0, 0, o.rx ?? 0, o.ry ?? 0, 0, 0, Math.PI * 2);

    return;
  }

  if (o.isType('Circle')) {
    ctx.arc(0, 0, o.radius ?? 0, ((o.startAngle ?? 0) * Math.PI) / 180, ((o.endAngle ?? 360) * Math.PI) / 180);

    return;
  }

  // An image, text, a sticky note: what it paints is its box.
  ctx.rect(-o.width / 2, -o.height / 2, o.width, o.height);
}

/** Device px per unit of the context's current plane (the transform's area scale). */
function planeScale(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform();

  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
}

/**
 * Width (device px) of one object's halo stroke: the stroke as painted plus the halo on each side.
 * `deviceScale` is device px per unit of the object's own plane; `sceneScale` is device px per scene
 * unit (zoom × retina), the unit a `strokeUniform` stroke is painted in.
 */
export function haloLineWidth(
  object: Pick<FabricObject, 'stroke' | 'strokeWidth' | 'strokeUniform'>,
  deviceScale: number,
  sceneScale: number,
  retina: number,
): number {
  const stroked = Boolean(object.stroke) && (object.strokeWidth ?? 0) > 0;
  const strokeDevice = !stroked ? 0 : object.strokeUniform ? object.strokeWidth * sceneScale : object.strokeWidth * deviceScale;

  return strokeDevice + 2 * HALO_WIDTH_PX * retina;
}

/** Paints `object`'s halo. `ctx` is in the object's PARENT plane, `ownPlane` moves it into the object's; left as found. */
function paintHalo(object: FabricObject, ctx: CanvasRenderingContext2D, ownPlane: () => void, sceneScale: number, retina: number): void {
  const children = (object as Traceable)._objects;

  ctx.save();
  ownPlane();

  if (Array.isArray(children)) {
    // A group (a traced word): each child traced in its own plane, inside the group's.
    for (const child of children) {
      if (child.visible === false) continue;

      paintHalo(child, ctx, () => ctx.transform(...(child.calcOwnMatrix() as [number, number, number, number, number, number])), sceneScale, retina);
    }

    ctx.restore();

    return;
  }

  const deviceScale = planeScale(ctx);

  traceObjectOutline(object, ctx);
  // The path is fixed in device space as it is built: stroke it untransformed, so the width is plain px.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = haloLineWidth(object, deviceScale, sceneScale, retina);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = HALO_COLOR;
  ctx.stroke();
  ctx.restore();
}

let haloPatched = false;

/**
 * Teaches every Fabric object to paint its selection halo. Fabric calls `drawSelectionBackground` from
 * `render()` BEFORE the object paints itself (and outside its cache), so the halo lands under the ink.
 * Only on canvases that opted in ({@link installModernSelectionChrome}); everywhere else the original
 * runs. Patched once per page.
 */
function installInkHalo(): void {
  if (haloPatched) return;
  haloPatched = true;

  const proto = FabricObjectClass.prototype as unknown as { drawSelectionBackground: (ctx: CanvasRenderingContext2D) => void };
  const original = proto.drawSelectionBackground;

  proto.drawSelectionBackground = function drawSelectionHalo(this: FabricObject, ctx: CanvasRenderingContext2D) {
    if (!showsHalo(this)) {
      original.call(this, ctx);

      return;
    }

    const retina = (this.canvas as Canvas).getRetinaScaling?.() ?? 1;

    try {
      // `render()` hands us the context in the scene plane (viewport × retina): its scale is the scene's.
      paintHalo(this, ctx, () => this.transform(ctx), planeScale(ctx), retina);
    } catch {
      // A halo is decoration: a malformed object must never stop the ink from painting.
    }
  };
}

/**
 * Applies the modern selection to whatever becomes the active object on `canvas` and the accent to
 * Fabric's own rubber band, and turns on, for this canvas, the halo, the grab-by-paint and the
 * width-keeping stretch. Returns the uninstaller.
 */
export function installModernSelectionChrome(canvas: Canvas): () => void {
  installInkHalo();
  haloCanvases.add(canvas);

  const ungrab = setSelectionGrabsByPaint(canvas);
  const unbake = enableStrokeScaleBake(canvas);

  const previous = {
    selectionColor: canvas.selectionColor,
    selectionBorderColor: canvas.selectionBorderColor,
    selectionLineWidth: canvas.selectionLineWidth,
  };

  canvas.selectionColor = SELECTION_MARQUEE.modern.fill;
  canvas.selectionBorderColor = SELECTION_ACCENT;
  canvas.selectionLineWidth = 1.5;

  const dress = () => {
    const active = canvas.getActiveObject();

    if (!active) return;
    applyModernSelectionStyle(active);
    canvas.requestRenderAll();
  };

  canvas.on('selection:created', dress as never);
  canvas.on('selection:updated', dress as never);
  // A resize can make a selection small (or big) enough to change which handles it shows.
  canvas.on('object:modified', dress as never);
  dress();

  return () => {
    canvas.off('selection:created', dress as never);
    canvas.off('selection:updated', dress as never);
    canvas.off('object:modified', dress as never);
    haloCanvases.delete(canvas);
    ungrab();
    unbake();
    Object.assign(canvas, previous);
  };
}
