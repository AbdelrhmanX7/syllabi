import { PencilBrush, Point } from 'fabric';

import type { Canvas, TEvent } from 'fabric';

import type { StrokeInkContrast } from '../utils/inkContrast';

import { isDarkBoardContext, paintedInkColor } from '../utils/darkBoard';
import type { StrokeSmootherOptions } from './strokeSmoothing';

import { findLiftHookTrim, StrokeSmoother } from './strokeSmoothing';

/** A pen frame's own point is only good for the twin event of that same frame. */
const PEN_FRAME_POINT_FRESH_MS = 50;
/** Fabric's point and the pen's own sample further apart than this (screen px) is worth a trace line. */
export const PEN_FRAME_MISMATCH_SCREEN_PX = 3;

/**
 * A hook into the live stroke, for features that may take the stroke over before it is committed —
 * hold-to-snap shapes (`shapeSnap.ts`). Every method runs on the input path, so implementations must
 * be O(1) per sample: no allocation-heavy work, no recognition, no layout reads.
 */
export interface StrokeInterceptor {
  /** A stroke began at `pointer` (scene coords). */
  strokeStart(brush: LowLatencyPencilBrush, pointer: Point, e: TEvent['e']): void;
  /**
   * One more sample of the stroke in progress (`e` is absent for a coalesced sub-frame sample).
   * Return true to CONSUME it: the brush then neither records nor draws it.
   */
  strokeSample(brush: LowLatencyPencilBrush, pointer: Point, e: TEvent['e'] | undefined): boolean;
  /**
   * The stroke is being committed (pen lift, or an interrupted stroke being closed). Return true when
   * the interceptor committed something of its own instead — the freehand path is then NOT created.
   */
  strokeFinalize(brush: LowLatencyPencilBrush): boolean;
}

/**
 * A {@link PencilBrush} that can be fed the sub-frame digitizer samples the browser buffered between
 * animation frames, instead of the single sample the default pipeline keeps per move.
 *
 * A pen digitizer reports at 120–240 Hz while the compositor fires one move per animation frame (~60 Hz).
 * The browser buffers everything it captured in between; keeping only the last entry visibly facets fast
 * curves — a smooth arc arrives as a short run of straight chords — and costs up to a frame of perceived
 * latency. Replaying the real samples reconstructs the actual pen path. Nothing here is speculative, so
 * there are no prediction artifacts, and `decimate` still runs at finalize over the denser set, so the
 * teacher's jitter filter behaves exactly as before.
 *
 * WHY THE BRUSH CANNOT COLLECT THEM ITSELF — this is the part that was wrong for a long time.
 * `getCoalescedEvents()` exists only on `PointerEvent`. This canvas is deliberately built WITHOUT
 * Fabric's pointer-event mode, because that is what lets a resting palm be starved out of the raw touch
 * stream before Fabric ever sees it. So every event handed to a brush is a `MouseEvent` (the pen's compat
 * events) or a `TouchEvent` (the panel's capacitive pen) — neither has the method. An earlier version of
 * this class called `getCoalescedEvents` on the event Fabric gave it and therefore did nothing at all, on
 * every device we ship to, for its entire life.
 *
 * The hook owns the real `PointerEvent`, so extraction happens there and the samples are pushed in
 * through {@link appendCoalescedSample} from a CAPTURE-phase listener — i.e. before Fabric processes its
 * own event for the same frame, which is what keeps the points in chronological order.
 */
export class LowLatencyPencilBrush extends PencilBrush {
  /** The colour this brush paints with into `ctx`: its own on a light surface, remapped on a dark board (utils/darkBoard). */
  protected paintColorFor(ctx: CanvasRenderingContext2D): string {
    const color = String(this.color);

    return isDarkBoardContext(ctx) ? paintedInkColor(color) : color;
  }

  override _setBrushStyles(ctx: CanvasRenderingContext2D): void {
    super._setBrushStyles(ctx);
    if (isDarkBoardContext(ctx)) ctx.strokeStyle = paintedInkColor(String(this.color));
  }

