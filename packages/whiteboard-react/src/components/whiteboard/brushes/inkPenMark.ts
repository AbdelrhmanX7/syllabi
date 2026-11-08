import { Path } from 'fabric';

/**
 * Which outline pen drew a filled stroke (`'script'` or `'brush'`), saved on the stroke so «Size» on the
 * selection bar knows how to read its outline (see `utils/inkOutlineResize`). Strokes saved before this
 * existed have no mark; their pen is worked out from the outline's shape instead.
 */
export const INK_PEN_PROP = 'inkPen';

export type InkPen = 'script' | 'brush';

/** Keep {@link INK_PEN_PROP} through `toJSON` (Fabric drops unlisted props). Idempotent. */
export function registerInkPenPersistence(): void {
  const own = Object.prototype.hasOwnProperty.call(Path, 'customProperties') ? Path.customProperties : undefined;
  const current = own ?? Path.customProperties ?? [];

  if (!current.includes(INK_PEN_PROP)) Path.customProperties = [...current, INK_PEN_PROP];
}

export function markInkPen(path: Path, pen: InkPen): Path {
  registerInkPenPersistence();
  (path as unknown as Record<string, unknown>)[INK_PEN_PROP] = pen;

  return path;
}

export function inkPenOf(path: unknown): InkPen | undefined {
  const value = (path as Record<string, unknown> | null)?.[INK_PEN_PROP];

  return value === 'script' || value === 'brush' ? value : undefined;
}
