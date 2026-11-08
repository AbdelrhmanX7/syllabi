import type { SceneTransform } from './pdfScrollLayout';

/**
 * The board's in-app clipboard and the pure halves of the selection actions (recolour, copy/paste
 * placement). Fabric-free so every rule here is unit-testable; `selectionActions.ts` does the canvas
 * work on top of it.
 *
 * ## Frames
 *
 * Copied objects are stored in the PAGE-LOCAL frame of the page they were copied from — the frame a
 * page's `canvasJSON` is stored in. In the paged layout that is the scene itself; in the continuous
 * PDF column every page sits in the scene through its own `pageToSceneTransform` (a scale plus an
 * offset). Storing page-local units is what makes a copy from page 3 of a scrolled PDF land at the same
 * size on page 7, on a blank paged notebook, or on another board entirely: paste maps the stored
 * objects through the TARGET page's transform, centred on the paste point.
 *
 * ## Persistence
 *
 * Module memory first (copy → paste on the same page never touches storage), mirrored to
 * localStorage so a copy survives switching notebooks (each notebook mounts a fresh editor) and a
 * reload. Every storage access is guarded: a private window or a full quota only costs the mirror.
 */

export interface ClipboardItem {
  /** `toObject()` of one object, absolute and centre-origined, in the source page-local frame. */
  json: Record<string, unknown>;
  /** The object's own origin, restored after it is revived (the JSON is centre-origined for maths). */
  originX: string;
  originY: string;
}

export interface ClipboardRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WbClipboard {
  version: 1;
  items: ClipboardItem[];
  /** Union bounds of the items, page-local. Paste centres this box on the paste point. */
  bounds: ClipboardRect;
  copiedAt: number;
}

export const CLIPBOARD_STORAGE_KEY = 'wb-selection-clipboard';

/**
 * Properties a pasted copy must NOT inherit. `t` is the Study app's lecture stroke clock (ms of
 * recorded audio): a copy carrying it would seek the source lecture's video, and its absence is what
 * lets the host stamp the copy as new ink.
 */
const STRIPPED_ON_PASTE = ['t'] as const;

export const IDENTITY_SCENE_TRANSFORM: SceneTransform = { scale: 1, dx: 0, dy: 0 };

// --- Geometry -------------------------------------------------------------------------------------

export function unionRects(rects: readonly ClipboardRect[]): ClipboardRect | null {
  if (rects.length === 0) return null;

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  }

  return { left, top, width: right - left, height: bottom - top };
}

export function transformRect(rect: ClipboardRect, transform: SceneTransform): ClipboardRect {
  return {
    left: rect.left * transform.scale + transform.dx,
    top: rect.top * transform.scale + transform.dy,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale,
  };
}

/** Moves one object's JSON through a scene transform: position and scale; everything else as is. */
export function transformItemJson(json: Record<string, unknown>, transform: SceneTransform): Record<string, unknown> {
  const next: Record<string, unknown> = { ...json };
  const left = typeof json.left === 'number' ? json.left : 0;
  const top = typeof json.top === 'number' ? json.top : 0;
  const scaleX = typeof json.scaleX === 'number' ? json.scaleX : 1;
  const scaleY = typeof json.scaleY === 'number' ? json.scaleY : 1;

  next.left = left * transform.scale + transform.dx;
  next.top = top * transform.scale + transform.dy;
  next.scaleX = scaleX * transform.scale;
  next.scaleY = scaleY * transform.scale;

  return next;
}

/**
 * Builds the clipboard from objects already made absolute and centre-origined in SCENE coordinates,
 * plus the source page's page→scene transform (identity in the paged layout).
 */
