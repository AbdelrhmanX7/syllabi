/**
 * Viewport clamping for the "page covers the view" mode (`WhiteboardEditor.lockZoomToPage` and the
 * continuous PDF scroll layout).
 *
 * A constraint is a SCENE rect the viewport may never leave plus a zoom range. The minimum zoom is
 * chosen by the caller as the fit-width zoom of that rect, so zooming out stops exactly where the
 * page fills the width and no board around it ever shows; panning is clamped so an edge of the rect
 * never crosses into the canvas. When the rect is smaller than the canvas on an axis (a page shorter
 * than the window) it is centred on that axis instead.
 *
 * Pure functions over the 6-element Fabric viewport transform `[zoom, 0, 0, zoom, offsetX, offsetY]`.
 */

export interface SceneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ViewportConstraints {
  minZoom: number;
  maxZoom: number;
  /** The rect the viewport must stay inside, in scene (viewport-at-identity) coordinates. */
  scene: SceneRect;
}

export type ViewportTransform6 = [number, number, number, number, number, number];

const EPSILON = 1e-6;

/** Zoom floor while free zoom is on (see WhiteboardEditor.freeZoom). */
export const FREE_ZOOM_MIN = 0.1;
const FREE_SCENE_EXTENT = 1e6;

/** The cage with its zoom floor lowered and its pan limits pushed out of reach. */
export function relaxConstraints(constraints: ViewportConstraints): ViewportConstraints {
  return {
    maxZoom: constraints.maxZoom,
    minZoom: Math.min(constraints.minZoom, FREE_ZOOM_MIN),
    scene: { bottom: FREE_SCENE_EXTENT, left: -FREE_SCENE_EXTENT, right: FREE_SCENE_EXTENT, top: -FREE_SCENE_EXTENT },
  };
}

export function clampZoom(zoom: number, constraints: ViewportConstraints): number {
  const min = Number.isFinite(constraints.minZoom) && constraints.minZoom > 0 ? constraints.minZoom : EPSILON;
  const max = Number.isFinite(constraints.maxZoom) && constraints.maxZoom >= min ? constraints.maxZoom : min;

  return Math.min(max, Math.max(min, zoom));
}

/** The zoom at which `sceneWidth` scene px exactly fill `canvasWidth` CSS px. 1 when either is unusable. */
export function resolveFitWidthZoom(canvasWidth: number, sceneWidth: number): number {
  if (!(canvasWidth > 0) || !(sceneWidth > 0) || !Number.isFinite(canvasWidth) || !Number.isFinite(sceneWidth)) {
    return 1;
  }

  return canvasWidth / sceneWidth;
}

/**
 * Clamp one axis's offset: `extent` is the scene rect's length on that axis (scene px), `start` its
 * scene start, `canvasLength` the canvas length on that axis (CSS px). A rect shorter than the canvas
 * is centred; otherwise the offset is kept so the rect's start never shows past the canvas start and
 * its end never shows before the canvas end.
 */
function clampAxisOffset(offset: number, start: number, extent: number, zoom: number, canvasLength: number): number {
  const screenExtent = extent * zoom;

  if (screenExtent <= canvasLength) {
    return (canvasLength - screenExtent) / 2 - start * zoom;
  }

  const maxOffset = -start * zoom;
  const minOffset = canvasLength - (start + extent) * zoom;

  return Math.min(maxOffset, Math.max(minOffset, offset));
}

export function isSameViewportTransform(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (!a || !b || a.length < 6 || b.length < 6) return a === b;

  for (let index = 0; index < 6; index += 1) {
    if (Math.abs((a[index] ?? 0) - (b[index] ?? 0)) > EPSILON) return false;
  }

  return true;
}

/**
 * Return `viewportTransform` pulled back inside `constraints` for a canvas of the given CSS size.
 * A zoom outside the range is corrected ABOUT THE CANVAS CENTRE (the scene point under the centre
 * stays put), then the offsets are clamped. The input is never mutated; the result is a fresh array
 * even when nothing changed, so callers compare with {@link isSameViewportTransform}.
 */
