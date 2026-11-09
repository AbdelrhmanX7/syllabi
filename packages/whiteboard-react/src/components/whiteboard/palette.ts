/**
 * The board's colour set — one considered palette for the pen, the highlighter and shape / area fills,
 * used by the toolbar, the pen shortcuts menu and the selection panel alike.
 *
 * Ink is stored as picked (a light-paper colour). On the dark board it is painted lighter at draw time
 * (`utils/darkBoard.ts`), so every ink here is the LIGHT half of a light/dark pair whose dark half is
 * `darkBoardInkColor(ink)`. Both halves were measured (see `palette.test.ts`): ≥ 4.5 : 1 against the
 * paper they sit on, and still apart from each other for the common colour blindnesses (simulated:
 * the closest pair stays a clear step apart under protan, deutan and tritan vision).
 *
 * Old pages are untouched: a stored colour is never rewritten, so ink saved in an older colour (pure
 * black included) paints exactly as before.
 */

/** Pen / stroke inks: the board's original set (the owner prefers it). Same list as whiteboard-core's `DEFAULT_COLORS`. */
export const INK_COLORS = [
  '#000000',
  '#FFFFFF',
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#6B7280',
] as const;

export const DEFAULT_INK_COLOR = INK_COLORS[0];

/**
 * Highlighter inks — full-strength hexes, laid down at the highlighter's own translucency, so text under
 * them stays readable.
 */
export const HIGHLIGHTER_INKS = ['#ffd60a', '#ff9f1c', '#ff5d8f', '#7bd389', '#4cc9f0', '#a78bfa', '#f15bb5', '#2f5bea', '#9ef01a', '#ffffff'] as const;

/** «No fill». Stored as an empty fill on the object. */
export const NO_FILL = 'transparent';

/**
 * Light fill tints, one per ink (same order), so a blue outline pairs with a light blue fill. On the
 * dark board they are painted as deep tints of the same hue instead (`darkBoardFillColor`).
 */
export const FILL_TINTS = [
  '#E5E7EB', // black
  '#FFFFFF', // white
  '#FEE2E2', // red
  '#FFEDD5', // orange
  '#FEF9C3', // yellow
  '#DCFCE7', // green
  '#DBEAFE', // blue
  '#EDE9FE', // violet
  '#FCE7F3', // pink
  '#F3F4F6', // grey
] as const;

/** The short background row of the shape panel: none, then light red, green, blue and yellow. */
export const QUICK_FILL_TINTS = [NO_FILL, FILL_TINTS[2], FILL_TINTS[5], FILL_TINTS[6], FILL_TINTS[4]] as const;

/** The light fill that pairs with an ink of the palette (null for a colour outside it). */
export function tintForInk(ink: string): string | null {
  const index = INK_COLORS.findIndex((color) => color.toLowerCase() === ink.toLowerCase());

  return index >= 0 ? FILL_TINTS[index]! : null;
}
