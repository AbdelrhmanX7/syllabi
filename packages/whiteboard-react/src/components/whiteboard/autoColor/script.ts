/**
 * Script handling for handwritten notes. The product is English-only, so the recognizer runs the
 * English model alone and every reading is `en`. The helpers keep their shapes (candidate lists per
 * script, a per-word pick, a per-line pick) so the controller and the debug overlay stay unchanged.
 *
 * Digits and symbols are script-neutral: a word that is mostly digits/operators keeps its reading.
 */
import type { InkDirection, InkScript } from './model';
import type { InkCandidate } from './types';

const LATIN = /[A-Za-z]/;
const SYMBOL_OR_DIGIT = /[0-9=+\-−×÷/^*().,%<>→←]/;

export interface ScriptPick {
  script: InkScript;
  text: string;
  /** 0–1: how sure the pick is (for the debug overlay and telemetry). */
  confidence: number;
}

/** Normalised edit similarity of two short strings (1 = identical). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);

  for (let i = 1; i <= m; i += 1) {
    const cur = [i];

    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }

    prev = cur;
  }

  return 1 - prev[n] / Math.max(m, n);
}

/** Share of a text's non-space characters that are digits / operators. */
export function symbolRatio(text: string): number {
  const chars = Array.from(text.replace(/\s+/g, ''));

  if (chars.length === 0) return 0;

  return chars.filter((ch) => SYMBOL_OR_DIGIT.test(ch)).length / chars.length;
}

/** `en` when the text holds any Latin letter; `null` for digits / symbols only. */
export function scriptOfText(text: string): InkScript | null {
  return LATIN.test(text) ? 'en' : null;
}

function stability(candidates: InkCandidate[]): number {
  if (candidates.length < 2) return 0.5;
  const top = candidates[0].text;
  const others = candidates.slice(1, 3);

  return others.reduce((sum, c) => sum + similarity(top, c.text), 0) / others.length;
}

/** The recognizer's flat candidate list → the English model's best-first list (`en`, `en-US`… → en). */
export function splitByScript(candidates: readonly InkCandidate[]): Record<InkScript, InkCandidate[]> {
  const out: Record<InkScript, InkCandidate[]> = { en: [] };

  for (const candidate of candidates) {
    if (!candidate.text.trim()) continue;
    const tag = candidate.lang.toLowerCase();

    if (tag === 'en' || tag.startsWith('en-')) out.en.push(candidate);
  }

  return out;
}

/** The reading (and how self-consistent the model is about it) for one word. */
export function pickScript(candidates: readonly InkCandidate[], _dirHint: InkDirection | null, _prior: InkScript | null): ScriptPick | null {
  const { en } = splitByScript(candidates);

  if (en.length === 0) return null;

  return { script: 'en', text: en[0].text, confidence: Math.round((0.5 + 0.5 * stability(en)) * 100) / 100 };
}

/** One script for a whole LINE: `en` when any word was read, otherwise the previous line's. */
export function pickLineScript(
  words: ReadonlyArray<{ candidates: readonly InkCandidate[]; weight: number }>,
  _lineDir: InkDirection | null,
  prior: InkScript | null,
): InkScript | null {
  return words.some((word) => pickScript(word.candidates, null, null)) ? 'en' : prior;
}

/** A word's text read in the line's script. */
export function textInScript(candidates: readonly InkCandidate[], _script: InkScript): string {
  return splitByScript(candidates).en[0]?.text ?? '';
}
