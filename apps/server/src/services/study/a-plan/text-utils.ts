import { createHash } from "crypto";

/** Pure text helpers for the A plan: hashing, quote verification, title matching. */

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Whitespace normalization for the verbatim-quote check. Besides collapsing whitespace it folds
 * typographic quotes/dashes/nbsp to ASCII (a PDF text layer and an HTML body spell the same
 * sentence with different code points) — nothing else, so a paraphrase still fails.
 */
export function normalizeForQuote(s: string): string {
  return String(s ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[  -​  　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Keep only quotes that are verbatim substrings of `source` (after normalization). */
export function verifyQuotes<T extends { text: string }>(quotes: T[], source: string): { kept: T[]; dropped: T[] } {
  const hay = normalizeForQuote(source);
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const q of quotes) {
    const needle = normalizeForQuote(q.text).replace(/^["']|["']$/g, "").trim();
    if (needle.length >= 8 && hay.includes(needle)) kept.push({ ...q, text: needle });
    else dropped.push(q);
  }
  return { kept, dropped };
}

// ─── title matching ─────────────────────────────────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "for", "of", "to", "and", "on", "in", "is", "due", "now", "your"]);

/** Drop "(DUE: …)" style parentheticals, dates and times — they are noise for identity. */
export function cleanTitle(t: string): string {
  return String(t ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?/gi, " ")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const tokens = (t: string) => cleanTitle(t).split(" ").filter((w) => w && !STOP.has(w));

/** (keyword, number) identity pairs: "quiz 5" → quiz:5; "Programming Assignment 1" → assignment:1 + pa:1. */
export function idPairs(t: string): Set<string> {
  const tk = cleanTitle(t).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 1; i < tk.length; i++) {
    if (!/^\d+$/.test(tk[i]) || /^\d+$/.test(tk[i - 1])) continue;
    const n = String(Number(tk[i]));
    out.add(`${tk[i - 1]}:${n}`);
    // Acronym of the alphabetic run before the number (≥2 words): "discussion board post 1" → dbp:1.
    let j = i - 1;
    const run: string[] = [];
    while (j >= 0 && /^[a-z]+$/.test(tk[j]) && !STOP.has(tk[j])) run.unshift(tk[j--]);
    for (let k = 0; k <= run.length - 2; k++) out.add(`${run.slice(k).map((w) => w[0]).join("")}:${n}`);
  }
  return out;
}

/**
 * Similarity 0..1 between a mention in an announcement and an item title. Hard gate: every
 * (keyword, number) pair in the mention must appear in the title — "Quiz 1" never matches "Quiz 10".
 */
export function titleSimilarity(mention: string, title: string): number {
  const mp = idPairs(mention);
  const tp = idPairs(title);
  for (const p of mp) if (!tp.has(p)) return 0;
  const m = new Set(tokens(mention));
  const t = new Set(tokens(title));
  if (!m.size || !t.size) return 0;
  if (cleanTitle(mention) === cleanTitle(title)) return 1;
  let inter = 0;
  for (const w of m) if (t.has(w)) inter++;
  // Acronym pairs count as overlap of the mention's words ("DBP 2" vs "Discussion Board Post 2").
  const pairHits = [...mp].filter((p) => tp.has(p)).length;
  const containment = Math.min(1, (inter + pairHits) / m.size);
  const jaccard = inter / (m.size + t.size - inter);
  const base = 0.75 * containment + 0.25 * jaccard;
  // A matched identity pair is strong evidence on its own.
  return Math.min(1, mp.size && pairHits === mp.size ? Math.max(base, 0.8 + 0.2 * jaccard) : base);
}

export const MATCH_MIN = 0.75;
export const MATCH_MARGIN = 0.15;

/** Best item for a mention, but only when the match is confident AND unambiguous. */
export function bestTitleMatch<T extends { title: string }>(mention: string, items: T[]): { item: T | null; confidence: number } {
  const scored = items.map((it) => ({ it, s: titleSimilarity(mention, it.title) })).sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (!best) return { item: null, confidence: 0 };
  const second = scored[1]?.s ?? 0;
  const confident = best.s >= MATCH_MIN && best.s - second >= MATCH_MARGIN;
  return { item: confident ? best.it : null, confidence: Number(best.s.toFixed(3)) };
}

/** Category-name equality for syllabus ↔ Canvas groups ("Quizzes" ≈ "Canvas Quizzes", "Tests" ≈ "Exams"). */
const SYN: Record<string, string> = { tests: "exam", test: "exam", exams: "exam", midterms: "exam", midterm: "exam", quizzes: "quiz", labs: "lab", reports: "report", assignments: "assignment", credits: "credit", activities: "activity", maps: "map", posts: "post" };
/** Words that say what a category COUNTS, not which category it is ("Practice Credits" vs "Engagement Credits"). */
const GENERIC = new Set(["credit", "question", "point", "score", "grade", "total", "item", "work", "mark"]);
const rawCatTokens = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w) && w !== "canvas")
    .map((w) => SYN[w] ?? w.replace(/s$/, ""));
/** Distinctive tokens; a name made only of generic words keeps them. */
const catTokens = (s: string) => {
  const all = rawCatTokens(s);
  const distinct = all.filter((w) => !GENERIC.has(w));
  return distinct.length ? distinct : all;
};

export function categorySimilarity(a: string, b: string): number {
  const x = new Set(catTokens(a));
  const y = new Set(catTokens(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / Math.max(x.size, y.size);
}

/** Greedy 1:1 pairing of syllabus categories to Canvas groups, best score first, score ≥ 0.5. */
export function pairCategories<A extends { name: string }, B extends { name: string }>(as: A[], bs: B[]): Map<A, B> {
  const cand: { a: A; b: B; s: number }[] = [];
  for (const a of as) for (const b of bs) {
    const s = categorySimilarity(a.name, b.name);
    if (s >= 0.5) cand.push({ a, b, s });
  }
  cand.sort((p, q) => q.s - p.s);
  const out = new Map<A, B>();
  const usedB = new Set<B>();
  for (const c of cand) if (!out.has(c.a) && !usedB.has(c.b)) {
    out.set(c.a, c.b);
    usedB.add(c.b);
  }
  return out;
}
