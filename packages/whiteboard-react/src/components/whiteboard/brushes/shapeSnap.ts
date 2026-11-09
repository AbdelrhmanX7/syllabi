import { controlsUtils, Ellipse, Path, Polygon, Polyline, Shadow } from 'fabric';

import type { Canvas, FabricObject, Point, TPointerEvent } from 'fabric';

import type { LineShape } from '../types';
import { isHoverWithoutContact } from '../utils/hoverContact';
import { recognizeRadical } from '../utils/radicalSign';
import { adjustSnappedShape, radicalShape, recognizeShape } from '../utils/shapeRecognition';
import type { RecognizedShape, ShapeGeometry, ShapeKind, Vec } from '../utils/shapeRecognition';
import { sampleShapeOutline } from '../utils/shapeSampling';
import { smoothStroke } from '../utils/smoothStroke';
import { CalligraphyBrush, NIB_WIDTH_SCALE } from './CalligraphyBrush';
import { applyRadicalControls, createRadicalPolyline, RADICAL_PARAMS_PROP } from './radicalObject';
import type { LowLatencyPencilBrush, StrokeInterceptor } from './LowLatencyPencilBrush';
import { SoftMarkerBrush, softMarkerBlur } from './SoftMarkerBrush';

/**
 * Hold-to-snap shapes — the live half. `utils/shapeRecognition` decides WHAT the stroke is; this
 * decides WHEN to ask, swaps the live preview for the perfect shape while the pen is still down, lets
 * the pen keep resizing/rotating it (Apple's behaviour), and commits it on lift as an ordinary
 * object — one `object:added`, so one undo step, one autosave, one sync, like any stroke.
 *
 * LATENCY. Nothing here runs per sample beyond a distance check: recognition runs ONCE, from a timer,
 * when the pen has stayed inside {@link SHAPE_HOLD_RADIUS_PX} for {@link SHAPE_HOLD_MS}. The timer is
 * armed at pen-down and re-armed only by the timer itself, so a moving pen never touches
 * setTimeout/clearTimeout.
 *
 * WHAT CAN START A HOLD. Only a stroke the brush is actually drawing, i.e. a contact Fabric accepted:
 * a hovering pen never reaches the brush (no mousedown), a palm and a finger pan are filtered out
 * before Fabric on a pen device, and on a touch-only panel a finger's tentative ink is far below the
 * minimum shape size before the pan takes over. The one hole — a lost pen-up followed by a STILL
 * hover — is closed by remembering whether the latest sample still had tip contact.
 *
 * COMMITTED OBJECTS are plain Fabric shapes carrying {@link SNAPPED_SHAPE_PROP}:
 *   line                        Polyline (2 points) — endpoint handles
 *   triangle / polygon          Polygon — a handle on every vertex, plus rotate
 *   rectangle / square          Polygon — the normal scale + rotate box (vertex drags would un-square it)
 *   ellipse / circle            Ellipse — the normal scale + rotate box
 *   smooth (any other stroke)   Polyline / Polygon of the smoothed stroke — the normal scale + rotate box
 *   radical (√)                 Polyline + its params — bar-end and depth handles that REGENERATE the
 *                               sign (`radicalObject.ts`); never scaled, never swept with a nib
 * Every eraser already handles all three classes (`eraserHitTest`), and `canvas.toJSON` keeps the
 * marker prop through the class `customProperties` registered here.
 *
 * THE CALLIGRAPHY BRUSH is the exception: its mark is not a stroked line but the nib swept along the
 * pen's points (see `CalligraphyBrush`), so a snapped shape committed as a uniform Polyline looked like
 * the plain pen — the brush character vanished the moment the shape snapped. For that brush the snapped
 * geometry is sampled back into points (`utils/shapeSampling`) and swept through the brush's own
 * outline, preview and commit alike; the committed object is the same kind of filled `Path` a brush
 * stroke commits, still carrying {@link SNAPPED_SHAPE_PROP}. A filled outline has no vertices to drag,
 * so it gets the ordinary scale + rotate box, never the vertex handles. The marker keeps its stroked
 * Polyline: a constant width plus the same edge blur IS the marker.
 */

/** How long the pen must stay still before the stroke is recognised. */
export const SHAPE_HOLD_MS = 500;
/**
 * "Still", in CSS px on screen. An S Pen held deliberately still on a tablet wanders 2–5 px; a pen
 * that is actually finishing a stroke leaves an 8 px circle within a frame or two.
 */
