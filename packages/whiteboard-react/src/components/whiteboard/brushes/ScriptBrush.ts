import { Path } from 'fabric';

import type { PencilBrush, Point, TEvent } from 'fabric';

import type { StrokeSmootherOptions } from './strokeSmoothing';

import { LowLatencyPencilBrush } from './LowLatencyPencilBrush';
import { markInkPen } from './inkPenMark';

/**
 * Script: neat handwritten gel / fountain ink. A smooth monoline whose width breathes gently with pen
 * pressure, drawn as one filled outline that comes to a fine point at both ends — no round blob where
 * the pen lands or lifts.
 *
 * BUILT LIKE THE CALLIGRAPHY BRUSH, with a round "nib" instead of a canted one. The centreline is the
 * pen's (filtered) samples, smoothed and densified with Fabric's quadratic-through-midpoints curve; the
 * outline is that centreline offset either side by a half-width; the preview fills it through `Path2D`
 * and the committed object is the same outline as a filled `Path`. The width is baked into the outline,
 * so a saved stroke reloads exactly as drawn — the same contract as the brush.
 *
 * THE WIDTH. {@link scriptHalfWidth}: `width/2 × pressure × taper`.
 *   - pressure: 0..1 maps linearly onto 0.75×..1.25×. Unknown pressure (mouse, finger, the native S Pen
 *     path, a panel that never reports it) is exactly 1×, so the stroke is then a clean monoline.
 *     Smoothed per sample (an EMA) so the line swells and thins rather than wobbling.
 *   - taper: a smoothstep ramp from {@link SCRIPT_TAPER_MIN} of the width at each end up to full width
 *     over {@link scriptTaperLength} of arc length (a few widths; halved for a stroke too short for two
 *     full ramps). The ends are closed by a semicircle at the TAPERED half-width — a fine point, not a
 *     cap the size of the nib.
 *
 * PRESSURE LIVES ON THE POINTS. Each sample's pressure is stamped onto Fabric's own `Point` object in
 * `_addPoint`. Fabric's decimation and the lift-hook trim both keep a subset of the same objects, so the
 * value follows its point through every rewrite of `_points`. A parallel array would drift out of step
 * (the calligraphy brush's ghost-line history is why that is not done here).
 *
 * APPEND-ONLY, LIKE THE BRUSH. Offsets are cached once final. The start taper depends only on distance
 * from the start, so it is final once computed; the end taper follows the moving tip, so the offsets
 * within one taper length of the tip are recomputed every frame — a handful of points — and everything
 * behind them is kept. While the stroke is still shorter than two full ramps the taper length itself
 * depends on the stroke length, so nothing is cached until it grows past that (it is tiny until then).
 * The preview and the committed object go through the same functions, so nothing moves on pen-up.
 */

/** Width at pressure 0 and at pressure 1, as a fraction of the configured pen width. */
export const SCRIPT_MIN_PRESSURE_SCALE = 0.75;
export const SCRIPT_MAX_PRESSURE_SCALE = 1.25;
/** With «Pressure» on: the same range the small writing pad uses (half … one and a half of the pen size). */
export const PRESSURE_ON_MIN = 0.5;
export const PRESSURE_ON_MAX = 1.5;
/** The width at the very tip of a taper, as a fraction of the full width there. */
export const SCRIPT_TAPER_MIN = 0.2;
/** A full taper runs this many pen widths of arc length… */
const TAPER_LENGTH_WIDTHS = 3;
/** …but never shorter than this (scene px), so a thin pen still gets a visible point. */
const MIN_TAPER_LENGTH = 4;
/** Weight of the newest sample in the pressure EMA. Lower = gentler swelling. */
const PRESSURE_SMOOTHING = 0.25;

/**
 * Stronger than the plain pen's One-Euro tuning (minCutoff 0.04, beta 0.12): slow ink is averaged a bit
 * harder so letters flow. Kept close to the default because every step down adds lag on the slow tablets.
 */
const SCRIPT_SMOOTHER_OPTIONS: Partial<StrokeSmootherOptions> = { minCutoff: 0.03, beta: 0.09 };

/** Below this movement a sample is jitter and is skipped. */
const MIN_SAMPLE_DISTANCE = 0.35;
/** Target spacing (scene px) of the densified centreline, and the cap on subdivisions per gap. */
const CENTERLINE_STEP_PX = 2;
const MAX_SUBDIVISIONS = 8;
/** Segments of the semicircle that closes each end, and of a dot. */
const CAP_SEGMENTS = 6;
const DOT_SEGMENTS = 12;
const DEGENERATE_TANGENT_EPS = 1e-9;