export function buildClipboard(
  sceneItems: readonly ClipboardItem[],
  sceneBounds: ClipboardRect,
  sourceTransform: SceneTransform,
  now: number = Date.now(),
): WbClipboard {
  const toLocal: SceneTransform = {
    scale: 1 / sourceTransform.scale,
    dx: -sourceTransform.dx / sourceTransform.scale,
    dy: -sourceTransform.dy / sourceTransform.scale,
  };

  return {
    version: 1,
    items: sceneItems.map((item) => ({ ...item, json: transformItemJson(item.json, toLocal) })),
    bounds: transformRect(sceneBounds, toLocal),
    copiedAt: now,
  };
}

/**
 * The scene-space JSON for pasting `clipboard` so its bounds' centre lands on `at` (scene), at the
 * scale of the target page (`targetTransform`, identity in the paged layout).
 */
export function placeClipboard(
  clipboard: WbClipboard,
  targetTransform: SceneTransform,
  at: { x: number; y: number },
): { items: ClipboardItem[]; bounds: ClipboardRect } {
  const centreX = clipboard.bounds.left + clipboard.bounds.width / 2;
  const centreY = clipboard.bounds.top + clipboard.bounds.height / 2;
  const scale = targetTransform.scale;
  const transform: SceneTransform = { scale, dx: at.x - centreX * scale, dy: at.y - centreY * scale };

  return {
    items: clipboard.items.map((item) => {
      const json = transformItemJson(item.json, transform);

      for (const key of STRIPPED_ON_PASTE) delete json[key];

      return { ...item, json };
    }),
    bounds: transformRect(clipboard.bounds, transform),
  };
}

// --- Recolour -------------------------------------------------------------------------------------

/** The slice of a Fabric object recolouring reads and writes, so tests need no Fabric. */
export interface RecolorableObject {
  type?: string;
  stroke?: unknown;
  fill?: unknown;
  strokeWidth?: number;
  set(key: string, value: unknown): unknown;
  getObjects?: () => RecolorableObject[];
}

const TEXT_TYPES = new Set(['text', 'i-text', 'itext', 'textbox']);
const SKIPPED_TYPES = new Set(['image']);

/** Alpha of a CSS colour string, or null when it has none / is not one we parse. */
export function colorAlpha(value: string): number | null {
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value.trim());

  if (rgba) {
    const parts = rgba[1]!.split(/[\s,/]+/).filter(Boolean);

    if (parts.length >= 4) {
      const raw = parts[3]!;
      const alpha = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);

      return Number.isFinite(alpha) ? alpha : null;
    }

    return null;
  }

  const hex = /^#([0-9a-f]{8}|[0-9a-f]{4})$/i.exec(value.trim());

  if (hex) {
    const digits = hex[1]!;
    const alphaHex = digits.length === 8 ? digits.slice(6) : digits.slice(3).repeat(2);

    return Number.parseInt(alphaHex, 16) / 255;
  }

  if (value.trim().toLowerCase() === 'transparent') return 0;

  return null;
}

/** `#rrggbb` (or `#rgb`) as rgba with the given alpha; any other input is returned as is. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(color.trim());

  if (!hex) return color;

  const digits = hex[1]!.length === 3 ? hex[1]!.replace(/./g, (c) => c + c) : hex[1]!;
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);

  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
}

const isPaint = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && colorAlpha(value) !== 0;

/** Same colour ignoring alpha (hex or rgb[a]); false when either cannot be read. */
function sameRgb(a: string, b: string): boolean {
  const rgb = (value: string): string | null => {
    const v = value.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);

    if (hex) {
      const d = hex[1]!.length <= 4 ? hex[1]!.slice(0, 3).replace(/./g, (c) => c + c) : hex[1]!.slice(0, 6);

      return [0, 2, 4].map((i) => Number.parseInt(d.slice(i, i + 2), 16)).join(',');
    }

    const m = /^rgba?\(([^)]+)\)$/.exec(v);

    return m ? m[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((n) => String(Math.round(Number(n)))).join(',') : null;
  };
  const x = rgb(a);

  return x !== null && x === rgb(b);
}

