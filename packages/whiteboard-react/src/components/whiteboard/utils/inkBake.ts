import { isPointerDown, millisecondsSinceLastInput } from './inputActivity';
import { scheduleQuietIdleWork, type QuietIdleHandle } from './idleWork';
import { registerDarkBoardSurface } from './darkBoard';
import { perfSpan } from './perfSpan';
import { recordPerf } from './perfHud';

import type { Canvas, FabricObject } from 'fabric';

/**
 * Render-only "ink bake": a prefix of the object list is pre-rasterised into ONE offscreen bitmap
 * and blitted once per frame, so a pen lift no longer costs a re-render of every stroke on the page.
 *
 * ## Why
 *
 * Measured on a Win10 VM imitating the studio PC (2 slow cores, software GPU): a page holding 1,152
 * `Path` objects spent 88–120 ms on the main thread at EVERY pen lift, because `path:created` ends in
 * `requestRenderAll()` and Fabric's `renderCanvas` re-renders the whole object list onto the lower
 * canvas. Every other cost on that path (page save, cloud sync) is already ≤ 50 ms. The render is the
 * remaining one, and it grows with the ink — exactly the shape a teacher notices late in a lesson.
 *
 * ## What changes, and what deliberately does not
 *
 * ONLY the lower-canvas paint. The object list, `toJSON`, history, selection, hit-testing, the erasers
 * and every export path are untouched: the bake is consulted inside `_renderObjects` and nowhere else,
 * and only when the context being painted IS the canvas's own lower canvas. `toCanvasElement` (and so
 * `toDataURL` / `toBlob` / the page export snapshot / thumbnails) renders into a FRESH canvas element
 * with retina scaling off, so `ctx.canvas !== canvas.getElement()` and the bake is skipped there by
 * construction — exports keep rendering every object at full fidelity.
 *
 * ## Why the bake includes the background and blits with `copy`
 *
 * A partial ("pixel") erase does not remove anything: it commits a `Path` with
 * `globalCompositeOperation: 'destination-out'` that punches every fabric pixel BELOW it — background
 * included. An ink-only bitmap composited with `source-over` could not reproduce that: a
 * destination-out object inside the baked prefix would have erased only the ink baked before it, never
 * the background beneath. So a bake is built exactly the way `renderCanvas` builds a frame — clear,
 * `_renderBackground`, then the prefix under the viewport transform — and blitted with `copy`, which
 * replaces everything painted so far. The result is pixel-identical to the normal path by
 * construction, for any mix of composite operations. (On this board the fabric canvas is transparent
 * and the PDF page / pinned images live on a separate canvas BELOW it — see `backgroundLayers.ts` —
 * so the background half is usually a no-op. It is still done, because `setBackgroundImage` exists.)
 *
 * ## Validity
 *
 * A bake is a promise that objects `[0, k)` still paint exactly as they did when it was made. That is
 * re-checked on EVERY frame against object identity (catches removal, reorder, undo, `loadFromJSON`,
 * page switch), the `dirty` flag, `visible`, `opacity`, the viewport transform, retina scaling, the
 * canvas size and the background fingerprint. Anything off → that frame renders normally, and a fresh
 * bake is scheduled for the next quiet moment. The one exception is a viewport that only SCROLLED by
 * whole device pixels: the bitmap is shifted in place and just the revealed strips are painted
 * (`scrollBake`), which keeps it exactly what a full render would paint.
 *
 * `dirty` alone is NOT enough and the code does not pretend otherwise: Fabric only sets it for
 * `cacheProperties`, so moving or scaling a baked object (`left`, `top`, `scaleX`, …) would never raise
 * it. Hence the explicit `object:moving` / `scaling` / `rotating` / `skewing` / `modified` /
 * `removed` / `selection:*` invalidations below. `dirty` is kept as the cheap extra net for fill,
 * stroke and shadow edits that arrive without an event.
 */

/** A Fabric object, reduced to the properties the validity check reads (so tests need no Fabric). */
export interface BakeableObject {
  dirty?: boolean;
  visible?: boolean;
  opacity?: number;
}

export interface InkBakeOptions {
  /** Below this many objects a bake is never built — the normal render is already cheap. */
  minObjects?: number;
  /** Once this many unbaked objects trail the prefix, the bake is extended incrementally. */
  maxTail?: number;
}

export interface ResolvedInkBakeOptions {
  minObjects: number;
  maxTail: number;
}

export interface InkBakeStats {
  /** Whether the most recent lower-canvas frame actually used the bake. */
  enabled: boolean;
  /** Objects covered by the current bake. */
  baked: number;
  /** Objects on the canvas at that moment. */
  total: number;
  /** How many bakes (full + incremental) have been built. */
  bakes: number;
  /** Duration of the most recent bake, in milliseconds. */
  lastBakeMs: number;
}

export interface InkBakeHandle {
  /** Mark the bake stale: the next frame renders normally and a rebake is scheduled. */
  invalidate(): void;
  /** Ask for a bake at the next quiet idle moment (debounced — at most one is ever pending). */
  scheduleBake(): void;
  getStats(): InkBakeStats;
  /** Restore the original `_renderObjects`, drop listeners and release the bitmap. */
  dispose(): void;
}