/** Pressure 0..1 → width factor. Missing / non-finite / non-positive means unknown → exactly 1. */
export function scriptPressureScale(pressure: number | undefined): number {
  if (typeof pressure !== 'number' || !Number.isFinite(pressure) || pressure <= 0) return 1;

  const clamped = Math.min(1, pressure);

  return SCRIPT_MIN_PRESSURE_SCALE + (SCRIPT_MAX_PRESSURE_SCALE - SCRIPT_MIN_PRESSURE_SCALE) * clamped;
}

/**
 * Arc length over which each end tapers, for a pen `width` and a stroke `strokeLength` long so far.
 * Halved stroke length at most, so a short stroke tapers in and straight back out instead of never
 * reaching its width.
 */
export function scriptTaperLength(width: number, strokeLength: number): number {
  const full = Math.max(MIN_TAPER_LENGTH, width * TAPER_LENGTH_WIDTHS);

  return Math.max(0, Math.min(full, strokeLength / 2));
}

function smoothstep(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;

  return x * x * (3 - 2 * x);
}

/**
 * Taper factor at a point `fromStart` along the stroke and `fromEnd` before its end (either may be
 * Infinity). {@link SCRIPT_TAPER_MIN} at the ends, 1 once a full `taperLength` in from both.
 */
export function scriptTaperScale(fromStart: number, fromEnd: number, taperLength: number): number {
  if (!(taperLength > 0)) return SCRIPT_TAPER_MIN;

  const ramp = Math.min(smoothstep(fromStart / taperLength), smoothstep(fromEnd / taperLength));

  return SCRIPT_TAPER_MIN + (1 - SCRIPT_TAPER_MIN) * ramp;
}

/** Half the ink width at one point of a script stroke. */
export function scriptHalfWidth(
  width: number,
  pressure: number | undefined,
  fromStart: number,
  fromEnd: number,
  taperLength: number,
): number {
  return (width / 2) * scriptPressureScale(pressure) * scriptTaperScale(fromStart, fromEnd, taperLength);
}

/** The pen pressure carried by a pointer / stylus event, or NaN. Fingers and mice report none we trust. */
function penPressureFromEvent(e: unknown): number {
  if (!e || typeof e !== 'object') return Number.NaN;

  const pointer = e as { pointerType?: unknown; pressure?: unknown };

  if (pointer.pointerType === 'pen' && typeof pointer.pressure === 'number') return pointer.pressure;

  const touches = (e as { touches?: ArrayLike<{ touchType?: string; force?: number }> }).touches;
  const touch = touches && touches.length > 0 ? touches[0] : undefined;

  if (touch && touch.touchType === 'stylus' && typeof touch.force === 'number') return touch.force;

  return Number.NaN;
}

interface OutlinePoint {
  x: number;
  y: number;
}

/** A centreline point with its (smoothed) pressure, NaN when unknown. */
interface InkPoint extends OutlinePoint {
  p: number;
}

type PressurePoint = Point & { pressure?: number };

interface OutlineGeometry {
  left: OutlinePoint[];
  right: OutlinePoint[];
  tailLeft: OutlinePoint[];
  tailRight: OutlinePoint[];
  first: OutlinePoint;
  last: OutlinePoint;
  startHalf: number;
  endHalf: number;
  startNormal: OutlinePoint;
  startTangent: OutlinePoint;
  endNormal: OutlinePoint;
  endTangent: OutlinePoint;
  /** A dot: `left` holds the closed polygon and nothing else is drawn. */
  dot: boolean;
}

/** 1/100 px: the committed path data is parsed once and rasterised; more digits are just string length. */
function coordinate(value: number): string {
  return value.toFixed(2);
}

export class ScriptBrush extends LowLatencyPencilBrush {
  protected override smootherOptions(): Partial<StrokeSmootherOptions> {
    return SCRIPT_SMOOTHER_OPTIONS;
  }

  /** The pressure EMA for the stroke in progress (NaN until a known pressure arrives). */
  private smoothedPressure = Number.NaN;