  /** See {@link StrokeInterceptor}. Null on brushes that must never be taken over (the eraser). */
  strokeInterceptor: StrokeInterceptor | null = null;

  /**
   * Smart ink contrast (`utils/inkContrast.ts`). While set, the colour this brush PAINTS with for a
   * stroke is `inkContrast.adjust(the colour it was given)` — a shade of the same hue that reads against
   * the background sampled at pen-down — and `color` is put back to what it was given once the stroke
   * is committed, so the palette's colour is what the brush reports between strokes. Null on brushes
   * that must paint exactly what they are told (the highlighter, the eraser).
   */
  inkContrast: StrokeInkContrast<Canvas> | null = null;

  /**
   * The colour the host asked for on the stroke in progress, and the adjusted colour painted for it.
   * Both null between strokes. Tracked as a pair so a `color` written by someone else mid-stroke (a
   * tool-state pass) is recognised and respected at restore time rather than overwritten.
   */
  private requestedStrokeColor: string | null = null;
  private paintedStrokeColor: string | null = null;

  /**
   * Smooth the pen's samples as they enter the stroke (`strokeSmoothing.ts`) and cut a lift-off hook at
   * commit. On for every inking brush; the eraser turns it off (lag there means missed erasing).
   *
   * The filter runs in `_addPoint` — the one funnel every sample goes through (Fabric's own move, the
   * coalesced sub-frame samples, every subclass) — so the live preview, the full-render repaints and the
   * committed path are all built from the SAME filtered points, and nothing moves on pen-up.
   */
  smoothing = true;
  private readonly smoother = new StrokeSmoother(this.smootherOptions());

  /**
   * Tuning for this brush's sample filter. Read ONCE, from the base constructor's field initialiser —
   * so an override must return a constant and must not touch its own instance fields (they are not
   * initialised yet). The plain pen keeps the defaults; the script nib asks for a smoother line.
   */
  protected smootherOptions(): Partial<StrokeSmootherOptions> {
    return {};
  }

  /**
   * The pen's pressure (0..1) for the NEXT sample, or NaN when unknown. Fabric's own samples arrive as
   * Mouse/Touch compat events with no pressure, so the hook hands it in from the real PointerEvent
   * (`notePressure`, and the second argument of `appendCoalescedSample`). Only the script nib reads it;
   * every other brush ignores it.
   */
  protected livePressure = Number.NaN;

  /** See {@link livePressure}. Anything that is not a finite number in (0, 1] means "unknown". */
  notePressure(pressure: number | undefined): void {
    this.livePressure = typeof pressure === 'number' && Number.isFinite(pressure) && pressure > 0 ? Math.min(1, pressure) : Number.NaN;
  }
  /** The last RAW sample accepted, for the duplicate check (the stored point is the filtered one). */
  private lastRawX = Number.NaN;
  private lastRawY = Number.NaN;

  /** The stroke's raw points so far, in scene coords. Read-only by contract — do not mutate. */
  get liveStrokePoints(): readonly Point[] {
    return this._points;
  }

  /**
   * Give the stroke in progress — or, between strokes, the next one — the colour `color`, through the
   * contrast adjustment when a stroke is live. This is what the dual-tip head revision and the colour
   * barrel button go through; a bare `brush.color = …` mid-stroke would paint the raw colour and the
   * adjustment would be lost for the rest of that stroke.
   */
  setStrokeColor(color: string): void {
    if (this.paintedStrokeColor === null || !this.inkContrast) {
      this.color = color;

      return;
    }

    this.requestedStrokeColor = color;
    this.paintedStrokeColor = this.inkContrast.adjust(color);
    this.color = this.paintedStrokeColor;
  }

  /** A dashed stroke restarts its dash pattern on every incremental segment: repaint it whole instead. */
  override needsFullRender(): boolean {
    return super.needsFullRender() || (this.strokeDashArray?.length ?? 0) > 0;
  }

  override _reset(): void {
    super._reset();
    this.penFramePoint = null;
    this.smoother.reset();
    this.lastRawX = Number.NaN;
    this.lastRawY = Number.NaN;
  }