/** Identity of the canvas background, as far as painting is concerned. */
export interface BackgroundFingerprint {
  color: unknown;
  image: unknown;
  /** The `<img>`/canvas element behind a `FabricImage` — `setSrc` swaps this without a new object. */
  element: unknown;
  vpt: boolean;
  /** Geometry + paint props of the background image that Fabric does NOT flag as `dirty`. */
  geometry: string;
}

/** Everything about the frame being painted that a bake has to match. */
export interface BakeFrameInfo {
  /** Whether the context belongs to the canvas's own lower canvas element. */
  isLowerCanvas: boolean;
  width: number;
  height: number;
  /** The viewport transform, all six numbers. */
  transform: readonly number[];
  retina: number;
  background: BackgroundFingerprint;
}

/** What a built bake remembers, so the next frame can prove it is still true. */
export interface BakeValidityState {
  /** The baked objects, by identity. */
  objects: readonly BakeableObject[];
  visible: readonly boolean[];
  opacity: readonly number[];
  transform: readonly number[];
  retina: number;
  width: number;
  height: number;
  background: BackgroundFingerprint;
  /** Set by `invalidate()`; a stale bake is never used, whatever else matches. */
  stale: boolean;
}

export type BakePlan =
  | { mode: 'none' }
  | { mode: 'full'; from: number; to: number }
  | { mode: 'tail'; from: number; to: number };

/** An axis-aligned box in scene coordinates (Fabric's `getBoundingRect()`). */
export interface SceneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A whole-pixel box on the bake bitmap. */
export interface DeviceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * How far around a removed object's box the bake is repainted, in DEVICE px. Covers what Fabric's
 * `aCoords` leave out of a box: a shadow (the marker's edge blur is a few px; a sticky note's is
 * larger), antialiasing, and the half-pixel the stroke's own edge straddles.
 */
export const REMOVAL_PATCH_PAD_PX = 48;
/**
 * Removals patched in place between two live frames before the bake gives up and goes stale. A
 * `canvas.clear()` removes every object one event at a time — hundreds of small repaints would cost
 * more than the one full render a stale bake falls back to.
 */
export const REMOVAL_PATCH_BUDGET_PER_FRAME = 24;

export const DEFAULT_MIN_OBJECTS = 120;
export const DEFAULT_MAX_TAIL = 8;

/** Input must be quiet for this long before a bake runs — a bake under the pen is the bug, not the fix. */
const BAKE_QUIET_MS = 150;
/** …but a teacher who never pauses must still get a bake. At this point it runs at the next lift. */
const BAKE_MAX_DEFER_MS = 1_500;

export function resolveInkBakeOptions(options?: InkBakeOptions): ResolvedInkBakeOptions {
  return {
    maxTail: Math.max(1, options?.maxTail ?? DEFAULT_MAX_TAIL),
    minObjects: Math.max(1, options?.minObjects ?? DEFAULT_MIN_OBJECTS),
  };
}

const visibilityOf = (object: BakeableObject): boolean => object.visible !== false;
const opacityOf = (object: BakeableObject): number => (typeof object.opacity === 'number' ? object.opacity : 1);

export function sameBackground(a: BackgroundFingerprint, b: BackgroundFingerprint): boolean {
  return (
    a.color === b.color &&
    a.image === b.image &&
    a.element === b.element &&
    a.vpt === b.vpt &&
    a.geometry === b.geometry
  );
}