export const SHAPE_HOLD_RADIUS_PX = 8;
/** A stroke whose bounding box is smaller than this on screen is never a shape (a dot, a comma). */
export const SHAPE_MIN_SCREEN_PX = 28;
/** The snap cue: a halo that fades out over this long. */
const SNAP_CUE_MS = 260;
const SNAP_CUE_HALO_PX = 10;

/**
 * A √ is also recognised at pen-LIFT, without the hold — writing «√x» must not need a pause. The lift
 * path asks for a longer vinculum (relative to the stem height) than the deliberate hold does, so a
 * quick "v" with a connector stroke stays ink.
 */
export const RADICAL_LIFT_MIN_BAR_RATIO = 0.85;

/** The marker prop persisted on every committed snapped shape: its {@link ShapeKind}. */
export const SNAPPED_SHAPE_PROP = 'wbShape';

type SnappedObject = FabricObject & { [SNAPPED_SHAPE_PROP]?: ShapeKind };

/**
 * The dash pattern of a dashed stroke, scaled to its width (round caps add `width` to each dash, so the
 * visible dash is ~2.5 widths and the gap ~1.5). Null when the stroke is solid.
 */
export function dashArrayFor(settings: { width: number; dashed?: boolean }, widthScale = 1): number[] | null {
  if (!settings.dashed) return null;

  const width = settings.width * widthScale;

  return [width * 1.5, width * 2.5];
}

export interface ShapeSnapHost {
  /** Setting on AND the active tool is one that may snap. Read at pen-down and again at the hold. */
  isEnabled(): boolean;
  /** Object opacity for the shape the active tool would commit. */
  getOpacity(): number;
  /** The pen's line mode: `hold` snaps to a line on a pause, `always` makes every stroke a line. */
  getLineShape?(): LineShape;
  /** The active pen draws dashed. */
  isDashed?(): boolean;
  /** Last touches on the committed shape before it is added (e.g. the remembered background). */
  decorate?(object: FabricObject): void;
}

interface ShapeStyle {
  color: string;
  width: number;
  opacity: number;
  /** Marker halo, scene px; 0 = none. */
  blur: number;
  /** The calligraphy brush drawing: the shape is swept with its nib rather than stroked. */
  nib: CalligraphyBrush | null;
  /** Dash pattern of the stroked shape; absent/null = solid. The nib sweep is a filled outline and never dashes. */
  dash?: number[] | null;
}

/**
 * Spacing of the points a snapped shape is sampled into for the nib sweep, scene px — the brush
 * densifies its own centreline at 2 px, so this is "a pen stroke's samples". `maxPoints` keeps a huge
 * shape's per-frame preview bounded.
 */
const NIB_SAMPLE_SPACING_PX = 2;
const NIB_SAMPLE_MAX_POINTS = 400;

type DrawingCanvas = Canvas & { _isCurrentlyDrawing?: boolean };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const toVec = (p: { x: number; y: number }): Vec => ({ x: p.x, y: p.y });

export class ShapeSnapController implements StrokeInterceptor {
  private readonly host: ShapeSnapHost;
  private brush: LowLatencyPencilBrush | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Where the pen came to rest (scene) and when — re-anchored whenever it leaves the hold radius. */
  private anchor: Vec | null = null;
  private anchorAt = 0;
  private lastPen: Vec | null = null;
  /** False once a sample reported the tip off the glass (hover after a lost pen-up). */
  private inContact = true;

  // Snapped state.
  private base: RecognizedShape | null = null;
  private current: RecognizedShape | null = null;
  private holdPoint: Vec | null = null;
  private adjusting = false;
  private style: ShapeStyle | null = null;
  private cueStartedAt = 0;
  private frame = 0;
  /** Straight-line mode: the stroke's first point, and whether the snapped line follows the pen. */
  private lineMode: LineShape = 'free';
  private lineStart: Vec | null = null;
  private lineFollowsPen = false;

  constructor(host: ShapeSnapHost) {
    this.host = host;
  }

  /** True between the snap and the lift. */
  get isSnapped(): boolean {
    return this.current !== null;
  }