  override _addPoint(point: Point): boolean {
    // Straight-line mode pops and replaces the last point — it wants the raw position, not a filtered
    // one trailing behind it.
    if (!this.smoothing || this.drawStraightLine) {
      return super._addPoint(point);
    }

    // Mirror Fabric's duplicate rule on the RAW sample (the stored point is filtered, so it never equals
    // a repeated raw one). Like Fabric, the first two points may repeat: pen-down records the contact
    // twice on purpose so a tap draws a dot.
    if (this._points.length > 1 && point.x === this.lastRawX && point.y === this.lastRawY) {
      return false;
    }

    this.lastRawX = point.x;
    this.lastRawY = point.y;

    const filtered = this.smoother.next(point.x, point.y, this.canvas.getZoom());

    return super._addPoint(new Point(filtered.x, filtered.y));
  }

  /**
   * Cut a lift-off hook (a few screen px turning sharply against the stroke) before the path
   * is built. Bounded and conservative — see `findLiftHookTrim` — so dots and deliberate flicks are kept.
   */
  private trimLiftHooks(): boolean {
    if (!this.smoothing || this._hasStraightLine) {
      return false;
    }

    const points = this._points;
    const [start, end] = findLiftHookTrim(points, this.canvas.getZoom());

    if (start > 0 || end < points.length - 1) {
      this._points = points.slice(start, end + 1);

      return true;
    }

    return false;
  }

  /**
   * Let the finished stroke reach the last point the pen touched. The smoothing filter trails the pen a
   * little, and when the pen stops (or flicks off) no further sample comes to pull the line the rest of
   * the way — so the committed stroke ended short of where the ink was written, most visibly at the tail
   * of a quick «2» or «z». Add that last raw point (unless the end was just cut as a lift hook).
   */
  private reachLastSample(): void {
    if (!this.smoothing || this._hasStraightLine || this._points.length < 2) return;
    if (!Number.isFinite(this.lastRawX) || !Number.isFinite(this.lastRawY)) return;

    const last = this._points[this._points.length - 1];
    const zoom = this.canvas.getZoom() || 1;

    if (Math.hypot(last.x - this.lastRawX, last.y - this.lastRawY) * zoom < 0.25) return;

    // Straight into the stroke, past the filter (the point is where the pen really was).
    this.smoothing = false;

    try {
      this._addPoint(new Point(this.lastRawX, this.lastRawY));
    } finally {
      this.smoothing = true;
    }
  }

  override onMouseDown(pointer: Point, eventData: TEvent): void {
    // A secondary touch is ignored by Fabric (`_isMainEvent`); it must not restart the hold either.
    const isMainEvent = this.canvas._isMainEvent(eventData.e);

    // BEFORE Fabric's own mouse-down: `_prepareForDrawing` copies `color` into the top context's
    // strokeStyle and paints the first dot, so the adjusted colour has to be in place by then for the
    // live preview to match the committed stroke.
    if (isMainEvent && this.inkContrast) {
      this.restoreRequestedColor();
      this.inkContrast.strokeStart(this.canvas, pointer.x, pointer.y);
      this.requestedStrokeColor = String(this.color);
      this.paintedStrokeColor = this.inkContrast.adjust(this.requestedStrokeColor);
      this.color = this.paintedStrokeColor;
    }

    super.onMouseDown(pointer, eventData);

    if (this.strokeInterceptor && isMainEvent) {
      this.strokeInterceptor.strokeStart(this, pointer, eventData.e);
    }
  }

  /**
   * The pen frame's own last sample (scene coords), resolved by the host from the real PointerEvent with
   * the same nib/tilt correction as the frame's other samples. Fabric's next move — its twin touchmove /
   * compat mousemove for the same frame — uses THIS instead of the point it resolved from the twin, so
   * the whole line comes from one coordinate channel. Consumed once; ignored when stale.
   */
  private penFramePoint: Point | null = null;
  private penFramePointAt = 0;