function sameTransform(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Whether the bitmap described by `state` may be blitted for the frame described by `frame`.
 *
 * Deliberately strict and deliberately O(baked): the per-object loop is a handful of reference and
 * number comparisons (~15 µs for 1,200 objects, measured against the 88–120 ms it replaces) and it is
 * the ONE check that catches removal, reordering, undo, a page switch and an active-selection
 * restack without needing to know that any of those happened.
 */
export function isBakeValid(
  state: BakeValidityState | null,
  frame: BakeFrameInfo,
  objects: readonly BakeableObject[],
): boolean {
  if (state === null || state.stale) {
    return false;
  }

  if (!frame.isLowerCanvas) {
    return false;
  }

  if (state.width !== frame.width || state.height !== frame.height || state.retina !== frame.retina) {
    return false;
  }

  if (!sameTransform(state.transform, frame.transform)) {
    return false;
  }

  if (!sameBackground(state.background, frame.background)) {
    return false;
  }

  const baked = state.objects.length;

  if (objects.length < baked) {
    return false;
  }

  for (let i = 0; i < baked; i += 1) {
    const object = objects[i];

    if (object !== state.objects[i]) {
      return false;
    }

    if (object.dirty === true) {
      return false;
    }

    if (visibilityOf(object) !== state.visible[i] || opacityOf(object) !== state.opacity[i]) {
      return false;
    }
  }

  return true;
}

/**
 * What the next bake should do. `bakedCount` is the size of the CURRENTLY VALID bake, or `null` when
 * there is none (absent, stale or invalidated). Pure, so the escalation rules are unit-testable.
 */
export function planBake(bakedCount: number | null, objectCount: number, options: ResolvedInkBakeOptions): BakePlan {
  if (objectCount < options.minObjects) {
    return { mode: 'none' };
  }

  if (bakedCount === null) {
    return { from: 0, mode: 'full', to: objectCount };
  }

  if (objectCount - bakedCount >= options.maxTail) {
    return { from: bakedCount, mode: 'tail', to: objectCount };
  }

  return { mode: 'none' };
}

/**
 * The validity state with `removed` taken out of the baked prefix — what the bake describes once the
 * pixels it painted have been repainted (see `patchRemoval`). Null when the object was not baked (a
 * tail object: the bake is untouched by its removal) or the state is unusable.
 */
export function dropBakedObject(state: BakeValidityState | null, removed: BakeableObject): BakeValidityState | null {
  if (state === null || state.stale) {
    return null;
  }

  const index = state.objects.indexOf(removed);

  if (index < 0) {
    return null;
  }

  const without = <T>(list: readonly T[]): T[] => [...list.slice(0, index), ...list.slice(index + 1)];

  return {
    ...state,
    objects: without(state.objects),
    opacity: without(state.opacity),
    visible: without(state.visible),
  };
}

/** The scene box of `rect` grown by `pad` on every side. */
export function padSceneRect(rect: SceneRect, pad: number): SceneRect {
  return { height: rect.height + 2 * pad, left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad };
}

export function sceneRectsIntersect(a: SceneRect, b: SceneRect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Where a scene box lands on the bake bitmap: the box's corners through the bake's viewport transform
 * and retina scale, snapped OUT to whole device pixels and clipped to the bitmap. Whole pixels matter:
 * a clip on a fractional edge would blend the repaint with the old pixels along the seam. Null when the
 * box misses the bitmap entirely (nothing of it was ever painted).
 */
export function removalPatchRegion(
  rect: SceneRect,
  bake: Pick<BakeValidityState, 'retina' | 'transform' | 'width' | 'height'>,
): DeviceRect | null {
  const [a, b, c, d, e, f] = bake.transform;
  const corners = [
    [rect.left, rect.top],
    [rect.left + rect.width, rect.top],
    [rect.left, rect.top + rect.height],
    [rect.left + rect.width, rect.top + rect.height],
  ];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [x, y] of corners) {
    const deviceX = (a * x + c * y + e) * bake.retina;
    const deviceY = (b * x + d * y + f) * bake.retina;

    minX = Math.min(minX, deviceX);
    minY = Math.min(minY, deviceY);
    maxX = Math.max(maxX, deviceX);
    maxY = Math.max(maxY, deviceY);
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return null;
  }

  const left = Math.max(0, Math.floor(minX));
  const top = Math.max(0, Math.floor(minY));
  const right = Math.min(bake.width, Math.ceil(maxX));
  const bottom = Math.min(bake.height, Math.ceil(maxY));

  if (right <= left || bottom <= top) {
    return null;
  }

  return { height: bottom - top, left, top, width: right - left };
}

// --- Scrolling a bake ---------------------------------------------------------------------------

/** How close to a whole device pixel a translation must be for the bake to be shifted instead of redrawn. */
const WHOLE_PIXEL_EPSILON = 1e-3;

/**
 * The bake's bitmap moved by a WHOLE number of device pixels and nothing else: the shift that turns the
 * bitmap into the frame's, or null when the frame differs in any other way (scale, rotation, a
 * fractional shift, size, retina) or not at all.
 *
 * WHY WHOLE PIXELS ONLY. Shifting a bitmap by a fractional amount resamples it; every frame of a scroll
 * would resample the previous one and the ink would visibly soften as it scrolls. An integer shift is
 * an exact pixel copy, so the shifted bake stays identical to what a full render would paint. The
 * continuous layout's touch pan snaps its per-frame delta to whole device pixels for exactly this.
 */
export function bakeTranslation(
  bake: Pick<BakeValidityState, 'transform' | 'retina' | 'width' | 'height'>,
  frame: Pick<BakeFrameInfo, 'transform' | 'retina' | 'width' | 'height'>,
): { dx: number; dy: number } | null {
  if (bake.width !== frame.width || bake.height !== frame.height || bake.retina !== frame.retina) {
    return null;
  }

  const a = bake.transform;
  const b = frame.transform;

  if (a.length !== 6 || b.length !== 6 || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]) {
    return null;
  }

  const rawX = (b[4] - a[4]) * frame.retina;
  const rawY = (b[5] - a[5]) * frame.retina;
  const dx = Math.round(rawX);
  const dy = Math.round(rawY);

  if (Math.abs(rawX - dx) > WHOLE_PIXEL_EPSILON || Math.abs(rawY - dy) > WHOLE_PIXEL_EPSILON) {
    return null;
  }

  if (dx === 0 && dy === 0) {
    return null;
  }

  // Shifted completely out of the bitmap: nothing of it survives, a full render is the honest path.
  if (Math.abs(dx) >= frame.width || Math.abs(dy) >= frame.height) {
    return null;
  }

  return { dx, dy };
}

