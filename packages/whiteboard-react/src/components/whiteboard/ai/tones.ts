import type { BoardAiTone } from './types';

/**
 * Semantic colours in an AI answer. The model marks a part of its answer as correct, a mistake, a
 * caution or a tip with a callout — `> [!success]` (GitHub/Obsidian style, the body on the following
 * `>` lines) or a `:::wrong … :::` fence — or a short phrase inline as `:success[well done]`. The panel
 * tints those parts, the board writes them in the matching ink. A name we do not know is NOT a tone:
 * the text stays exactly as the model wrote it.
 */

const TONE_ALIASES: Record<string, BoardAiTone> = {
  success: 'success',
  correct: 'success',
  right: 'success',
  good: 'success',
  wrong: 'wrong',
  mistake: 'wrong',
  error: 'wrong',
  incorrect: 'wrong',
  danger: 'wrong',
  warning: 'warning',
  warn: 'warning',
  caution: 'warning',
  important: 'warning',
  info: 'info',
  note: 'info',
  tip: 'info',
  hint: 'info',
};

/** A callout / span name → its tone, or null for a name we do not colour. */
export function parseTone(name: string | undefined | null): BoardAiTone | null {
  return TONE_ALIASES[(name ?? '').trim().toLowerCase()] ?? null;
}

const TONE_NAMES = Object.keys(TONE_ALIASES).join('|');

/** `:success[short phrase]` — an inline tone span (no nesting, one line). */
export const INLINE_TONE_RE = new RegExp(`:(${TONE_NAMES})\\[([^\\]\\n]+)\\]`, 'gi');

/** `> [!success] optional first line` — a callout head. */
export const CALLOUT_HEAD_RE = /^\s{0,3}>\s*\[!([A-Za-z]+)\][+-]?\s*(.*)$/;
/** A `>` continuation line of a callout. */
export const CALLOUT_LINE_RE = /^\s{0,3}>\s?(.*)$/;
/** `:::success` — a fenced callout's opening line; `:::` alone closes it. */
export const TONE_FENCE_OPEN_RE = /^\s*:::\s*([A-Za-z]+)\s*$/;
export const TONE_FENCE_CLOSE_RE = /^\s*:::\s*$/;

/** Inline tone spans → their plain text (the board and copy paths). */
export function stripInlineTones(text: string): string {
  return text.replace(INLINE_TONE_RE, '$2');
}

/** The ink a toned block is written in on the board (readable on the white page). */
export const TONE_INK: Record<BoardAiTone, string> = {
  success: '#15803d',
  wrong: '#dc2626',
  warning: '#b45309',
  info: '#2563eb',
};

export const toneInk = (tone: BoardAiTone | undefined | null): string | undefined => (tone ? TONE_INK[tone] : undefined);
