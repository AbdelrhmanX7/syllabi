import { Point, util } from 'fabric';

import type { Canvas, Circle, Ellipse, FabricObject, Group, Line, Path, Polyline, TMat2D } from 'fabric';

import type { Vec } from './eraserGeometry';
import { distancePointToSegment, ellipsePoints, flattenPath, pointInPolygon } from './eraserGeometry';
import { polygonTakesRect } from './selectionClipboard';

/**
 * The select tool's hit tests, by what is PAINTED rather than by bounding box.
 *
 * Fabric's own target find asks "is the point inside the object's box?" and takes the topmost yes —
 * for a pen stroke that box is the whole rectangle the stroke spans, so a tap in the empty bend of a
 * curve selected it, a tap on a word written inside a drawn circle selected the circle, and where
 * several strokes' boxes overlap (every line of handwriting) the topmost box won whatever was under the
 * pen. Here each stroke or outline shape is reduced to the polyline it paints, in scene space — the
 * same reduction the object eraser uses (`eraserHitTest`):
 *
 *   tap      the object whose paint is NEAREST the point, within a pointer-sized tolerance (pen 12 px,
 *            finger 14 px, mouse 6 px, in screen px); a stroke's or a hollow shape's paint is its
 *            outline, half a stroke width thick; a filled path or shape also paints its inside; an
 *            image, text or sticky note paints its box. Ties go to the one on top;
 *   lasso    most of the stroke's sampled points (≥ 60%, {@link INSIDE_FRACTION}) are inside the loop —
 *            Samsung Notes' rule, so a loop around a word never grabs the underline crossing it;
 *   box      the same rule with the dragged rectangle as the polygon.
 *
 * Cost. The select tool runs the tap test on every hover move (a hovering S Pen streams them), over
 * every object on the page. The broad phase is Fabric's cached corner coords (`aCoords`) — four point
 * compares per object, no matrix, no allocation — so only the handful of objects near the pointer get
 * their geometry, and that geometry is cached per object (source + transform compared field by field).
 */

/** Screen-px reach of a tap, by pointer: generous for a finger and a pen, tight for a mouse. */
export const TAP_TOLERANCE_PX = { pen: 12, touch: 14, mouse: 6 } as const;

/** Share of a stroke's sampled points that must lie inside a lasso or box for the stroke to be taken. */
export const INSIDE_FRACTION = 0.6;

/** Arc-length step between samples along a stroke, scene px, and the cap on samples per stroke. */
const SAMPLE_SPACING_SCENE = 4;
const MAX_SAMPLES_PER_STROKE = 200;

export function tapTolerancePx(pointerType: string | undefined): number {
  if (pointerType === 'pen') return TAP_TOLERANCE_PX.pen;
  if (pointerType === 'touch') return TAP_TOLERANCE_PX.touch;

  return TAP_TOLERANCE_PX.mouse;
}

export interface SceneBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What a stroke or outline shape paints, in scene space. */
export interface StrokeGeometry {
  /** One polyline per sub-path, already transformed by the object's full matrix (group nesting included). */
  polylines: Vec[][];
  /** Half the painted stroke width, scene px (0 for a filled outline with no stroke). */
  halfStroke: number;
  /** A filled path or shape: its inside is paint too. */
  filled: boolean;
  /** A polygon, a shape outline or a `Z`-closed path: the last→first edge is paint. */
  closed: boolean;
  /** Axis-aligned bounds of the polylines, NOT inflated by the stroke width. */
  bounds: SceneBounds;
}

interface GeometryCacheEntry {
  matrix: TMat2D;
  source: unknown;
  strokeWidth: number;
  strokeUniform: boolean;
  fill: unknown;
  geometry: StrokeGeometry | null;
}

const geometryCache = new WeakMap<FabricObject, GeometryCacheEntry>();

export function isPathOnlyGroup(group: Group): boolean {
  const children = group.getObjects();

  return children.length > 0 && children.every((child) => child.isType('Path') || (child.isType('Group') && isPathOnlyGroup(child as Group)));
}

