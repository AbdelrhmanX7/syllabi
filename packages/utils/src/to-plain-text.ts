/**
 * Authored rich text → the plain string a human should read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONLY HTML-TO-TEXT IMPLEMENTATION IN THE MONOREPO.
 *
 * It lives in `@repo/utils` — not in `@repo/assessment-share` — because it is a
 * generic text utility, and `apps/admin` and `apps/teacher` need it without
 * taking a dependency on a package about sharing assessments.
 * `@repo/assessment-share` re-exports it from here, so its own callers and
 * `packages/assessment-share/src/seo.ts` are unaffected.
 *
 * There were six hand-rolled copies before this one, five of which ended in
 * `/<[^>]*>/g` and silently deleted question content (see the allowlist note
 * below). If you find yourself writing another, import this instead — that
 * duplication is the bug this file exists to close.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **This is content correctness, NOT escaping.** It DECODES entities, which
 * is the opposite direction from escaping. Callers that interpolate the result
 * into a `<script>` block (JSON-LD) must still escape `<`, `>` and `&` on the
 * way out, and callers rendering HTML must still sanitize it. Never let this
 * function be mistaken for either.
 *
 * SSR-safe by construction: string operations only — no `DOMParser`, no
 * `document`, no `window`. Several call sites are pre-hydration fallbacks that
 * run on the server, and one of them is what a crawler indexes.
 */

/**
 * The two tag patterns below share one rule and differ in one.
 *
 * ⚠️ BOTH ARE ALLOWLISTS, NOT `/<[^>]*>/g`, AND THAT DIFFERENCE MATTERS.
 *
 * The obvious pattern eats maths. A stem reading `x < 5 and y > 3` contains a
 * `<` … `>` pair, so `/<[^>]*>/g` deletes «5 and y» from the middle of the
 * question and leaves something that still reads like a sentence. On an algebra
 * platform that is not a corner case, it is Tuesday — and the failure is
 * silent, which makes it worse than the tags it was meant to remove.
 *
 * Requiring a known element name after `<` cannot do that: `< 5` has no tag
 * name, so it is left alone. The trade-off is that an exotic tag (a MathJax
 * `<mjx-container>`, say) survives into the text — visible, obvious, and
 * fixable by adding a name below, which is the failure mode to prefer.
 *
 * They differ in what replaces the tag: block gets a space, inline gets
 * nothing. See each.
 */

/**
 * BLOCK-level elements — replaced with a SPACE.
 *
 * `<p>a</p><p>b</p>` must not fuse into `ab`, and neither must adjacent table
 * cells or list items. A browser renders a break between these; so do we.
 */
const HTML_BLOCK_TAG =
  /<\/?(?:p|br|hr|div|ul|ol|li|dl|dt|dd|h[1-6]|table|thead|tbody|tfoot|tr|td|th|caption|pre|blockquote|figure|figcaption|section|article|header|footer|main|aside|nav|script|style)\b[^<>]*>/gi;

/**
 * INLINE elements — replaced with NOTHING.
 *
 * ⚠️ This split is not tidiness. Substituting a space for every tag mangles
 * chemistry and exponents, which on this platform is pervasive rather than
 * exotic:
 *
 *   `H<sub>2</sub>O`                 → `H 2 O`      (should be `H2O`)
 *   `H<sub>2</sub>SO<sub>4</sub>`    → `H 2 SO 4`   (should be `H2SO4`)
 *   `x<sup>2</sup>`                  → `x 2`        (should be `x2`)
 *
 * Block-breaks-inline-doesn't is simply how HTML renders, which is also what
 * `DOMParser` produces — so this keeps a server-rendered pass and a hydrated
 * pass in agreement instead of quietly disagreeing about spacing.
 */
const HTML_INLINE_TAG =
  /<\/?(?:span|strong|b|em|i|u|s|sub|sup|a|img|code|font|small|mark|del|ins|abbr|cite|q|time|label)\b[^<>]*>/gi;

/**
 * Elements whose BODY is never display text — it has to go with the tags.
 *
 * Stripping `<script>` and `<style>` as ordinary tags leaves their contents
 * behind, so `before<script>alert(1)</script>after` renders as `before alert(1) after`
 * and `alert(1)` lands verbatim in `<title>`, the meta description and the
 * JSON-LD `name`. Nothing executes — the output is text handed to React, or
 * JSON-stringified and escaped into the `<script type="application/ld+json">`
 * block — so this is content correctness, not a security hole. It still reads
 * as gibberish in a search result.
 *
 * ⚠️ **Paired only — no unclosed-tag fallback, deliberately.** Swallowing to
 * end-of-string on an unclosed `<script>` is what a browser does, but it would
 * silently delete the rest of a question if a teacher ever wrote a raw
 * `<script>` while explaining HTML. An unclosed tag instead loses the tag (it
 * is in `HTML_BLOCK_TAG` above) and leaves its body visible — obviously wrong
 * than quietly truncated, the same trade-off the allowlist makes.
 */