  /**
   * How much the width follows pressure: the factor at the lightest touch and at full pressure. The
   * script pen breathes gently by default; {@link setPressure} makes it follow the hand clearly, or not at all.
   */
  pressureMin = SCRIPT_MIN_PRESSURE_SCALE;
  pressureMax = SCRIPT_MAX_PRESSURE_SCALE;
  /** False = no pointed ends: the line starts and stops at its full width (the plain pen's look). */
  tapered = true;

  /** Pressure on = the width runs from half to one and a half of the pen size with the hand; off = an even line. */
  setPressure(on: boolean): void {
    this.pressureMin = on ? PRESSURE_ON_MIN : 1;
    this.pressureMax = on ? PRESSURE_ON_MAX : 1;
  }

  private pressureScale(pressure: number | undefined): number {
    if (typeof pressure !== 'number' || !Number.isFinite(pressure) || pressure <= 0) return 1;

    return this.pressureMin + (this.pressureMax - this.pressureMin) * Math.min(1, pressure);
  }

  private halfWidth(width: number, pressure: number | undefined, fromStart: number, fromEnd: number, taperLength: number): number {
    return (width / 2) * this.pressureScale(pressure) * (this.tapered ? scriptTaperScale(fromStart, fromEnd, taperLength) : 1);
  }

  private get strokePoints(): PressurePoint[] {
    return (this as unknown as { _points?: PressurePoint[] })._points ?? [];
  }

  override onMouseDown(pointer: Point, eventData: TEvent): void {
    if (this.canvas._isMainEvent(eventData.e)) {
      const fromEvent = penPressureFromEvent(eventData.e);

      if (Number.isFinite(fromEvent) && fromEvent > 0) this.notePressure(fromEvent);
      this.smoothedPressure = Number.NaN;
    }

    super.onMouseDown(pointer, eventData);
  }

  override onMouseMove(pointer: Point, eventData: TEvent): void {
    const fromEvent = penPressureFromEvent(eventData.e);

    if (Number.isFinite(fromEvent) && fromEvent > 0) this.notePressure(fromEvent);

    super.onMouseMove(pointer, eventData);
  }

  override _addPoint(point: Point): boolean {
    const added = super._addPoint(point);

    if (added) {
      const points = this.strokePoints;
      const raw = this.livePressure;

      if (Number.isFinite(raw)) {
        this.smoothedPressure = Number.isFinite(this.smoothedPressure)
          ? this.smoothedPressure + PRESSURE_SMOOTHING * (raw - this.smoothedPressure)
          : raw;
      }

      points[points.length - 1].pressure = this.smoothedPressure;
    }

    return added;
  }

  override _finalizeAndAddPath(): void {
    try {
      super._finalizeAndAddPath();
    } finally {
      // The next stroke starts from what ITS pen-down reports, not from this stroke's lift.
      this.livePressure = Number.NaN;
      this.smoothedPressure = Number.NaN;
    }
  }

  private outline: {
    source: PressurePoint[];
    width: number;
    consumed: number;
    sig: InkPoint[];
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    /** Smoothed + densified centreline (stable prefix) and the arc length at each point. */
    dense: InkPoint[];
    arc: number[];
    densifiedThrough: number;
    lastRawX: number;
    lastRawY: number;
    left: OutlinePoint[];
    right: OutlinePoint[];
    startNormal: OutlinePoint;
    startTangent: OutlinePoint;
    startHalf: number;
  } | null = null;

  private freshOutline(source: PressurePoint[]) {
    this.outline = {
      source,
      width: this.width,
      consumed: 0,
      sig: [],
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      dense: [],
      arc: [],
      densifiedThrough: 0,
      lastRawX: Number.NaN,
      lastRawY: Number.NaN,
      left: [],
      right: [],
      startNormal: { x: 0, y: 0 },
      startTangent: { x: 0, y: 0 },
      startHalf: 0,
    };

    return this.outline;
  }

