/**
 * Keyword scoring for the tutor's retrieval — no vectors, no index beyond Mongo regex
 * pre-filters. A snippet's score is how many DISTINCT query terms it contains (+ a title boost
 * the caller adds), and its text is the window around the densest cluster of hits.
 */

const STOP = new Set(
  (
    "the and for are but not you your with this that what when where which who why how can could would should does did " +
    "was were has have had been being from into onto about than then them they their there these those its it's our ours " +
    "a an of to in on at by as or if is be do so me my we us i explain define tell show give make please help quiz ask " +
    "question questions answer mean means meaning what's whats also just like more most some any all each other again"
  ).split(/\s+/)
);

/**
 * Light plural folding: matching is by SUBSTRING, so "derivatives" → "derivative" still matches
 * "derivatives" and now also "derivative" (an unfolded plural matched nothing singular).
 */
export function stem(w: string): string {
  if (w.length <= 4 || !/[a-z]s$/.test(w) || /(ss|us|is|ies)$/.test(w)) return w;
  if (/(ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  return w.slice(0, -1);
}

/** Lower-cased distinct terms (letters and digits), stopwords dropped, max 20. */
export function keywords(text: string, max = 20): string[] {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
  return [...new Set(words)].slice(0, max);
}

export const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One case-insensitive regex matching ANY term (for a Mongo `$regex` pre-filter). */
export function anyTermRx(terms: string[]): { $regex: string; $options: string } | null {
  if (!terms.length) return null;
  return { $regex: terms.map(escapeRx).join("|"), $options: "i" };
}

/** Distinct terms present in `text` (substring match, case-insensitive). */
export function overlap(text: string, terms: string[]): number {
  if (!terms.length || !text) return 0;
  const t = text.toLowerCase();
  let n = 0;
  for (const term of terms) if (t.includes(term)) n++;
  return n;
}

/**
 * The `size`-char window of `text` with the most term hits, snapped to whitespace. Text no
 * longer than `size` comes back whole.
 */
export function bestWindow(text: string, terms: string[], size: number): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= size) return clean;
  const lower = clean.toLowerCase();
  const hits: number[] = [];
  for (const term of terms) {
    let i = lower.indexOf(term);
    while (i !== -1 && hits.length < 500) {
      hits.push(i);
      i = lower.indexOf(term, i + term.length);
    }
  }
  if (!hits.length) return clip(clean, size);
  hits.sort((a, b) => a - b);
  let best = hits[0];
  let bestCount = 0;
  for (let i = 0, j = 0; i < hits.length; i++) {
    while (hits[j] < hits[i] - size * 0.8) j++;
    if (i - j + 1 > bestCount) {
      bestCount = i - j + 1;
      best = hits[j];
    }
  }
  let start = Math.max(0, best - Math.floor(size * 0.15));
  if (start + size > clean.length) start = clean.length - size;
  const sp = start > 0 ? clean.indexOf(" ", start) : 0;
  start = sp === -1 || sp - start > 40 ? start : sp + (start > 0 ? 1 : 0);
  const out = clean.slice(start, start + size);
  const lastSp = out.lastIndexOf(" ");
  const body = start + size < clean.length && lastSp > size * 0.8 ? out.slice(0, lastSp) : out;
  return `${start > 0 ? "…" : ""}${body}${start + body.length < clean.length ? "…" : ""}`;
}

/** At most `max` chars, cut at a word boundary, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${sp > max * 0.6 ? cut.slice(0, sp) : cut}…`;
}

/** The conversation title: the first question, one line, ≤ 60 chars at a word boundary. */
export function titleFrom(question: string): string {
  const t = String(question ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "New conversation";
  return clip(t.charAt(0).toUpperCase() + t.slice(1), 60);
}
