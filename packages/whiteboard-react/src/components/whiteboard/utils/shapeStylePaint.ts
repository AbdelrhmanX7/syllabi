import { BaseFabricObject, Ellipse, FabricObject, Line, Path, Polygon, Polyline, Rect, Triangle } from 'fabric';

import { isRenderingDarkBoard } from './darkBoard';
import { darkBoardFillColor, hatchLineColor } from './inkContrast';
import {
  dashArrayForStyle,
  EDGES_PROP,
  ellipsePoints,
  FILL_STYLE_PROP,
  INK_FILL_PROP,
  newRoughSeed,
  ROUGH_PROP,
  roughAmplitude,
  roughOutline,
  roundCornerRadius,
  roundedPolygon,
  SEED_PROP,
  SHAPE_STYLE_PROPS,
} from './shapeStyle';

import type { ShapeEdges, ShapeFillStyle, ShapeRough, ShapeStyleSettings, Vec } from './shapeStyle';

/**
 * The Fabric half of shape styles (see `shapeStyle.ts`): keeps the new fields through save / undo, and
 * paints hatches, hand-drawn outlines and rounded polygon corners. Installed once; idempotent.
 */

type Styled = FabricObject & {
  wbFillStyle?: ShapeFillStyle;
  wbRough?: ShapeRough;
  wbSeed?: number;
  wbEdges?: ShapeEdges;
  wbInkFill?: boolean;
  __wbRoughKey?: string;
  __wbRoughPath?: Path2D | null;
};

type Klass = { customProperties?: string[]; cacheProperties?: string[] };

const SHAPE_CLASSES: Klass[] = [FabricObject, Rect, Ellipse, Triangle, Line, Polyline, Polygon, Path] as unknown as Klass[];

let registered = false;

/** Keep the style fields through `toJSON` (Fabric drops unlisted ones) and repaint a cache when they change. */
export function registerShapeStyleProps(): void {
  if (registered) return;
  registered = true;

  const base = BaseFabricObject as unknown as Klass;

  base.customProperties = [...new Set([...(base.customProperties ?? []), ...SHAPE_STYLE_PROPS])];

  for (const klass of SHAPE_CLASSES) {
    // A class may own its list (shape snap and auto-colour give `Path` and the polylines one); undo's
    // change check reads the class's own list, so the fields go there too.
    if (Object.prototype.hasOwnProperty.call(klass, 'customProperties')) {
      klass.customProperties = [...new Set([...(klass.customProperties ?? []), ...SHAPE_STYLE_PROPS])];
    }

    if (Object.prototype.hasOwnProperty.call(klass, 'cacheProperties')) {
      klass.cacheProperties = [...new Set([...(klass.cacheProperties ?? []), FILL_STYLE_PROP, ROUGH_PROP, SEED_PROP, EDGES_PROP])];
    }
  }
}

// --- Hatch tiles ------------------------------------------------------------------------------------

const HATCH_TILE = 12;
const tileCache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();

function makeTile(color: string, style: 'hatch' | 'cross'): HTMLCanvasElement | OffscreenCanvas | null {
  const key = `${style}|${color}`;
  const cached = tileCache.get(key);

  if (cached) return cached;

  let tile: HTMLCanvasElement | OffscreenCanvas | null = null;

  if (typeof document !== 'undefined') {
    tile = document.createElement('canvas');
    tile.width = HATCH_TILE;
    tile.height = HATCH_TILE;
  } else if (typeof OffscreenCanvas !== 'undefined') {
    tile = new OffscreenCanvas(HATCH_TILE, HATCH_TILE);
  }

  const ctx = tile?.getContext('2d') as CanvasRenderingContext2D | null | undefined;

  if (!tile || !ctx) return null;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineCap = 'square';
  ctx.beginPath();
  // One diagonal across the tile, plus the corner pieces, so the lines join seamlessly when repeated.
  ctx.moveTo(0, HATCH_TILE);
  ctx.lineTo(HATCH_TILE, 0);
  ctx.moveTo(-HATCH_TILE / 2, HATCH_TILE / 2);
  ctx.lineTo(HATCH_TILE / 2, -HATCH_TILE / 2);
  ctx.moveTo(HATCH_TILE / 2, HATCH_TILE * 1.5);
  ctx.lineTo(HATCH_TILE * 1.5, HATCH_TILE / 2);

  if (style === 'cross') {
    ctx.moveTo(0, 0);
    ctx.lineTo(HATCH_TILE, HATCH_TILE);
    ctx.moveTo(-HATCH_TILE / 2, HATCH_TILE / 2);
    ctx.lineTo(HATCH_TILE / 2, HATCH_TILE * 1.5);
    ctx.moveTo(HATCH_TILE / 2, -HATCH_TILE / 2);
    ctx.lineTo(HATCH_TILE * 1.5, HATCH_TILE / 2);
  }

  ctx.stroke();

  if (tileCache.size > 64) tileCache.clear();
  tileCache.set(key, tile);

  return tile;
}

