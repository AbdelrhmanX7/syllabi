/**
 * The AI panel floats over the whole screen (portalled, `position: fixed`), so it can be dragged
 * anywhere by its header — over the toolbar, the title bar, half off an edge — and resized from its
 * corner. The one rule: enough of the header stays on screen to grab it again. These helpers do the
 * maths in viewport pixels and remember where (and how big) the teacher left it, one spot per device.
 */
import type { CSSProperties } from 'react';

export interface PanelPoint {
  left: number;
  top: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

/** Where the panel sits, plus the size the teacher dragged it to (absent = its natural size). */
export interface PanelPlacement extends PanelPoint {
  width?: number;
  height?: number;
}

export const PANEL_POSITION_KEY = 'wb-ai-panel-pos';
/** Gap kept between an automatically placed panel and the screen edge. */
export const PANEL_MARGIN = 8;
/** Height a panel is assumed to need before it has measured itself; also the smallest resize. */
export const PANEL_MIN_HEIGHT = 200;
/** The narrowest the corner handle can make the panel. */
export const PANEL_MIN_WIDTH = 260;
/** How much of the header must stay on screen vertically: the whole header row. */
export const PANEL_HEADER_KEEP = 44;
/** How much of the header must stay on screen horizontally: enough to put a finger on. */
export const PANEL_GRIP_KEEP = 96;

/**
 * The only clamp: the header stays grabbable. The top never goes above the screen or so low that the
 * header row leaves it; at least {@link PANEL_GRIP_KEEP} px of the panel's width stays on screen on
 * either side. Everything else — overlapping chrome, hanging off an edge — is the teacher's call.
 */
export function clampPanelPosition(point: PanelPoint, width: number, area: PanelSize): PanelPoint {
  const keep = Math.min(PANEL_GRIP_KEEP, width, area.width);
  const minLeft = keep - width;
  const maxLeft = area.width - keep;
  const maxTop = Math.max(0, area.height - PANEL_HEADER_KEEP);
  const clamp = (value: number, min: number, max: number) => (Number.isFinite(value) ? Math.round(Math.max(min, Math.min(value, max))) : Math.round(Math.max(min, 0)));

  return { left: clamp(point.left, minLeft, maxLeft), top: clamp(point.top, 0, maxTop) };
}

/** A dragged size kept between the minimum and the screen. */
export function clampPanelSize(size: PanelSize, area: PanelSize): PanelSize {
  const clamp = (value: number, min: number, max: number) => Math.round(Math.max(Math.min(min, max), Math.min(Number.isFinite(value) ? value : min, max)));

  return { width: clamp(size.width, PANEL_MIN_WIDTH, area.width), height: clamp(size.height, PANEL_MIN_HEIGHT, area.height) };
}

/** A placed panel's natural width on a screen this wide: the phone sheet's full width, else the desktop card. */
export function placedPanelWidth(areaWidth: number, margin = PANEL_MARGIN): number {
  return areaWidth < 640 ? areaWidth - margin * 2 : Math.min(384, areaWidth - margin * 2);
}

/**
 * The style a placed panel gets. A resized panel never grows past the size it was dragged to, but
 * hugs a short body (no empty space under an empty chat); a natural
 * one is capped at the room below its top (never under {@link PANEL_MIN_HEIGHT}), so its body
 * scrolls instead of running off the bottom as an answer streams in.
 */
export function placedPanelStyle(placement: PanelPlacement, area: PanelSize, margin = PANEL_MARGIN): CSSProperties & PanelPoint {
  const width = placement.width ?? Math.min(placedPanelWidth(area.width, margin), area.width - margin * 2);
  const spot = clampPanelPosition(placement, width, area);

  if (placement.height !== undefined) {
    return { left: spot.left, top: spot.top, width, maxHeight: placement.height };
  }

  return { left: spot.left, top: spot.top, width, maxHeight: Math.max(PANEL_MIN_HEIGHT, area.height - spot.top - margin) };
}

interface PositionStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** The remembered placement; an older `{left, top}` entry still reads (natural size). */
export function readPanelPosition(storage: PositionStorage | null | undefined): PanelPlacement | null {
  try {
    const raw = storage?.getItem(PANEL_POSITION_KEY);

    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<Record<keyof PanelPlacement, unknown>>;

    if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null;

    const placement: PanelPlacement = { left: Number(parsed.left), top: Number(parsed.top) };

    if (Number.isFinite(parsed.width) && Number.isFinite(parsed.height) && Number(parsed.width) > 0 && Number(parsed.height) > 0) {
      placement.width = Number(parsed.width);
      placement.height = Number(parsed.height);
    }

    return placement;
  } catch {
    return null;
  }
}

export function writePanelPosition(storage: PositionStorage | null | undefined, placement: PanelPlacement): void {
  try {
    const stored: PanelPlacement = { left: Math.round(placement.left), top: Math.round(placement.top) };

    if (placement.width !== undefined && placement.height !== undefined) {
      stored.width = Math.round(placement.width);
      stored.height = Math.round(placement.height);
    }

    storage?.setItem(PANEL_POSITION_KEY, JSON.stringify(stored));
  } catch {
    /* a convenience */
  }
}

/** `localStorage`, or null where reading it throws (private mode, blocked site data, SSR). */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
