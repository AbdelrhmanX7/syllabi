/**
 * Pure geometry + persistence helpers for the radial quick pen menu (QuickGestureMenu).
 *
 * The menu is a hub with a ring of slots around it. Its position is the hub's centre in the board
 * viewport, stored as viewport-relative fractions so it survives rotation and resolution changes.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Ring slot (colour swatch / width button) diameter — the 44px minimum touch target. */
export const QUICK_MENU_ITEM_SIZE = 44;
export const QUICK_MENU_HUB_SIZE = 60;
/** Distance from the hub centre to each slot centre. 8 slots × 44px fit with ~11px gaps at 72px. */
export const QUICK_MENU_RING_RADIUS = 72;
/** Padding between the outer edge of the slots and the edge of the paper disc. */
export const QUICK_MENU_DISC_PADDING = 8;
/** Half the disc's diameter — the disc's border box (border-sk is drawn inside it). */
export const QUICK_MENU_EXTENT = QUICK_MENU_RING_RADIUS + QUICK_MENU_ITEM_SIZE / 2 + QUICK_MENU_DISC_PADDING;
/** Paint outside the border box: the disc's `shadow-sk-xl` hard drop (10px). Reserved on every side. */
export const QUICK_MENU_CHROME = 10;
/** Everything the menu paints lies within this distance of its centre. */
export const QUICK_MENU_OUTER_EXTENT = QUICK_MENU_EXTENT + QUICK_MENU_CHROME;
/** Gap kept between the menu's outer paint and the edge of the visible viewport. */
export const QUICK_MENU_VIEWPORT_MARGIN = 16;
/** Pointer travel (px) after which a press on the hub becomes a drag instead of a tap. */
export const QUICK_MENU_DRAG_THRESHOLD = 6;

const STORAGE_KEY_PREFIX = 'whiteboard:quick-pen-menu:position';

/**
 * Offsets (relative to the hub centre, screen coordinates: +y is down) of `count` evenly spaced
 * slots. `startAngleDeg` is the first slot's angle measured clockwise from 3 o'clock.
 */
export function getRingSlotOffsets(count: number, radius: number, startAngleDeg = -90): Point[] {
  if (count <= 0) return [];
  const step = 360 / count;

  return Array.from({ length: count }, (_, index) => {
    const radians = ((startAngleDeg + index * step) * Math.PI) / 180;

    // Round away float noise (cos(90°) ≈ 6e-17) so slots land on whole pixels.
    return {
      x: Math.round(Math.cos(radians) * radius * 1000) / 1000,
      y: Math.round(Math.sin(radians) * radius * 1000) / 1000,
    };
  });
}

/**
 * The menu's slot layout: 8 slots offset half a step so two sit symmetrically about 6 o'clock —
 * those take width − (left) and width + (right); the 6 colours fill the arc over the top,
 * left-to-right.
 */
export function getQuickMenuSlots(radius = QUICK_MENU_RING_RADIUS): {
  colors: Point[];
  decrease: Point;
  increase: Point;
} {
  // start at 6 o'clock + 22.5° (just right of bottom), going clockwise.
  const slots = getRingSlotOffsets(8, radius, 90 - 22.5);
  // slots[0] = bottom-right, slots[1] = bottom-left, slots[2..7] = left → top → right.
  const [increase, decrease, ...colors] = slots;

  return { colors, decrease, increase };
}

/** Visible part of the menu's container, in container coordinates. */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The part of a container (its client rect) that is actually on screen, in the container's own
 * coordinates — a board container wider/taller than the window, or shifted off it, must not let the
 * menu sit in the hidden part.
 */
export function getVisibleBounds(
  rect: { left: number; top: number; width: number; height: number },
  windowSize: Size,
): Bounds {
  const left = Math.max(0, -rect.left);
  const top = Math.max(0, -rect.top);
  const right = Math.min(rect.width, windowSize.width - rect.left);
  const bottom = Math.min(rect.height, windowSize.height - rect.top);

  // Fully off-screen (or a bogus window size): fall back to the container itself.
  if (right <= left || bottom <= top) return { left: 0, top: 0, right: rect.width, bottom: rect.height };

  return { left, top, right, bottom };
}