export function clampViewportTransform(
  viewportTransform: readonly number[] | undefined,
  constraints: ViewportConstraints,
  canvasWidth: number,
  canvasHeight: number,
): ViewportTransform6 {
  const vt = viewportTransform ?? [1, 0, 0, 1, 0, 0];
  const zoom = vt[0] || 1;
  let offsetX = vt[4] || 0;
  let offsetY = vt[5] || 0;
  const nextZoom = clampZoom(zoom, constraints);

  if (Math.abs(nextZoom - zoom) > EPSILON) {
    const centreX = canvasWidth / 2;
    const centreY = canvasHeight / 2;
    const sceneCentreX = (centreX - offsetX) / zoom;
    const sceneCentreY = (centreY - offsetY) / zoom;

    offsetX = centreX - sceneCentreX * nextZoom;
    offsetY = centreY - sceneCentreY * nextZoom;
  }

  const { scene } = constraints;

  offsetX = clampAxisOffset(offsetX, scene.left, Math.max(0, scene.right - scene.left), nextZoom, canvasWidth);
  offsetY = clampAxisOffset(offsetY, scene.top, Math.max(0, scene.bottom - scene.top), nextZoom, canvasHeight);

  return [nextZoom, 0, 0, nextZoom, offsetX, offsetY];
}

/**
 * The largest part of a requested pan `(dx, dy)` that keeps the viewport inside `constraints`.
 * Used by the CSS gesture preview, which translates the layer before anything is committed to
 * Fabric: clamping the preview keeps the committed result and what the finger saw identical.
 */
export function clampPanDelta(
  viewportTransform: readonly number[] | undefined,
  dx: number,
  dy: number,
  constraints: ViewportConstraints,
  canvasWidth: number,
  canvasHeight: number,
): { dx: number; dy: number } {
  const vt = viewportTransform ?? [1, 0, 0, 1, 0, 0];
  const moved: ViewportTransform6 = [vt[0] || 1, 0, 0, vt[3] || vt[0] || 1, (vt[4] || 0) + dx, (vt[5] || 0) + dy];
  const clamped = clampViewportTransform(moved, constraints, canvasWidth, canvasHeight);

  return { dx: clamped[4] - (vt[4] || 0), dy: clamped[5] - (vt[5] || 0) };
}

/**
 * Constraints for ONE page shown alone (the paged layout under `lockZoomToPage`): the page rect is
 * the scene rect, the fit-width zoom is the floor. `null` when the frame is not known yet.
 */
export function constraintsForPageRect(input: {
  canvasWidth: number;
  maxZoom: number;
  rect: { x: number; y: number; width: number; height: number } | null | undefined;
}): ViewportConstraints | null {
  const { canvasWidth, maxZoom, rect } = input;

  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !(canvasWidth > 0)) {
    return null;
  }

  const minZoom = resolveFitWidthZoom(canvasWidth, rect.width);

  return {
    maxZoom: Math.max(maxZoom, minZoom),
    minZoom,
    scene: { bottom: rect.y + rect.height, left: rect.x, right: rect.x + rect.width, top: rect.y },
  };
}

/**
 * The viewport after the canvas changed size (window resize, split screen, rotation, chrome toggling)
 * or the cage changed: `previous` is the cage the view was laid out against, `next` the one for the new
 * size. A view that sat at the old fit zoom (or below the new one) follows to the NEW fit zoom, so the
 * page keeps exactly filling the width — never wider than the view, never letterboxed — with the scene
 * row at the top of the view kept where it is. A view zoomed in past fit keeps its zoom and is only
 * pulled back inside.
 */
export function refitViewportToConstraints(
  viewportTransform: readonly number[] | undefined,
  previous: ViewportConstraints | null | undefined,
  next: ViewportConstraints,
  canvasWidth: number,
  canvasHeight: number,
): ViewportTransform6 {
  const zoom = viewportTransform?.[0] || 1;
  const wasAtFit = !previous || zoom <= previous.minZoom + EPSILON || zoom < next.minZoom - EPSILON;

  if (!wasAtFit) return clampViewportTransform(viewportTransform, next, canvasWidth, canvasHeight);

  const sceneTop = -(viewportTransform?.[5] ?? 0) / zoom;
  const fit = clampZoom(next.minZoom, next);

  return clampViewportTransform([fit, 0, 0, fit, 0, -sceneTop * fit], next, canvasWidth, canvasHeight);
}
