/**
 * Shape styles — the board's take on a sketching app's shape panel: background colour with a fill
 * pattern (hatched / cross-hatched / solid), outline style (solid / dashed / dotted), sloppiness
 * (smooth / a little hand-drawn / very hand-drawn), edges (sharp / round) and opacity.
 *
 * STORED AS PLAIN OBJECT FIELDS. Fabric's own fields carry what they can (`fill`, `stroke`, `strokeWidth`,
 * `strokeDashArray`, `opacity`, a rectangle's `rx`/`ry`), so an older copy of the app opens a styled shape
 * as a plain one. Three optional fields add the rest; absent, they read as the old look:
 *
 *   wbFillStyle   'hatch' | 'cross' | 'solid'   absent → solid (every fill saved before this)
 *   wbRough       0 | 1 | 2                     absent → 0 (a clean outline)
 *   wbSeed        number                        the hand-drawn wobble's seed, so it never moves on redraw
 *   wbEdges       'round'                       absent → sharp (rectangles use `rx`/`ry` as well)
 *
 * PAINTED AT DRAW TIME, CHEAPLY. A hatch is a small pattern tile, drawn once per colour and kept; the
 * shape's own fill path is filled with it, so the lines sit exactly inside the outline. A hand-drawn
 * outline is computed once per shape (keyed on its size, seed and sloppiness) and kept on the object as a
 * `Path2D`; Fabric's object cache then keeps the pixels. Nothing is redone per frame.
 */

export type ShapeFillStyle = 'hatch' | 'cross' | 'solid';
export type ShapeDash = 'solid' | 'dashed' | 'dotted';
export type ShapeRough = 0 | 1 | 2;
export type ShapeEdges = 'sharp' | 'round';

export const FILL_STYLE_PROP = 'wbFillStyle';
export const ROUGH_PROP = 'wbRough';
export const SEED_PROP = 'wbSeed';
export const EDGES_PROP = 'wbEdges';
/** Marks the fill laid under hand-drawn ink (see `inkAreaFill.ts`). */
export const INK_FILL_PROP = 'wbInkFill';

export const SHAPE_STYLE_PROPS = [FILL_STYLE_PROP, ROUGH_PROP, SEED_PROP, EDGES_PROP, INK_FILL_PROP] as const;

/** Thin / medium / thick, in scene px. */
export const SHAPE_WIDTHS = [2, 4, 8] as const;

/** What the shape panel sets, and what a new shape is drawn with. */
export interface ShapeStyleSettings {
  stroke: string;
  /** A colour, or `transparent` for none. */
  fill: string;
  fillStyle: ShapeFillStyle;
  width: number;
  dash: ShapeDash;
  rough: ShapeRough;
  edges: ShapeEdges;
  /** 0–1. */
  opacity: number;
}

export const DEFAULT_SHAPE_STYLE: ShapeStyleSettings = {
  stroke: '#1F2937',
  fill: 'transparent',
  fillStyle: 'hatch',
  width: 4,
  dash: 'solid',
  rough: 0,
  edges: 'sharp',
  opacity: 1,
};

const SHAPE_STYLE_STORAGE_KEY = 'whiteboard-shape-style';

const FILL_STYLES: readonly ShapeFillStyle[] = ['hatch', 'cross', 'solid'];
const DASHES: readonly ShapeDash[] = ['solid', 'dashed', 'dotted'];

/** Reads the remembered shape settings; anything missing or malformed falls back to the default. */
export function parseShapeStyle(raw: string | null | undefined): ShapeStyleSettings {
  let value: Partial<ShapeStyleSettings> = {};

  try {
    value = raw ? (JSON.parse(raw) as Partial<ShapeStyleSettings>) : {};
  } catch {
    value = {};
  }

  const d = DEFAULT_SHAPE_STYLE;

  return {
    stroke: typeof value.stroke === 'string' && value.stroke ? value.stroke : d.stroke,
    fill: typeof value.fill === 'string' && value.fill ? value.fill : d.fill,
    fillStyle: FILL_STYLES.includes(value.fillStyle as ShapeFillStyle) ? (value.fillStyle as ShapeFillStyle) : d.fillStyle,
    width: typeof value.width === 'number' && value.width > 0 && value.width <= 64 ? value.width : d.width,
    dash: DASHES.includes(value.dash as ShapeDash) ? (value.dash as ShapeDash) : d.dash,
    rough: value.rough === 1 || value.rough === 2 ? value.rough : 0,
    edges: value.edges === 'round' ? 'round' : 'sharp',
    opacity: typeof value.opacity === 'number' && value.opacity >= 0.05 && value.opacity <= 1 ? value.opacity : d.opacity,
  };
}

export function readShapeStyle(): ShapeStyleSettings {
  try {
    return parseShapeStyle(typeof window === 'undefined' ? null : window.localStorage.getItem(SHAPE_STYLE_STORAGE_KEY));
  } catch {
    return DEFAULT_SHAPE_STYLE;
  }
}

export function writeShapeStyle(style: ShapeStyleSettings): void {
  try {
    window.localStorage.setItem(SHAPE_STYLE_STORAGE_KEY, JSON.stringify(style));
  } catch {
    // Private mode / storage full: the settings just are not remembered.
  }
}

