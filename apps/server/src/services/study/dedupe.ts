import { createHash } from "crypto";

/**
 * Near-duplicate stem detection for the question bank. Two stems in the same class are the
 * same question when their normalised text is identical OR the Jaccard similarity of their
 * word 3-shingles is ≥ DEDUPE_JACCARD. Numbers are tokens, so a "same question, new numbers"
 * variant (POST /similar) lands well below the threshold and is kept.
 */
export const DEDUPE_JACCARD = 0.85;
export const SHINGLE_SIZE = 3;
const MAX_SHINGLES = 400;

/** Lowercase, NFKC, `$`/markdown/LaTeX-brace noise dropped, punctuation → space, one space. */
export function normalizeStem(stem: string): string {
  return String(stem ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\\(left|right|displaystyle|,|;|!|quad|qquad)/g, " ")
    .replace(/[$*_`#>{}[\]()|~]/g, " ")
    .replace(/[^\p{L}\p{N}\\^+\-=/<>.]+/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const stemHash = (stem: string) => createHash("sha1").update(normalizeStem(stem)).digest("hex");

/** Word k-shingles of the normalised stem (the tokens themselves when shorter than k). */
export function shingleSet(stem: string, k = SHINGLE_SIZE): Set<string> {
  const toks = normalizeStem(stem).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (toks.length < k) {
    if (toks.length) out.add(toks.join(" "));
    return out;
  }
  for (let i = 0; i + k <= toks.length; i++) out.add(toks.slice(i, i + k).join(" "));
  return out;
}

/** Short stored hashes of the shingles — the DB candidate lookup key. */
export const shingleHashes = (stem: string) =>
  [...shingleSet(stem)].slice(0, MAX_SHINGLES).map((s) => createHash("sha1").update(s).digest("base64").slice(0, 12));

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function isNearDuplicate(a: string, b: string): boolean {
  if (normalizeStem(a) === normalizeStem(b)) return true;
  return jaccard(shingleSet(a), shingleSet(b)) >= DEDUPE_JACCARD;
}

/** Same rule over the stored hashes (what the save path compares). */
export function isNearDuplicateStored(a: { stemHash: string; shingles: string[] }, b: { stemHash: string; shingles: string[] }): boolean {
  if (a.stemHash === b.stemHash) return true;
  return jaccard(new Set(a.shingles), new Set(b.shingles)) >= DEDUPE_JACCARD;
}
