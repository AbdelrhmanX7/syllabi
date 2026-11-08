/**
 * Test fixture: the owner's first tablet screenshot (S Pen, print-style letters, each letter one or two
 * strokes with small gaps), as stroke boxes in scene units. Lines (baseline y):
 *
 *   «Definition:»          y ≈ 180
 *   «-> Part 1: Mitosis»   y ≈ 285
 *   «-> Part 2:»           y ≈ 390
 *   «-> Part3:»            y ≈ 495
 *
 * Each entry is [left, top, width, height] of one stroke, in writing order, tagged with the word it
 * belongs to (what a correct grouping must reproduce).
 */
export type FixtureStroke = { word: string; box: [number, number, number, number] };

const at = (dy: number, strokes: FixtureStroke[]): FixtureStroke[] =>
  strokes.map((s) => ({ word: s.word, box: [s.box[0], s.box[1] + dy, s.box[2], s.box[3]] }));

const s = (word: string, left: number, top: number, w: number, h: number): FixtureStroke => ({ word, box: [left, top, w, h] });

/** «Definition:» — capital D, f with its cross, two i dots, t cross, colon. */
export const DEFINITION_LINE: FixtureStroke[] = [
  s('Definition:', 70, 140, 6, 40), // D stem
  s('Definition:', 70, 140, 22, 40), // D bowl
  s('Definition:', 98, 160, 15, 20), // e
  s('Definition:', 118, 140, 10, 40), // f
  s('Definition:', 114, 156, 16, 3), // f cross
  s('Definition:', 134, 160, 4, 20), // i
  s('Definition:', 134, 149, 4, 4), // i dot
  s('Definition:', 145, 160, 22, 20), // n
  s('Definition:', 175, 160, 4, 20), // i
  s('Definition:', 175, 149, 4, 4), // i dot
  s('Definition:', 186, 146, 6, 34), // t
  s('Definition:', 181, 158, 16, 3), // t cross
  s('Definition:', 204, 160, 4, 20), // i
  s('Definition:', 204, 149, 4, 4), // i dot
  s('Definition:', 216, 162, 16, 18), // o
  s('Definition:', 240, 160, 20, 20), // n
  s('Definition:', 268, 162, 5, 5), // colon top
  s('Definition:', 268, 176, 5, 5), // colon bottom
];

/** «-> Part N:» + optional rest, at baseline 285. */
const partLine = (digit: boolean, gapBeforeDigit: number): FixtureStroke[] => [
  s('->', 100, 271, 20, 3), // arrow shaft
  s('->', 122, 264, 18, 18), // arrow head
  s('Part', 155, 245, 4, 40), // P stem
  s('Part', 155, 245, 20, 20), // P bowl
  s('Part', 180, 262, 15, 23), // a
  s('Part', 198, 262, 14, 23), // r
  s('Part', 218, 250, 6, 35), // t
  s('Part', 212, 260, 14, 3), // t cross
  ...(digit ? [s('1:', 226 + gapBeforeDigit, 245, 10, 40)] : []), // digit
  s('1:', 236 + gapBeforeDigit + 17, 262, 5, 5), // colon top
  s('1:', 236 + gapBeforeDigit + 17, 278, 5, 5), // colon bottom
];

/** «-> Part 1: Mitosis» — «Mito sis» written with a visible gap, as on the screenshot. */
export const PART1_LINE: FixtureStroke[] = [
  ...partLine(true, 32),
  s('Mitosis', 320, 245, 30, 38), // M
  s('Mitosis', 352, 260, 5, 25), // i
  s('Mitosis', 352, 249, 4, 4), // i dot
  s('Mitosis', 364, 250, 5, 35), // t
  s('Mitosis', 359, 260, 15, 3), // t cross
  s('Mitosis', 392, 265, 16, 20), // o
  s('Mitosis', 425, 265, 15, 20), // s
  s('Mitosis', 444, 262, 5, 23), // i
  s('Mitosis', 444, 251, 4, 4), // i dot
  s('Mitosis', 456, 265, 15, 20), // s
];

/** «-> Part 2:» — the arrow almost touching «P», digit 18 after «t», colon after a gap. */
export const PART2_LINE: FixtureStroke[] = at(
  105,
  partLine(true, 18).map((st) => (st.word === '->' ? { ...st, box: [st.box[0] - 4, st.box[1], st.box[2], st.box[3]] as FixtureStroke['box'] } : st)),
);

/** «-> Part3:» — the digit right against the «t». */
export const PART3_LINE: FixtureStroke[] = at(210, partLine(true, 2).map((st) => (st.word === '1:' ? { ...st, word: 'Part3:' } : st.word === 'Part' ? { ...st, word: 'Part3:' } : st)));