/** Types whose paint is a polyline outline (plus their inside when filled), not their box. */
const OUTLINE_TYPES = ['Path', 'Polyline', 'Polygon', 'Line', 'Rect', 'Ellipse', 'Circle', 'Triangle'] as const;

/** A stroke- or outline-shaped object, or a group made only of paths (a traced word). */
export function isStrokeLike(obj: FabricObject): boolean {
  return obj.isType(...OUTLINE_TYPES) || (obj.isType('Group') && isPathOnlyGroup(obj as Group));
}

function isVisibleFill(fill: FabricObject['fill']): boolean {
  if (fill == null) return false;
  if (typeof fill !== 'string') return true;

  const normalized = fill.trim().toLowerCase();

  return normalized !== '' && normalized !== 'transparent' && normalized !== 'none' && !/^(rgba|hsla)\([^)]*,\s*0(\.0+)?\s*\)$/.test(normalized);
}

function boundsOf(polylines: readonly Vec[][]): SceneBounds {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const polyline of polylines) {
    for (const p of polyline) {
      if (p.x < left) left = p.x;
      if (p.x > right) right = p.x;
      if (p.y < top) top = p.y;
      if (p.y > bottom) bottom = p.y;
    }
  }

  return { left, top, right, bottom };
}

/**
 * What the object's outline is built from, compared by identity (a path's command list, a polyline's
 * point list) or element by element (a shape's dimensions) — no strings, no allocation for the first two.
 */
function outlineSource(obj: FabricObject): unknown {
  if (obj.isType('Path')) return (obj as Path).path;
  if (obj.isType('Polyline', 'Polygon')) return (obj as Polyline).points;
  if (obj.isType('Line')) {
    const line = obj as Line;

    return [line.x1, line.y1, line.x2, line.y2];
  }
  if (obj.isType('Ellipse')) return [(obj as Ellipse).rx, (obj as Ellipse).ry];
  if (obj.isType('Circle')) {
    const circle = obj as Circle;

    return [circle.radius, circle.startAngle, circle.endAngle];
  }
  if (obj.isType('Rect', 'Triangle')) return [obj.width, obj.height];

  return null;
}

function sameSource(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;

  return a.every((value, index) => typeof value === 'number' && value === b[index]);
}

function sameMatrix(a: TMat2D, b: TMat2D): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5];
}

/** Arc of a circle from `start` to `end` degrees (Fabric's convention), as points. */
function arcPoints(radius: number, startDeg: number, endDeg: number, steps = 32): Vec[] {
  const start = (startDeg * Math.PI) / 180;
  const sweep = (((endDeg - startDeg) % 360) + 360) % 360 || 360;
  const count = Math.max(2, Math.ceil((steps * sweep) / 360));
  const points: Vec[] = [];

  for (let index = 0; index <= count; index += 1) {
    const angle = start + ((sweep * Math.PI) / 180) * (index / count);

    points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }

  return points;
}

/** Raw (untransformed, object-space) polylines of a stroke- or outline-shaped object. */
function rawPolylines(obj: FabricObject): { polylines: Vec[][]; closed: boolean } | null {
  if (obj.isType('Path')) {
    const { path, pathOffset } = obj as Path;
    const polylines = flattenPath(path as never).map((polyline) => polyline.map((p) => ({ x: p.x - pathOffset.x, y: p.y - pathOffset.y })));
    const closed = (path as ReadonlyArray<ReadonlyArray<string | number>>).some((command) => command[0] === 'Z' || command[0] === 'z');

    return { polylines, closed };
  }

  if (obj.isType('Polyline', 'Polygon')) {
    const { points, pathOffset } = obj as Polyline;

    return { polylines: [points.map((p) => ({ x: p.x - pathOffset.x, y: p.y - pathOffset.y }))], closed: obj.isType('Polygon') };
  }

  if (obj.isType('Line')) {
    const { x1, y1, x2, y2 } = (obj as Line).calcLinePoints();

    return { polylines: [[{ x: x1, y: y1 }, { x: x2, y: y2 }]], closed: false };
  }

  if (obj.isType('Ellipse')) {
    const { rx, ry } = obj as Ellipse;

    return { polylines: [ellipsePoints(rx, ry)], closed: true };
  }

  if (obj.isType('Circle')) {
    const { radius, startAngle = 0, endAngle = 360 } = obj as Circle;
    const full = Math.abs(endAngle - startAngle) >= 360 || (((endAngle - startAngle) % 360) + 360) % 360 === 0;

    return full ? { polylines: [ellipsePoints(radius, radius)], closed: true } : { polylines: [arcPoints(radius, startAngle, endAngle)], closed: false };
  }

  if (obj.isType('Rect')) {
    const halfWidth = obj.width / 2;
    const halfHeight = obj.height / 2;

    return {
      polylines: [
        [
          { x: -halfWidth, y: -halfHeight },
          { x: halfWidth, y: -halfHeight },
          { x: halfWidth, y: halfHeight },
          { x: -halfWidth, y: halfHeight },
        ],
      ],
      closed: true,
    };
  }

  if (obj.isType('Triangle')) {
    const halfWidth = obj.width / 2;
    const halfHeight = obj.height / 2;

    return {
      polylines: [
        [
          { x: -halfWidth, y: halfHeight },
          { x: 0, y: -halfHeight },
          { x: halfWidth, y: halfHeight },
        ],
      ],
      closed: true,
    };
  }

  return null;
}