// --- Outlines (object space) ------------------------------------------------------------------------

/** The object's outline in its own (centred) space, and whether it is closed; null for anything else. */
export function shapeOutline(object: FabricObject): { points: Vec[]; closed: boolean } | null {
  const o = object as Styled;

  if (object instanceof Rect) {
    const w = object.width;
    const h = object.height;
    const corners = [
      { x: -w / 2, y: -h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 },
      { x: -w / 2, y: h / 2 },
    ];
    const r = Math.min(object.rx || 0, object.ry || 0);

    return { points: r > 0 ? roundedPolygon(corners, r) : corners, closed: true };
  }

  if (object instanceof Ellipse) return { points: ellipsePoints(object.rx, object.ry), closed: true };

  if (object instanceof Triangle) {
    const w = object.width;
    const h = object.height;

    return { points: [{ x: -w / 2, y: h / 2 }, { x: 0, y: -h / 2 }, { x: w / 2, y: h / 2 }], closed: true };
  }

  if (object instanceof Polyline) {
    const offset = object.pathOffset;
    const points = object.points.map((point) => ({ x: point.x - offset.x, y: point.y - offset.y }));
    const closed = !(object as unknown as { isOpen(): boolean }).isOpen();

    return {
      points: closed && o.wbEdges === 'round' ? roundedPolygon(points, roundCornerRadius(object.width, object.height)) : points,
      closed,
    };
  }

  if (object instanceof Line) {
    const p = object.calcLinePoints();

    return {
      points: [
        { x: p.x1, y: p.y1 },
        { x: p.x2, y: p.y2 },
      ],
      closed: false,
    };
  }

  return null;
}

function roughPathOf(object: Styled): Path2D | null {
  const rough = object.wbRough ?? 0;

  if (!rough || typeof Path2D === 'undefined') return null;

  const outline = shapeOutline(object);

  if (!outline) return null;

  const seed = object.wbSeed ?? 1;
  const key = `${rough}|${seed}|${object.strokeWidth}|${outline.closed}|${outline.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}`;

  if (object.__wbRoughKey === key && object.__wbRoughPath !== undefined) return object.__wbRoughPath;

  const path = new Path2D();

  for (const pass of roughOutline(outline.points, outline.closed, rough, object.strokeWidth, seed)) {
    pass.forEach((point, index) => (index === 0 ? path.moveTo(point.x, point.y) : path.lineTo(point.x, point.y)));
  }

  object.__wbRoughKey = key;
  object.__wbRoughPath = path;

  return path;
}

// --- Paint patch ------------------------------------------------------------------------------------

let installed = false;

