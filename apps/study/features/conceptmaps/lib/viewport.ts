// Viewbox maths for the reference-map viewer: fit (to the width, or the whole graph), zoom about a
// point, pan — always kept over the drawing. A view has the port's aspect, so the svg's `meet` never
// letterboxes it and 1 unit = port.w / view.w px. Pure — unit-tested.

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/**
 * `width`: the drawing's full width, from the top (taller graphs scroll inside); `contain`: the whole
 * drawing, centred.
 */
export function fitView(content: Size, port: Size, mode: 'width' | 'contain'): View {
  if (content.w <= 0 || content.h <= 0 || port.w <= 0 || port.h <= 0) return { x: 0, y: 0, ...content };
  const scale = mode === 'width' ? port.w / content.w : Math.min(port.w / content.w, port.h / content.h);
  const w = port.w / scale;
  const h = port.h / scale;

  return { x: (content.w - w) / 2, y: h >= content.h ? (content.h - h) / 2 : 0, w, h };
}

/** Keeps the view over the drawing: no panning past an edge; a view larger than it stays around it. */
export function clampView(view: View, content: Size): View {
  const clamp = (value: number, a: number, b: number) => Math.min(Math.max(a, b), Math.max(Math.min(a, b), value));

  return { ...view, x: clamp(view.x, 0, content.w - view.w), y: clamp(view.y, 0, content.h - view.h) };
}

/**
 * Zoom by `factor` (>1 = in) about the point `at` (drawing units). Null = back at (or past) the fit
 * view. Never closer than `minWidth` units across.
 */
export function zoomView(
  view: View,
  at: { x: number; y: number },
  factor: number,
  fit: View,
  content: Size,
  minWidth = 160,
): View | null {
  const w = Math.min(fit.w, Math.max(Math.min(minWidth, fit.w), view.w / factor));

  if (w >= fit.w - 0.5) return null;
  const ratio = w / view.w;

  return clampView(
    { x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio, w, h: view.h * ratio },
    content,
  );
}

/** Pan by a drag of (dx, dy) px on a port `portWidth` px wide. */
export function panView(view: View, dx: number, dy: number, portWidth: number, content: Size): View {
  const scale = portWidth / view.w;

  return clampView({ ...view, x: view.x - dx / scale, y: view.y - dy / scale }, content);
}

/**
 * A view centred on `box` (drawing units) with `margin` around it, at the port's aspect; never
 * closer than `minWidth` across. Null when that is as wide as the fit view (just fit).
 */
export function focusView(box: View, fit: View, content: Size, margin = 40, minWidth = 320): View | null {
  const aspect = fit.h / fit.w;
  let w = Math.max(minWidth, box.w + margin * 2, (box.h + margin * 2) / aspect);

  if (w >= fit.w - 0.5) return null;
  w = Math.min(w, fit.w);
  const h = w * aspect;

  return clampView({ x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h }, content);
}

/**
 * The starting view: `whole` unless that shrinks text below `minScale` (px per unit) — then the
 * top-centre of the drawing at `minScale`, the rest a pan away.
 */
export function readableView(whole: View, content: Size, port: Size, minScale: number): View {
  if (port.w <= 0 || whole.w <= 0 || port.w / whole.w >= minScale) return whole;
  const w = port.w / minScale;
  const h = port.h / minScale;

  return clampView({ x: (content.w - w) / 2, y: 0, w, h }, content);
}