/**
 * The object's painted outline in scene space, or null for anything that paints its box (an image,
 * text, a sticky note, a mixed group…). Cached per object and rebuilt only when its outline source,
 * transform, stroke width or fill changed — a hover sweep pays a few compares per candidate, never a
 * re-flatten.
 */
export function strokeGeometryOf(obj: FabricObject): StrokeGeometry | null {
  const source = outlineSource(obj);

  if (source === null) return null;

  const matrix = obj.calcTransformMatrix();
  const strokeWidth = obj.stroke ? obj.strokeWidth ?? 0 : 0;
  const strokeUniform = Boolean(obj.strokeUniform);
  const cached = geometryCache.get(obj);

  if (
    cached &&
    cached.strokeWidth === strokeWidth &&
    cached.strokeUniform === strokeUniform &&
    cached.fill === obj.fill &&
    sameMatrix(cached.matrix, matrix) &&
    sameSource(cached.source, source)
  ) {
    return cached.geometry;
  }

  const raw = rawPolylines(obj);
  let geometry: StrokeGeometry | null = null;

  if (raw) {
    const toScene = (p: Vec): Vec => util.transformPoint(new Point(p.x, p.y), matrix);
    const { scaleX, scaleY } = util.qrDecompose(matrix);
    const strokeScale = strokeUniform ? 1 : Math.max(Math.abs(scaleX), Math.abs(scaleY));
    const polylines = raw.polylines.map((polyline) => polyline.map(toScene));

    geometry = {
      polylines,
      halfStroke: (strokeWidth * strokeScale) / 2,
      filled: isVisibleFill(obj.fill),
      closed: raw.closed,
      bounds: boundsOf(polylines),
    };
  }

  geometryCache.set(obj, { matrix: [...matrix] as TMat2D, source, strokeWidth, strokeUniform, fill: obj.fill, geometry });

  return geometry;
}

/**
 * Is `p` (scene) certainly farther than `reach` from the object's box? Read from Fabric's CACHED corners
 * — no `setCoords`, no allocation for a top-level object: the broad phase of every hover move must stay
 * a few compares per object. Fabric refreshes `aCoords` whenever an object is added, moved, scaled or
 * rotated. They are in the PARENT's plane, so a member of a group or a multi-selection goes through
 * `getCoords()`, which maps them to the scene.
 */
function outsideCachedBox(obj: FabricObject, p: Vec, reach: number): boolean {
  const own = (obj as unknown as { aCoords?: Record<'tl' | 'tr' | 'bl' | 'br', Vec> }).aCoords;

  if (!own) return false;

  let tl: Vec = own.tl;
  let tr: Vec = own.tr;
  let bl: Vec = own.bl;
  let br: Vec = own.br;

  if (obj.group) [tl, tr, br, bl] = obj.getCoords() as unknown as [Vec, Vec, Vec, Vec];

  return (
    p.x < Math.min(tl.x, tr.x, bl.x, br.x) - reach ||
    p.x > Math.max(tl.x, tr.x, bl.x, br.x) + reach ||
    p.y < Math.min(tl.y, tr.y, bl.y, br.y) - reach ||
    p.y > Math.max(tl.y, tr.y, bl.y, br.y) + reach
  );
}

