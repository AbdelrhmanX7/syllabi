// Pure logic for the `matching` and `fill_blank` question types (BE #580 shapes): blank splitting,
// matching state, attempt payloads, verdict marks and the stored-answer encodings.
//   matching   → answer `{"<left>":"<right>"}`; open exams send pairs as `{left, right:null}`
//   fill_blank → answer `["word|alt", …]`, one entry per run of ≥3 underscores in the stem

import type { MdBlock } from './markdown';
import type { Question } from '@/lib/api/types';

import { parseMarkdown } from './markdown';

/* ------------------------------------------------------------------ fill_blank */

export type BlankSegment = { kind: 'text'; text: string } | { kind: 'blank'; index: number };

/** Any run of three or more underscores is one blank — anywhere in the stem, exactly as the BE counts. */
const BLANK_RE = /_{3,}/g;

/** Splits one run of text into text and blanks, numbering blanks from `start`. */
export function splitBlanks(text: string, start = 0): { segments: BlankSegment[]; next: number } {
  const segments: BlankSegment[] = [];
  let index = start;
  let last = 0;
  let match: RegExpExecArray | null;

  BLANK_RE.lastIndex = 0;
  while ((match = BLANK_RE.exec(text)) !== null) {
    if (match.index > last) segments.push({ kind: 'text', text: text.slice(last, match.index) });
    segments.push({ kind: 'blank', index });
    index += 1;
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });

  return { segments, next: index };
}

/** A markdown block with its inline runs pre-split into blanks. */
export type BlankBlock =
  | { type: 'p' | 'h'; level?: number; segments: BlankSegment[] }
  | { type: 'list'; ordered: boolean; items: BlankSegment[][] }
  | Exclude<MdBlock, { type: 'p' } | { type: 'h' } | { type: 'list' }>;

/**
 * Parses a stem into blocks and numbers every blank across them, in reading order. A code or math
 * block that holds a blank becomes a plain paragraph so the numbering still matches the BE's count.
 */
export function parseBlankStem(stem: string): { blocks: BlankBlock[]; count: number } {
  let next = 0;
  const split = (text: string) => {
    const out = splitBlanks(text, next);

    next = out.next;

    return out.segments;
  };
  const blocks: BlankBlock[] = parseMarkdown(stem).map((block) => {
    if (block.type === 'p') return { type: 'p', segments: split(block.text) };
    if (block.type === 'h') return { type: 'h', level: block.level, segments: split(block.text) };
    if (block.type === 'list') return { type: 'list', ordered: block.ordered, items: block.items.map(split) };
    if (block.type === 'code' && /_{3,}/.test(block.code)) return { type: 'p', segments: split(block.code) };
    if (block.type === 'math' && /_{3,}/.test(block.tex)) return { type: 'p', segments: split(block.tex) };

    return block;
  });

  return { blocks, count: next };
}

export const blankCount = (stem: string): number => (stem.match(BLANK_RE) ?? []).length;

/** The stem with each blank drawn as a visible gap that the inline parser won't read as `_em_`. */
export const stemWithGaps = (stem: string): string => stem.replace(BLANK_RE, '＿＿＿');

/** Normalises a draft to exactly `count` entries. */
export function sizeBlanks(values: readonly string[] | undefined, count: number): string[] {
  return Array.from({ length: count }, (_, i) => values?.[i] ?? '');
}

export const blanksStarted = (values: readonly string[] | undefined) =>
  Boolean(values?.some((v) => v.trim().length > 0));

/** `{ blanks }` — trimmed, one per blank, empty strings kept so positions line up. */
export const fillBlankPayload = (values: readonly string[], count: number) => ({
  blanks: sizeBlanks(values, count).map((v) => v.trim()),
});

/** The stored key → one entry per blank with its alternatives (`["lava|lava flow"]` → `[["lava","lava flow"]]`). */
export function decodeBlankAnswer(answer: string | null | undefined): string[][] {
  const text = (answer ?? '').trim();

  if (!text) return [];
  let list: unknown = [text];

  if (text.startsWith('[')) {
    try {
      list = JSON.parse(text);
    } catch {
      list = [text];
    }
  }
  if (!Array.isArray(list)) return [];

  return list.map((entry) =>
    String(entry ?? '')
      .split('|')
      .map((alt) => alt.trim())
      .filter(Boolean),
  );
}

/**
 * Editor lines (one per blank, `|` between accepted alternatives) → the stored JSON key, or an error
 * when the number of lines does not match the blanks in the stem.
 */
export function encodeBlankAnswer(lines: string, stem: string): { answer: string } | { error: string } {
  const count = blankCount(stem);
  const entries = lines
    .split('\n')
    .map((line) =>
      line
        .split('|')
        .map((alt) => alt.trim())
        .filter(Boolean)
        .join('|'),
    )
    .filter(Boolean);

  if (!count) return { error: 'Put a ___ (three underscores) in the question for each blank.' };
  if (entries.length !== count)
    return {
      error: `The question has ${count} blank${count === 1 ? '' : 's'} but ${entries.length} answer line${entries.length === 1 ? '' : 's'}.`,
    };

  return { answer: JSON.stringify(entries) };
}

