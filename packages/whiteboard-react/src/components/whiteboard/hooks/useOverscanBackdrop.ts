import { useCallback, useEffect, useRef } from 'react';

import type { RefObject } from 'react';

import type { Canvas, FabricObject } from 'fabric';

import type { BackgroundType } from '../types';
import { currentBoardBaseColor } from '../utils/backgroundLayers';
import { boardPatternColor, registerDarkBoardSurface } from '../utils/darkBoard';
import { scheduleQuietIdleWork, type QuietIdleHandle } from '../utils/idleWork';
import { isPointerDown, millisecondsSinceLastInput } from '../utils/inputActivity';
import { createInkLedger, sceneRectToBackdropPixels, type SceneRect } from '../utils/backdropInkLedger';
import { isLockedImage } from '../utils/lockedImages';
import {
  backdropNeedsRefresh,
  backdropPaintTransform,
  backdropPatternTile,
  placeBackdrop,
  planBackdrop,
  resolveBackdropBudget,
  sceneRectIntersectsPlan,
  type BackdropPlan,
} from '../utils/overscanBackdrop';
import { recordPerf } from '../utils/perfHud';

/**
 * Keeps the low-resolution "overscan backdrop" (see utils/overscanBackdrop) behind the crisp layers.
 *
 * ## Never on the hot path
 *
 * - A refresh is only ever STARTED from the quiet-idle scheduler: no contact on the glass, no input
 *   for {@link BACKDROP_QUIET_MS}, and no gesture preview (CSS transform) in flight — a momentum fling
 *   is not input, so the zoom layer's transform is checked too.
 * - The ink is rendered in `requestIdleCallback` slices of at most {@link SLICE_BUDGET_MS}. Before every
 *   slice the job checks for a contact, a live gesture/fling, or input in the last
 *   {@link SLICE_INPUT_GAP_MS} (a hovering pen) and PAUSES if so; a content change drops it. Pen input
 *   therefore never waits on more than one slice that had already started.
 * - The two uncuttable blits — compose (background + one drawImage of the ink) and blur — each get
 *   their own idle callback with at least {@link BLIT_MIN_IDLE_MS} of idle time left. Until compose
 *   the PREVIOUS backdrop stays up: stale on ADDITIONS is fine, blank is not.
 * - Added ink (on screen, under the crisp layers) waits {@link CONTENT_QUIET_MS} of quiet instead of
 *   rebuilding after every stroke; a viewport that is no longer covered waits only
 *   {@link BACKDROP_QUIET_MS}; ink wiped by a removal waits {@link HOLE_QUIET_MS}.
 *
 * ## Never shows ink that no longer exists
 *
 * Background (board colour, pattern, PDF page, pins) and ink are TWO canvases. Every object drawn into
 * the ink layer is in a ledger (utils/backdropInkLedger) with the scene rect it was drawn at; a removal,
 * a modification (its OLD rect) or a pixel-eraser stroke `clearRect`s that rect on the ink layer
 * synchronously, inside the Fabric event — one clearRect on a transparent canvas, cheap enough for an
 * eraser drag. Neighbouring ink inside the rect goes missing until the rebuild; never wrong ink.
 * - Between refreshes it is only REPOSITIONED (one style write) when the committed viewport moves.
 *
 * ## Memory
 *
 * Two resident canvases of at most `maxPixels` each (≤ 1.6 MP ≈ 6.4 MB per layer; 1.0 / 0.55 MP on
 * 4 GB / 2 GB devices), plus a same-sized ink scratch that exists only while a refresh is being built.
 */

const BACKDROP_QUIET_MS = 500;
const SLICE_BUDGET_MS = 6;
const FALLBACK_SLICE_DELAY_MS = 16;
/** A slice never starts within this long of the last input event (a hovering pen is about to land). */
const SLICE_INPUT_GAP_MS = 150;
/** How long a paused job waits before looking again. */
const SLICE_PAUSE_MS = 250;
/** Content-only rebuilds (the viewport is still covered) wait for this much quiet. */
const CONTENT_QUIET_MS = 2_500;
/** A rebuild after ink was WIPED (erase / delete / move) comes sooner: the hole is missing ink. */
const HOLE_QUIET_MS = 600;
/** Backdrop pixels a wiped rect is grown by: blur spill (1px) + anti-aliasing + rounding. */
const CLEAR_MARGIN_PX = 3;
/** compose/blur each run only in an idle period with at least this much left (rIC grants up to 50). */
const BLIT_MIN_IDLE_MS = 12;
/** Blur radius in BACKDROP pixels; on screen it is scaled by 1/ratio (≈ 2.5–3 CSS px). */
const BLUR_BACKDROP_PX = 1;
const GRID_SIZE = 30;
const LINE_SPACING = 30;

