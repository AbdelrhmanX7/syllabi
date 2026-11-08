import type { GlyphForm, GlyphKey } from './types';

/**
 * «My handwriting» — which bank glyphs spell a word. Latin letters, digits and a little punctuation;
 * every glyph is written on its own (no joining), left to right.
 */

export interface ResolvedGlyph {
  char: string;
  form: GlyphForm;
  /** Bank keys to try in order; the first present wins. Empty for a character nobody can write. */
  candidates: GlyphKey[];
  /** Synthesised from the dot glyph: `.` `,` `:` need no sheet cell of their own. */
  synth?: 'period' | 'comma' | 'colon';
}

/** The dot cell. The key name predates the English-only sheet and stays for saved banks. */
export const dotKey = (count: 1 | 2 | 3 = 1): GlyphKey => `ar-dot:${count}`;
export const digitKey = (char: string): GlyphKey => `digit:${char}`;
export const latinKey = (char: string): GlyphKey => `lat:${char}`;

const DIGIT_RE = /[0-9]/;
const LATIN_RE = /[A-Za-z]/;

export const isDigit = (char: string): boolean => DIGIT_RE.test(char);
export const isLatin = (char: string): boolean => LATIN_RE.test(char);

/** One character → the glyph compose will look for, with its bank keys in preference order. */
export function resolveGlyph(char: string): ResolvedGlyph {
  if (isDigit(char)) return { char, form: 'isol', candidates: [digitKey(char)] };
  if (isLatin(char)) {
    const lower = char.toLowerCase();

    return { char, form: 'isol', candidates: lower === char ? [latinKey(char)] : [latinKey(char), latinKey(lower)] };
  }

  if (char === '.' || char === ',' || char === ':') {
    return { char, form: 'isol', candidates: [dotKey(1)], synth: char === '.' ? 'period' : char === ':' ? 'colon' : 'comma' };
  }

  return { char, form: 'isol', candidates: [] };
}

/** One word → the glyphs that spell it, in reading order. */
export function shapeWord(word: string): ResolvedGlyph[] {
  return Array.from(word).map((char) => resolveGlyph(char));
}