/** Re-tints `next` with the alpha `previous` carried, so a translucent fill stays translucent. */
function keepAlpha(previous: string, next: string): string {
  const alpha = colorAlpha(previous);

  return alpha === null || alpha >= 1 ? next : withAlpha(next, alpha);
}

/**
 * Recolours one object in place; returns how many leaf objects changed.
 *
 *  - Ink and shape outlines: the stroke takes the colour.
 *  - Filled ink (the calligraphy and marker brushes paint a filled outline with no stroke): the fill.
 *  - A shape's interior fill in the outline's own colour: re-tinted, keeping its alpha (a 20 % wash
 *    stays a 20 % wash). A background in another colour (the Background row's) is left alone, and so is
 *    the fill laid under hand-drawn ink.
 *  - Text: its fill (Fabric text paints with fill).
 *  - Groups (AI objects, arrows): every member. Images are left alone.
 */
export function recolorObject(object: RecolorableObject, color: string): number {
  const type = (object.type ?? '').toLowerCase();
  const previousStroke = typeof object.stroke === 'string' ? object.stroke : '';

  if (SKIPPED_TYPES.has(type)) return 0;

  const children = object.getObjects?.();

  if (children && type !== 'activeselection') {
    return children.reduce((count, child) => count + recolorObject(child, color), 0);
  }

  if (TEXT_TYPES.has(type)) {
    object.set('fill', isPaint(object.fill) ? keepAlpha(object.fill, color) : color);

    return 1;
  }

  // The fill laid under hand-drawn ink is a background: the Background row sets it, not Colour.
  if ((object as { wbInkFill?: boolean }).wbInkFill) return 0;

  const hasStroke = isPaint(object.stroke) && (object.strokeWidth ?? 1) > 0;
  const hasFill = isPaint(object.fill);
  let changed = false;

  if (hasStroke) {
    object.set('stroke', keepAlpha(object.stroke as string, color));
    changed = true;
  }

  // A shape's own background (picked on the Background row) keeps its colour; a fill in the outline's
  // own colour (an arrowhead, a wash of the outline colour) follows the outline.
  if (hasFill && (!hasStroke || sameRgb(object.fill as string, previousStroke))) {
    object.set('fill', keepAlpha(object.fill as string, color));
    changed = true;
  }

  return changed ? 1 : 0;
}

/** Sets the stroke width of stroked leaves (filled ink has no stroke to thicken). */
export function restrokeObject(object: RecolorableObject, width: number): number {
  const type = (object.type ?? '').toLowerCase();

  if (SKIPPED_TYPES.has(type) || TEXT_TYPES.has(type)) return 0;

  const children = object.getObjects?.();

  if (children && type !== 'activeselection') {
    return children.reduce((count, child) => count + restrokeObject(child, width), 0);
  }

  if (!isPaint(object.stroke) || (object.strokeWidth ?? 0) <= 0) return 0;

  object.set('strokeWidth', width);

  return 1;
}

/** Gap between the press point and the chip, and the chip's minimum distance from the layer's edges. */
const CHIP_GAP = 14;
const CHIP_MARGIN = 8;

/**
 * Where the chip goes: centred above the press point (clear of the finger or pen), below it when there
 * is no room above, and always fully inside the layer.
 */
export function placePasteChip(
  at: { left: number; top: number },
  chip: { width: number; height: number },
  container?: { width: number; height: number },
  /** Room the top chrome takes (the board's top buttons); the chip goes below the point rather than under it. */
  topInset = 0,
): { left: number; top: number } {
  let left = at.left - chip.width / 2;
  let top = at.top - CHIP_GAP - chip.height;

  if (!container) return { left, top };

  const minTop = Math.max(CHIP_MARGIN, topInset);

  if (top < minTop) top = at.top + CHIP_GAP;

  left = Math.min(Math.max(left, CHIP_MARGIN), Math.max(CHIP_MARGIN, container.width - chip.width - CHIP_MARGIN));
  top = Math.min(Math.max(top, minTop), Math.max(minTop, container.height - chip.height - CHIP_MARGIN));

  return { left, top };
}