type RenderableObject = FabricObject & {
  _setupCompositeOperation?: (ctx: CanvasRenderingContext2D) => void;
  _setOpacity?: (ctx: CanvasRenderingContext2D) => void;
  drawObject?: (ctx: CanvasRenderingContext2D, forClipping: boolean, context: object) => void;
  excludeFromExport?: boolean;
};

interface BackdropJob {
  /** ink → (idle slices) → compose → blur → done; each phase is its own idle callback. */
  phase: 'ink' | 'compose' | 'blur' | 'done';
  plan: BackdropPlan;
  objects: RenderableObject[];
  index: number;
  generation: number;
  ink: HTMLCanvasElement;
  inkContext: CanvasRenderingContext2D;
  /** The scene rect each rendered object is drawn at — becomes the ledger at compose. */
  drawn: Array<readonly [FabricObject, SceneRect]>;
  startedAt: number;
  workMs: number;
  maxSliceMs: number;
  slices: number;
}

export interface UseOverscanBackdropOptions {
  canvas: Canvas | null;
  containerRef: RefObject<HTMLDivElement | null>;
  zoomLayerRef: RefObject<HTMLDivElement | null>;
  /** The background layer (board colour, pattern, page raster, pins). */
  backdropCanvasRef: RefObject<HTMLCanvasElement | null>;
  /** The ink layer, stacked right above the background layer. */
  backdropInkCanvasRef: RefObject<HTMLCanvasElement | null>;
  /** Live getter (a ref read) so a pattern change never re-creates the hook's callbacks. */
  getBackgroundType: () => BackgroundType;
  /** Live getter for the pattern spacing in board px (utils/paperSpacing); absent = the original 30 px. */
  getBackgroundSpacing?: () => number | undefined;
  /**
   * Paint the page image (PDF / slide raster) and pinned images into the backdrop context, in scene
   * space, using `backdropPaintTransform(plan)` as the viewport transform and `plan.ratio` as the pixel
   * ratio — the same recipe the live background layer uses with the real transform and the DPR.
   */
  paintPage: (ctx: CanvasRenderingContext2D, plan: BackdropPlan) => void;
  /**
   * Never show the backdrop. Set by the page-covers-view modes (`lockZoomToPage`, the continuous PDF
   * layout): there the viewport is clamped to the page, so no gesture can reveal anything beyond it —
   * and in the scroll layout the backdrop would paint ONE page's raster where the next page belongs.
   */
  disabled?: boolean;
}

export interface OverscanBackdropHandle {
  /** Content changed: rebuild at the next quiet moment. `hide` also takes the current one down (page switch). */
  invalidate: (options?: { hide?: boolean }) => void;
}

const readDeviceMemory = (): number | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

const isDisposed = (canvas: Canvas): boolean =>
  (canvas as Canvas & { lowerCanvasEl?: HTMLCanvasElement | null }).lowerCanvasEl == null;

const isEraserStroke = (object: FabricObject | undefined): boolean =>
  (object as (FabricObject & { globalCompositeOperation?: string }) | undefined)?.globalCompositeOperation ===
  'destination-out';

const sceneRectOf = (object: FabricObject): SceneRect | null => {
  try {
    const rect = object.getBoundingRect();

    return Number.isFinite(rect.left + rect.top + rect.width + rect.height) ? rect : null;
  } catch {
    return null;
  }
};

