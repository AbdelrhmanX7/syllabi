import { Path } from 'fabric';

import type { PencilBrush, Point } from 'fabric';

import { LowLatencyPencilBrush } from './LowLatencyPencilBrush';
import { markInkPen } from './inkPenMark';

/**
 * A broad-edge calligraphy nib: a flat, slanted tip dragged along the stroke. Pull across the edge and
 * the line is thick; run along it and it thins to a hairline. This is myViewBoard's brush.
 *
 * MODELLED ON myViewBoard'S OWN FILE FORMAT, not on guesswork. A brush drawing exported from it
 * (`.olf`, seven strokes) describes every stroke identically:
 *
 *     pen-type: watercolor-pen
 *     pen-width: 6.0   pen-height: 9.6                    (the nib is an ellipse, 1 : 1.6)
 *     stylus-tip-transform: 1,0,0, 0.70710678,0.6, 0,0,1  (sheared, then squashed to 0.6)
 *     stylus-points: every point at pressure 0.5
 *
 * Two things follow. The nib is a FIXED shape and orientation, so width varies with the direction of
 * travel alone — which is why the same letter always comes out the same. And pressure is written as a
 * constant 0.5 and never used, which matches this hardware exactly: the ViewSonic panel reports a flat
 * 0.5 for every contact. Nothing here depends on a signal the panel cannot give.
 *
 * THE GEOMETRY. The nib is the unit circle under a linear map `A` — a circle scaled to the nib's two
 * radii, then put through myViewBoard's shear. The silhouette's half-width along a normal `n` is the
 * support function `|Aᵀn|`, which is what makes cross-strokes fat and along-strokes thin — but the point
 * where the nib actually TOUCHES that supporting line is `A·Aᵀn / |Aᵀn|`, and using the former as an
 * offset direction (which this brush did at first) produces a band symmetric about the centreline: right
 * width, no lean. Stroke ends are the nib's own elliptical arc, because that is the mark a real broad
 * edge leaves when you stop — not a flat perpendicular cut.
 *
 * THE DOT. A tap is not the bare footprint. The footprint is the nib's silhouette, a 2 : 1 ellipse lying
 * along the cant, and on its own it reads as a slanted hairline — too thin and too light next to the
 * strokes it sits between, and handwriting is full of dots (i, j, full stops, colons). No
 * calligrapher taps for a dot either: the nib is pulled a short way across its own edge, which is why
 * the manuals' dot is the rhombus whose side is the nib's width. So a tap — and any stroke too short to
 * be anything else, see {@link CalligraphyBrush.buildOutline} — is committed as exactly that pull:
 * the nib swept along its thin axis just far enough that the mark is as long as it is wide, through
 * the same sides-and-caps outline as every stroke. The preview and the committed object agree because
 * they share the geometry.
 *
 * STATELESS BY CONSTRUCTION. The outline is derived from Fabric's own `_points` every time, and this
 * class keeps no copy of the stroke. An earlier version kept a parallel array so it could store a width
 * per sample, and any path where that array outlived its stroke — a stroke Fabric discarded, a tool
 * swapped mid-stroke — left the next stroke's outline starting at the PREVIOUS stroke's first point,
 * drawing a ghost line across the page into whatever was being written. Because the nib's width is a
 * pure function of direction, no history is needed, and that whole class of bug cannot occur.
 */

interface OutlinePoint {
  x: number;
  y: number;
  /** The (smoothed) pen pressure at this point, when «Pressure» is on and the pen reports one. */
  p?: number;
}

type PressurePoint = Point & { pressure?: number };

/** Weight of the newest sample in the pressure average: the nib swells and thins, it does not wobble. */
const PRESSURE_SMOOTHING = 0.25;

/** One frame's swept-nib geometry: the cached prefix, plus the few offsets still in flux. */
interface OutlineGeometry {
  /** Cached offsets. Final; never recomputed. */
  left: OutlinePoint[];
  right: OutlinePoint[];
  /** The trailing offsets that still move as the pen does. */
  tailLeft: OutlinePoint[];
  tailRight: OutlinePoint[];
  first: OutlinePoint;
  last: OutlinePoint;
  startNormal: OutlinePoint;
  startTangent: OutlinePoint;
  endNormal: OutlinePoint;
  endTangent: OutlinePoint;
}