function pointNearBounds(p: Vec, bounds: SceneBounds, reach: number): boolean {
  return p.x >= bounds.left - reach && p.x <= bounds.right + reach && p.y >= bounds.top - reach && p.y <= bounds.bottom + reach;
}

function distanceToPolyline(p: Vec, polyline: readonly Vec[], closed: boolean): number {
  if (polyline.length === 0) return Number.POSITIVE_INFINITY;
  if (polyline.length === 1) return Math.hypot(p.x - polyline[0]!.x, p.y - polyline[0]!.y);

  let best = Number.POSITIVE_INFINITY;

  for (let index = 1; index < polyline.length; index += 1) {
    const d = distancePointToSegment(p, polyline[index - 1]!, polyline[index]!);

    if (d < best) best = d;
  }

  if (closed) {
    const d = distancePointToSegment(p, polyline[polyline.length - 1]!, polyline[0]!);

    if (d < best) best = d;
  }

  return best;
}

/**
 * How far `point` (scene) is from this object's paint, in scene px — 0 on (or inside filled) paint —
 * or null when it is farther than `tolerance`. A stroke and a hollow shape paint only their outline,
 * half a stroke width thick; a filled path or shape also its inside; a path-only group its children;
 * everything else its box.
 */
export function objectTapDistance(obj: FabricObject, point: Vec, tolerance: number, broadPhase = true): number | null {
  // A path-only group's children are judged by their own geometry below.
  if (broadPhase && outsideCachedBox(obj, point, tolerance)) return null;

  if (obj.isType('Group') && isPathOnlyGroup(obj as Group)) {
    let best: number | null = null;

    for (const child of (obj as Group).getObjects()) {
      const d = objectTapDistance(child, point, tolerance, false);

      if (d !== null && (best === null || d < best)) best = d;
    }

    return best;
  }

  const geometry = strokeGeometryOf(obj);

  if (!geometry) {
    const corners = obj.getCoords();

    if (pointInPolygon(point, corners)) return 0;

    const d = distanceToPolyline(point, corners, true);

    return d <= tolerance ? d : null;
  }

  if (!pointNearBounds(point, geometry.bounds, tolerance + geometry.halfStroke)) return null;

  let best = Number.POSITIVE_INFINITY;

  for (const polyline of geometry.polylines) {
    if (geometry.filled && polyline.length >= 3 && pointInPolygon(point, polyline)) return 0;

    const d = distanceToPolyline(point, polyline, geometry.closed) - geometry.halfStroke;

    if (d < best) best = d;
  }

  return best <= tolerance ? Math.max(0, best) : null;
}

/** Is `point` (scene) on this object's paint, within `tolerance` scene px? See {@link objectTapDistance}. */
export function objectHitsTap(obj: FabricObject, point: Vec, tolerance: number): boolean {
  return objectTapDistance(obj, point, tolerance) !== null;
}

/**
 * What a tap with the select tool picks: of the visible, evented objects whose paint is within
 * `tolerance` of `point`, the one whose paint is NEAREST — a word written inside a circle wins over the
 * circle, the stroke actually touched wins over its neighbours — with the one on top winning a tie.
 *
 * A SOLID object (an image, text, a sticky note: anything that paints its box, not an outline) answers
 * 0 anywhere inside it, so a press anywhere on a picture grabs the picture. Ink drawn OVER it keeps its
 * pointer-sized reach though: a stroke above within `tolerance` wins over the solid object under it —
 * except when that solid object is `active` (already selected), where only ink actually touched (0)
 * takes the press, so a drag inside a selected, annotated picture moves the picture.
 *
 * Objects that cannot be selected (a locked background image) only answer when nothing selectable
 * does, so they never shadow the ink drawn over them.
 */