function paintPattern(ctx: CanvasRenderingContext2D, plan: BackdropPlan, type: BackgroundType, spacing?: number): void {
  if (type === 'blank') return;

  const tile = backdropPatternTile(plan, spacing !== undefined && spacing > 0 ? spacing : type === 'lined' ? LINE_SPACING : GRID_SIZE);

  if (!tile) return;

  const tileCanvas = document.createElement('canvas');

  tileCanvas.width = tile.tilePx;
  tileCanvas.height = tile.tilePx;

  const tileContext = tileCanvas.getContext('2d');

  if (!tileContext) return;

  tileContext.fillStyle = boardPatternColor();

  if (type === 'grid') {
    tileContext.fillRect(0, 0, tile.tilePx, 1);
    tileContext.fillRect(0, 0, 1, tile.tilePx);
  } else if (type === 'lined') {
    tileContext.fillRect(0, 0, tile.tilePx, 1);
  } else {
    // A dot centred on every corner: four quarter-discs that join up across tile seams.
    const radius = Math.max(0.6, 1.5 * plan.zoom * plan.ratio);

    for (const [cx, cy] of [
      [0, 0],
      [tile.tilePx, 0],
      [0, tile.tilePx],
      [tile.tilePx, tile.tilePx],
    ]) {
      tileContext.beginPath();
      tileContext.arc(cx, cy, radius, 0, Math.PI * 2);
      tileContext.fill();
    }
  }

  const pattern = ctx.createPattern(tileCanvas, 'repeat');

  if (!pattern) return;

  // Without CanvasPattern.setTransform the tile cannot be pinned to the scene origin; a drifting
  // pattern under real ink would read as wrong, so leave the board plain instead.
  if (typeof pattern.setTransform !== 'function' || typeof DOMMatrix === 'undefined') return;

  pattern.setTransform(new DOMMatrix([tile.scale, 0, 0, tile.scale, tile.translateX, tile.translateY]));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, plan.pixelWidth, plan.pixelHeight);
  ctx.restore();
}

/** Render one top-level object into the backdrop's ink scratch (context already in backdrop space). */
function renderObject(ctx: CanvasRenderingContext2D, object: RenderableObject): void {
  // Fabric's own `render()` would cull against the LIVE viewport (`skipOffscreen`) — the very thing
  // this layer exists to get around — and, for an uncached object, throw away its cache canvas. So
  // replay its body directly: composite op (keeps pixel-eraser strokes erasing ink only, since this
  // scratch holds ink alone), transform, opacity, then the uncached draw.
  ctx.save();
  object._setupCompositeOperation?.(ctx);
  object.transform(ctx);
  object._setOpacity?.(ctx);
  object.drawObject?.(ctx, false, {});
  ctx.restore();
}