/**
 * Emit a coordinate at 1/100 px. The outline is rebuilt into an SVG path string on every frame and
 * re-parsed by `new Path2D(...)`, so the length of that string is a real per-frame cost — and full
 * float precision was writing seventeen significant digits per number ("862.8045111697093") for a
 * value that is then rasterised onto a pixel grid. Two decimals is far below anything visible at any
 * zoom this board supports, and cuts the string roughly in half.
 */
function coordinate(value: number): string {
  return value.toFixed(2);
}

/**
 * The nib's aspect: `pen-width` 6.0 against `pen-height` 9.6 in the myViewBoard export. The teacher's
 * pen-width slider drives the short axis, so a wider pen scales the whole nib.
 */
const NIB_ASPECT = 9.6 / 6;
/**
 * myViewBoard's `stylus-tip-transform`, the 2x2 part: x' = x, y' = ±0.70710678x + 0.6y.
 *
 * Their file ships a POSITIVE shear — a nib canted for a left-to-right hand, which is what a
 * Latin-script broad-edge pen wants, so it is used as is (0.70710678 = cos 45°).
 */
const NIB_SHEAR_X = 0.70710678118654752;
const NIB_SCALE_Y = 0.6;
/** The nib is broader than a round pen tip at the same setting, as a real brush is. */
export const NIB_WIDTH_SCALE = 1.6;
/** Below this movement a point is jitter: its direction is meaningless, so it is skipped. */
const MIN_SAMPLE_DISTANCE = 0.35;
/** Never let a stroke vanish completely where it runs exactly along the nib edge. */
const MIN_HALF_WIDTH = 0.35;
/**
 * Segments per half-turn of nib silhouette at a stroke end. A real broad nib does not leave a flat cut
 * where the stroke stops — it leaves its own footprint, which for this nib is an ellipse arc. Ten
 * segments is well under a pixel of chord error at any pen width the teacher can pick.
 */
const CAP_SEGMENTS = 10;
/**
 * Target spacing, in scene px, for the smoothed centreline the nib is swept along.
 *
 * SMOOTH THE PATH, NOT THE SILHOUETTE. This brush used to run Fabric's quadratic-through-midpoints
 * smoothing over the finished OUTLINE. That curve never passes through the offset points — it uses them
 * as control points and passes through their midpoints — so every corner of the silhouette got rounded
 * off and the stroke was pulled slightly thinner. The corners of a broad-nib silhouette are exactly
 * where its thick/thin contrast lives, so smoothing there is smoothing away the whole point of the nib:
 * the mark came out soft where a real broad edge is crisp.
 *
 * The smoothing belongs on the pen path, which is what Fabric's own pencil applies it to. So: smooth and
 * densify the CENTRELINE here, offset the nib at every densified point, then join those with straight
 * segments. Curves stay smooth, and the silhouette keeps its edges.
 */
const CENTERLINE_STEP_PX = 2;
/** Never subdivide a single gap more than this, whatever the zoom or how fast the pen moved. */
const MAX_SUBDIVISIONS = 8;
/** Below this a difference vector carries no usable direction. */
const DEGENERATE_TANGENT_EPS = 1e-9;

export class CalligraphyBrush extends LowLatencyPencilBrush {
  /** Fabric's own points for the stroke in progress — the single source of truth. */
  private get strokePoints(): PressurePoint[] {
    return (this as unknown as { _points?: PressurePoint[] })._points ?? [];
  }

  /**
   * PRESSURE (optional). The nib's SHAPE stays fixed — thick across its edge, thin along it — and with
   * «Pressure» on the whole nib grows and shrinks with the hand: 0.5× at the lightest touch, 1.5× pressed
   * hard. Off (the default here), or with a pen / finger / panel that reports no pressure, the factor is
   * exactly 1 and the brush is the direction-only nib described above.
   *
   * The pressure rides ON Fabric's own points (stamped in `_addPoint`, like the script pen), never in a
   * parallel array — the ghost-line history above is why.
   */
  private pressureMin = 1;
  private pressureMax = 1;
  private smoothedPressure = Number.NaN;

  setPressure(on: boolean): void {
    this.pressureMin = on ? 0.5 : 1;
    this.pressureMax = on ? 1.5 : 1;
  }

