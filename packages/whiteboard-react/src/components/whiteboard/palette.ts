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

/** Pen / stroke inks. Graphite, never pure black. The same list as whiteboard-core's `DEFAULT_COLORS`. */
export const INK_COLORS = [
  '#1F2937', // graphite
  '#2563EB', // blue
  '#991B1B', // red (deep, so it never reads like the green or the orange)
  '#15803D', // green
  '#C2410C', // orange
  '#581C87', // purple (deep, apart from the blue for red–green colour blindness)
  '#A21CAF', // magenta
  '#115E59', // teal
] as const;

export const DEFAULT_INK_COLOR = INK_COLORS[0];

/**
 * Highlighter inks — full-strength hexes, laid down at the highlighter's own translucency, so text under
 * them stays readable.
 */
export const HIGHLIGHTER_INKS = [
  '#FFD60A', // yellow
  '#4ADE80', // green
  '#38BDF8', // blue
  '#F472B6', // pink
  '#FB923C', // orange
] as const;

/** «No fill». Stored as an empty fill on the object. */
export const NO_FILL = 'transparent';

/**
 * Light fill tints, one per ink (same order), so a blue outline pairs with a light blue fill. On the
 * dark board they are painted as deep tints of the same hue instead (`darkBoardFillColor`).
 */
export const FILL_TINTS = [
  '#E5E7EB', // graphite
  '#DBEAFE', // blue
  '#FEE2E2', // red
  '#DCFCE7', // green
  '#FFEDD5', // orange
  '#F3E8FF', // purple
  '#FAE8FF', // magenta
  '#CCFBF1', // teal
  '#FEF9C3', // yellow (pairs with the yellow highlight)
] as const;

/** The short background row of the shape panel: none, then light red, green, blue and yellow. */
export const QUICK_FILL_TINTS = [NO_FILL, FILL_TINTS[2], FILL_TINTS[3], FILL_TINTS[1], FILL_TINTS[8]] as const;

/** The light fill that pairs with an ink of the palette (null for a colour outside it). */
export function tintForInk(ink: string): string | null {
  const index = INK_COLORS.findIndex((color) => color.toLowerCase() === ink.toLowerCase());

  return index >= 0 ? FILL_TINTS[index]! : null;
}
