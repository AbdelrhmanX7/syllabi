// Video + notes layout: the share of the width the notes get (dragged on the divider, remembered on
// this device) and where the floating mini player may sit.

export const NOTES_RATIO_DEFAULT = 0.62;
export const MIN_VIDEO_COLUMN_PX = 300;
export const MIN_NOTES_PX = 420;
const RATIO_KEY = 'study_video_notes_ratio';

/** The notes' share of `widthPx`, kept so both columns stay usable; a garbage ratio falls back to the default. */
export function clampNotesRatio(ratio: number, widthPx: number): number {
  const wanted = Number.isFinite(ratio) ? ratio : NOTES_RATIO_DEFAULT;

  if (!(widthPx > 0)) return Math.min(0.9, Math.max(0.3, wanted));
  // Too narrow for both minimums: split what there is in proportion to them.
  if (widthPx < MIN_VIDEO_COLUMN_PX + MIN_NOTES_PX) return MIN_NOTES_PX / (MIN_VIDEO_COLUMN_PX + MIN_NOTES_PX);
  const min = MIN_NOTES_PX / widthPx;
  const max = 1 - MIN_VIDEO_COLUMN_PX / widthPx;

  return Math.min(max, Math.max(min, wanted));
}

export function readNotesRatio(): number {
  try {
    const raw = window.localStorage.getItem(RATIO_KEY);
    const value = raw === null ? NaN : Number(raw);

    return Number.isFinite(value) && value > 0 && value < 1 ? value : NOTES_RATIO_DEFAULT;
  } catch {
    return NOTES_RATIO_DEFAULT;
  }
}

export function writeNotesRatio(ratio: number): void {
  try {
    window.localStorage.setItem(RATIO_KEY, ratio.toFixed(4));
  } catch {
    // private mode — the ratio holds for this visit
  }
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Mini player width for an area this wide: a fifth of it, within readable bounds. */
export function miniPlayerWidth(areaWidth: number): number {
  return Math.round(Math.min(420, Math.max(240, areaWidth * 0.22)));
}

/** Keep the mini player fully inside the area (with a margin); it may not leave the screen. */
export function clampMiniPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  area: { width: number; height: number },
  margin = 12,
): { x: number; y: number } {
  const maxX = Math.max(margin, area.width - size.width - margin);
  const maxY = Math.max(margin, area.height - size.height - margin);

  return { x: Math.min(maxX, Math.max(margin, x)), y: Math.min(maxY, Math.max(margin, y)) };
}