  private pressureScale(pressure: number | undefined): number {
    if (this.pressureMin === this.pressureMax) return 1;
    if (typeof pressure !== 'number' || !Number.isFinite(pressure) || pressure <= 0) return 1;

    return this.pressureMin + (this.pressureMax - this.pressureMin) * Math.min(1, pressure);
  }

  override onMouseDown(pointer: Point, eventData: Parameters<LowLatencyPencilBrush['onMouseDown']>[1]): void {
    if (this.canvas._isMainEvent(eventData.e)) this.smoothedPressure = Number.NaN;

    super.onMouseDown(pointer, eventData);
  }

  override _addPoint(point: Point): boolean {
    const added = super._addPoint(point);

    if (added) {
      const points = this.strokePoints;
      const raw = this.livePressure;

      if (Number.isFinite(raw)) {
        this.smoothedPressure = Number.isFinite(this.smoothedPressure) ? this.smoothedPressure + PRESSURE_SMOOTHING * (raw - this.smoothedPressure) : raw;
      }

      points[points.length - 1]!.pressure = this.smoothedPressure;
    }

    return added;
  }

  /**
   * The nib as a 2x2 matrix: the unit circle scaled to the nib radii, then sheared the way
   * myViewBoard's `stylus-tip-transform` shears it. Read per call so a width change applies at once.
   *
   * With it, the silhouette's principal axes: `thin` is the unit direction along which the nib is
   * narrowest (its minor axis — pulling the nib THIS way leaves the broadest mark), `broad` and `narrow`
   * are the silhouette's two half-widths. A dot is built from these, see {@link buildOutline}.
   */
  private nibCache: {
    a: number;
    b: number;
    c: number;
    d: number;
    thin: OutlinePoint;
    broad: number;
    narrow: number;
    width: number;
  } | null = null;

  private nibMatrix(): NonNullable<CalligraphyBrush['nibCache']> {
    // Cached on width, not recomputed per call. This runs once per outline POINT per FRAME — several
    // thousand times a second on a long stroke — and returning a fresh object each time made the nib
    // geometry the single biggest source of garbage in the draw loop. Keying on width keeps the original
    // contract that a width change applies immediately.
    const cached = this.nibCache;

    if (cached && cached.width === this.width) return cached;

    const radiusX = (this.width * NIB_WIDTH_SCALE) / 2;
    const radiusY = radiusX * NIB_ASPECT;

    // [1       0     ] [radiusX  0      ]   [radiusX          0             ]
    // [shearX  scaleY] [0        radiusY] = [shearX*radiusX   scaleY*radiusY]
    const a = radiusX;
    const b = 0;
    const c = NIB_SHEAR_X * radiusX;
    const d = NIB_SCALE_Y * radiusY;

    // The silhouette's major axis is the leading eigenvector of A·Aᵀ, and for a symmetric 2x2
    // [[p, q], [q, r]] that direction is at half the angle of (p − r, 2q). The half-width along it is
    // the support |Aᵀ·major|; the minor axis is the perpendicular, with the smaller support.
    const p = a * a + b * b;
    const q = a * c + b * d;
    const r = c * c + d * d;
    const angle = 0.5 * Math.atan2(2 * q, p - r);
    const majorX = Math.cos(angle);
    const majorY = Math.sin(angle);
    const thin = { x: -majorY, y: majorX };

    this.nibCache = {
      a,
      b,
      c,
      d,
      thin,
      broad: Math.hypot(a * majorX + c * majorY, b * majorX + d * majorY),
      narrow: Math.hypot(a * thin.x + c * thin.y, b * thin.x + d * thin.y),
      width: this.width,
    };

    return this.nibCache;
  }