  /** Offset one centreline point by `half` along the normal of its local direction. */
  private offsetAt(point: OutlinePoint, previous: OutlinePoint, next: OutlinePoint, half: number) {
    // Centred difference, falling back to a half-step at a hairpin (pen out and straight back) where the
    // centred one cancels — same reasoning as the calligraphy brush.
    let tangentX = next.x - previous.x;
    let tangentY = next.y - previous.y;
    let length = Math.hypot(tangentX, tangentY);

    if (length < DEGENERATE_TANGENT_EPS) {
      tangentX = point.x - previous.x;
      tangentY = point.y - previous.y;
      length = Math.hypot(tangentX, tangentY);
    }

    if (length < DEGENERATE_TANGENT_EPS) {
      tangentX = next.x - point.x;
      tangentY = next.y - point.y;
      length = Math.hypot(tangentX, tangentY);
    }

    if (length < DEGENERATE_TANGENT_EPS) {
      tangentX = 1;
      tangentY = 0;
      length = 1;
    }

    const unitTangentX = tangentX / length;
    const unitTangentY = tangentY / length;
    const normalX = -unitTangentY;
    const normalY = unitTangentX;

    return {
      left: { x: point.x + normalX * half, y: point.y + normalY * half },
      right: { x: point.x - normalX * half, y: point.y - normalY * half },
      normal: { x: normalX, y: normalY },
      tangent: { x: unitTangentX, y: unitTangentY },
    };
  }

  private buildOutline(): OutlineGeometry | null {
    const raw = this.strokePoints;
    let cache = this.outline;
    // Fabric replaces `_points` on reset and at finalize (identity), and straight-line mode replaces the
    // last point in place (same array, same length) — compare that point by value too.
    const newest = raw.length > 0 ? raw[raw.length - 1] : null;
    const lastPointReplaced =
      !!cache &&
      raw.length === cache.consumed &&
      !!newest &&
      (newest.x !== cache.lastRawX || newest.y !== cache.lastRawY);

    if (
      !cache ||
      cache.source !== raw ||
      cache.width !== this.width ||
      raw.length < cache.consumed ||
      lastPointReplaced
    ) {
      cache = this.freshOutline(raw);
    }

    for (let index = cache.consumed; index < raw.length; index += 1) {
      const point = raw[index];
      const previous = cache.sig[cache.sig.length - 1];

      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= MIN_SAMPLE_DISTANCE) {
        const pressure = typeof point.pressure === 'number' ? point.pressure : Number.NaN;

        cache.sig.push({ x: point.x, y: point.y, p: pressure });
        cache.minX = Math.min(cache.minX, point.x);
        cache.minY = Math.min(cache.minY, point.y);
        cache.maxX = Math.max(cache.maxX, point.x);
        cache.maxY = Math.max(cache.maxY, point.y);
      }
    }

    cache.consumed = raw.length;

    if (newest) {
      cache.lastRawX = newest.x;
      cache.lastRawY = newest.y;
    }

    const sig = cache.sig;

    if (sig.length === 0) return null;

    const width = this.width;
    const extent = Math.hypot(cache.maxX - cache.minX, cache.maxY - cache.minY);

    // A tap, or a stroke no longer than the pen is wide: a round dot of the pen's width. Tapering
    // something that short would leave nothing — and i, j, full stops and colons are dots.
    if (extent < width) {
      const centreX = (cache.minX + cache.maxX) / 2;
      const centreY = (cache.minY + cache.maxY) / 2;
      const radius = (width / 2) * this.pressureScale(sig[0].p);
      const polygon: OutlinePoint[] = [];

      for (let i = 0; i < DOT_SEGMENTS; i += 1) {
        const angle = (2 * Math.PI * i) / DOT_SEGMENTS;

        polygon.push({ x: centreX + Math.cos(angle) * radius, y: centreY + Math.sin(angle) * radius });
      }

      const centre = { x: centreX, y: centreY };
      const axis = { x: 1, y: 0 };

      return {
        left: polygon,
        right: [],
        tailLeft: [],
        tailRight: [],
        first: centre,
        last: centre,
        startHalf: radius,
        endHalf: radius,
        startNormal: axis,
        startTangent: axis,
        endNormal: axis,
        endTangent: axis,
        dot: true,
      };
    }

    // Densify the centreline. Iteration `i` reads sig[i-1..i+1], so it is final once sig[i+1] exists.
    if (cache.dense.length === 0) {
      cache.dense.push(sig[0]);
      cache.arc.push(0);
    }