function boundsOf(viewport: Size, bounds?: Bounds): Bounds {
  return bounds ?? { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
}

/** Clamp a centre so the menu's whole outer paint (plus `margin`) stays inside the visible bounds. */
export function clampMenuCenter(
  center: Point,
  viewport: Size,
  bounds?: Bounds,
  extent = QUICK_MENU_OUTER_EXTENT,
  margin = QUICK_MENU_VIEWPORT_MARGIN,
): Point {
  const visible = boundsOf(viewport, bounds);
  const clampAxis = (value: number, start: number, end: number) => {
    const min = start + extent + margin;
    const max = end - extent - margin;

    // Visible span narrower than the menu: centre it on that axis instead of pinning to one edge.
    if (max < min) return (start + end) / 2;

    return Math.min(max, Math.max(min, value));
  };

  return {
    x: clampAxis(center.x, visible.left, visible.right),
    y: clampAxis(center.y, visible.top, visible.bottom),
  };
}

/** Today's spot: hugging the left edge, vertically centred — fully inside, margin included. */
export function getDefaultMenuCenter(viewport: Size, bounds?: Bounds): Point {
  const visible = boundsOf(viewport, bounds);

  return clampMenuCenter({ x: visible.left, y: (visible.top + visible.bottom) / 2 }, viewport, bounds);
}

export function getQuickMenuStorageKey(boardId?: string | null): string {
  return `${STORAGE_KEY_PREFIX}:${boardId || 'default'}`;
}

export function toViewportFraction(center: Point, viewport: Size): Point {
  return {
    x: viewport.width > 0 ? center.x / viewport.width : 0,
    y: viewport.height > 0 ? center.y / viewport.height : 0,
  };
}

export function fromViewportFraction(fraction: Point, viewport: Size): Point {
  return { x: fraction.x * viewport.width, y: fraction.y * viewport.height };
}

/** Parse a stored value; anything malformed or out of [0,1] reads as "no saved position". */
export function parseStoredFraction(raw: string | null | undefined): Point | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Point> | null;
    if (!value || typeof value.x !== 'number' || typeof value.y !== 'number') return null;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    if (value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1) return null;

    return { x: value.x, y: value.y };
  } catch {
    return null;
  }
}

export function serializeFraction(fraction: Point): string {
  return JSON.stringify({ x: Math.round(fraction.x * 10000) / 10000, y: Math.round(fraction.y * 10000) / 10000 });
}

/** Saved position for this board in this viewport, clamped; the default spot when none is saved. */
export function resolveMenuCenter(raw: string | null | undefined, viewport: Size, bounds?: Bounds): Point {
  const fraction = parseStoredFraction(raw);
  if (!fraction) return getDefaultMenuCenter(viewport, bounds);

  return clampMenuCenter(fromViewportFraction(fraction, viewport), viewport, bounds);
}

export function readStoredMenuPosition(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/*
 * Shared anchor: the trigger button («Pen shortcuts») and the menu are one position. It is stored
 * once per board as a viewport fraction; each of them derives its own centre from it, clamped by its
 * own outer extent, so the button and the open menu never drift apart.
 */

/** Trigger button diameter. */
export const QUICK_PEN_TRIGGER_SIZE = 40;
/** Half the button plus its `shadow-sk` hard drop (6px), reserved on every side. */
export const QUICK_PEN_TRIGGER_OUTER_EXTENT = QUICK_PEN_TRIGGER_SIZE / 2 + 6;
/** Gap between the trigger's paint and the visible viewport edge — the old `end-2` inset. */
export const QUICK_PEN_TRIGGER_MARGIN = 8;

const TRIGGER_STORAGE_KEY_PREFIX = 'whiteboard:quick-pen-trigger:position';

export function getQuickPenTriggerStorageKey(boardId?: string | null): string {
  return `${TRIGGER_STORAGE_KEY_PREFIX}:${boardId || 'default'}`;
}

export function clampTriggerCenter(center: Point, viewport: Size, bounds?: Bounds): Point {
  return clampMenuCenter(center, viewport, bounds, QUICK_PEN_TRIGGER_OUTER_EXTENT, QUICK_PEN_TRIGGER_MARGIN);
}

/** Where the trigger sat before it was draggable: the inline-end edge, vertically centred. */
export function getDefaultTriggerCenter(viewport: Size, bounds?: Bounds, isRtl = true): Point {
  const visible = boundsOf(viewport, bounds);

  return clampTriggerCenter(
    { x: isRtl ? visible.left : visible.right, y: (visible.top + visible.bottom) / 2 },
    viewport,
    bounds,
  );
}

/** The trigger's centre for a shared anchor (null = never moved → the default edge spot). */
export function resolveTriggerCenter(anchor: Point | null, viewport: Size, bounds?: Bounds, isRtl = true): Point {
  if (!anchor) return getDefaultTriggerCenter(viewport, bounds, isRtl);

  return clampTriggerCenter(fromViewportFraction(anchor, viewport), viewport, bounds);
}

/** The open menu's centre: centred on the trigger, pulled inward only as far as the ring needs. */
export function resolveMenuCenterForAnchor(
  anchor: Point | null,
  viewport: Size,
  bounds?: Bounds,
  isRtl = true,
): Point {
  return clampMenuCenter(resolveTriggerCenter(anchor, viewport, bounds, isRtl), viewport, bounds);
}

/** New shared anchor after dragging something whose centre started at `origin` by `delta`. */
export function dragAnchor(
  origin: Point,
  delta: Point,
  viewport: Size,
  clamp: (center: Point, viewport: Size, bounds?: Bounds) => Point,
  bounds?: Bounds,
): Point {
  return toViewportFraction(clamp({ x: origin.x + delta.x, y: origin.y + delta.y }, viewport, bounds), viewport);
}

export function readStoredAnchor(key: string): Point | null {
  return parseStoredFraction(readStoredMenuPosition(key));
}

export function writeStoredAnchor(key: string, anchor: Point): void {
  try {
    globalThis.localStorage?.setItem(key, serializeFraction(anchor));
  } catch {
    // storage blocked / full — the position just won't stick.
  }
}