  /**
   * Where the nib's silhouette actually touches the supporting line whose outward normal is `n`.
   *
   * The support function of the linearly-mapped circle is `h(n) = |Aᵀn|` — the DISTANCE from the nib's
   * centre to that line, which is what makes cross-strokes fat and along-strokes thin. But the contact
   * POINT is the gradient of the support function, `A·Aᵀn / |Aᵀn|`, not `n · h(n)`.
   *
   * Those two agree only for a ROUND nib. For a sheared ellipse the contact point slides sideways along
   * the supporting line, and that slide is precisely what makes a broad nib's sweep LEAN. Offsetting
   * along `n` instead — which is what this brush used to do — gave a band symmetric about the centreline:
   * the right width everywhere, but no lean, and every thick/thin transition landing in the wrong place.
   * On a straight segment the two are indistinguishable (same supporting line, points just slide along
   * it); on curves and at stroke ends, which is all of handwriting, they are not.
   */
  private nibOffset(normalX: number, normalY: number): OutlinePoint {
    const { a, b, c, d } = this.nibMatrix();
    // q = Aᵀn
    const projectedX = a * normalX + c * normalY;
    const projectedY = b * normalX + d * normalY;
    const support = Math.hypot(projectedX, projectedY);

    if (support < MIN_HALF_WIDTH) {
      return { x: normalX * MIN_HALF_WIDTH, y: normalY * MIN_HALF_WIDTH };
    }

    // A·q / |q|
    return {
      x: (a * projectedX + b * projectedY) / support,
      y: (c * projectedX + d * projectedY) / support,
    };
  }

  /**
   * The incrementally-built stroke geometry.
   *
   * APPEND-ONLY BY DESIGN. This used to be recomputed from every point on every frame — filter, densify,
   * offset, stringify — so a stroke cost O(n) per frame and O(n**2) over its life. Measured on a desktop:
   * a 1200-point stroke burned about a second of CPU across the stroke and 2.4ms on its final frame. The
   * teacher's panel is several times slower than that, which is a dropped frame on every sample near the
   * end of a long stroke — the "theirs responds faster" complaint, in one number.
   *
   * Appending is sound because of the dependency structure: a densify iteration for significant point `i`
   * reads `sig[i-1 .. i+1]`, and an offset at densified index `j` reads `dense[j-1 .. j+1]`. Both are
   * FINAL the moment the following point exists, so only the last entry or two are ever in flux. Those
   * are recomputed per frame; everything before them is kept.
   */
  private outline: {
    /** The `_points` array these were built from. Fabric REPLACES it on reset and at finalize. */
    source: Point[];
    /** Nib width they were offset for; a width change invalidates everything. */
    width: number;
    /** How many of `source` have been folded into `sig`. */
    consumed: number;
    /** Raw points with sub-jitter movement dropped. */
    sig: OutlinePoint[];
    /** Bounding box of `sig` — how far the pen has actually travelled, which decides tap vs stroke. */
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    /** Smoothed + densified centreline — the STABLE prefix only. */
    dense: OutlinePoint[];
    /** Highest `sig` index whose densify iteration has been emitted. */
    densifiedThrough: number;
    /** The last raw point folded in, BY VALUE — see the straight-line note in buildOutline. */
    lastRawX: number;
    lastRawY: number;
    left: OutlinePoint[];
    right: OutlinePoint[];
    startNormal: OutlinePoint;
    startTangent: OutlinePoint;
  } | null = null;

  private freshOutline(source: Point[]) {
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
      densifiedThrough: 0,
      lastRawX: Number.NaN,
      lastRawY: Number.NaN,
      left: [],
      right: [],
      startNormal: { x: 0, y: 0 },
      startTangent: { x: 0, y: 0 },
    };