  /**
   * Called when Fabric's own point for a pen frame disagreed with the pen's sample by more than
   * {@link PEN_FRAME_MISMATCH_SCREEN_PX} (dx/dy in scene px). Diagnostics only: the pen's sample is used.
   */
  onPenFrameMismatch: ((dx: number, dy: number) => void) | null = null;

  notePenFramePoint(point: Point): void {
    this.penFramePoint = point;
    this.penFramePointAt = Date.now();
  }

  private takePenFramePoint(): Point | null {
    const point = this.penFramePoint;

    this.penFramePoint = null;

    if (!point || Date.now() - this.penFramePointAt > PEN_FRAME_POINT_FRESH_MS) return null;

    return point;
  }

  override onMouseMove(pointer: Point, eventData: TEvent): void {
    const framePoint = this.takePenFramePoint();

    if (framePoint) {
      const dx = pointer.x - framePoint.x;
      const dy = pointer.y - framePoint.y;

      if (Math.hypot(dx, dy) * (this.canvas.getZoom() || 1) > PEN_FRAME_MISMATCH_SCREEN_PX) {
        this.onPenFrameMismatch?.(dx, dy);
      }

      pointer = framePoint;
    }

    if (this.strokeInterceptor?.strokeSample(this, pointer, eventData.e)) {
      return;
    }

    super.onMouseMove(pointer, eventData);
  }

  override _finalizeAndAddPath(): void {
    try {
      if (!this.trimLiftHooks()) this.reachLastSample();

      if (this.strokeInterceptor?.strokeFinalize(this)) {
        return;
      }

      super._finalizeAndAddPath();
    } finally {
      // After the path (or the snapped shape) has been created with the painted colour.
      this.restoreRequestedColor();
      this.inkContrast?.strokeEnd();
    }
  }

  /**
   * Put `color` back to what the host asked for — unless something else wrote `color` since the
   * stroke started (a tool-state pass applying a new palette colour), in which case that write is the
   * newer truth and stays.
   */
  private restoreRequestedColor(): void {
    if (this.paintedStrokeColor !== null && this.requestedStrokeColor !== null && this.color === this.paintedStrokeColor) {
      this.color = this.requestedStrokeColor;
    }

    this.requestedStrokeColor = null;
    this.paintedStrokeColor = null;
  }

  /**
   * Append one buffered digitizer sample to the stroke in progress and, for an incremental brush, draw
   * its segment on the top canvas right away.
   *
   * WHY IT MUST DRAW. Fabric's `onMouseMove` incremental branch paints exactly ONE segment per call: from
   * `oldEnd` to the midpoint of the last two points. A sample that is only appended to `_points` is
   * therefore skipped by the live preview, and the next frame stitches a straight chord across it. Under
   * any slow frame — an Intel HD 530 compositing a PDF page, say — the live stroke degrades into a
   * jagged polyline that only turns smooth at pen-up, when `_finalizeAndAddPath` builds the real path
   * from every point. Drawing each sample's segment here, exactly the way Fabric draws the frame's own,
   * keeps the preview continuous and advances `oldEnd`, so Fabric's following move continues from the
   * right place instead of double-drawing.
   *
   * Full-render brushes (calligraphy, marker, highlighter — `needsFullRender()` true) still only
   * accumulate: their `_render()` repaints the whole stroke from `_points` on the frame's own move, so
   * the appended samples are covered there and a per-sample repaint would be pure waste.
   */
  appendCoalescedSample(point: Point, pressure?: number): void {
    if (pressure !== undefined) this.notePressure(pressure);

    if (this.strokeInterceptor?.strokeSample(this, point, undefined)) {
      return;
    }

    if (!this._addPoint(point) || this._points.length < 2) {
      return;
    }

    if (this.needsFullRender()) {
      return;
    }

    const points = this._points;
    const length = points.length;
    const ctx = this.canvas.contextTop;
    const from = this.oldEnd ?? points[length - 2];

    this._saveAndTransform(ctx);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    this.oldEnd = PencilBrush.drawSegment(ctx, points[length - 2], points[length - 1]);
    ctx.stroke();
    ctx.restore();
  }
}