/** The dash pattern for an outline style at a width (round caps: a dot is a zero-length dash). */
export function dashArrayForStyle(dash: ShapeDash, width: number): number[] | null {
  if (dash === 'dashed') return [width * 2.5, width * 2];
  if (dash === 'dotted') return [0.01, width * 2.2];

  return null;
}

/** The outline style a dash pattern was made by (for showing the current choice). */
export function dashOfArray(array: readonly number[] | null | undefined): ShapeDash {
  if (!array || array.length < 2) return 'solid';

  return array[0]! < 0.5 ? 'dotted' : 'dashed';
}

/** A rectangle's corner radius for «round» edges: a quarter of the short side, at most 32. */
export function roundCornerRadius(width: number, height: number): number {
  return Math.max(0, Math.min(32, Math.min(Math.abs(width), Math.abs(height)) * 0.25));
}

// --- Hand-drawn outline -------------------------------------------------------------------------

export interface Vec {
  x: number;
  y: number;
}

/** mulberry32: a tiny deterministic generator, so a seed always draws the same wobble. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const newRoughSeed = (): number => Math.floor(Math.random() * 2 ** 31) + 1;

/** How far (scene px) a hand-drawn line may stray from the true outline. */
export function roughAmplitude(rough: ShapeRough, strokeWidth: number): number {
  if (rough === 0) return 0;

  return (rough === 1 ? 1.2 : 2.6) + Math.min(strokeWidth, 12) * (rough === 1 ? 0.15 : 0.3);
}

/**
 * A hand-drawn version of an outline: every edge is drawn twice, each pass a gently bowed line whose
 * ends miss the corners by a little — the look of a quick pen sketch. Returns the passes as polylines
 * (scene units). Pure and deterministic for a given seed.
 */
export function roughOutline(points: readonly Vec[], closed: boolean, rough: ShapeRough, strokeWidth: number, seed: number): Vec[][] {
  if (rough === 0 || points.length < 2) return [points.slice()];

  const random = seededRandom(seed);
  const amp = roughAmplitude(rough, strokeWidth);
  const jitter = () => (random() * 2 - 1) * amp;
  const passes: Vec[][] = [];
  const count = closed ? points.length : points.length - 1;

  for (let pass = 0; pass < 2; pass += 1) {
    const line: Vec[] = [];

    for (let i = 0; i < count; i += 1) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);

      if (length < 1e-6) continue;

      const nx = -(b.y - a.y) / length;
      const ny = (b.x - a.x) / length;
      // A long edge bows a little more than a short one, never past the amplitude's double.
      const bow = jitter() * Math.min(2, 0.6 + length / 200);
      const start = { x: a.x + jitter(), y: a.y + jitter() };
      const end = { x: b.x + jitter(), y: b.y + jitter() };
      const steps = Math.max(2, Math.min(24, Math.ceil(length / 24)));

      for (let s = line.length === 0 || i === 0 ? 0 : 1; s <= steps; s += 1) {
        const t = s / steps;
        const lift = Math.sin(Math.PI * t) * bow;

        line.push({ x: start.x + (end.x - start.x) * t + nx * lift, y: start.y + (end.y - start.y) * t + ny * lift });
      }
    }

    if (line.length > 1) passes.push(line);
  }

  return passes;
}

/** An ellipse as a closed polygon (enough points that a hand-drawn pass still reads as round). */
export function ellipsePoints(rx: number, ry: number): Vec[] {
  const steps = Math.max(16, Math.min(64, Math.ceil((Math.abs(rx) + Math.abs(ry)) / 6)));

  return Array.from({ length: steps }, (_, i) => {
    const angle = (Math.PI * 2 * i) / steps;

    return { x: Math.cos(angle) * rx, y: Math.sin(angle) * ry };
  });
}

/**
 * A closed polygon with its corners rounded (each corner cut by an arc of up to `radius`, never past half
 * of either edge), as a polyline. Used for «round» edges on drawn polygons.
 */
export function roundedPolygon(points: readonly Vec[], radius: number): Vec[] {
  if (points.length < 3 || radius <= 0) return points.slice();

  const out: Vec[] = [];

  for (let i = 0; i < points.length; i += 1) {
    const prev = points[(i - 1 + points.length) % points.length]!;
    const at = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const toPrev = { x: prev.x - at.x, y: prev.y - at.y };
    const toNext = { x: next.x - at.x, y: next.y - at.y };
    const lp = Math.hypot(toPrev.x, toPrev.y);
    const ln = Math.hypot(toNext.x, toNext.y);

    if (lp < 1e-6 || ln < 1e-6) {
      out.push(at);
      continue;
    }

    const r = Math.min(radius, lp / 2, ln / 2);
    const a = { x: at.x + (toPrev.x / lp) * r, y: at.y + (toPrev.y / lp) * r };
    const b = { x: at.x + (toNext.x / ln) * r, y: at.y + (toNext.y / ln) * r };

    // A quadratic through the corner: close to an arc, cheap, and exactly tangent to both edges.
    for (let s = 0; s <= 6; s += 1) {
      const t = s / 6;
      const u = 1 - t;

      out.push({ x: u * u * a.x + 2 * u * t * at.x + t * t * b.x, y: u * u * a.y + 2 * u * t * at.y + t * t * b.y });
    }
  }

  return out;
}