    for (let i = Math.max(1, cache.densifiedThrough + 1); i <= sig.length - 2; i += 1) {
      const before = sig[i - 1];
      const control = sig[i];
      const after = sig[i + 1];
      const fromX = (before.x + control.x) / 2;
      const fromY = (before.y + control.y) / 2;
      const toX = (control.x + after.x) / 2;
      const toY = (control.y + after.y) / 2;
      const fromP = (before.p + control.p) / 2;
      const toP = (control.p + after.p) / 2;
      const steps = Math.min(
        MAX_SUBDIVISIONS,
        Math.max(
          1,
          Math.ceil(
            (Math.hypot(control.x - fromX, control.y - fromY) + Math.hypot(toX - control.x, toY - control.y)) /
              CENTERLINE_STEP_PX,
          ),
        ),
      );

      // Step 0 of every iteration after the first is the previous iteration's end point — skip the copy.
      for (let step = i === 1 ? 0 : 1; step <= steps; step += 1) {
        const t = step / steps;
        const inv = 1 - t;
        const previous = cache.dense[cache.dense.length - 1];
        const next: InkPoint = {
          x: inv * inv * fromX + 2 * inv * t * control.x + t * t * toX,
          y: inv * inv * fromY + 2 * inv * t * control.y + t * t * toY,
          p: inv * inv * fromP + 2 * inv * t * control.p + t * t * toP,
        };

        cache.arc.push(cache.arc[cache.arc.length - 1] + Math.hypot(next.x - previous.x, next.y - previous.y));
        cache.dense.push(next);
      }

      cache.densifiedThrough = i;
    }

    const stableCount = cache.dense.length;
    const tip = sig[sig.length - 1];
    const lastStable = cache.dense[stableCount - 1];
    const tipArc = cache.arc[stableCount - 1] + Math.hypot(tip.x - lastStable.x, tip.y - lastStable.y);
    const total = stableCount + 1;
    const stable = cache;
    const centre = (index: number): InkPoint => (index < stableCount ? stable.dense[index] : tip);
    const arcAt = (index: number): number => (index < stableCount ? stable.arc[index] : tipArc);
    const taperLength = scriptTaperLength(width, tipArc);
    // Offsets may be cached only once the taper length has stopped depending on the stroke's length.
    const canCache = taperLength >= scriptTaperLength(width, Number.POSITIVE_INFINITY);

    let startNormal = cache.startNormal;
    let startTangent = cache.startTangent;
    let startHalf = cache.startHalf;

    // Cache every offset whose neighbours are final AND that is beyond the end taper's reach for good
    // (the tip only ever moves further away along the arc).
    if (canCache) {
      for (let j = cache.left.length; j <= stableCount - 2 && tipArc - arcAt(j) >= taperLength; j += 1) {
        const point = centre(j);
        const half = this.halfWidth(width, point.p, arcAt(j), Number.POSITIVE_INFINITY, taperLength);
        const resolved = this.offsetAt(point, centre(Math.max(0, j - 1)), centre(j + 1), half);

        cache.left.push(resolved.left);
        cache.right.push(resolved.right);

        if (j === 0) {
          cache.startNormal = resolved.normal;
          cache.startTangent = resolved.tangent;
          cache.startHalf = half;
          startNormal = resolved.normal;
          startTangent = resolved.tangent;
          startHalf = half;
        }
      }
    }

    const tailLeft: OutlinePoint[] = [];
    const tailRight: OutlinePoint[] = [];
    let endNormal: OutlinePoint = { x: 0, y: 0 };
    let endTangent: OutlinePoint = { x: 0, y: 0 };
    let endHalf = 0;

    for (let j = cache.left.length; j < total; j += 1) {
      const point = centre(j);
      const half = this.halfWidth(width, point.p, arcAt(j), tipArc - arcAt(j), taperLength);
      const resolved = this.offsetAt(point, centre(Math.max(0, j - 1)), centre(Math.min(total - 1, j + 1)), half);

      tailLeft.push(resolved.left);
      tailRight.push(resolved.right);

      if (j === 0) {
        startNormal = resolved.normal;
        startTangent = resolved.tangent;
        startHalf = half;
      }

      if (j === total - 1) {
        endNormal = resolved.normal;
        endTangent = resolved.tangent;
        endHalf = half;
      }
    }

