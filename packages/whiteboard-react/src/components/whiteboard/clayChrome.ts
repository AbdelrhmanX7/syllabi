/**
 * Board chrome in the host app's clay look: a soft edge and a solid lip straight DOWN in the same colour.
 * Reads Study's `--st-*` tokens and falls back to their light values outside Study.
 */
export const CLAY_EDGE = 'border-2 border-[rgb(var(--st-clay-edge,205_209_224))]';
export const CLAY_LIP = 'shadow-[0_4px_0_rgb(var(--st-clay-edge,205_209_224))]';
export const CLAY_SURFACE = 'bg-[rgb(var(--st-surface,255_255_255))] text-ink';
export const CLAY_PRESS = 'transition-[transform,box-shadow] duration-100 active:translate-y-[3px] active:shadow-none';

/** A darker rung of a #rrggbb fill, for a coloured key's own edge and lip (no color-mix: Chrome 103). */
export function clayRung(hex: string, amount = 0.28): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());

  if (!m) return 'rgba(24, 32, 74, 0.35)';
  const n = parseInt(m[1], 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - amount) + 24 * amount);

  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}