const RAW_TEXT_ELEMENT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Editor comments are not content either, and their bodies also survive tag-stripping. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Named entities, weighted toward what THIS platform authors.
 *
 * The generic list — `amp`, `lt`, `quot` — is the easy half. The half that
 * matters here is maths and science: these are secondary-school algebra,
 * physics and chemistry papers, so `&times;`, `&deg;`, `&sup2;`, `&le;` and
 * `&radic;` are routine input, not exotica. Left undecoded, a stem reading
 * `3 &times; 5` puts the literal string `&times;` into `<title>` and the
 * JSON-LD `name`.
 *
 * An unknown entity — **any name not listed below** — is preserved VERBATIM
 * rather than dropped, via the fallback in `toPlainText`. Seeing one survive
 * into a title is odd enough that someone adds a row here; silently deleting it
 * loses content nobody notices. That is the whole reason this table can afford
 * to be incomplete, and why adding a row is always safe.
 *
 * ⚠️ Note the absence of a worked example, deliberately. Every earlier version
 * of this comment named one — and each time, the named entity was later added
 * to the table, leaving a doc that cited as "unknown" a name sitting a few lines
 * below it. Three separate comments in this feature have now decayed that exact
 * way: the conclusion stayed true while the example quietly stopped being one,
 * which is worse than no example because a reader checks it and is misled.
 * If you want one, `tests/to-plain-text.test.ts` holds an obviously-invented
 * name that cannot be added — a test breaks if it ever is.
 */
const NAMED_ENTITIES: Record<string, string> = {
  // structural
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  // typography
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  bull: '•',
  middot: '·',
  sect: '§',
  deg: '°',
  prime: '′',
  Prime: '″',
  copy: '©',
  reg: '®',
  trade: '™',
  permil: '‰',
  // maths operators and relations
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  ne: '≠',
  le: '≤',
  ge: '≥',
  asymp: '≈',
  equiv: '≡',
  prop: '∝',
  radic: '√',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  int: '∫',
  part: '∂',
  nabla: '∇',
  ang: '∠',
  perp: '⊥',
  sim: '∼',
  cong: '≅',
  // fractions and superscripts
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  // sets and logic
  isin: '∈',
  notin: '∉',
  sub: '⊂',
  sup: '⊃',
  cap: '∩',
  cup: '∪',
  empty: '∅',
  forall: '∀',
  exist: '∃',
  // arrows
  rarr: '→',
  larr: '←',
  harr: '↔',
  uarr: '↑',
  darr: '↓',
  rArr: '⇒',
  hArr: '⇔',
  // Greek — physics and maths notation
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  Delta: 'Δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  Sigma: 'Σ',
  tau: 'τ',
  phi: 'φ',
  omega: 'ω',
  Omega: 'Ω',
  // bidi / joiner marks — invisible but not noise
  rlm: '‏',
  lrm: '‎',
  zwnj: '‌',
  zwj: '‍',
};

/**
 * Rich text with the markup taken out — what a student would actually read.
 *
 * Question stems and option texts come out of a WYSIWYG editor, so they carry
 * markup. Copied verbatim into a JSON-LD `name`, that markup is what Google
 * prints in a rich result; rendered as a pre-hydration fallback, it is what a
 * student reads while the JS loads.
 *
 * Order is deliberate — strip, then decode, then collapse. Decoding first would
 * turn an author's literal `&lt;p&gt;` into a real `<p>` and then delete it,
 * silently removing text they meant to show.
 *
 * Non-ASCII is never touched: no character-class filtering anywhere, so accented
 * letters, symbols and other scripts pass through unchanged.
 */
export function toPlainText(value: string | null | undefined): string {
  return (
    (value ?? '')
      // Bodies first: these elements' contents are not display text, so removing
      // only their tags would promote a stylesheet or a script into the title.
      .replace(RAW_TEXT_ELEMENT, ' ')
      .replace(HTML_COMMENT, ' ')
      // Block breaks, inline does not. Getting this backwards turns `H₂O` into
      // `H 2 O` — see the two patterns above.
      .replace(HTML_BLOCK_TAG, ' ')
      .replace(HTML_INLINE_TAG, '')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
      // Digits are part of the name (`&frac12;`, `&sup2;`), so the character
      // class cannot be letters-only. And the lookup tries the EXACT name before
      // folding case, because case is meaningful in entity names: `&Delta;` is Δ
      // and `&delta;` is δ — folding first silently swaps one for the other.
      .replace(
        /&([a-zA-Z][a-zA-Z0-9]*);/g,
        (match, name: string) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? match,
      )
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Numeric entities that are out of range must not throw — leave them be. */
function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