    return {
      left: cache.left,
      right: cache.right,
      tailLeft,
      tailRight,
      first: centre(0),
      last: tip,
      startHalf,
      endHalf,
      startNormal,
      startTangent,
      endNormal,
      endTangent,
      dot: false,
    };
  }

  /** A semicircle of radius `half` round `at`, sweeping `from → through → −from` (both unit vectors). */
  private eachCapPoint(
    at: OutlinePoint,
    half: number,
    from: OutlinePoint,
    through: OutlinePoint,
    emit: (x: number, y: number) => void,
  ): void {
    for (let i = 1; i < CAP_SEGMENTS; i += 1) {
      const angle = (Math.PI * i) / CAP_SEGMENTS;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      emit(at.x + (from.x * cos + through.x * sin) * half, at.y + (from.y * cos + through.y * sin) * half);
    }
  }

  /** Walk the closed outline once. Shared by the preview (Path2D) and the commit (string), so they agree. */
  private traceOutline(
    geometry: OutlineGeometry,
    moveTo: (x: number, y: number) => void,
    lineTo: (x: number, y: number) => void,
  ): boolean {
    if (geometry.dot) {
      geometry.left.forEach((point, index) => (index === 0 ? moveTo(point.x, point.y) : lineTo(point.x, point.y)));

      return geometry.left.length > 0;
    }

    let started = false;
    const emit = (point: OutlinePoint) => {
      if (started) {
        lineTo(point.x, point.y);
      } else {
        moveTo(point.x, point.y);
        started = true;
      }
    };

    for (const point of geometry.left) emit(point);
    for (const point of geometry.tailLeft) emit(point);

    if (!started) return false;

    this.eachCapPoint(geometry.last, geometry.endHalf, geometry.endNormal, geometry.endTangent, lineTo);

    for (let i = geometry.tailRight.length - 1; i >= 0; i -= 1) {
      lineTo(geometry.tailRight[i].x, geometry.tailRight[i].y);
    }

    for (let i = geometry.right.length - 1; i >= 0; i -= 1) {
      lineTo(geometry.right[i].x, geometry.right[i].y);
    }

    this.eachCapPoint(
      geometry.first,
      geometry.startHalf,
      { x: -geometry.startNormal.x, y: -geometry.startNormal.y },
      { x: -geometry.startTangent.x, y: -geometry.startTangent.y },
      lineTo,
    );

    return true;
  }

  /** The outline as SVG path data — for the COMMITTED object, built once at pen-up. */
  private outlinePathData(): string | null {
    const geometry = this.buildOutline();

    if (!geometry) return null;

    let data = '';
    const drawn = this.traceOutline(
      geometry,
      (x, y) => {
        data += `M ${coordinate(x)} ${coordinate(y)}`;
      },
      (x, y) => {
        data += ` L ${coordinate(x)} ${coordinate(y)}`;
      },
    );

    return drawn ? `${data} Z` : null;
  }

  /**
   * Always Fabric's full-render path: the incremental one strokes each new segment at a constant
   * `lineWidth`, which is not this brush, and leaves a live subpath behind (see the calligraphy brush).
   */
  override needsFullRender(): boolean {
    return true;
  }

  /**
   * Draw the in-progress stroke. Clear and `beginPath()` BEFORE any early return — both are owed to
   * whatever draws next (Fabric does not clear contextTop while drawing, and `fill(Path2D)` never resets
   * the context path, so a stray `moveTo` from `_prepareForDrawing` would otherwise stay live).
   */
  override _render(ctx?: CanvasRenderingContext2D): void {
    const canvas = this.canvas;
    const isPreview = !ctx;
    const target = ctx ?? canvas.contextTop;

    if (isPreview) canvas.clearContext(target);

    target.beginPath();

    const geometry = this.buildOutline();

    if (!geometry) return;

    const path = new Path2D();
    const drawn = this.traceOutline(
      geometry,
      (x, y) => path.moveTo(x, y),
      (x, y) => path.lineTo(x, y),
    );

    if (!drawn) return;

    path.closePath();

    target.save();
    if (isPreview) target.transform(...canvas.viewportTransform);
    target.fillStyle = this.paintColorFor(target);
    target.fill(path, 'nonzero');
    target.restore();
  }

  /** The committed object: a FILLED path (the outline), not a stroked one — the width is in the geometry. */
  override createPath(pathData: Parameters<PencilBrush['createPath']>[0]): Path {
    const outlineData = this.outlinePathData() ?? pathData;

    const path = new Path(outlineData, {
      fill: this.color,
      stroke: '',
      strokeWidth: 0,
      fillRule: 'nonzero',
    });

    // Only a real outline is marked: Fabric's fallback line data is not laid out like one.
    return outlineData === pathData ? path : markInkPen(path, 'script');
  }
}