    return this.outline;
  }

  /** Offset one centreline point. Shared by the cached pass and the per-frame tail, so they cannot drift. */
  private offsetAt(point: OutlinePoint, previous: OutlinePoint, next: OutlinePoint) {
    // The CENTRED difference cancels exactly at a hairpin — pen out and straight back, which is every
    // cross-out and every back-and-forth scribble. `next` and `previous` land on top of each other, the
    // tangent is the zero vector, and the normal with it; nibOffset then returns {0,0} and the outline
    // pinches to a point, amputating the whole turn-around. (Measured: 20px of ink gone at width 6.) Fall
    // back to whichever half-step still carries a direction.
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
      // Truly stationary: any direction gives the nib's own footprint, which is the right mark for it.
      tangentX = 1;
      tangentY = 0;
      length = 1;
    }

    const unitTangentX = tangentX / length;
    const unitTangentY = tangentY / length;
    // Unit normal to the direction of travel — the direction the nib's silhouette spreads in.
    const normalX = -unitTangentY;
    const normalY = unitTangentX;
    const nib = this.nibOffset(normalX, normalY);
    const scale = this.pressureScale(point.p);
    const offset = scale === 1 ? nib : { x: nib.x * scale, y: nib.y * scale };

    return {
      left: { x: point.x + offset.x, y: point.y + offset.y },
      right: { x: point.x - offset.x, y: point.y - offset.y },
      normal: { x: normalX, y: normalY },
      tangent: { x: unitTangentX, y: unitTangentY },
    };
  }

  private buildOutline(): OutlineGeometry | null {
    const raw = this.strokePoints;
    let cache = this.outline;

    // Fabric keeps ONE brush instance for the life of the board. `_reset()` assigns a new empty `_points`
    // and `_finalizeAndAddPath` assigns a decimated copy — both change the array IDENTITY, which is the
    // only reliable signal that the cache no longer describes this stroke. (Length alone is not enough:
    // decimation can return an array of the same length with different contents.)
    // Array identity and length are not enough. When a straight line is being drawn (Fabric's shift-key
    // mode), `PencilBrush._addPoint` does `_points.pop()` then `_points.push(point)` — SAME array, SAME
    // length, different contents. Every guard below would pass and the append loop would add nothing, so
    // the preview froze at wherever the drag first landed and only snapped straight on lift. Compare the
    // last point by value too.
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

    // The jitter filter only looks at the previous KEPT point, so it appends cleanly.
    for (let index = cache.consumed; index < raw.length; index += 1) {
      const point = raw[index];
      const previous = cache.sig[cache.sig.length - 1];

      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= MIN_SAMPLE_DISTANCE) {
        cache.sig.push({ x: point.x, y: point.y, p: point.pressure });
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
    const origin: OutlinePoint = { x: 0, y: 0 };

    if (sig.length === 0) return null;

    // A TAP, or a stroke shorter than the nib is wide, is a dot — and a dot is a short pull of the nib
    // across its own edge, not its bare footprint (see the class note). The pull runs along the
    // silhouette's thin axis, so the sides sit at the nib's broadest half-width, and is just long enough
    // that the mark is as long as it is wide: the square dot of the manuals, with the nib's own arcs for
    // ends. Centred on the little the pen did travel, so a wandering tap lands where it was aimed.
    //
    // "Shorter than the nib is wide" is measured as the extent of the points, not their count: a
    // deliberate tick for a diacritic is a few px of travel over several samples, and an S Pen tap
    // wanders a px or two before it lifts. Both are dots. A stroke that grows past this on a later frame
    // simply takes the ordinary path below — nothing was cached for it yet, so the densifier starts from
    // the first point as it would have anyway.
    const nib = this.nibMatrix();
    const extent = Math.hypot(cache.maxX - cache.minX, cache.maxY - cache.minY);

    if (extent < 2 * nib.broad) {
      const tangent = nib.thin;
      // Same left-hand normal `offsetAt` uses, so the caps sweep the same way round as a stroke's.
      const normal = { x: -tangent.y, y: tangent.x };
      // A dot is as big as the hand pressed it.
      const dotScale = this.pressureScale(sig[0].p);
      const halfPull = (nib.broad - nib.narrow) * dotScale;
      const centreX = (cache.minX + cache.maxX) / 2;
      const centreY = (cache.minY + cache.maxY) / 2;
      const first = { x: centreX - tangent.x * halfPull, y: centreY - tangent.y * halfPull, p: sig[0].p };
      const last = { x: centreX + tangent.x * halfPull, y: centreY + tangent.y * halfPull, p: sig[0].p };
      const nibDot = this.nibOffset(normal.x, normal.y);
      const offset = { x: nibDot.x * dotScale, y: nibDot.y * dotScale };

      return {
        left: [
          { x: first.x + offset.x, y: first.y + offset.y },
          { x: last.x + offset.x, y: last.y + offset.y },
        ],
        right: [
          { x: first.x - offset.x, y: first.y - offset.y },
          { x: last.x - offset.x, y: last.y - offset.y },
        ],
        tailLeft: [],
        tailRight: [],
        first,
        last,
        startNormal: normal,
        startTangent: tangent,
        endNormal: normal,
        endTangent: tangent,
      };
    }

    // Densify the centreline. Iteration `i` needs sig[i+1], so it is final the moment that point lands.
    if (cache.dense.length === 0) cache.dense.push(sig[0]);

    for (let i = Math.max(1, cache.densifiedThrough + 1); i <= sig.length - 2; i += 1) {
      const control = sig[i];
      const fromX = (sig[i - 1].x + control.x) / 2;
      const fromY = (sig[i - 1].y + control.y) / 2;
      const toX = (control.x + sig[i + 1].x) / 2;
      const toY = (control.y + sig[i + 1].y) / 2;
      // Pressure follows the same curve as the position (undefined stays undefined: no pressure).
      const hasPressure = Number.isFinite(control.p) && Number.isFinite(sig[i - 1].p) && Number.isFinite(sig[i + 1].p);
      const fromP = hasPressure ? ((sig[i - 1].p as number) + (control.p as number)) / 2 : undefined;
      const toP = hasPressure ? ((control.p as number) + (sig[i + 1].p as number)) / 2 : undefined;
      // Measure the CONTROL POLYGON, not the chord. A quadratic's arc length can be arbitrarily longer
      // than |to - from|, and the gap is widest exactly where the curve turns hardest — so keying on the
      // chord made the densifier least accurate precisely where it mattered most, which is the inverse of
      // adaptive. At a reversal the chord collapses to zero, giving one step, two identical points, and
      // the entire excursion through the control point silently dropped.
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

      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const inv = 1 - t;

        cache.dense.push({
          x: inv * inv * fromX + 2 * inv * t * control.x + t * t * toX,
          y: inv * inv * fromY + 2 * inv * t * control.y + t * t * toY,
          ...(hasPressure ? { p: inv * inv * (fromP as number) + 2 * inv * t * (control.p as number) + t * t * (toP as number) } : {}),
        });
      }

      cache.densifiedThrough = i;
    }

    // The centreline always ends at the newest point, which moves — so it is read through an accessor
    // rather than concatenated into a new array, which would put the O(n) allocation straight back.
    const stableCount = cache.dense.length;
    const tip = sig[sig.length - 1];
    const total = stableCount + 1;
    const stable = cache;
    const centre = (index: number): OutlinePoint => (index < stableCount ? stable.dense[index] : tip);

    let startNormal = cache.startNormal;
    let startTangent = cache.startTangent;

    // Cache every offset whose successor is already final...
    for (let j = cache.left.length; j <= stableCount - 2; j += 1) {
      const resolved = this.offsetAt(centre(j), centre(Math.max(0, j - 1)), centre(j + 1));

      cache.left.push(resolved.left);
      cache.right.push(resolved.right);

      if (j === 0) {
        cache.startNormal = resolved.normal;
        cache.startTangent = resolved.tangent;
        startNormal = resolved.normal;
        startTangent = resolved.tangent;
      }
    }

    // ...and recompute only the one or two that are still moving.
    const tailLeft: OutlinePoint[] = [];
    const tailRight: OutlinePoint[] = [];
    let endNormal: OutlinePoint = origin;
    let endTangent: OutlinePoint = origin;

    for (let j = cache.left.length; j < total; j += 1) {
      const resolved = this.offsetAt(
        centre(j),
        centre(Math.max(0, j - 1)),
        centre(Math.min(total - 1, j + 1)),
      );

      tailLeft.push(resolved.left);
      tailRight.push(resolved.right);

      if (j === 0) {
        startNormal = resolved.normal;
        startTangent = resolved.tangent;
      }

      if (j === total - 1) {
        endNormal = resolved.normal;
        endTangent = resolved.tangent;
      }
    }

    return {
      left: cache.left,
      right: cache.right,
      tailLeft,
      tailRight,
      first: centre(0),
      last: tip,
      startNormal,
      startTangent,
      endNormal,
      endTangent,
    };
  }

  /**
   * The nib's own outline across a sweep of normals — a true elliptical end cap.
   *
   * `from` and `through` are unit vectors 90 degrees apart; the sweep runs `from -> through -> -from`.
   * Because every point comes from {@link nibOffset}, the cap is the same curve as the stroke's sides and
   * joins them without a seam: the sides stop where the normal is +/-n, and the cap picks up exactly there.
   */
  private eachCapPoint(
    at: OutlinePoint,
    from: OutlinePoint,
    through: OutlinePoint,
    emit: (x: number, y: number) => void,
  ): void {
    for (let i = 1; i <= CAP_SEGMENTS; i += 1) {
      const angle = (Math.PI * i) / CAP_SEGMENTS;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const offset = this.nibOffset(from.x * cos + through.x * sin, from.y * cos + through.y * sin);
      // The end cap is the nib at the size it had there, so it meets the two sides exactly.
      const scale = this.pressureScale(at.p);

      emit(at.x + offset.x * scale, at.y + offset.y * scale);
    }
  }

  /**
   * Walk the closed outline once: up the left side, round the far end on the nib's own arc, back down the
   * right side, round the near end.
   *
   * The live preview and the committed object BOTH go through this, so they cannot describe different
   * shapes — the preview feeds it a `Path2D` and the commit feeds it a string builder.
   *
   * Straight segments between offset points, deliberately. The curve is already smooth because the
   * CENTRELINE was smoothed and densified before the nib was offset along it. Smoothing here as well
   * would round off the silhouette's own corners, which is where the nib's thick/thin contrast lives —
   * that is what made this brush read as soft next to a real broad edge.
   */
  private traceOutline(
    geometry: OutlineGeometry,
    moveTo: (x: number, y: number) => void,
    lineTo: (x: number, y: number) => void,
  ): boolean {
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

    this.eachCapPoint(geometry.last, geometry.endNormal, geometry.endTangent, lineTo);

    for (let i = geometry.tailRight.length - 1; i >= 0; i -= 1) {
      lineTo(geometry.tailRight[i].x, geometry.tailRight[i].y);
    }

    for (let i = geometry.right.length - 1; i >= 0; i -= 1) {
      lineTo(geometry.right[i].x, geometry.right[i].y);
    }

    this.eachCapPoint(
      geometry.first,
      { x: -geometry.startNormal.x, y: -geometry.startNormal.y },
      { x: -geometry.startTangent.x, y: -geometry.startTangent.y },
      lineTo,
    );

    return true;
  }

  /** The swept outline as SVG path data — for the COMMITTED object, built once at pen-up. */
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
   * Always take Fabric's full-render path, never its incremental one.
   *
   * Fabric has two preview modes. The incremental one draws only the newest segment with
   * `ctx.stroke()` at a constant `lineWidth` — which is not this brush at all, so the stroke would
   * appear as a plain line while writing and only become a nib stroke on lift. Worse, that branch skips
   * `ctx.beginPath()` on a stroke's first move (it only calls it once `oldEnd` exists), relying on
   * Fabric's own `_render` — which this class replaces — to have reset the context path at mouse-down.
   * Drawing with `Path2D` never touches the context path, so the previous stroke's subpath survived and
   * `ctx.stroke()` painted a line from where the last stroke ended to wherever the pen now was: the
   * ghost line, appearing while writing and vanishing on lift when the top canvas is cleared.
   *
   * Forcing the full-render path fixes both: Fabric clears the top canvas and calls `_render` every
   * frame, so the preview IS the nib outline, and the incremental branch can never run.
   */
  override needsFullRender(): boolean {
    return true;
  }

  /**
   * Draw the in-progress stroke.
   *
   * On the installed Fabric (7.2.0) this is ALWAYS called with no argument — `PencilBrush.onMouseDown`,
   * `PencilBrush.onMouseMove` and `SelectableCanvas.renderTopLayer` are the only three call sites and all
   * three pass nothing, over an `abstract _render(): void` in `BaseBrush`. The optional parameter is kept
   * only so a subclass (or a future Fabric) can retarget the paint; `isPreview` is true in practice.
   *
   * CLEARING AND `beginPath()` HAPPEN BEFORE ANY EARLY RETURN, deliberately. Both are invariants owed to
   * whatever draws next, not steps in painting this frame:
   *
   *   - The clear, because Fabric will not do it. `renderAll()` refuses to clear contextTop while
   *     `isDrawingMode` is true, and `onMouseDown` calls `_render()` with no clear at all — so anything
   *     already on the top canvas (the eraser's full-board preview blit above all) would survive the
   *     whole stroke and only vanish on lift.
   *   - The `beginPath()`, because `fill(Path2D)` below never touches the context's current path. This is
   *     the only `_render` in the app that leaves that path empty, which is exactly what makes it safe —
   *     but only if it runs. `PencilBrush._prepareForDrawing` writes a raw `contextTop.moveTo(pointer)`
   *     using SCENE coordinates outside `_saveAndTransform`, so at zoom > 1 that stray point sits well
   *     above and left of the pen; the next `ctx.stroke()` anywhere would draw a line to it from
   *     off-screen. Returning early past this line re-arms that.
   */
  override _render(ctx?: CanvasRenderingContext2D): void {
    const canvas = this.canvas;
    const isPreview = !ctx;
    const target = ctx ?? canvas.contextTop;

    if (isPreview) canvas.clearContext(target);

    target.beginPath();

    const geometry = this.buildOutline();

    if (!geometry) return;

    // Built by CALLING Path2D, not by serialising the outline to a string and re-parsing it. The preview
    // repaints on every sample, and `new Path2D(data)` means formatting several thousand numbers and
    // handing the engine a path parser to run, every frame, for a shape that is about to be thrown away.
    // The committed object still goes through the string form — but that happens once, at pen-up.
    const path = new Path2D();
    const drawn = this.traceOutline(
      geometry,
      (x, y) => path.moveTo(x, y),
      (x, y) => path.lineTo(x, y),
    );

    if (!drawn) return;

    path.closePath();

    target.save();
    // The preview must sit in scene space so it tracks pan and zoom mid-stroke. In the full-render path
    // Fabric has already applied the viewport, so don't apply it twice.
    if (isPreview) target.transform(...canvas.viewportTransform);
    target.fillStyle = this.paintColorFor(target);
    target.fill(path, 'nonzero');
    target.restore();
  }

  /**
   * Run `fn` with the brush describing `points` instead of the stroke in progress. The live stroke's
   * array and its append-only outline cache are put back afterwards, so a call mid-stroke (the snapped
   * preview is drawn while the pen is still down) costs the live stroke nothing.
   */
  private withPoints<T>(points: ReadonlyArray<{ x: number; y: number }>, fn: () => T): T {
    const self = this as unknown as { _points: Point[] };
    const savedPoints = self._points;
    const savedOutline = this.outline;

    // The outline only ever reads `.x` / `.y`, so plain points (a sampled shape) serve as well as Fabric's.
    self._points = points as unknown as Point[];
    this.outline = null;

    try {
      return fn();
    } finally {
      self._points = savedPoints;
      this.outline = savedOutline;
    }
  }

  /**
   * The nib swept along `points` (scene coords), as the SVG path data of the committed object — the same
   * mark a pen stroke through those points would leave. Hold-to-snap shapes feed the sampled geometry of
   * the snapped line / polygon / ellipse here so a snapped shape keeps the brush look instead of dropping
   * to a uniform line. Null when the points are too few/close to outline.
   */
  outlinePathDataFor(points: ReadonlyArray<{ x: number; y: number }>): string | null {
    return this.withPoints(points, () => this.outlinePathData());
  }

  /**
   * Paint the nib swept along `points` onto `ctx`, filled in the brush colour. The caller owns the
   * context state (viewport transform, alpha). Returns false when there was nothing to draw.
   */
  renderOutlineFor(points: ReadonlyArray<{ x: number; y: number }>, ctx: CanvasRenderingContext2D): boolean {
    return this.withPoints(points, () => {
      const geometry = this.buildOutline();

      if (!geometry) return false;

      const path = new Path2D();
      const drawn = this.traceOutline(
        geometry,
        (x, y) => path.moveTo(x, y),
        (x, y) => path.lineTo(x, y),
      );

      if (!drawn) return false;

      path.closePath();
      ctx.fillStyle = this.paintColorFor(ctx);
      ctx.fill(path, 'nonzero');

      return true;
    });
  }

  /** The committed object: a FILLED path (the swept outline), not a stroked one. */
  override createPath(pathData: Parameters<PencilBrush['createPath']>[0]): Path {
    // Falls back to Fabric's own (constant-width) data if the stroke was too short to outline.
    const outlineData = this.outlinePathData() ?? pathData;

    const path = new Path(outlineData, {
      fill: this.color,
      stroke: '',
      strokeWidth: 0,
      fillRule: 'nonzero',
    });

    // Only a real outline is marked: Fabric's fallback line data is not laid out like one.
    return outlineData === pathData ? path : markInkPen(path, 'brush');
  }
}