export function installShapeStylePaint(): void {
  registerShapeStyleProps();

  if (installed) return;
  installed = true;

  const proto = FabricObject.prototype as unknown as {
    _renderFill(this: Styled, ctx: CanvasRenderingContext2D): void;
    _renderStroke(this: Styled, ctx: CanvasRenderingContext2D): void;
    _getCacheCanvasDimensions(this: Styled): { width: number; height: number; zoomX: number; zoomY: number; x: number; y: number };
  };
  const renderFill = proto._renderFill;
  const renderStroke = proto._renderStroke;
  const cacheDims = proto._getCacheCanvasDimensions;

  proto._renderFill = function styledFill(ctx) {
    const style = this.wbFillStyle;

    if (!style || typeof this.fill !== 'string' || !this.fill || this.fill === 'transparent') {
      renderFill.call(this, ctx);

      return;
    }

    const dark = isRenderingDarkBoard();

    ctx.save();

    if (style === 'solid') {
      ctx.fillStyle = dark ? darkBoardFillColor(this.fill) : this.fill;
    } else {
      const tile = makeTile(hatchLineColor(this.fill, dark), style);
      const pattern = tile ? ctx.createPattern(tile as CanvasImageSource, 'repeat') : null;

      if (!pattern) {
        ctx.restore();
        renderFill.call(this, ctx);

        return;
      }

      // Stretching a shape must not stretch its hatch: undo the object's own scale on the pattern.
      const sx = this.scaleX || 1;
      const sy = this.scaleY || 1;

      if ((sx !== 1 || sy !== 1) && typeof DOMMatrix !== 'undefined' && typeof pattern.setTransform === 'function') {
        pattern.setTransform(new DOMMatrix([1 / sx, 0, 0, 1 / sy, 0, 0]));
      }

      ctx.fillStyle = pattern;
    }

    if ((this as unknown as { fillRule?: string }).fillRule === 'evenodd') ctx.fill('evenodd');
    else ctx.fill();
    ctx.restore();
  };

  proto._renderStroke = function styledStroke(ctx) {
    const path = this.wbRough && this.stroke && this.strokeWidth ? roughPathOf(this) : null;

    if (!path) {
      renderStroke.call(this, ctx);

      return;
    }

    ctx.save();

    if (this.strokeUniform) {
      const scaling = this.getObjectScaling();

      ctx.scale(1 / scaling.x, 1 / scaling.y);
    }

    (this as unknown as { _setLineDash(c: CanvasRenderingContext2D, d: number[] | null): void })._setLineDash(ctx, this.strokeDashArray);
    (this as unknown as { _setStrokeStyles(c: CanvasRenderingContext2D, d: FabricObject): void })._setStrokeStyles(ctx, this);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.restore();
  };

  // A hand-drawn outline strays past the true box; widen the object's cache canvas so it is never cut.
  proto._getCacheCanvasDimensions = function paddedCacheDims() {
    const dims = cacheDims.call(this);
    const rough = this.wbRough ?? 0;

    if (!rough) return dims;

    const pad = roughAmplitude(rough, this.strokeWidth || 0) * 2 + 2;
    const padX = Math.ceil(pad * 2 * dims.zoomX);
    const padY = Math.ceil(pad * 2 * dims.zoomY);

    return { ...dims, width: dims.width + padX, height: dims.height + padY, x: dims.x + padX, y: dims.y + padY };
  };

  // Round edges on a drawn polygon (a hold-snapped rectangle, a triangle): trace the rounded outline.
  const polylineProto = Polyline.prototype as unknown as {
    _render(this: Styled & Polyline, ctx: CanvasRenderingContext2D): void;
    _renderPaintInOrder(ctx: CanvasRenderingContext2D): void;
  };
  const renderPolyline = polylineProto._render;

  polylineProto._render = function roundedPolyline(ctx) {
    if (this.wbEdges !== 'round' || (this as unknown as { isOpen(): boolean }).isOpen() || this.points.length < 3) {
      renderPolyline.call(this, ctx);

      return;
    }

    const outline = shapeOutline(this);

    if (!outline) {
      renderPolyline.call(this, ctx);

      return;
    }

    ctx.beginPath();
    outline.points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
    ctx.closePath();
    polylineProto._renderPaintInOrder.call(this, ctx);
  };
}

// --- Applying a style -------------------------------------------------------------------------------

/** A drawn shape (rectangle, ellipse, triangle, polygon, polyline, line / arrow) — not ink, text or a picture. */
export function isStyledShape(object: FabricObject): boolean {
  return (
    object instanceof Rect ||
    object instanceof Ellipse ||
    object instanceof Triangle ||
    object instanceof Polyline ||
    object instanceof Line ||
    (object.type ?? '').toLowerCase() === 'arrow'
  );
}

/** A shape that encloses an area, so it can take a background. */
export function isClosedShape(object: FabricObject): boolean {
  if (object instanceof Rect || object instanceof Ellipse || object instanceof Triangle) return true;
  if (object instanceof Polyline) return !(object as unknown as { isOpen(): boolean }).isOpen();

  return false;
}

export type ShapeStylePatch = Partial<ShapeStyleSettings>;

/**
 * Applies the parts of `patch` that fit this object, in place. Returns 1 when anything changed.
 * Opacity fits any object; background and fill pattern a closed shape (or the fill under ink); outline,
 * sloppiness and edges a drawn shape.
 */
