import { Shadow } from 'fabric';

import type { Path, PencilBrush } from 'fabric';

import { LowLatencyPencilBrush } from './LowLatencyPencilBrush';

/**
 * A felt-tip marker: one constant width, a softly blurred edge, and colour that builds up where
 * strokes cross — the second of the two myViewBoard-style brushes.
 *
 * Unlike the calligraphy brush this keeps Fabric's ordinary stroked path (constant width is exactly
 * what a stroked path is). The felt-tip character comes from two things: a slight transparency, so
 * overlapping strokes darken the way real marker ink does, and a same-colour blur around the stroke,
 * which softens the edge without changing where the line sits.
 *
 * The blur is a `Shadow` with no offset — an even halo rather than a drop shadow. It is deliberately
 * small: a wide blur reads as a glow, and glow is not what a marker looks like.
 */

/** Ink transparency. High enough to read as solid, low enough that crossings visibly darken. */
export const SOFT_MARKER_OPACITY = 0.82;
/** Edge blur, as a fraction of the stroke width. */
const EDGE_SOFTNESS = 0.32;
/** Marker nibs are broader than a pen tip; this is the multiplier on the configured pen width. */
export const SOFT_MARKER_WIDTH_SCALE = 2.2;

/** The marker's edge blur radius (scene px) for a nib `width` — shared with hold-to-snap shapes. */
export const softMarkerBlur = (width: number): number => Math.max(1, width * EDGE_SOFTNESS);

export class SoftMarkerBrush extends LowLatencyPencilBrush {
  /** Blur radius for the current width, in scene px. */
  private get blur(): number {
    return softMarkerBlur(this.width);
  }

  /**
   * Always take Fabric's full-render path, never its incremental one.
   *
   * This was previously true only by accident. `needsFullRender()` was inherited from `BaseBrush`,
   * which returns true merely because this brush's colour carries alpha < 1 — so the marker's
   * correctness depended on the palette. `withAlpha` returns its input unchanged for any colour that
   * is neither `#rrggbb` nor `rgb(...)`, so a named colour, or any future caller that sets `color`
   * directly, silently dropped the marker onto the incremental branch.
   *
   * That branch is the bug factory: it never clears the top canvas for the life of the stroke, and it
   * only calls `ctx.beginPath()` once `oldEnd` exists — so a stale `oldEnd` bridges a straight line
   * from where the previous stroke stopped to wherever the pen now is. Neither artifact is in
   * `_points`, so neither is committed, and both vanish on lift when `_finalizeAndAddPath` clears the
   * top canvas. It also strokes at a flat `lineWidth` with no shadow, which is not a marker at all.
   *
   * Pin it to true rather than depending on a colour string parsing the way we expect.
   */
  override needsFullRender(): boolean {
    return true;
  }

  override _render(): void {
    const ctx = this.canvas.contextTop;

    // Fabric clears the top canvas for full-render brushes on mouse MOVE, but NOT on mouse DOWN
    // (`PencilBrush.onMouseDown` calls `_render()` with no clear) and not when the canvas repaints the
    // top layer itself. Clear here so every call site is covered and a stroke can never start on top
    // of another tool's leftovers — the eraser's full-board preview blit above all, which is
    // pixel-identical to the live board except inside the erased region, where it still holds the
    // un-erased ink. Fabric will not do it for us: `renderAll()` skips clearing contextTop while
    // `isDrawingMode` is true.
    this.canvas.clearContext(ctx);

    // Reset the context's current path BEFORE the early return below, not just via super._render().
    // `clearContext` is a plain `clearRect`: it erases pixels and leaves the path untouched, so on a
    // frame with nothing to draw the raw `contextTop.moveTo(pointer)` that `PencilBrush._prepareForDrawing`
    // wrote — in SCENE coordinates, outside `_saveAndTransform`, so well off-screen at zoom > 1 — would
    // stay live and the next `ctx.stroke()` anywhere would draw a line to it.
    ctx.beginPath();

    // `PencilBrush._render` reads `_points[0]` unguarded and throws on an empty array — which would
    // escape between the save() and restore() below and strand the viewport transform on the top
    // canvas. After that `clearContext` only ever clears a sub-rectangle of it, leaving permanent
    // residue. Nothing to draw is not an error; the canvas is already clean, so just leave.
    if (this._points.length === 0) return;

    ctx.save();

    // Soften the live preview too, otherwise the stroke visibly changes character the moment it is
    // committed — which reads as a glitch even though the final result is correct.
    //
    // `shadowBlur` is in DEVICE px and is not touched by the viewport transform, while the stroke itself
    // is drawn under it. So the blur has to be scaled by hand or the halo stays a fixed size on screen
    // while the ink grows and shrinks with zoom — exactly the factor `BaseBrush._setShadow` applies for
    // the same reason.
    ctx.shadowColor = this.paintColorFor(ctx);
    ctx.shadowBlur = this.blur * this.canvas.getZoom() * this.canvas.getRetinaScaling();
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    try {
      super._render();
    } finally {
      ctx.restore();
    }
  }

  override createPath(pathData: Parameters<PencilBrush['createPath']>[0]): Path {
    const path = super.createPath(pathData);

    path.set({
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      // `affectStroke` is REQUIRED here. It defaults to false, and this path is stroke-only (`fill` is
      // null), so without it Fabric strips the shadow before stroking and the committed mark has no
      // halo at all — the blur the teacher watched while drawing vanished the instant they lifted the
      // pen. `PencilBrush.createPath` sets the same flag on its own brush shadows.
      shadow: new Shadow({ color: this.color, blur: this.blur, offsetX: 0, offsetY: 0, affectStroke: true }),
    });

    return path;
  }
}