// --- Store ----------------------------------------------------------------------------------------

let memory: WbClipboard | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

export function parseClipboard(raw: string | null): WbClipboard | null {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<WbClipboard>;

    if (value?.version !== 1 || !Array.isArray(value.items) || value.items.length === 0 || !value.bounds) return null;

    const { left, top, width, height } = value.bounds;

    if (![left, top, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;

    const items = value.items.filter(
      (item): item is ClipboardItem => Boolean(item) && typeof item.json === 'object' && item.json !== null && typeof item.json.type === 'string',
    );

    return items.length > 0 ? { version: 1, items, bounds: value.bounds, copiedAt: Number(value.copiedAt) || 0 } : null;
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readClipboard(): WbClipboard | null {
  if (!hydrated) {
    hydrated = true;

    try {
      memory = memory ?? parseClipboard(storage()?.getItem(CLIPBOARD_STORAGE_KEY) ?? null);
    } catch {
      // Unreadable storage: the in-memory clipboard is all there is.
    }
  }

  return memory;
}

export function writeClipboard(next: WbClipboard): void {
  memory = next;
  hydrated = true;

  try {
    storage()?.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode: the copy still pastes within this page load.
  }

  listeners.forEach((listener) => listener());
}

export function subscribeClipboard(listener: () => void): () => void {
  listeners.add(listener);

  // Another tab (or another notebook window) copied: pick it up.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CLIPBOARD_STORAGE_KEY) return;

    memory = parseClipboard(event.newValue);
    listener();
  };

  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);

    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Test hook: forget the in-memory clipboard so the next read goes back to storage. */
export function resetClipboardMemory(): void {
  memory = null;
  hydrated = false;
}

// --- Bar placement --------------------------------------------------------------------------------

/**
 * Where the floating bar goes: centred above the selection, flipped below it when there is no room
 * above, and clamped inside the container either way. All values in container CSS pixels.
 */
export function placeSelectionBar(
  selection: ClipboardRect,
  bar: { width: number; height: number },
  container: { width: number; height: number },
  options: {
    gap?: number;
    margin?: number;
    topInset?: number;
    /** Gap when the bar sits ABOVE / BELOW the selection (default `gap`) — room for the frame's handles. */
    gapAbove?: number;
    gapBelow?: number;
    /** Which side to try first. Default `above`. */
    prefer?: 'above' | 'below';
  } = {},
): { left: number; top: number; below: boolean } {
  const gap = options.gap ?? 12;
  const gapAbove = options.gapAbove ?? gap;
  const gapBelow = options.gapBelow ?? gap;
  const margin = options.margin ?? 8;
  const topInset = Math.max(margin, options.topInset ?? margin);
  const maxLeft = Math.max(margin, container.width - bar.width - margin);
  const left = Math.min(Math.max(selection.left + selection.width / 2 - bar.width / 2, margin), maxLeft);
  const above = selection.top - gapAbove - bar.height;
  const below = selection.top + selection.height + gapBelow;
  const maxTop = Math.max(topInset, container.height - bar.height - margin);
  const fitsAbove = above >= topInset;
  const fitsBelow = below + bar.height <= container.height - margin;

  if (options.prefer === 'below') {
    if (fitsBelow) return { left, top: below, below: true };
    if (fitsAbove) return { left, top: above, below: false };

    // Neither side fits (a selection taller than the view): the edge with more room, over the selection.
    const roomAbove = selection.top - topInset;
    const roomBelow = container.height - margin - (selection.top + selection.height);

    return roomBelow >= roomAbove ? { left, top: maxTop, below: true } : { left, top: topInset, below: false };
  }

  if (fitsAbove) return { left, top: above, below: false };

  // Neither side fits (a selection taller than the view): pin to the top inset, over the selection.
  return { left, top: Math.min(Math.max(below, topInset), maxTop), below: fitsBelow };
}

// --- Lasso ----------------------------------------------------------------------------------------

export function pointInPolygon(point: { x: number; y: number }, polygon: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;

    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }

  return inside;
}

/**
 * The polygon a freehand loop selects by. A loop drawn as a near-straight diagonal (the rubber-band
 * habit) encloses no area — that drag selects like Fabric's rectangle would, by the box it spans.
 * Fewer than two points is no loop at all (an empty polygon takes nothing).
 */
export function lassoPolygon(loop: ReadonlyArray<{ x: number; y: number }>): ReadonlyArray<{ x: number; y: number }> {
  if (loop.length < 2) return [];

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let area = 0;

  for (let i = 0, j = loop.length - 1; i < loop.length; j = i, i += 1) {
    const p = loop[i]!;

    left = Math.min(left, p.x);
    right = Math.max(right, p.x);
    top = Math.min(top, p.y);
    bottom = Math.max(bottom, p.y);
    area += (loop[j]!.x + p.x) * (loop[j]!.y - p.y);
  }

  const boxArea = Math.max(1, (right - left) * (bottom - top));

  return Math.abs(area / 2) < boxArea * 0.15
    ? [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ]
    : loop;
}

/** Whether a closed polygon takes in the scene box `rect`: its centre inside, or at least three of its four corners. */
export function polygonTakesRect(polygon: ReadonlyArray<{ x: number; y: number }>, rect: ClipboardRect): boolean {
  if (polygon.length < 3) return false;

  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.left + rect.width, y: rect.top },
    { x: rect.left + rect.width, y: rect.top + rect.height },
    { x: rect.left, y: rect.top + rect.height },
  ];

  if (pointInPolygon({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, polygon)) return true;

  return corners.filter((corner) => pointInPolygon(corner, polygon)).length >= 3;
}

