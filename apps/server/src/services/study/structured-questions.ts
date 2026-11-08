import type { AttemptResult, IStudyQuestion } from "@/models/study/question";

/**
 * `matching` and `fill_blank` questions: storage shape, validation and DETERMINISTIC grading
 * (no model call). Both store their key in the existing `answer` string as JSON:
 *   matching   → `{"<left>":"<right>"}` (always derived from `pairs`, the source of truth)
 *   fill_blank → `["word|alt1|alt2", …]`, one entry per `___` in the stem
 * Grading returns the same verdict shape as every other grader (steps `{index,text,latex,ok,note}`).
 */

export class StructuredInputError extends Error {}

export const MATCHING_MAX_PAIRS = 20;
export const MATCHING_MAX_CHOICES = 30;
export const FILL_BLANK_MAX = 30;
/** Typo tolerance: Levenshtein ≤ 1 only for expected words LONGER than this many characters. */
export const FUZZY_MIN_LEN = 5;

const BLANK_RX = /_{3,}/g;
export const countBlanks = (stem: string) => (String(stem ?? "").match(BLANK_RX) ?? []).length;

/** Compare form: NFKC, trimmed, lower-case, inner whitespace collapsed. */
export const normAnswer = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const clean = (v: unknown, max: number): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

const parseJson = (v: string): unknown => {
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

// ─── matching ───────────────────────────────────────────────────────────────────────────

export type Pair = { left: string; right: string };

/** Deterministic shuffle (so the same pairs always give the same choice order). */
function stableShuffle(list: string[]): string[] {
  const key = (s: string) => {
    let h = 2166136261;
    for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return h;
  };
  return [...list].sort((a, b) => key(a) - key(b) || a.localeCompare(b));
}

/**
 * Raw input → `{pairs, choices, answer}`. `pairs` may come as `[{left,right}]` or, when absent,
 * from an `answer` object / JSON object. Empty `choices` → the rights, shuffled. Throws
 * StructuredInputError on: no pairs, a blank side, duplicate left, a right missing from choices.
 */
export function normalizeMatching(raw: { pairs?: unknown; choices?: unknown; answer?: unknown }): { pairs: Pair[]; choices: string[]; answer: string } {
  let src: unknown = raw.pairs;
  if (!Array.isArray(src) || !src.length) {
    const a = typeof raw.answer === "string" ? parseJson(raw.answer) : raw.answer;
    if (a && typeof a === "object" && !Array.isArray(a)) src = Object.entries(a as Record<string, unknown>).map(([left, right]) => ({ left, right }));
  }
  if (!Array.isArray(src) || !src.length) throw new StructuredInputError("matching needs a non-empty pairs array of {left, right}");
  if (src.length > MATCHING_MAX_PAIRS) throw new StructuredInputError(`matching allows at most ${MATCHING_MAX_PAIRS} pairs`);
  const pairs: Pair[] = [];
  const lefts = new Set<string>();
  for (let i = 0; i < src.length; i++) {
    const p = src[i] as any;
    const left = clean(p?.left, 500);
    const right = clean(p?.right, 500);
    if (!left || !right) throw new StructuredInputError(`pairs[${i}] needs a non-empty left and right`);
    if (lefts.has(normAnswer(left))) throw new StructuredInputError(`pairs: duplicate left "${left}"`);
    lefts.add(normAnswer(left));
    pairs.push({ left, right });
  }
  let choices = Array.isArray(raw.choices) ? raw.choices.map((c) => clean(c, 500)).filter((c): c is string => !!c) : [];
  choices = [...new Map(choices.map((c) => [normAnswer(c), c])).values()];
  if (!choices.length) choices = stableShuffle([...new Map(pairs.map((p) => [normAnswer(p.right), p.right])).values()]);
  if (choices.length > MATCHING_MAX_CHOICES) throw new StructuredInputError(`matching allows at most ${MATCHING_MAX_CHOICES} choices`);
  const have = new Set(choices.map(normAnswer));
  const missing = pairs.find((p) => !have.has(normAnswer(p.right)));
  if (missing) throw new StructuredInputError(`choices must include every right ("${missing.right}" is missing)`);
  return { pairs, choices, answer: JSON.stringify(Object.fromEntries(pairs.map((p) => [p.left, p.right]))) };
}

// ─── fill_blank ─────────────────────────────────────────────────────────────────────────

/** Stored/input answer → `["word|alt", …]`: an array, a JSON array string, or one plain string (one blank). */
export function parseBlankAnswer(answer: unknown): string[] {
  let list: unknown = answer;
  if (typeof answer === "string") {
    const t = answer.trim();
    const j = t.startsWith("[") ? parseJson(t) : undefined;
    list = Array.isArray(j) ? j : t ? [t] : [];
  }
  if (!Array.isArray(list)) return [];
  return list.map((x) => {
    const alts = String(typeof x === "number" ? x : typeof x === "string" ? x : "")
      .split("|")
      .map((a) => a.trim().slice(0, 300))
      .filter(Boolean);
    return alts.join("|");
  });
}

/** Validated `{answer}` for a fill_blank stem; throws when the blank count and answer length differ. */
export function normalizeFillBlank(stem: string, answer: unknown): { answer: string } {
  const blanks = countBlanks(stem);
  if (!blanks) throw new StructuredInputError("fill_blank stem needs at least one ___ blank");
  if (blanks > FILL_BLANK_MAX) throw new StructuredInputError(`fill_blank allows at most ${FILL_BLANK_MAX} blanks`);
  const list = parseBlankAnswer(answer);
  if (list.length !== blanks) throw new StructuredInputError(`fill_blank: the stem has ${blanks} blank${blanks > 1 ? "s" : ""} but answer has ${list.length} entr${list.length === 1 ? "y" : "ies"}`);
  const empty = list.findIndex((e) => !e);
  if (empty >= 0) throw new StructuredInputError(`fill_blank: answer[${empty}] is empty`);
  return { answer: JSON.stringify(list) };
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** One blank: exact (normalised) match on any alt, or one edit away from an alt longer than FUZZY_MIN_LEN. */
export function blankMatches(given: unknown, entry: string): "exact" | "close" | null {
  const g = normAnswer(given);
  if (!g) return null;
  const alts = entry.split("|").map(normAnswer).filter(Boolean);
  if (alts.includes(g)) return "exact";
  return alts.some((a) => a.length > FUZZY_MIN_LEN && levenshtein(g, a) <= 1) ? "close" : null;
}

// ─── grading ────────────────────────────────────────────────────────────────────────────

type Step = { index: number; text: string; latex: null; ok: boolean; note: string };
type Verdict = { result: AttemptResult; steps: Step[]; firstErrorStep: number | null; hint: string | null; solution: string | null };

const settle = (steps: Step[], what: string, solution: string | null, reveal: boolean): Verdict => {
  const right = steps.filter((s) => s.ok).length;
  const result: AttemptResult = right === steps.length ? "right" : right === 0 ? "wrong" : "partial";
  return {
    result,
    steps,
    firstErrorStep: steps.find((s) => !s.ok)?.index ?? null,
    hint: result === "right" ? null : `${right} of ${steps.length} ${what} correct.`,
    solution: reveal ? solution : null,
  };
};

/** Student `matches` (`{left: right}`) must be a plain object of strings. */
export function validMatches(v: unknown): v is Record<string, string | null> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = Object.entries(v as Record<string, unknown>);
  return e.length <= 100 && e.every(([k, x]) => k.length <= 500 && (x === null || (typeof x === "string" && x.length <= 500)));
}

export function validBlanks(v: unknown): v is Array<string | null> {
  return Array.isArray(v) && v.length <= 100 && v.every((x) => x === null || (typeof x === "string" && x.length <= 500));
}

export function gradeMatching(q: Pick<IStudyQuestion, "pairs">, matches: Record<string, string | null>, reveal: boolean): Verdict {
  const pairs = q.pairs ?? [];
  const byLeft = new Map(Object.entries(matches).map(([k, v]) => [normAnswer(k), v ?? ""]));
  const steps: Step[] = pairs.map((p, i) => {
    const chosen = String(matches[p.left] ?? byLeft.get(normAnswer(p.left)) ?? "").trim();
    const ok = !!chosen && normAnswer(chosen) === normAnswer(p.right);
    const shown = chosen || "—";
    const text = ok ? `${p.left} → ${shown} ✓` : reveal ? `${p.left} → ${shown} ✗ (correct: ${p.right})` : `${p.left} → ${shown} ✗`;
    return { index: i + 1, text, latex: null, ok, note: ok ? "" : chosen ? "Wrong match" : "Not matched" };
  });
  return settle(steps, "matches", pairs.map((p) => `- ${p.left} → ${p.right}`).join("\n") || null, reveal);
}

export function gradeFillBlank(q: Pick<IStudyQuestion, "answer">, blanks: Array<string | null>, reveal: boolean): Verdict {
  const key = parseBlankAnswer(q.answer);
  const steps: Step[] = key.map((entry, i) => {
    const given = String(blanks[i] ?? "").trim();
    const m = blankMatches(given, entry);
    const ok = m !== null;
    const best = entry.split("|")[0];
    const text = `blank ${i + 1}: '${given}' ${ok ? "✓" : "✗"}${!ok && reveal ? ` (correct: ${best})` : ""}`;
    return { index: i + 1, text, latex: null, ok, note: m === "close" ? "Close spelling accepted" : ok ? "" : given ? "Not the expected word" : "Left blank" };
  });
  return settle(steps, "blanks", key.map((e, i) => `${i + 1}. ${e.split("|").join(" / ")}`).join("\n") || null, reveal);
}