  strokeStart(brush: LowLatencyPencilBrush, pointer: Point): void {
    this.cancel();

    if (!this.host.isEnabled()) return;

    this.brush = brush;
    this.lineMode = this.host.getLineShape?.() ?? 'free';
    this.lineStart = toVec(pointer);
    this.anchor = toVec(pointer);
    this.anchorAt = now();
    this.lastPen = this.anchor;
    this.inContact = true;
    // `always` snaps from the first sample on, so there is no hold to wait for.
    if (this.lineMode !== 'always') this.arm(SHAPE_HOLD_MS);
  }

  strokeSample(brush: LowLatencyPencilBrush, pointer: Point, e: TPointerEvent | undefined): boolean {
    if (brush !== this.brush) return false;

    if (e) this.inContact = !isHoverWithoutContact(e as { pointerType?: string; buttons?: number });

    const zoom = brush.canvas.getZoom();

    this.lastPen = { x: pointer.x, y: pointer.y };

    if (this.lineMode === 'always' || (this.lineFollowsPen && this.current)) {
      this.followPen(brush, zoom);

      return true;
    }

    if (this.current?.kind === 'smooth') {
      const hold = this.holdPoint;

      // Smoothing is only a pause away in handwriting: the pen moving on means the stroke goes on,
      // so the smoothed preview is dropped and the freehand stroke continues untouched.
      if (!hold || Math.hypot(pointer.x - hold.x, pointer.y - hold.y) * zoom <= SHAPE_HOLD_RADIUS_PX) return true;
      this.unsnap(brush);
    } else if (this.current) {
      this.adjust(zoom);

      return true;
    }

    const anchor = this.anchor;

    if (anchor && Math.hypot(pointer.x - anchor.x, pointer.y - anchor.y) * zoom > SHAPE_HOLD_RADIUS_PX) {
      this.anchor = this.lastPen;
      this.anchorAt = now();
      // A hold that was already tried and found nothing stops the timer; moving on re-arms it.
      if (!this.timer) this.arm(SHAPE_HOLD_MS);
    }

    return false;
  }

  strokeFinalize(brush: LowLatencyPencilBrush): boolean {
    if (brush !== this.brush) return false;

    let shape = this.current;
    let style = this.style;

    if (!shape && this.host.isEnabled()) {
      // No hold happened: a single stroke that is plainly a √ with a long bar still becomes one.
      const radical = recognizeRadical(brush.liveStrokePoints, {
        minSize: SHAPE_MIN_SCREEN_PX / brush.canvas.getZoom(),
        minBarRatio: RADICAL_LIFT_MIN_BAR_RATIO,
      });

      if (radical) {
        shape = radicalShape(radical);
        style = this.styleFor(brush);
      }
    }

    this.cancel();

    if (!shape || shape.kind === 'none' || !style) return false;

    const canvas = brush.canvas;
    const object = createSnappedShapeObject(shape, style);

    this.host.decorate?.(object);

    if (canvas.contextTop) canvas.clearContext(canvas.contextTop);

    // Mirror what Fabric's own finalize leaves behind, minus the path.
    (brush as unknown as { _reset?: () => void })._reset?.();
    canvas.add(object);
    object.setCoords();
    canvas.requestRenderAll();

    return true;
  }

