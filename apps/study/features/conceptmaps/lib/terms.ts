// Prompt-term checklist matching: which of the instructor's terms appear among the nodes the model
// read off the map. Tolerant of case, punctuation, possessives, plurals, extra words ("Plate
// tectonics theory") and short misspellings ("Phanitic" for "Phaneritic"). Pure — unit-tested.
import type { ReadNode } from '../types';

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for']);

/** Lower-case, no diacritics, no punctuation, possessives dropped, single spaces. */
export function normalizeTerm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Crude English singular: series → series, boundaries → boundary, bonds → bond, gases → gas. */
export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/(ss|us|is|series)$/.test(word)) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(sh|ch|x|z|s)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);

  return word;
}

export function termTokens(value: string): string[] {
  return normalizeTerm(value)
    .split(' ')
    .filter((token) => token && !STOPWORDS.has(token))
    .map(singularize);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }

  return previous[b.length]!;
}

/** Edits allowed for two tokens to count as the same word: none under 5 letters (mica ≠ mice), 1 at 5–7, 2 from 8. */
export const tokenAllowance = (length: number): number => (length >= 8 ? 2 : length >= 5 ? 1 : 0);

export function tokensEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const allowance = tokenAllowance(Math.min(a.length, b.length));

  return allowance > 0 && levenshtein(a, b) <= allowance;
}

/** True when every token of `term` appears, in order, somewhere in `label`. */
export function termMatches(term: string, label: string): boolean {
  const needle = termTokens(term);
  const hay = termTokens(label);

  if (needle.length === 0 || hay.length === 0) return false;
  if (needle.length === 1) return hay.some((token) => tokensEqual(token, needle[0]!));

  for (let start = 0; start + needle.length <= hay.length; start += 1) {
    let ok = true;

    for (let offset = 0; offset < needle.length; offset += 1) {
      if (!tokensEqual(hay[start + offset]!, needle[offset]!)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }

  // Compound terms written as one word ("seafloor spreading" ↔ "sea floor spreading").
  const joinedNeedle = needle.join('');
  const joinedHay = hay.join(' ');

  return (
    joinedHay.split(' ').some((token) => tokensEqual(token, joinedNeedle)) ||
    joinedHay.replace(/ /g, '').includes(joinedNeedle)
  );
}

export interface TermMatch {
  term: string;
  /** The node that carries the term, or null when it is missing from the map. */
  node: ReadNode | null;
  /** Matched by exact normalized text (false = fuzzy / contained). */
  exact: boolean;
}

/** One row per prompt term; a node is claimed by at most one term (exact matches claim first). */
export function matchTerms(terms: string[], nodes: ReadNode[]): TermMatch[] {
  const claimed = new Set<string>();
  const result: TermMatch[] = terms.map((term) => ({ term, node: null, exact: false }));

  // Pass 1 — exact.
  result.forEach((row) => {
    const exact = nodes.find((node) => !claimed.has(node.id) && normalizeTerm(node.label) === normalizeTerm(row.term));

    if (exact) {
      row.node = exact;
      row.exact = true;
      claimed.add(exact.id);
    }
  });
  // Pass 2 — fuzzy / contained, shortest label first so "Plate Tectonics" takes "plate tectonics
  // theory" before a long definition bubble that merely mentions it.
  const byLength = [...nodes].sort((a, b) => a.label.length - b.label.length);

  result.forEach((row) => {
    if (row.node) return;
    const hit = byLength.find((node) => !claimed.has(node.id) && termMatches(row.term, node.label));

    if (hit) {
      row.node = hit;
      claimed.add(hit.id);
    }
  });

  return result;
}

export const missingTerms = (terms: string[], nodes: ReadNode[]): string[] =>
  matchTerms(terms, nodes)
    .filter((row) => !row.node)
    .map((row) => row.term);

/** Splits a typed "a, b; c" list into clean, de-duplicated terms (max 8). */
export function parseTermList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of text.split(/[,;\n]+/)) {
    const term = raw.trim().replace(/\s+/g, ' ');
    const key = normalizeTerm(term);

    if (!term || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= 8) break;
  }

  return out;
}