/* ------------------------------------------------------------------ matching */

export type Matches = Record<string, string>;

export const matchingLefts = (question: Pick<Question, 'pairs'>): string[] => (question.pairs ?? []).map((p) => p.left);

/** The right-hand options: the server's `choices`, else the pairs' rights (de-duplicated). */
export function matchingChoices(question: Pick<Question, 'pairs' | 'choices'>): string[] {
  if (question.choices?.length) return question.choices;

  return Array.from(new Set((question.pairs ?? []).map((p) => p.right ?? '').filter(Boolean)));
}

/** One option per left unless there are fewer options than lefts (then options repeat). */
export const matchingIsUnique = (lefts: number, choices: number) => choices >= lefts;

/** Assigns `right` to `left`; with `unique`, the option leaves whichever left held it before. */
export function assignMatch(matches: Matches, left: string, right: string, unique: boolean): Matches {
  const next: Matches = {};

  for (const [l, r] of Object.entries(matches)) {
    if (l === left) continue;
    if (unique && r === right) continue;
    next[l] = r;
  }
  next[left] = right;

  return next;
}

export function clearMatch(matches: Matches, left: string): Matches {
  const next = { ...matches };

  delete next[left];

  return next;
}

/** The next left without an answer after `from` (wrapping), or null when all are matched. */
export function nextUnmatched(lefts: readonly string[], matches: Matches, from: string | null): string | null {
  if (!lefts.length) return null;
  const start = from ? lefts.indexOf(from) + 1 : 0;

  for (let k = 0; k < lefts.length; k += 1) {
    const left = lefts[(start + k) % lefts.length]!;

    if (!matches[left]) return left;
  }

  return null;
}

/** Which lefts hold `right` — for the «used» badge on an option. */
export function leftsHolding(matches: Matches, right: string): string[] {
  return Object.entries(matches)
    .filter(([, r]) => r === right)
    .map(([l]) => l);
}

export const matchesStarted = (matches: Matches | undefined) => Boolean(matches && Object.keys(matches).length);

/** `{ matches }` — only lefts that belong to the question. */
export function matchingPayload(lefts: readonly string[], matches: Matches): { matches: Matches } {
  const out: Matches = {};

  for (const left of lefts) if (matches[left]) out[left] = matches[left]!;

  return { matches: out };
}

/** Whether every right is known (bank solve, results) — open exams send `right: null`. */
export const pairsRevealed = (question: Pick<Question, 'pairs'>) =>
  Boolean(question.pairs?.length) && question.pairs!.every((p) => Boolean(p.right?.trim()));

/**
 * Editor lines `left => right` (also `→`, `->` or a tab) → pairs, plus the stored JSON key. Extra
 * options (distractors) join the rights in `choices`; with none, the server shuffles the rights.
 */
export function encodeMatching(
  lines: string,
  distractors = '',
): { pairs: { left: string; right: string }[]; choices?: string[]; answer: string } | { error: string } {
  const pairs: { left: string; right: string }[] = [];
  const seen = new Set<string>();

  for (const raw of lines.split('\n')) {
    const line = raw.trim();

    if (!line) continue;
    const parts = line.split(/\s*(?:=>|→|->|\t)\s*/);

    if (parts.length !== 2 || !parts[0] || !parts[1]) return { error: `Write each pair as "left => right": ${line}` };
    const key = parts[0].toLowerCase();

    if (seen.has(key)) return { error: `"${parts[0]}" is on the left twice.` };
    seen.add(key);
    pairs.push({ left: parts[0], right: parts[1] });
  }
  if (pairs.length < 2) return { error: 'Add at least two pairs.' };
  const extra = distractors
    .split('\n')
    .map((d) => d.trim())
    .filter(Boolean);
  const answer = JSON.stringify(Object.fromEntries(pairs.map((p) => [p.left, p.right])));

  if (!extra.length) return { pairs, answer };
  const choices = Array.from(new Set([...pairs.map((p) => p.right), ...extra]));

  return { pairs, choices, answer };
}

/* ------------------------------------------------------------------ shared */

/**
 * Per-item ✓/✗ from the verdict steps (BE: one step per pair / per blank, in order); nulls when the
 * step count does not line up.
 */
export function stepMarks(steps: readonly { ok: boolean }[] | undefined, count: number): (boolean | null)[] {
  if (!steps || steps.length !== count) return Array.from({ length: count }, () => null);

  return steps.map((s) => s.ok);
}

export const isStructured = (type: Question['type']) => type === 'matching' || type === 'fill_blank';