  /** Drop any hold in progress (and a snapped preview, uncommitted). Safe to call any time. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.frame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.frame);

    this.timer = null;
    this.frame = 0;
    this.brush = null;
    this.anchor = null;
    this.lastPen = null;
    this.base = null;
    this.current = null;
    this.holdPoint = null;
    this.adjusting = false;
    this.style = null;
    this.lineMode = 'free';
    this.lineStart = null;
    this.lineFollowsPen = false;
  }

  // --- internals ----------------------------------------------------------------------------------

  private arm(delay: number): void {
    this.timer = setTimeout(this.onTimer, Math.max(16, delay));
  }

  private readonly onTimer = (): void => {
    this.timer = null;

    const brush = this.brush;

    if (!brush || this.current) return;

    const elapsed = now() - this.anchorAt;

    if (elapsed < SHAPE_HOLD_MS - 8) {
      this.arm(SHAPE_HOLD_MS - elapsed);

      return;
    }

    const canvas = brush.canvas as DrawingCanvas;

    if (
      !this.inContact ||
      !canvas._isCurrentlyDrawing ||
      canvas.freeDrawingBrush !== brush ||
      !canvas.contextTop ||
      !this.host.isEnabled()
    ) {
      return;
    }

    if (this.lineMode === 'hold') {
      const start = this.lineStart;
      const pen = this.lastPen;

      // A pause too close to where the stroke began is a dot or a squiggle, not a line.
      if (!start || !pen || Math.hypot(pen.x - start.x, pen.y - start.y) * canvas.getZoom() < SHAPE_MIN_SCREEN_PX) return;

      this.base = lineBetween(start, pen);
      this.current = this.base;
      this.holdPoint = pen;
      this.lineFollowsPen = true;
      this.style = this.styleFor(brush);
      this.cueStartedAt = now();

      try {
        navigator.vibrate?.(12);
      } catch {
        // Haptics are a nicety; a locked-down WebView may throw.
      }

      this.draw();

      return;
    }

    const points = brush.liveStrokePoints.map(toVec);
    let shape = recognizeShape(points, { minSize: SHAPE_MIN_SCREEN_PX / canvas.getZoom() });

    // Not a shape: smooth the stroke instead (a curve, a contour, a freehand outline).
    if (shape.kind === 'none') {
      const smooth = smoothStroke(points, canvas.getZoom());

      if (smooth) shape = { kind: 'smooth', geometry: smooth };
    }

    if (shape.kind === 'none') return;

    this.base = shape;
    this.current = shape;
    this.holdPoint = this.lastPen ?? this.anchor;
    this.adjusting = false;
    this.style = this.styleFor(brush);
    // A radical stays a stretchable stroked line with every brush; the nib sweep would freeze it.
    if (shape.kind === 'radical') this.style.nib = null;
    this.cueStartedAt = now();

    try {
      navigator.vibrate?.(12);
    } catch {
      // Haptics are a nicety; a locked-down WebView may throw.
    }

    this.draw();
  };

  /** Back to the freehand stroke after a smoothed preview: repaint it and let the hold re-arm. */
  private unsnap(brush: LowLatencyPencilBrush): void {
    if (this.frame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.base = null;
    this.current = null;
    this.holdPoint = null;
    this.style = null;
    this.anchor = this.lastPen;
    this.anchorAt = now();

    const canvas = brush.canvas;

    if (canvas.contextTop) canvas.clearContext(canvas.contextTop);
    (brush as unknown as { _render: () => void })._render();
    if (!this.timer) this.arm(SHAPE_HOLD_MS);
  }

  private styleFor(brush: LowLatencyPencilBrush): ShapeStyle {
    return {
      color: String(brush.color),
      width: brush.width,
      opacity: this.host.getOpacity(),
      blur: brush instanceof SoftMarkerBrush ? softMarkerBlur(brush.width) : 0,
      nib: brush instanceof CalligraphyBrush ? brush : null,
      dash: this.host.isDashed?.() ? dashArrayFor({ width: brush.width, dashed: true }) : null,
    };
  }

  /** Rubber-band the straight line: start → current pen. `always` mode starts drawing it once the pen moves. */
  private followPen(brush: LowLatencyPencilBrush, zoom: number): void {
    const start = this.lineStart;
    const pen = this.lastPen;

    if (!start || !pen) return;

    if (!this.current) {
      // A tap stays a dot: no line until the pen has actually travelled.
      if (Math.hypot(pen.x - start.x, pen.y - start.y) * zoom <= SHAPE_HOLD_RADIUS_PX) return;

      this.style = this.styleFor(brush);
      // No snap cue: this line is the stroke, not a transformation of it.
      this.cueStartedAt = Number.NEGATIVE_INFINITY;
      this.lineFollowsPen = true;
    }

    this.current = lineBetween(start, pen);
    this.requestDraw();
  }

  private adjust(zoom: number): void {
    const base = this.base;
    const hold = this.holdPoint;
    const pen = this.lastPen;

    if (!base || !hold || !pen) return;

    // Hand tremor right after the snap must not nudge the perfect shape.
    if (!this.adjusting && Math.hypot(pen.x - hold.x, pen.y - hold.y) * zoom <= SHAPE_HOLD_RADIUS_PX) return;

    this.adjusting = true;
    this.current = adjustSnappedShape(base, hold, pen);
    this.requestDraw();
  }

  private requestDraw(): void {
    if (this.frame) return;

    if (typeof requestAnimationFrame === 'undefined') {
      this.draw();

      return;
    }

    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /** Paint the snapped shape on the top canvas in place of the freehand preview. */
  private draw(): void {
    const brush = this.brush;
    const shape = this.current;
    const style = this.style;

    if (!brush || !shape || shape.kind === 'none' || !style) return;

    const canvas = brush.canvas;
    const ctx = canvas.contextTop;

    if (!ctx) return;

    const zoom = canvas.getZoom();
    const cue = (now() - this.cueStartedAt) / SNAP_CUE_MS;
    // The halo hugs the mark: the nib's widest extent for the brush, the line width otherwise.
    const markWidth = style.nib ? style.width * NIB_WIDTH_SCALE : style.width;

    canvas.clearContext(ctx);
    ctx.save();
    ctx.transform(...canvas.viewportTransform);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style.color;
    traceGeometry(ctx, shape.geometry);

    if (cue < 1) {
      // The cue: a soft halo that blooms and fades — "this is now a shape".
      ctx.globalAlpha = 0.3 * (1 - cue);
      ctx.lineWidth = markWidth + (SNAP_CUE_HALO_PX * (0.5 + 0.5 * cue)) / zoom;
      ctx.stroke();
    }

    ctx.globalAlpha = style.opacity;

    if (style.nib) {
      // The brush's own mark along the shape — the same sweep the committed object will be.
      style.nib.renderOutlineFor(nibSamples(shape.geometry), ctx);
    } else {
      ctx.lineWidth = style.width;
      if (style.dash) ctx.setLineDash(style.dash);

      if (style.blur > 0) {
        ctx.shadowColor = style.color;
        ctx.shadowBlur = style.blur * zoom * canvas.getRetinaScaling();
      }

      ctx.stroke();
    }

    ctx.restore();

    if (cue < 1) this.requestDraw();
  }
}

function lineBetween(a: Vec, b: Vec): Exclude<RecognizedShape, { kind: 'none' }> {
  return { kind: 'line', geometry: { type: 'poly', points: [a, b], closed: false } };
}

/** The snapped geometry as the points a nib is swept along. */
function nibSamples(geometry: ShapeGeometry): Vec[] {
  return sampleShapeOutline(geometry, { spacing: NIB_SAMPLE_SPACING_PX, maxPoints: NIB_SAMPLE_MAX_POINTS });
}

function traceGeometry(ctx: CanvasRenderingContext2D, geometry: ShapeGeometry): void {
  ctx.beginPath();

  if (geometry.type === 'ellipse') {
    ctx.ellipse(geometry.cx, geometry.cy, geometry.rx, geometry.ry, geometry.angle, 0, Math.PI * 2);

    return;
  }

  geometry.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));