/**
 * One frame of a pan, snapped to whole device pixels so the bake can follow it with {@link bakeTranslation}:
 * the step to pan by (in CSS px, a whole number of device px) and the sub-pixel remainder to carry into
 * the next frame. Over a gesture the total distance is exactly what the finger moved.
 */
export function snapPanStep(
  deltaX: number,
  deltaY: number,
  retina: number,
  carry: { x: number; y: number },
): { x: number; y: number; carry: { x: number; y: number } } {
  const scale = retina > 0 ? retina : 1;
  const wantX = deltaX * scale + carry.x;
  const wantY = deltaY * scale + carry.y;
  const stepX = Math.round(wantX);
  const stepY = Math.round(wantY);

  return { carry: { x: wantX - stepX, y: wantY - stepY }, x: stepX / scale, y: stepY / scale };
}

/**
 * The parts of a `width`×`height` bitmap that a shift by (`dx`, `dy`) leaves uncovered — the strips a
 * scroll reveals, which the old bitmap never painted. At most two, never overlapping: the full-height
 * column first, then the row across what is left.
 */
export function exposedStrips(width: number, height: number, dx: number, dy: number): DeviceRect[] {
  const strips: DeviceRect[] = [];
  const columnWidth = Math.min(width, Math.abs(dx));
  const rowHeight = Math.min(height, Math.abs(dy));

  if (columnWidth > 0) {
    strips.push({ height, left: dx > 0 ? 0 : width - columnWidth, top: 0, width: columnWidth });
  }

  if (rowHeight > 0 && columnWidth < width) {
    strips.push({
      height: rowHeight,
      left: dx > 0 ? columnWidth : 0,
      top: dy > 0 ? 0 : height - rowHeight,
      width: width - columnWidth,
    });
  }

  return strips;
}

/** The scene box a device-pixel rect of a bitmap painted under (`retina`, `transform`) shows. */
export function deviceRectToScene(rect: DeviceRect, retina: number, transform: readonly number[]): SceneRect {
  const [a, b, c, d, e, f] = transform;
  const det = a * d - b * c || 1;
  const corners = [
    [rect.left, rect.top],
    [rect.left + rect.width, rect.top],
    [rect.left, rect.top + rect.height],
    [rect.left + rect.width, rect.top + rect.height],
  ];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [deviceX, deviceY] of corners) {
    const x = deviceX / retina - e;
    const y = deviceY / retina - f;
    const sceneX = (d * x - c * y) / det;
    const sceneY = (a * y - b * x) / det;

    minX = Math.min(minX, sceneX);
    minY = Math.min(minY, sceneY);
    maxX = Math.max(maxX, sceneX);
    maxY = Math.max(maxY, sceneY);
  }

  return { height: maxY - minY, left: minX, top: minY, width: maxX - minX };
}

/** Fabric internals this module reaches into. Named here so the casts below stay honest. */
type BakeCanvas = Canvas & {
  _renderObjects: (ctx: CanvasRenderingContext2D, objects: FabricObject[]) => void;
  _renderBackground: (ctx: CanvasRenderingContext2D) => void;
  clearContext: (ctx: CanvasRenderingContext2D) => void;
  __inkBake?: InkBakeHandle;
};

const BACKGROUND_GEOMETRY_PROPS = [
  'left',
  'top',
  'width',
  'height',
  'scaleX',
  'scaleY',
  'angle',
  'skewX',
  'skewY',
  'flipX',
  'flipY',
  'opacity',
  'visible',
  'originX',
  'originY',
  'cropX',
  'cropY',
] as const;

function fingerprintBackground(canvas: BakeCanvas): BackgroundFingerprint {
  const image = canvas.backgroundImage as (FabricObject & { _element?: unknown }) | undefined;

  return {
    color: canvas.backgroundColor,
    element: image?._element,
    geometry: image
      ? BACKGROUND_GEOMETRY_PROPS.map((key) => String((image as unknown as Record<string, unknown>)[key])).join('|')
      : '',
    image,
    vpt: canvas.backgroundVpt !== false,
  };
}

/**
 * Drop the bake on a canvas without holding a reference to the handle — for the call sites that
 * replace the whole object set (page switch, `loadFromJSON`, history restore). The identity check
 * would catch every one of these on its own; this just saves the one stale frame it takes to notice.
 */
export function invalidateInkBake(canvas: Canvas | null | undefined): void {
  (canvas as BakeCanvas | null | undefined)?.__inkBake?.invalidate();
}

/** Read the live bake stats off a canvas (perf HUD / CDP driver). */
export function readInkBakeStats(canvas: Canvas | null | undefined): InkBakeStats | null {
  return (canvas as BakeCanvas | null | undefined)?.__inkBake?.getStats() ?? null;
}