export function pickTapTarget(
  objects: readonly FabricObject[],
  point: Vec,
  tolerance: number,
  active?: FabricObject | null,
): FabricObject | undefined {
  let best: FabricObject | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let fallback: FabricObject | undefined;

  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const obj = objects[index]!;

    if (!obj.visible || obj.evented === false) continue;

    if (obj.selectable === false) {
      if (!fallback && objectTapDistance(obj, point, tolerance) !== null) fallback = obj;
      continue;
    }

    const d = objectTapDistance(obj, point, tolerance);

    if (d === null) continue;

    if (d === 0 && best && !isStrokeLike(obj) && isStrokeLike(best)) {
      // Pressed inside a solid object with ink above it already within reach: the ink wins, unless this
      // is the selected object and the ink was not actually touched. Nothing below a solid object can
      // be seen, so the search ends here either way.
      if (obj === active && bestDistance > 0) best = obj;

      break;
    }

    if (d < bestDistance) {
      best = obj;
      bestDistance = d;

      // Right on its paint, on top of everything checked so far: nothing below can be nearer than 0,
      // and a tie goes to the one on top — stop here.
      if (d === 0) break;
    }
  }

  return best ?? fallback;
}

/**
 * Points spaced evenly along the stroke's painted polylines (every sub-path's ends included), at
 * roughly {@link SAMPLE_SPACING_SCENE} scene px, never more than {@link MAX_SAMPLES_PER_STROKE} in all.
 * A dot is its one point.
 */
export function strokeSamples(geometry: StrokeGeometry): Vec[] {
  let length = 0;

  for (const polyline of geometry.polylines) {
    for (let i = 1; i < polyline.length; i += 1) length += Math.hypot(polyline[i]!.x - polyline[i - 1]!.x, polyline[i]!.y - polyline[i - 1]!.y);
  }

  const spacing = Math.max(SAMPLE_SPACING_SCENE, length / MAX_SAMPLES_PER_STROKE);
  const samples: Vec[] = [];

  for (const polyline of geometry.polylines) {
    if (polyline.length === 0) continue;

    samples.push(polyline[0]!);

    let carry = spacing;

    for (let i = 1; i < polyline.length; i += 1) {
      const from = polyline[i - 1]!;
      const to = polyline[i]!;
      const segment = Math.hypot(to.x - from.x, to.y - from.y);
      let along = carry;

      while (along <= segment) {
        const t = along / segment;

        samples.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
        along += spacing;
      }

      carry = along - segment;
    }

    const last = polyline[polyline.length - 1]!;
    const tail = samples[samples.length - 1]!;

    if (polyline.length > 1 && (tail.x !== last.x || tail.y !== last.y)) samples.push(last);
  }

  return samples;
}

function polygonBounds(polygon: ReadonlyArray<Vec>): SceneBounds {
  return boundsOf([polygon as Vec[]]);
}

function boundsIntersect(a: SceneBounds, b: SceneBounds): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

/** Samples of every stroke in a path-only group, pooled — a word is taken when most of the WORD is inside. */
function groupSamples(group: Group): Vec[] {
  const samples: Vec[] = [];

  for (const child of group.getObjects()) {
    if (child.isType('Group') && isPathOnlyGroup(child as Group)) {
      samples.push(...groupSamples(child as Group));
      continue;
    }

    const geometry = strokeGeometryOf(child);

    if (geometry) samples.push(...strokeSamples(geometry));
  }

  return samples;
}

/**
 * Does the closed `polygon` (a lasso loop or a box's four corners, scene space) take this object? A
 * stroke when at least `minFraction` of its samples are inside; a path-only group likewise over all its
 * strokes; anything else by its box — centre inside, or three of four corners.
 */