  if (geometry.closed) ctx.closePath();
}

/** Build the committed Fabric object for a snapped shape. */
export function createSnappedShapeObject(shape: Exclude<RecognizedShape, { kind: 'none' }>, style: ShapeStyle): FabricObject {
  if (shape.kind === 'radical') {
    const radical = createRadicalPolyline(shape.radical, style);

    (radical as SnappedObject)[SNAPPED_SHAPE_PROP] = 'radical';
    applySnappedShapeControls(radical);

    return radical;
  }

  if (style.nib) {
    const swept = createSnappedBrushObject(shape, style, style.nib);

    if (swept) return swept;
  }

  const common = {
    stroke: style.color,
    strokeWidth: style.width,
    fill: '',
    opacity: style.opacity,
    strokeLineCap: 'round' as const,
    strokeLineJoin: 'round' as const,
    // Resizing a snapped shape later must not fatten its line.
    strokeUniform: true,
    strokeDashArray: style.dash ?? undefined,
    shadow: style.blur > 0 ? new Shadow({ color: style.color, blur: style.blur, offsetX: 0, offsetY: 0, affectStroke: true }) : null,
  };
  const geometry = shape.geometry;
  let object: FabricObject;

  if (geometry.type === 'ellipse') {
    object = new Ellipse({
      ...common,
      left: geometry.cx,
      top: geometry.cy,
      originX: 'center',
      originY: 'center',
      rx: geometry.rx,
      ry: geometry.ry,
      angle: (geometry.angle * 180) / Math.PI,
    });
  } else if (geometry.closed) {
    object = new Polygon(geometry.points.map(toVec), common);
  } else {
    object = new Polyline(geometry.points.map(toVec), common);
  }

  (object as SnappedObject)[SNAPPED_SHAPE_PROP] = shape.kind;
  applySnappedShapeControls(object);

  return object;
}