/**
 * Whether a freehand loop takes in an object with scene box `rect` — {@link lassoPolygon} judged by
 * {@link polygonTakesRect}. The box rule; strokes are judged by their ink in `selectionHitTest`.
 */
export function lassoSelects(loop: ReadonlyArray<{ x: number; y: number }>, rect: ClipboardRect): boolean {
  return polygonTakesRect(lassoPolygon(loop), rect);
}

// --- Rasterizing a selection ----------------------------------------------------------------------

export interface SelectionRasterPlan {
  /** Scene rectangle to render: the selection bounds plus padding. */
  region: ClipboardRect;
  /** Output pixels per scene unit. */
  scale: number;
  width: number;
  height: number;
}

/**
 * How to render a selection as a picture: the bounds padded by `padding` scene units, at the largest
 * scale that keeps the long side within `maxPx` — never above `maxScale` (a small word is not blown
 * up past what the pen put down) and never below what yields one pixel.
 */
export function planSelectionRaster(
  bounds: ClipboardRect,
  options: { maxPx?: number; maxScale?: number; padding?: number } = {},
): SelectionRasterPlan {
  const maxPx = options.maxPx ?? 2000;
  const maxScale = options.maxScale ?? 3;
  const padding = options.padding ?? 16;
  const region = {
    left: bounds.left - padding,
    top: bounds.top - padding,
    width: Math.max(1, bounds.width + padding * 2),
    height: Math.max(1, bounds.height + padding * 2),
  };
  const longSide = Math.max(region.width, region.height);
  const scale = Math.min(maxScale, maxPx / longSide);
  const width = Math.max(1, Math.min(maxPx, Math.round(region.width * scale)));
  const height = Math.max(1, Math.min(maxPx, Math.round(region.height * scale)));

  return { region, scale, width, height };
}

/** Whether two scene rectangles overlap (an eraser mark over the selection must punch it too). */
export function rectsOverlap(a: ClipboardRect, b: ClipboardRect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}