/** A no-op handle for environments without a DOM (SSR, the node test runner). */
function inertHandle(): InkBakeHandle {
  return {
    dispose: () => undefined,
    getStats: () => ({ baked: 0, bakes: 0, enabled: false, lastBakeMs: 0, total: 0 }),
    invalidate: () => undefined,
    scheduleBake: () => undefined,
  };
}

/**
 * Install the ink bake on one Fabric canvas. Call `dispose()` before `canvas.dispose()`.
 */
export function installInkBake(canvas: Canvas, options?: InkBakeOptions): InkBakeHandle {
  if (typeof document === 'undefined') {
    return inertHandle();
  }

  const resolved = resolveInkBakeOptions(options);
  const target = canvas as BakeCanvas;

  // `_renderObjects` lives on the prototype; bind it now so the override can delegate, and remember
  // whether anyone else had already parked an own-property version on this instance.
  const hadOwnRenderObjects = Object.prototype.hasOwnProperty.call(target, '_renderObjects');
  const previousOwnRenderObjects = hadOwnRenderObjects ? target._renderObjects : undefined;
  const renderObjectsOriginal = target._renderObjects.bind(target);

  let bakeCanvas: HTMLCanvasElement | null = null;
  let bakeContext: CanvasRenderingContext2D | null = null;
  let state: BakeValidityState | null = null;
  let idle: QuietIdleHandle | null = null;
  let disposed = false;

  let lastFrameUsedBake = false;
  let lastFrameObjectCount = 0;
  let bakes = 0;
  let lastBakeMs = 0;
  /** A bake was just built and has not yet been offered to a live frame. */
  let awaitingVerdict = false;
  /**
   * Bakes that were built and then rejected by the very next live frame WITHOUT anything having
   * invalidated them. That means the bitmap can never validate — the only case seen in practice is an
   * object whose `dirty` flag is re-raised by something outside a render — and rebuilding on every
   * quiet window would burn a full re-render of the page several times a second for nothing. After
   * this many in a row the scheduler stands down until something explicitly invalidates again.
   */
  let futileBakes = 0;
  const MAX_FUTILE_BAKES = 3;

  const frameInfo = (ctx: CanvasRenderingContext2D): BakeFrameInfo => ({
    background: fingerprintBackground(target),
    height: ctx.canvas.height,
    isLowerCanvas: ctx.canvas === target.getElement(),
    retina: target.getRetinaScaling(),
    transform: target.viewportTransform,
    width: ctx.canvas.width,
  });

  const markStale = (): void => {
    if (state) {
      state.stale = true;
    }

    // An explicit invalidation is new information: whatever made the last bakes futile may be gone.
    futileBakes = 0;
    awaitingVerdict = false;
  };

  /**
   * Put `ctx` into exactly the state `renderCanvas` leaves it in just before `_renderObjects` — the
   * retina base transform the DOM manager applied once at `setDimensions`, then the viewport transform.
   */
  const applyObjectTransform = (ctx: CanvasRenderingContext2D, retina: number, vpt: readonly number[]): void => {
    ctx.setTransform(retina, 0, 0, retina, 0, 0);
    ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
  };

  const ensureSurface = (width: number, height: number): CanvasRenderingContext2D | null => {
    if (!bakeCanvas) {
      bakeCanvas = document.createElement('canvas');
      registerDarkBoardSurface(bakeCanvas);
      bakeContext = null;
    }

    if (bakeCanvas.width !== width || bakeCanvas.height !== height) {
      bakeCanvas.width = width;
      bakeCanvas.height = height;
      // A resize resets the backing store; whatever was baked is gone.
      state = null;
    }

    if (!bakeContext) {
      bakeContext = bakeCanvas.getContext('2d');
    }

    return bakeContext;
  };

  const buildBake = (plan: BakePlan): void => {
    if (disposed || plan.mode === 'none') {
      return;
    }

    const element = target.getElement();

    // A zero-sized lower canvas (mount before layout) would make a zero-sized bitmap, and `drawImage`
    // throws on one — there is nothing worth baking at that size anyway.
    if (!element || target.destroyed || element.width === 0 || element.height === 0) {
      return;
    }

    const ctx = ensureSurface(element.width, element.height);

    if (!ctx) {
      return;
    }

    const objects = target.getObjects();
    const retina = target.getRetinaScaling();
    const vpt = target.viewportTransform;
    const to = Math.min(plan.to, objects.length);
    // `ensureSurface` may have dropped the bake on a resize, which turns a planned tail into a full.
    const from = plan.mode === 'tail' && state !== null ? plan.from : 0;

    if (to <= from && plan.mode === 'tail') {
      return;
    }

    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

    perfSpan(
      'ink-bake',
      () => {
        if (from === 0) {
          // Rebuild the frame the way `renderCanvas` does: clear, background, then the prefix under
          // the viewport transform. Anything else and a `destination-out` stroke inside the prefix
          // would composite against the wrong backdrop.
          ctx.setTransform(retina, 0, 0, retina, 0, 0);
          target.clearContext(ctx);
          ctx.imageSmoothingEnabled = target.imageSmoothingEnabled;
          target._renderBackground(ctx);
        }

        ctx.save();
        applyObjectTransform(ctx, retina, vpt);
        renderObjectsOriginal(ctx, objects.slice(from, to) as FabricObject[]);
        ctx.restore();
      },
      `k=${to} mode=${plan.mode}`,
    );

    lastBakeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
    bakes += 1;

    const bakedObjects = objects.slice(0, to) as unknown as BakeableObject[];

    state = {
      background: fingerprintBackground(target),
      height: element.height,
      objects: bakedObjects,
      opacity: bakedObjects.map(opacityOf),
      retina,
      stale: false,
      transform: [vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]],
      visible: bakedObjects.map(visibilityOf),
      width: element.width,
    };

    awaitingVerdict = true;
    recordPerf('ink-bake', lastBakeMs, `k=${to}/${objects.length} ${plan.mode}`);
    target.requestRenderAll();
  };

  /** Removals patched since the last live frame — see REMOVAL_PATCH_BUDGET_PER_FRAME. */
  let patchesSinceFrame = 0;

  /**
   * An object left the baked prefix: repaint the bake where it was, in place, instead of throwing the
   * whole bitmap away.
   *
   * WHY. The object eraser removes strokes while the pen is still moving, and a removal used to mark
   * the bake stale — so every frame of the rest of the drag rendered every object on the page (one
   * `drawImage` per stroke; 60–120 ms a frame on a dense page under throttling), and the drag read as
   * a freeze. Nothing can be rebaked under the pen either (`scheduleBake` waits for quiet input).
   *
   * HOW IT STAYS PIXEL-IDENTICAL. Inside the removed object's box (grown by REMOVAL_PATCH_PAD_PX for
   * shadows and antialiasing) the bake is rebuilt exactly the way `buildBake` built it — clear, the
   * background, then every REMAINING baked object whose box touches the region, in list order, under
   * the same transforms — with the context clipped to that region on whole device pixels. Outside the
   * region nothing is touched, and nothing outside could have painted inside (an object's paint lies in
   * its box plus the pad). A `destination-out` mark inside the region is re-applied in order over the
   * repainted background, as the full bake would.
   *
   * Returns false when the bake cannot be patched (none, stale, canvas size or background changed,
   * budget spent); the caller then marks it stale as before. A removal of an unbaked tail object returns
   * true with nothing to repaint — the prefix is intact.
   */
  const patchRemoval = (removed: FabricObject): boolean => {
    const current = state;

    if (disposed || current === null || current.stale || bakeCanvas === null || bakeContext === null) {
      return false;
    }

    const next = dropBakedObject(current, removed as unknown as BakeableObject);

    if (next === null) {
      // Not in the prefix: the bake does not paint it, so its removal changes nothing baked.
      return true;
    }

    const live = target.getContext();

    if (!live) {
      return false;
    }

    const frame = frameInfo(live);

    // The bake's TRANSLATION is not compared with the live one: the bitmap is self-consistent under the
    // transform it records, and `repaintRegion` culls by box, not by the live viewport. That matters
    // while the continuous layout scrolls — pages leaving the window are dehydrated between frames, when
    // the viewport has already moved past the bake's last shift; the next frame then shifts the bake.
    // A different scale or rotation means a bitmap no frame can use again: not worth repainting.
    const liveTransform = frame.transform;
    const own = current.transform;

    if (
      current.width !== frame.width ||
      current.height !== frame.height ||
      current.retina !== frame.retina ||
      own[0] !== liveTransform[0] ||
      own[1] !== liveTransform[1] ||
      own[2] !== liveTransform[2] ||
      own[3] !== liveTransform[3] ||
      !sameBackground(current.background, frame.background)
    ) {
      return false;
    }

    const retina = current.retina;
    const vpt = current.transform;
    const zoom = Math.hypot(vpt[0], vpt[1]) || 1;
    const padded = padSceneRect(removed.getBoundingRect(), REMOVAL_PATCH_PAD_PX / (retina * zoom));
    const region = removalPatchRegion(padded, current);

    if (region === null) {
      // Missed the bitmap: nothing of it was painted. Dropped from the record, free of the budget — a
      // page of ink dehydrated off screen must not cost the bake.
      state = next;

      return true;
    }

    if (patchesSinceFrame >= REMOVAL_PATCH_BUDGET_PER_FRAME) {
      return false;
    }

    state = next;
    patchesSinceFrame += 1;

    repaintRegion(bakeContext, region, padded, next.objects as unknown as FabricObject[], retina, vpt);

    return true;
  };

  /**
   * Rebuild `region` (whole device px) of the bake exactly the way `buildBake` built it — clear, the
   * background, then every object of `objects` whose box touches `scene` (the region's scene box, grown
   * by REMOVAL_PATCH_PAD_PX), in list order, under the bake's transforms — clipped to the region.
   * Outside the region nothing is touched, and nothing outside could have painted inside (an object's
   * paint lies in its box plus the pad), so the result is the full bake's pixels by construction; a
   * `destination-out` mark inside the region is re-applied in order over the repainted background.
   * Returns how many objects were repainted.
   */
  const repaintRegion = (
    ctx: CanvasRenderingContext2D,
    region: DeviceRect,
    scene: SceneRect,
    objects: readonly FabricObject[],
    retina: number,
    vpt: readonly number[],
  ): number => {
    const repaint = objects.filter((object) => sceneRectsIntersect(object.getBoundingRect(), scene));
    // Culled by box above. Fabric's own culling (`skipOffscreen`) tests the LIVE viewport, which may
    // already be ahead of the bake's transform mid-scroll; it must not drop an object the bake shows.
    const skipOffscreen = target.skipOffscreen;

    perfSpan(
      'ink-bake-patch',
      () => {
        target.skipOffscreen = false;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.rect(region.left, region.top, region.width, region.height);
        ctx.clip();
        ctx.clearRect(region.left, region.top, region.width, region.height);
        ctx.setTransform(retina, 0, 0, retina, 0, 0);
        ctx.imageSmoothingEnabled = target.imageSmoothingEnabled;
        target._renderBackground(ctx);
        applyObjectTransform(ctx, retina, vpt);
        try {
          renderObjectsOriginal(ctx, repaint);
        } finally {
          ctx.restore();
          target.skipOffscreen = skipOffscreen;
        }
      },
      `repaint=${repaint.length}`,
    );

    return repaint.length;
  };

  /**
   * The viewport scrolled by whole device pixels since the bake was made (the continuous layout's touch
   * pan, every frame): shift the bitmap in place and paint only the strips the scroll revealed, instead
   * of throwing the bake away and re-rendering every stroke on screen each frame — measured 38 % dropped
   * frames scrolling a 684-object board on a Tab S9 Ultra against ~5 % on an empty one.
   *
   * The strips MUST be painted, not just revealed: the bake was rendered under `skipOffscreen`, so it
   * holds nothing of the ink that was outside the viewport when it was made. Painting them with
   * {@link repaintRegion} keeps the shifted bake pixel-identical to a full render, so the frame after the
   * gesture settles needs nothing extra — the bake simply matches. Returns false when the frame differs
   * from the bake in any way a shift cannot express; the caller then renders normally.
   */
  const scrollBake = (frame: BakeFrameInfo, objects: readonly BakeableObject[]): boolean => {
    const current = state;
    const ctx = bakeContext;

    if (disposed || current === null || current.stale || bakeCanvas === null || ctx === null) {
      return false;
    }

    // A background that does not move with the viewport would be shifted along with the ink.
    if (target.backgroundImage && target.backgroundVpt === false) {
      return false;
    }

    if (target.backgroundColor && typeof target.backgroundColor !== 'string') {
      return false;
    }

    const shift = bakeTranslation(current, frame);

    if (shift === null) {
      return false;
    }

    const moved: BakeValidityState = { ...current, transform: [...frame.transform] };

    // Everything but the translation must still hold — objects, flags, background.
    if (!isBakeValid(moved, frame, objects)) {
      return false;
    }

    const bitmap = bakeCanvas;
    const { dx, dy } = shift;
    const retina = current.retina;
    const vpt = moved.transform;
    const zoom = Math.hypot(vpt[0], vpt[1]) || 1;
    const pad = REMOVAL_PATCH_PAD_PX / (retina * zoom);
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let repainted = 0;

    // A canvas drawn onto itself is snapshotted first (HTML spec), so the overlap is safe. `copy`
    // leaves the uncovered strips transparent; they are repainted right below.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(bitmap, dx, dy);
    ctx.restore();

    for (const strip of exposedStrips(current.width, current.height, dx, dy)) {
      const scene = padSceneRect(deviceRectToScene(strip, retina, vpt), pad);

      repainted += repaintRegion(ctx, strip, scene, current.objects as unknown as FabricObject[], retina, vpt);
    }

    state = moved;
    recordPerf(
      'ink-bake-scroll',
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
      `dx=${dx} dy=${dy} repaint=${repainted}`,
    );

    return true;
  };

  const runBake = (): void => {
    if (disposed || target.destroyed) {
      return;
    }

    const objects = target.getObjects();
    const liveContext = target.getContext();
    // Re-decided here rather than reused from the last frame: an `object:moving` or a `dirty` flip can
    // land between the frame and this callback, and extending a bitmap that is no longer true would
    // bake the stale pixels in permanently.
    const valid =
      liveContext !== null &&
      state !== null &&
      isBakeValid(state, frameInfo(liveContext), objects as unknown as BakeableObject[]);

    buildBake(planBake(valid && state ? state.objects.length : null, objects.length, resolved));
  };

  const scheduleBake = (): void => {
    if (disposed || futileBakes >= MAX_FUTILE_BAKES) {
      return;
    }

    if (idle === null) {
      idle = scheduleQuietIdleWork(runBake, {
        isBusy: isPointerDown,
        maxDeferMs: BAKE_MAX_DEFER_MS,
        msSinceInput: millisecondsSinceLastInput,
        quietMs: BAKE_QUIET_MS,
      });

      return;
    }

    if (idle.isPending()) {
      return;
    }

    idle.reschedule(runBake);
  };

  // --- The render hook -------------------------------------------------------------------------

  target._renderObjects = (ctx: CanvasRenderingContext2D, objects: FabricObject[]): void => {
    const bitmap = bakeCanvas;
    const current = state;
    const isLive = ctx.canvas === target.getElement();
    const frame = frameInfo(ctx);
    const valid =
      bitmap !== null &&
      current !== null &&
      (isBakeValid(current, frame, objects as unknown as BakeableObject[]) ||
        // Only the live canvas may move the bake; an export renders through here too.
        (isLive && scrollBake(frame, objects as unknown as BakeableObject[])));

    // Only the LIVE lower canvas feeds the scheduler. An export renders into its own element through
    // this same method and must leave the live bake's bookkeeping exactly as it found it.
    if (isLive) {
      lastFrameObjectCount = objects.length;
      lastFrameUsedBake = valid;
      patchesSinceFrame = 0;

      if (valid) {
        futileBakes = 0;
        awaitingVerdict = false;
      } else if (awaitingVerdict && current !== null && !current.stale) {
        // Built moments ago, nothing invalidated it, and it still does not match. See `futileBakes`.
        futileBakes += 1;
        awaitingVerdict = false;
      }
    }

    if (!valid || bitmap === null || state === null) {
      renderObjectsOriginal(ctx, objects);

      return;
    }

    // `copy` replaces the clear + background this frame already painted with the identical pixels the
    // bake captured. See the module header for why an ink-only `source-over` blit is not equivalent.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();

    const baked = state.objects.length;

    if (objects.length > baked) {
      renderObjectsOriginal(ctx, objects.slice(baked));
    }
  };

  // --- Canvas events ---------------------------------------------------------------------------

  const onAdded = (): void => {
    if (target.getObjects().length >= resolved.minObjects) {
      scheduleBake();
    }
  };

  const onAfterRender = (): void => {
    if (!lastFrameUsedBake || state === null) {
      if (lastFrameObjectCount >= resolved.minObjects) {
        scheduleBake();
      }

      return;
    }

    if (lastFrameObjectCount - state.objects.length >= resolved.maxTail) {
      scheduleBake();
    }
  };

  // A removal is patched in place where it can be (see patchRemoval), stale only where it cannot.
  const onRemoved = (event: { target?: FabricObject }): void => {
    if (!event?.target || !patchRemoval(event.target)) {
      markStale();
    }
  };

  // `dirty` is only raised for Fabric's `cacheProperties`, so a move/scale/rotate of a baked object
  // never shows up there — these events are the half of the contract the flag cannot cover. Selection
  // events are included because `Object.render` paints a selection background for a selected object,
  // which a baked object would never get the chance to draw.
  const invalidatingEvents = [
    'object:modified',
    'object:moving',
    'object:scaling',
    'object:rotating',
    'object:skewing',
    'selection:created',
    'selection:updated',
    'selection:cleared',
    'canvas:cleared',
  ] as const;

  const disposers: Array<() => void> = [];
  // Fabric's `on` overloads are keyed to the event map; one loosely-typed view keeps the list above
  // readable without widening anything else on the canvas.
  const observable = target as unknown as {
    on: (event: string, handler: (event: { target?: FabricObject }) => void) => () => void;
  };

  disposers.push(observable.on('object:added', onAdded));
  disposers.push(observable.on('path:created', onAdded));
  disposers.push(observable.on('after:render', onAfterRender));
  disposers.push(observable.on('object:removed', onRemoved));

  for (const event of invalidatingEvents) {
    disposers.push(observable.on(event, markStale));
  }

  const handle: InkBakeHandle = {
    dispose: () => {
      if (disposed) {
        return;
      }

      disposed = true;

      for (const off of disposers) {
        try {
          off();
        } catch {
          // A canvas already torn down by Fabric drops its own listeners; never throw on teardown.
        }
      }

      disposers.length = 0;
      idle?.cancel();
      idle = null;

      if (hadOwnRenderObjects) {
        target._renderObjects = previousOwnRenderObjects as BakeCanvas['_renderObjects'];
      } else {
        delete (target as Partial<BakeCanvas>)._renderObjects;
      }

      if (target.__inkBake === handle) {
        delete target.__inkBake;
      }

      state = null;
      bakeContext = null;
      // Zeroing the backing store releases the bitmap immediately rather than at the next GC — a
      // 4K board page is ~33 MB, and a teacher flips through dozens of pages a lesson.
      if (bakeCanvas) {
        bakeCanvas.width = 0;
        bakeCanvas.height = 0;
      }

      bakeCanvas = null;
    },
    getStats: () => ({
      baked: state !== null && !state.stale ? state.objects.length : 0,
      bakes,
      enabled: lastFrameUsedBake,
      lastBakeMs: Math.round(lastBakeMs * 10) / 10,
      total: lastFrameObjectCount,
    }),
    invalidate: markStale,
    scheduleBake,
  };

  // Read by the perf HUD and the CDP driver without going through `window`.
  target.__inkBake = handle;

  scheduleBake();

  return handle;
}