export function useOverscanBackdrop({
  backdropCanvasRef,
  backdropInkCanvasRef,
  canvas,
  containerRef,
  getBackgroundType,
  getBackgroundSpacing,
  paintPage,
  zoomLayerRef,
  disabled = false,
}: UseOverscanBackdropOptions): OverscanBackdropHandle {
  const planRef = useRef<BackdropPlan | null>(null);
  const disabledRef = useRef(disabled);

  disabledRef.current = disabled;
  const placedSignatureRef = useRef('');
  // Bumped by every content change; a job built for an older generation is thrown away.
  const generationRef = useRef(0);
  const builtGenerationRef = useRef(-1);
  const jobRef = useRef<BackdropJob | null>(null);
  const sliceHandleRef = useRef<{ kind: 'idle' | 'timeout'; id: number } | null>(null);
  const idleHandleRef = useRef<QuietIdleHandle | null>(null);
  const budgetRef = useRef(resolveBackdropBudget(readDeviceMemory()));
  const getBackgroundTypeRef = useRef(getBackgroundType);
  const getBackgroundSpacingRef = useRef(getBackgroundSpacing);
  const paintPageRef = useRef(paintPage);
  const ledgerRef = useRef(createInkLedger<FabricObject>());
  // Ink was wiped from the layer since the last compose: rebuild on the shorter HOLE_QUIET_MS.
  const inkHoleRef = useRef(false);

  getBackgroundTypeRef.current = getBackgroundType;
  getBackgroundSpacingRef.current = getBackgroundSpacing;
  paintPageRef.current = paintPage;

  const isGestureLive = useCallback(() => {
    const layer = zoomLayerRef.current;

    return Boolean(layer && layer.style.transform);
  }, [zoomLayerRef]);

  const isBusy = useCallback(() => isPointerDown() || isGestureLive(), [isGestureLive]);

  const cancelSlice = useCallback(() => {
    const handle = sliceHandleRef.current;

    if (!handle) return;

    if (handle.kind === 'idle' && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(handle.id);
    } else {
      window.clearTimeout(handle.id);
    }

    sliceHandleRef.current = null;
  }, []);

  const dropJob = useCallback(() => {
    cancelSlice();

    const job = jobRef.current;

    if (job) {
      // A zero-sized canvas hands its backing store back immediately.
      job.ink.width = 0;
      job.ink.height = 0;
      jobRef.current = null;
    }
  }, [cancelSlice]);

  /** Position the current backdrop for the committed viewport (scene-anchored). */
  const place = useCallback(() => {
    const element = backdropCanvasRef.current;
    const inkElement = backdropInkCanvasRef.current;
    const plan = planRef.current;

    if (!element || !plan || !canvas) return;

    const { scale, x, y } = placeBackdrop(plan, canvas.viewportTransform);
    const signature = `${x.toFixed(2)}|${y.toFixed(2)}|${scale.toFixed(5)}`;

    if (signature === placedSignatureRef.current) return;

    placedSignatureRef.current = signature;
    element.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;

    if (inkElement) {
      inkElement.style.transform = element.style.transform;
    }
  }, [backdropCanvasRef, backdropInkCanvasRef, canvas]);

  const hide = useCallback(() => {
    planRef.current = null;
    placedSignatureRef.current = '';
    ledgerRef.current.clear();

    for (const element of [backdropCanvasRef.current, backdropInkCanvasRef.current]) {
      if (element) {
        element.style.visibility = 'hidden';
      }
    }
  }, [backdropCanvasRef, backdropInkCanvasRef]);

  /** Wipe scene rects from the ink layer NOW (synchronous; one clearRect each). */
  const clearInk = useCallback(
    (rects: readonly SceneRect[]) => {
      const plan = planRef.current;
      const ctx = backdropInkCanvasRef.current?.getContext('2d');

      if (!plan || !ctx || rects.length === 0) return;

      const mapping = {
        originX: plan.sceneLeft,
        originY: plan.sceneTop,
        pixelHeight: plan.pixelHeight,
        pixelWidth: plan.pixelWidth,
        scale: plan.zoom * plan.ratio,
      };

      ctx.setTransform(1, 0, 0, 1, 0, 0);

      for (const rect of rects) {
        const px = sceneRectToBackdropPixels(rect, mapping, CLEAR_MARGIN_PX);

        if (px) {
          ctx.clearRect(px.x, px.y, px.width, px.height);
        }
      }

      inkHoleRef.current = true;
    },
    [backdropInkCanvasRef],
  );

  /** No rect to go by (a change Fabric reported without a target): take the whole ink layer down. */
  const hideInk = useCallback(() => {
    const inkElement = backdropInkCanvasRef.current;

    ledgerRef.current.clear();
    inkHoleRef.current = true;

    if (inkElement) {
      inkElement.style.visibility = 'hidden';
    }
  }, [backdropInkCanvasRef]);

  const needsWork = useCallback((): boolean => {
    const container = containerRef.current;

    if (!canvas || !container) return false;

    return (
      builtGenerationRef.current !== generationRef.current ||
      backdropNeedsRefresh(planRef.current, container.clientWidth, container.clientHeight, canvas.viewportTransform)
    );
  }, [canvas, containerRef]);

  // Assigned below; start/slices/schedule call each other through refs so none of them has to be
  // re-created when another is.
  const scheduleRef = useRef<() => void>(() => {});
  const contentTimerRef = useRef<number | null>(null);

  const runSliceRef = useRef<(deadline?: IdleDeadline) => void>(() => {});

  const queueSlice = useCallback((delayMs?: number) => {
    if (delayMs === undefined && typeof window.requestIdleCallback === 'function') {
      sliceHandleRef.current = {
        id: window.requestIdleCallback((deadline) => runSliceRef.current(deadline), { timeout: 1000 }),
        kind: 'idle',
      };

      return;
    }

    sliceHandleRef.current = {
      id: window.setTimeout(() => runSliceRef.current(), delayMs ?? FALLBACK_SLICE_DELAY_MS),
      kind: 'timeout',
    };
  }, []);

  /**
   * Phase 'compose': swap the new content into the VISIBLE backdrop — board colour → pattern → page
   * raster + pins → the finished ink scratch. From here on the element shows the new plan (unblurred
   * until the 'blur' phase, which is still correct content if a gesture interrupts in between).
   */
  const compose = useCallback(
    (job: BackdropJob): boolean => {
      const element = backdropCanvasRef.current;
      const inkElement = backdropInkCanvasRef.current;
      const ctx = element?.getContext('2d');
      const inkCtx = inkElement?.getContext('2d');

      if (!element || !ctx || !inkElement || !inkCtx) return false;

      const { plan } = job;

      for (const layer of [element, inkElement]) {
        if (layer.width !== plan.pixelWidth || layer.height !== plan.pixelHeight) {
          layer.width = plan.pixelWidth;
          layer.height = plan.pixelHeight;
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.fillStyle = currentBoardBaseColor();
      ctx.fillRect(0, 0, plan.pixelWidth, plan.pixelHeight);
      paintPattern(ctx, plan, getBackgroundTypeRef.current(), getBackgroundSpacingRef.current?.());
      paintPageRef.current(ctx, plan);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      inkCtx.setTransform(1, 0, 0, 1, 0, 0);
      inkCtx.globalAlpha = 1;
      inkCtx.filter = 'none';
      inkCtx.globalCompositeOperation = 'copy';
      inkCtx.drawImage(job.ink, 0, 0);
      inkCtx.globalCompositeOperation = 'source-over';

      planRef.current = plan;
      builtGenerationRef.current = job.generation;
      ledgerRef.current.reset(job.drawn);
      inkHoleRef.current = false;
      placedSignatureRef.current = '';
      place();
      element.style.visibility = 'visible';
      inkElement.style.visibility = 'visible';

      return true;
    },
    [backdropCanvasRef, backdropInkCanvasRef, place],
  );

  /**
   * Phase 'blur': soften it ONCE, here, rather than with a CSS `filter` the compositor would re-run on
   * every gesture frame — copy into the (now spare) ink scratch, blit back through a blur. Where
   * `ctx.filter` is unsupported the 2.5–3× upscale alone keeps it soft.
   */
  const blur = useCallback(
    (job: BackdropJob) => {
      if (planRef.current !== job.plan) return;

      const scratch = job.inkContext;

      // Each layer is blurred from ITS OWN current pixels (not from the job's scratch), so a wipe that
      // landed between compose and here is kept, never painted back.
      for (const element of [backdropInkCanvasRef.current, backdropCanvasRef.current]) {
        const ctx = element?.getContext('2d');

        if (!element || !ctx || !('filter' in ctx)) continue;

        scratch.setTransform(1, 0, 0, 1, 0, 0);
        scratch.globalAlpha = 1;
        scratch.globalCompositeOperation = 'copy';
        scratch.drawImage(element, 0, 0);
        scratch.globalCompositeOperation = 'source-over';
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'copy';
        ctx.filter = `blur(${BLUR_BACKDROP_PX}px)`;
        ctx.drawImage(job.ink, 0, 0);
        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
      }
    },
    [backdropCanvasRef, backdropInkCanvasRef],
  );

  const runSlice = useCallback(
    (deadline?: IdleDeadline) => {
      sliceHandleRef.current = null;

      const job = jobRef.current;

      if (!job) return;

      if (!canvas || isDisposed(canvas)) {
        dropJob();

        return;
      }

      // The content changed under the job: its object list is no longer the page's — publishing it
      // could bring back ink that was just erased. (Once composed, later wipes go straight to the
      // layer and the blur keeps them — finishing it is fine.)
      if ((job.phase === 'ink' || job.phase === 'compose') && job.generation !== generationRef.current) {
        dropJob();
        scheduleRef.current();

        return;
      }

      // A contact is down, a gesture/fling preview is live, or input just arrived (a hovering pen is
      // about to land): PAUSE — keep what is built, look again shortly. Never a slice under the pen.
      if (isBusy() || millisecondsSinceLastInput() < SLICE_INPUT_GAP_MS) {
        queueSlice(SLICE_PAUSE_MS);

        return;
      }

      // compose/blur are single blits that cannot be cut: wait for a properly idle period for them.
      if (job.phase !== 'ink' && deadline && !deadline.didTimeout && deadline.timeRemaining() < BLIT_MIN_IDLE_MS) {
        queueSlice();

        return;
      }

      const sliceStart = performance.now();

      if (job.phase === 'ink') {
        const budget = Math.min(SLICE_BUDGET_MS, deadline ? Math.max(1, deadline.timeRemaining()) : SLICE_BUDGET_MS);
        const { inkContext, objects, plan } = job;
        const transform = backdropPaintTransform(plan);
        const r = plan.ratio;

        inkContext.setTransform(r * transform[0], 0, 0, r * transform[3], r * transform[4], r * transform[5]);

        while (job.index < objects.length) {
          const object = objects[job.index];

          job.index += 1;

          // Removed since the job was planned (a removal also bumps the generation; belt and braces).
          if (object.canvas !== canvas) continue;

          try {
            renderObject(inkContext, object);
          } catch {
            // One broken object must not take the backdrop down with it.
          }

          if (performance.now() - sliceStart >= budget) break;
        }

        if (job.index >= objects.length) {
          job.phase = 'compose';
        }
      } else if (job.phase === 'compose') {
        if (!compose(job)) {
          dropJob();

          return;
        }

        job.phase = 'blur';
      } else {
        blur(job);
        job.phase = 'done';
      }

      const sliceMs = performance.now() - sliceStart;

      job.workMs += sliceMs;
      job.maxSliceMs = Math.max(job.maxSliceMs, sliceMs);
      job.slices += 1;

      if (job.phase !== 'done') {
        queueSlice();

        return;
      }

      const { plan } = job;

      recordPerf(
        'backdrop',
        job.workMs,
        `${plan.pixelWidth}x${plan.pixelHeight}@${plan.ratio.toFixed(2)} os=${plan.overscan} objs=${job.objects.length} slices=${job.slices} maxSlice=${job.maxSliceMs.toFixed(1)}ms wall=${(performance.now() - job.startedAt).toFixed(0)}ms`,
      );
      dropJob();

      // The content or the viewport may have moved on while this was being built.
      if (needsWork()) {
        scheduleRef.current();
      }
    },
    [blur, canvas, compose, dropJob, isBusy, needsWork, queueSlice],
  );

  runSliceRef.current = runSlice;

  /** Plan + collect, then render the ink in idle slices. Called only from the quiet-idle scheduler. */
  const start = useCallback(() => {
    const container = containerRef.current;

    if (!canvas || !container || isDisposed(canvas) || jobRef.current) return;

    if (isBusy()) {
      scheduleRef.current();

      return;
    }

    if (!needsWork()) return;

    // Only the CONTENT changed (the viewport is still well covered): what changed is on screen, under
    // the crisp layers, so the backdrop can wait for a real pause in the writing rather than rebuilding
    // half a second after every stroke.
    const sinceInput = millisecondsSinceLastInput();

    if (
      planRef.current &&
      !backdropNeedsRefresh(planRef.current, container.clientWidth, container.clientHeight, canvas.viewportTransform) &&
      sinceInput < (inkHoleRef.current ? HOLE_QUIET_MS : CONTENT_QUIET_MS)
    ) {
      if (contentTimerRef.current === null) {
        contentTimerRef.current = window.setTimeout(
          () => {
            contentTimerRef.current = null;
            scheduleRef.current();
          },
          (inkHoleRef.current ? HOLE_QUIET_MS : CONTENT_QUIET_MS) - sinceInput,
        );
      }

      return;
    }

    const plan = planBackdrop(
      container.clientWidth,
      container.clientHeight,
      canvas.viewportTransform,
      budgetRef.current,
    );

    if (!plan) return;

    const objects: RenderableObject[] = [];
    const drawn: Array<readonly [FabricObject, SceneRect]> = [];
    const wholePlan: SceneRect = {
      height: plan.sceneHeight,
      left: plan.sceneLeft,
      top: plan.sceneTop,
      width: plan.sceneWidth,
    };

    for (const object of canvas.getObjects() as RenderableObject[]) {
      if (object.visible === false || (object.opacity ?? 1) <= 0 || object.excludeFromExport || isLockedImage(object)) {
        continue;
      }

      const rect = sceneRectOf(object);

      if (rect && !sceneRectIntersectsPlan(plan, rect)) continue;

      objects.push(object);
      // No usable coords → it is rendered anyway (never drop real ink), and its removal wipes the
      // whole layer rather than leave it behind.
      drawn.push([object, rect ?? wholePlan]);
    }

    const ink = document.createElement('canvas');

    registerDarkBoardSurface(ink);

    ink.width = plan.pixelWidth;
    ink.height = plan.pixelHeight;

    const inkContext = ink.getContext('2d');

    if (!inkContext) return;

    jobRef.current = {
      drawn,
      generation: generationRef.current,
      index: 0,
      ink,
      inkContext,
      maxSliceMs: 0,
      objects,
      phase: 'ink',
      plan,
      slices: 0,
      startedAt: performance.now(),
      workMs: 0,
    };
    queueSlice();
  }, [canvas, containerRef, isBusy, needsWork, queueSlice]);

  const startRef = useRef(start);

  startRef.current = start;

  scheduleRef.current = () => {
    if (disabledRef.current || jobRef.current) return;

    const handle = idleHandleRef.current;

    if (handle) {
      handle.reschedule(() => startRef.current());

      return;
    }

    idleHandleRef.current = scheduleQuietIdleWork(() => startRef.current(), {
      isBusy,
      msSinceInput: millisecondsSinceLastInput,
      quietMs: BACKDROP_QUIET_MS,
    });
  };

  const invalidate = useCallback(
    (options?: { hide?: boolean }) => {
      generationRef.current += 1;

      if (options?.hide) {
        dropJob();
        hide();
      }

      scheduleRef.current();
    },
    [dropJob, hide],
  );

  useEffect(() => {
    if (!canvas) return;

    // Disabled: nothing is ever built or shown, and whatever an earlier mode left up comes down now.
    if (disabled) {
      dropJob();
      hide();

      return;
    }

    // Every committed frame: follow the viewport (cheap, deduped) and queue a rebuild when it no longer
    // covers enough around the viewport. During a CSS gesture preview Fabric does not render at all,
    // so this never runs per gesture frame; during a stroke the viewport is unchanged and it is a
    // string compare.
    const handleAfterRender = () => {
      place();

      if (!jobRef.current && needsWork()) {
        scheduleRef.current();
      }
    };
    type FabricEvent = { target?: FabricObject };

    const handleAdded = (event: FabricEvent) => {
      generationRef.current += 1;

      // A pixel-eraser stroke punches whatever ink is drawn under it.
      const target = event?.target;

      if (target) {
        const rect = ledgerRef.current.onAdded(target, isEraserStroke(target), sceneRectOf(target));

        if (rect) clearInk([rect]);
      }
    };
    const handleRemoved = (event: FabricEvent) => {
      generationRef.current += 1;

      const target = event?.target;

      if (!target) {
        hideInk();

        return;
      }

      const rect = ledgerRef.current.onRemoved(target);

      if (rect) clearInk([rect]);
    };
    const handleModified = (event: FabricEvent) => {
      generationRef.current += 1;

      const target = event?.target as (FabricObject & { getObjects?: () => FabricObject[] }) | undefined;

      if (!target) {
        hideInk();

        return;
      }

      // A multi-selection is not itself on the canvas: its members are what was drawn.
      const members =
        typeof target.getObjects === 'function' && !canvas.getObjects().includes(target)
          ? target.getObjects()
          : [target];

      clearInk(ledgerRef.current.onModified(members));
    };
    const handleCleared = () => {
      // A page load / undo restore swaps the whole object list: an old page outside the viewport would
      // be WRONG content, which is worse than none.
      generationRef.current += 1;
      dropJob();
      hide();
    };

    canvas.on('after:render', handleAfterRender);
    canvas.on('object:added', handleAdded);
    canvas.on('object:removed', handleRemoved);
    canvas.on('object:modified', handleModified);
    canvas.on('canvas:cleared', handleCleared);
    generationRef.current += 1;
    scheduleRef.current();

    return () => {
      canvas.off('after:render', handleAfterRender);
      canvas.off('object:added', handleAdded);
      canvas.off('object:removed', handleRemoved);
      canvas.off('object:modified', handleModified);
      canvas.off('canvas:cleared', handleCleared);
      idleHandleRef.current?.cancel();
      idleHandleRef.current = null;

      if (contentTimerRef.current !== null) {
        window.clearTimeout(contentTimerRef.current);
        contentTimerRef.current = null;
      }

      dropJob();
      hide();
    };
  }, [canvas, clearInk, disabled, dropJob, hide, hideInk, needsWork, place]);

  // Release the resident backing store when the board goes away.
  useEffect(
    () => () => {
      for (const element of [backdropCanvasRef.current, backdropInkCanvasRef.current]) {
        if (element) {
          element.width = 0;
          element.height = 0;
        }
      }
    },
    [backdropCanvasRef, backdropInkCanvasRef],
  );

  return { invalidate };
}
