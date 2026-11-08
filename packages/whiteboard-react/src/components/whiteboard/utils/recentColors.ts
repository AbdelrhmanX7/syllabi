/**
 * Recent pen colours, global across boards: whatever colour actually became the active pen colour
 * (toolbar picker, quick menu, barrel COLOR toggle…), most recent first. The quick pen menu's ring
 * shows these first and fills the rest from the default palette.
 */

export const RECENT_COLORS_STORAGE_KEY = 'whiteboard:recent-colors';
export const RECENT_COLORS_CAP = 12;
export const QUICK_COLOR_RING_SIZE = 6;
/** A custom-picker drag fires a colour per frame; only the one the teacher settles on is recorded. */
export const RECENT_COLOR_RECORD_DEBOUNCE_MS = 600;

function colorKey(color: string): string {
  return color.trim().toLowerCase();
}

export function sameColor(a: string, b: string): boolean {
  return colorKey(a) === colorKey(b);
}

/** Keep the first occurrence of each colour (case-insensitive), dropping blanks. */
export function dedupeColors(colors: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const color of colors) {
    if (typeof color !== 'string' || !color.trim()) continue;
    const key = colorKey(color);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(color.trim());
  }

  return result;
}

/** Move/insert `color` to the front, capped. */
export function pushRecentColor(recent: readonly string[], color: string, cap = RECENT_COLORS_CAP): string[] {
  if (!color || !color.trim()) return [...recent];

  return dedupeColors([color, ...recent]).slice(0, cap);
}

/**
 * The quick menu's colour ring: recent colours first, then the default palette, deduped, exactly
 * `size` slots (when there are enough colours). The active colour is always on it — if it didn't
 * make the cut it takes the last slot.
 */
export function buildQuickColorRing(
  recent: readonly string[],
  palette: readonly string[],
  activeColor: string | null | undefined,
  size = QUICK_COLOR_RING_SIZE,
): string[] {
  const ring = dedupeColors([...recent, ...palette]).slice(0, size);
  if (!activeColor || !activeColor.trim() || ring.some((color) => sameColor(color, activeColor))) return ring;
  if (ring.length < size) return [...ring, activeColor.trim()];

  return [...ring.slice(0, size - 1), activeColor.trim()];
}

export function parseRecentColors(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];

    return dedupeColors(value.filter((item): item is string => typeof item === 'string')).slice(0, RECENT_COLORS_CAP);
  } catch {
    return [];
  }
}

export function readRecentColors(): string[] {
  try {
    return parseRecentColors(globalThis.localStorage?.getItem(RECENT_COLORS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function writeRecentColors(colors: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(RECENT_COLORS_STORAGE_KEY, JSON.stringify(colors.slice(0, RECENT_COLORS_CAP)));
  } catch {
    // storage blocked / full — the ring just falls back to the palette.
  }
}