export function objectInsidePolygon(obj: FabricObject, polygon: ReadonlyArray<Vec>, minFraction = INSIDE_FRACTION): boolean {
  if (polygon.length < 3) return false;

  const samples = obj.isType('Group') && isPathOnlyGroup(obj as Group) ? groupSamples(obj as Group) : (() => {
    // Shapes (rect, ellipse, circle, triangle) keep the box rule here: a loop around a shape takes it.
    const geometry = obj.isType('Path', 'Polyline', 'Polygon', 'Line') ? strokeGeometryOf(obj) : null;

    return geometry ? strokeSamples(geometry) : null;
  })();

  if (!samples) {
    const bounds = obj.getBoundingRect();

    return polygonTakesRect(polygon, { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
  }

  if (samples.length === 0) return false;

  let inside = 0;

  for (const sample of samples) {
    if (pointInPolygon(sample, polygon)) inside += 1;
  }

  return inside / samples.length >= minFraction;
}

/**
 * Every object of `objects` the polygon takes, in stack order. Broad phase: the object's scene box must
 * touch the polygon's box at all; the sample test runs only on those.
 */
export function objectsInsidePolygon(objects: readonly FabricObject[], polygon: ReadonlyArray<Vec>, minFraction = INSIDE_FRACTION): FabricObject[] {
  if (polygon.length < 3) return [];

  const reach = polygonBounds(polygon);

  return objects.filter((obj) => {
    const bounds = obj.getBoundingRect();

    if (!boundsIntersect(reach, { left: bounds.left, top: bounds.top, right: bounds.left + bounds.width, bottom: bounds.top + bounds.height })) return false;

    return objectInsidePolygon(obj, polygon, minFraction);
  });
}


// --- Fabric wiring ---------------------------------------------------------------------------------

interface TargetsInfo {
  target?: FabricObject;
  subTargets: FabricObject[];
}

interface FullTargetsInfo extends TargetsInfo {
  container?: FabricObject;
  currentTarget?: FabricObject;
  currentContainer?: FabricObject;
  currentSubTargets?: FabricObject[];
}

interface TargetFindingCanvas {
  _objects: FabricObject[];
  _activeObject?: FabricObject | null;
  findTarget: (e: Event) => FullTargetsInfo;
  _searchPossibleTargets: (objects: FabricObject[], pointer: Point, subTargets: FabricObject[]) => TargetsInfo;
  _checkTarget: (obj: FabricObject, pointer: Point) => boolean;
  getZoom: () => number;
  getViewportPoint: (e: Event) => Point;
}

interface InstallOptions {
  /** The pointer type of the gesture being resolved (tests inject it; the default follows real pointer events). */
  pointerType?: () => string | undefined;
}

function isCollection(obj: FabricObject): obj is FabricObject & { _objects: FabricObject[]; subTargetCheck?: boolean } {
  return Array.isArray((obj as unknown as { _objects?: unknown })._objects);
}

/** A member of a multi-selection: dragging it drags the selection, so it never steals the target. */
function isSelectionMember(active: FabricObject, obj: FabricObject): boolean {
  return isCollection(active) && active.isType('ActiveSelection') && active._objects.includes(obj);
}

/** How much farther than a tap's reach the SELECTED object still answers: a drag that starts near the ink moves it. */
export const SELECTED_GRAB_FACTOR = 2;

const paintGrabCanvases = new WeakSet<object>();

/**
 * Where the selection shows no frame (the modern, shape-hugging chrome), there is nothing to grab in the
 * empty corners of its box: the selected object then answers only near its own paint
 * ({@link SELECTED_GRAB_FACTOR} × the tap reach), and a press in empty space starts a new selection.
 * Returns the undo.
 */
export function setSelectionGrabsByPaint(canvas: Canvas, on = true): () => void {
  if (on) paintGrabCanvases.add(canvas);
  else paintGrabCanvases.delete(canvas);

  return () => {
    paintGrabCanvases.delete(canvas);
  };
}

/** Does a press at `point` (scene) grab the selected `active` object by its paint (a multi-selection by any member's)? */
export function selectionGrabbedByPaint(active: FabricObject, point: Vec, tolerance: number): boolean {
  const reach = tolerance * SELECTED_GRAB_FACTOR;
  const members = isCollection(active) && active.isType('ActiveSelection') ? active._objects : [active];

  return members.some((member) => member.visible !== false && objectTapDistance(member, point, reach) !== null);
}

/**
 * Make the canvas's target find (a tap or hover with the select tool) answer by paint:
 *
 * - The search over the page's objects (`_searchPossibleTargets` on `canvas._objects`, which every
 *   target find goes through) returns the object whose paint is NEAREST the pointer
 *   ({@link pickTapTarget}), with a pointer-sized tolerance in screen px divided by the zoom.
 * - The selected object keeps its box only as the last resort: a tap inside it that touches no ink
 *   still lands on it, so the selection drags from anywhere inside its frame, but ink of ANOTHER object
 *   inside that frame — a word inside a selected circle — is picked over it. Fabric's search of the
 *   selection alone (`[activeObject]`) and of a group's children keep Fabric's own test.
 * - A multi-selection makes Fabric return the selection for any tap inside its box; a tap on the ink
 *   of an object that is NOT in the selection is given that object instead.
 *
 * Returns the undo. Fabric here runs on mouse/touch events, not pointer events, so the pointer type is
 * read from the pointer events that precede them on `window` (a pen's compatibility mousedown follows
 * its pointerdown).
 */
export function installGeometryTargetFind(canvas: Canvas, options: InstallOptions = {}): () => void {
  const c = canvas as unknown as TargetFindingCanvas;
  const originalFindTarget = c.findTarget;
  const originalSearch = c._searchPossibleTargets;
  let lastPointerType: string | undefined;
  let gesturePointerType: string | undefined;
  const readPointerType = options.pointerType ?? (() => lastPointerType);
  const notePointer = (event: Event) => {
    lastPointerType = (event as PointerEvent).pointerType || lastPointerType;
  };

  if (!options.pointerType && typeof window !== 'undefined') {
    window.addEventListener('pointerdown', notePointer, { capture: true, passive: true });
    window.addEventListener('pointermove', notePointer, { capture: true, passive: true });
  }

  const grabsByPaint = () => paintGrabCanvases.has(canvas);

  c._searchPossibleTargets = function searchByPaint(this: TargetFindingCanvas, objects: FabricObject[], pointer: Point, subTargets: FabricObject[]) {
    const tolerance = tapTolerancePx(gesturePointerType) / (this.getZoom() || 1);
    const active = this._activeObject;

    // Fabric's own "is the pointer over the selection?" check: a frameless selection answers by its paint.
    if (objects !== this._objects) {
      if (active && objects.length === 1 && objects[0] === active && grabsByPaint()) {
        return selectionGrabbedByPaint(active, pointer, tolerance) ? { target: active, subTargets } : { subTargets: [] };
      }

      return originalSearch.call(this, objects, pointer, subTargets);
    }

    let target = pickTapTarget(objects, pointer, tolerance, active);

    // Nothing painted under the pointer: inside the selected object's frame still grabs it — or, with
    // no frame drawn, near its paint.
    if (!target && active && objects.includes(active)) {
      if (grabsByPaint() ? selectionGrabbedByPaint(active, pointer, tolerance) : this._checkTarget(active, pointer)) target = active;
    }

    if (!target) return { subTargets: [] };

    if (isCollection(target) && target.subTargetCheck) {
      const { target: subTarget } = originalSearch.call(this, target._objects, pointer, subTargets);

      if (subTarget) subTargets.push(subTarget);
    }

    return { target, subTargets };
  };

  c.findTarget = function findTargetByPaint(this: TargetFindingCanvas, e: Event) {
    gesturePointerType = e && 'touches' in e ? 'touch' : readPointerType();

    const info = originalFindTarget.call(this, e);
    const active = this._activeObject;
    const touched = info?.currentTarget;

    if (active && info.target === active && touched && touched !== active && !isSelectionMember(active, touched)) {
      const isTouch = 'touches' in e || (e as PointerEvent).pointerType === 'touch';
      const control = active.findControl(this.getViewportPoint(e), isTouch);

      // A handle under the pointer always belongs to the selection.
      if (!control) {
        return { ...info, target: touched, container: info.currentContainer ?? touched, subTargets: info.currentSubTargets ?? [] };
      }
    }

    return info;
  };

  return () => {
    c.findTarget = originalFindTarget;
    c._searchPossibleTargets = originalSearch;

    if (!options.pointerType && typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', notePointer, { capture: true });
      window.removeEventListener('pointermove', notePointer, { capture: true });
    }
  };
}