export function applyShapeStyle(object: FabricObject, patch: ShapeStylePatch): number {
  const o = object as Styled;
  const before = JSON.stringify([o.fill, o.wbFillStyle, o.stroke, o.strokeWidth, o.strokeDashArray, o.wbRough, o.wbEdges, o.opacity, (o as Rect).rx]);

  if (patch.opacity !== undefined) o.set('opacity', patch.opacity);

  const fillable = isClosedShape(object) || o.wbInkFill === true;

  if (fillable && patch.fill !== undefined) {
    const none = !patch.fill || patch.fill === 'transparent';

    o.set('fill', none ? '' : patch.fill);
  }

  if (fillable && patch.fillStyle !== undefined) {
    // Absent = solid, so a solid fill writes nothing new into the saved page.
    o.set(FILL_STYLE_PROP as never, (patch.fillStyle === 'solid' ? undefined : patch.fillStyle) as never);
  }

  if (isStyledShape(object) && !o.wbInkFill) {
    if (patch.stroke !== undefined) o.set('stroke', patch.stroke);
    if (patch.width !== undefined) {
      const dash = o.strokeDashArray && o.strokeDashArray.length >= 2 ? (o.strokeDashArray[0]! < 0.5 ? 'dotted' : 'dashed') : 'solid';

      o.set('strokeWidth', patch.width);
      o.set('strokeDashArray', dashArrayForStyle(dash, patch.width));
    }
    if (patch.dash !== undefined) o.set('strokeDashArray', dashArrayForStyle(patch.dash, o.strokeWidth || 1));
    if (patch.dash === 'dotted' || (patch.dash === undefined && o.strokeDashArray?.[0] !== undefined && o.strokeDashArray[0] < 0.5)) {
      o.set('strokeLineCap', 'round');
    }
    if (patch.rough !== undefined) {
      o.set(ROUGH_PROP as never, (patch.rough === 0 ? undefined : patch.rough) as never);
      if (patch.rough !== 0 && !o.wbSeed) o.set(SEED_PROP as never, newRoughSeed() as never);
    }
    if (patch.edges !== undefined && isClosedShape(object)) {
      o.set(EDGES_PROP as never, (patch.edges === 'round' ? 'round' : undefined) as never);

      if (object instanceof Rect) {
        const r = patch.edges === 'round' ? roundCornerRadius(object.width, object.height) : 0;

        object.set({ rx: r, ry: r });
      }
    }
  }

  const after = JSON.stringify([o.fill, o.wbFillStyle, o.stroke, o.strokeWidth, o.strokeDashArray, o.wbRough, o.wbEdges, o.opacity, (o as Rect).rx]);

  if (before === after) return 0;

  o.__wbRoughKey = undefined;
  o.set('dirty', true);

  return 1;
}

/** The style a new shape is drawn with, as Fabric options plus the style fields. */
export function newShapeOptions(style: ShapeStyleSettings, closed: boolean): Record<string, unknown> {
  const none = !style.fill || style.fill === 'transparent';

  return {
    stroke: style.stroke,
    strokeWidth: style.width,
    strokeDashArray: dashArrayForStyle(style.dash, style.width),
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    opacity: style.opacity,
    fill: closed && !none ? style.fill : '',
    [FILL_STYLE_PROP]: closed && !none && style.fillStyle !== 'solid' ? style.fillStyle : undefined,
    [ROUGH_PROP]: style.rough || undefined,
    [SEED_PROP]: style.rough ? newRoughSeed() : undefined,
    [EDGES_PROP]: closed && style.edges === 'round' ? 'round' : undefined,
  };
}

/** Reads an object's style back for the panel (fields it does not have are left out). */
export function styleOfObject(object: FabricObject): ShapeStylePatch {
  const o = object as Styled;
  const out: ShapeStylePatch = { opacity: o.opacity ?? 1 };

  if (isClosedShape(object) || o.wbInkFill) {
    out.fill = typeof o.fill === 'string' && o.fill ? o.fill : 'transparent';
    out.fillStyle = o.wbFillStyle ?? 'solid';
  }

  if (isStyledShape(object)) {
    if (typeof o.stroke === 'string') out.stroke = o.stroke;
    out.width = o.strokeWidth;
    out.dash = !o.strokeDashArray || o.strokeDashArray.length < 2 ? 'solid' : o.strokeDashArray[0]! < 0.5 ? 'dotted' : 'dashed';
    out.rough = o.wbRough ?? 0;
    out.edges = o.wbEdges === 'round' || ((object as Rect).rx ?? 0) > 0 ? 'round' : 'sharp';
  }

  return out;
}

export const isInkAreaFill = (object: unknown): boolean => (object as { [INK_FILL_PROP]?: boolean } | null)?.[INK_FILL_PROP] === true;