/**
 * The calligraphy brush's committed snapped shape: the nib swept along the sampled geometry, as the same
 * filled `Path` a brush stroke commits (see `CalligraphyBrush.createPath`). Null when the shape is too
 * small to outline — the caller then falls back to the stroked geometry.
 */
export function createSnappedBrushObject(
  shape: Exclude<RecognizedShape, { kind: 'none' }>,
  style: Pick<ShapeStyle, 'color' | 'opacity'>,
  nib: Pick<CalligraphyBrush, 'outlinePathDataFor'>,
): FabricObject | null {
  const data = nib.outlinePathDataFor(nibSamples(shape.geometry));

  if (!data) return null;

  const object = new Path(data, {
    fill: style.color,
    stroke: '',
    strokeWidth: 0,
    fillRule: 'nonzero',
    opacity: style.opacity,
  });

  (object as SnappedObject)[SNAPPED_SHAPE_PROP] = shape.kind;
  applySnappedShapeControls(object);

  return object;
}

/** Shape kinds whose committed object edits by its vertices rather than a scale box. */
const VERTEX_EDITED: ReadonlySet<ShapeKind> = new Set<ShapeKind>(['line', 'triangle', 'polygon']);

/**
 * Finger-friendly handles for a snapped shape. Idempotent; called on creation and on every
 * `object:added` (which also covers a page load and an undo/redo restore — controls are not
 * serialised, so a revived object would otherwise come back with the generic box).
 */
export function applySnappedShapeControls(object: FabricObject): void {
  const kind = (object as SnappedObject)[SNAPPED_SHAPE_PROP];

  if (!kind) return;

  if (kind === 'radical') {
    applyRadicalControls(object);

    return;
  }

  object.set({
    cornerSize: 16,
    touchCornerSize: 44,
    cornerStyle: 'circle',
    transparentCorners: false,
    cornerColor: '#ffffff',
    cornerStrokeColor: '#2563eb',
    borderColor: '#2563eb',
    // A thin line's box is as tall as its stroke; padding gives a finger something to land on.
    padding: kind === 'line' ? 10 : 4,
  });

  // Vertex handles need vertices: a brush-swept shape is a filled outline Path and keeps the scale box.
  if (!VERTEX_EDITED.has(kind) || !(object instanceof Polyline)) return;

  const vertexControls = controlsUtils.createPolyControls(object, {
    cursorStyle: 'pointer',
    sizeX: 18,
    sizeY: 18,
    touchSizeX: 44,
    touchSizeY: 44,
  });

  if (kind === 'line') {
    object.controls = vertexControls;
    object.hasBorders = false;
  } else {
    const rotate = object.controls.mtr;

    object.controls = rotate ? { ...vertexControls, mtr: rotate } : vertexControls;
  }
  object.setCoords(); // keep the handle positions keyed like the new controls
}

/** Keep {@link SNAPPED_SHAPE_PROP} through `toJSON` (Fabric drops unlisted props). Idempotent. */
export function registerSnappedShapePersistence(): void {
  // `Path` too: a brush-swept snapped shape is one, and loses its kind on reload without it.
  for (const klass of [Polyline, Polygon, Ellipse, Path]) {
    const own = Object.prototype.hasOwnProperty.call(klass, 'customProperties') ? klass.customProperties : undefined;
    const current = own ?? klass.customProperties ?? [];

    if (!current.includes(SNAPPED_SHAPE_PROP)) {
      klass.customProperties = [...current, SNAPPED_SHAPE_PROP];
    }
  }

  // A radical's params regenerate it when stretched; without them it reloads as a frozen polyline.
  const polyline = Polyline.customProperties ?? [];

  if (!polyline.includes(RADICAL_PARAMS_PROP)) Polyline.customProperties = [...polyline, RADICAL_PARAMS_PROP];
}

/**
 * Wire snapped-shape persistence + handles onto a canvas. Returns the disposer.
 */
export function installSnappedShapeSupport(canvas: Canvas): () => void {
  registerSnappedShapePersistence();

  const onAdded = ({ target }: { target?: FabricObject }) => {
    if (target && (target as SnappedObject)[SNAPPED_SHAPE_PROP]) applySnappedShapeControls(target);
  };

  canvas.getObjects().forEach((object) => onAdded({ target: object }));

  return canvas.on('object:added', onAdded);
}
