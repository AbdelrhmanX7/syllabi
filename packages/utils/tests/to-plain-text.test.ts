/**
 * `toPlainText` — the monorepo's ONE html-to-text projection.
 *
 * These tests moved here from `packages/assessment-share/tests/seo.test.ts`
 * when the implementation did, and they are the reason the move was safe. The
 * cases that matter most are the ones asserting what is NOT removed: the maths
 * inequality, every non-ASCII character, and an author's escaped `&lt;p&gt;`.
 *
 * `@repo/assessment-share` re-exports the same function and keeps its own tests
 * for the SEO surfaces built on top of it (`buildQuizJsonLd`, the meta builder,
 * the breadcrumb trail), plus an identity check proving there is still only one
 * implementation behind both import paths.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { toPlainText } from '../src/to-plain-text';

// ---------------------------------------------------------- tag stripping

test('toPlainText strips editor markup from a stem', () => {
  // Note there is no space before «?» — the closing `</strong>` is inline, so
  // it closes up. A space there was the old behaviour and it was wrong.
  assert.equal(toPlainText('<p>What is <strong>2x + 3x</strong>?</p>'), 'What is 2x + 3x?');
  assert.equal(toPlainText('<div><span>a</span><br/><em>b</em></div>'), 'a b');
});

test('INLINE tags close up — chemistry and exponents survive', () => {
  // Substituting a space for every tag turns H₂O into `H 2 O`. On a science
  // platform that is every formula and every exponent, not a corner case.
  assert.equal(toPlainText('H<sub>2</sub>O'), 'H2O');
  assert.equal(toPlainText('Sulfuric acid H<sub>2</sub>SO<sub>4</sub>'), 'Sulfuric acid H2SO4');
  assert.equal(toPlainText('Area = x<sup>2</sup>'), 'Area = x2');
  assert.equal(toPlainText('n<sub>1</sub> + n<sub>2</sub>'), 'n1 + n2');
  // A stray space inside a word splits it in two.
  assert.equal(toPlainText('one<strong>joined</strong>word'), 'onejoinedword');
});

test('BLOCK tags break — adjacent paragraphs and cells do not fuse', () => {
  assert.equal(toPlainText('<p>First sentence.</p><p>Second sentence.</p>'), 'First sentence. Second sentence.');
  assert.equal(toPlainText('<li>one</li><li>two</li>'), 'one two');
  assert.equal(toPlainText('<td>a</td><td>b</td>'), 'a b');
  assert.equal(toPlainText('line<br/>two'), 'line two');
});

test('toPlainText keeps EVERY non-ASCII character', () => {
  const text = 'Café naïve — résumé: ½ × π ≈ 1.57 → Ω';
  const out = toPlainText(`<p><strong>${text}</strong></p>`);

  assert.equal(out, text);

  // Character-by-character, so a regex that ate non-ASCII could not slip past.
  for (const char of text) {
    assert.ok(out.includes(char), `lost «${char}»`);
  }
});

test('toPlainText does NOT eat a maths inequality', () => {
  // The reason the tag pattern is an allowlist. `/<[^>]*>/g` deletes «5 and y»
  // here and leaves a sentence that still reads as one — silent corruption.
  assert.equal(toPlainText('<p>If x < 5 and y > 3, what is x?</p>'), 'If x < 5 and y > 3, what is x?');
  assert.equal(toPlainText('Find x where 3 < x'), 'Find x where 3 < x');
});

test('toPlainText leaves an unknown tag visible rather than guessing', () => {
  // The deliberate trade-off: an exotic tag survives as text — obvious and
  // fixable — instead of risking a pattern that could eat real content.
  assert.equal(toPlainText('<mjx-container>x</mjx-container>'), '<mjx-container>x</mjx-container>');
});

// ---------------------------------------------------------- entity decoding

test('toPlainText decodes entities', () => {
  assert.equal(toPlainText('Algebra &amp; Geometry'), 'Algebra & Geometry');
  assert.equal(toPlainText('&quot;x&quot; &nbsp; and&hellip;'), '"x" and…');
  assert.equal(toPlainText('&#233;&#xe9;'), 'éé');
});

test('toPlainText decodes the maths and science entities this platform authors', () => {
  // Secondary-school algebra/physics papers: these are routine input, and left
  // undecoded the literal `&times;` lands in <title> and the JSON-LD name.
  assert.equal(toPlainText('3 &times; 5 = 15'), '3 × 5 = 15');
  assert.equal(toPlainText('Angle 90&deg;'), 'Angle 90°');
  assert.equal(toPlainText('Area = x&sup2;'), 'Area = x²');
  assert.equal(toPlainText('&frac12; + &frac14; = &frac34;'), '½ + ¼ = ¾');
  assert.equal(toPlainText('x &le; 5 and y &ge; 3'), 'x ≤ 5 and y ≥ 3');
  assert.equal(toPlainText('&radic;9 = 3 &plusmn; 0'), '√9 = 3 ± 0');
  assert.equal(toPlainText('&alpha; + &beta; &rarr; &theta;'), 'α + β → θ');
  assert.equal(toPlainText('&sect; Clause'), '§ Clause');
});

test('entity lookup is case-SENSITIVE where the name is', () => {
  // `&Delta;` is Δ and `&delta;` is δ. Folding case before the lookup would
  // silently swap one for the other — a wrong symbol reads as a real one.
  assert.equal(toPlainText('&Delta;'), 'Δ');
  assert.equal(toPlainText('&delta;'), 'δ');
  assert.equal(toPlainText('&Sigma; and &sigma;'), 'Σ and σ');
  assert.equal(toPlainText('&Omega; and &omega;'), 'Ω and ω');
  assert.equal(toPlainText('&rArr; and &rarr;'), '⇒ and →');
});

test('an unknown entity is preserved verbatim, never dropped', () => {
  // `notarealentity` is not an HTML entity and never will be, which is the
  // point: the `NAMED_ENTITIES` docblock points here rather than naming an
  // example of its own, because every example it named was later added to the
  // table and stopped being an example. This one cannot be, and if someone adds
  // it anyway this test fails — so the doc cannot decay silently.
  // Visible and odd beats silently deleted: someone notices and adds a row.
  assert.equal(toPlainText('x &notarealentity; y'), 'x &notarealentity; y');
});

test('toPlainText decodes AFTER stripping, so escaped markup survives as text', () => {
  // An author who wrote `&lt;p&gt;` meant to SHOW those characters. Decoding
  // first would turn them into a real tag and then delete them.
  assert.equal(toPlainText('<p>Type &lt;p&gt; in the editor</p>'), 'Type <p> in the editor');
});

// ---------------------------------------------------------- non-display bodies

test('toPlainText removes script/style BODIES, not just their tags', () => {
  // Stripping them as ordinary tags leaves the contents behind, so `alert(1)`
  // would land verbatim in <title>, the meta description and the JSON-LD name.
  assert.equal(toPlainText('before<script>alert(1)</script>after'), 'before after');
  assert.equal(toPlainText('before<style>.x{color:red}</style>after'), 'before after');
  assert.equal(toPlainText('<SCRIPT TYPE="text/javascript">x=1</SCRIPT>x'), 'x');
});

test('toPlainText removes HTML comments with their bodies', () => {
  assert.equal(toPlainText('before<!-- internal note -->after'), 'before after');
});

test('an UNCLOSED script loses its tag but keeps its body visible', () => {
  // Deliberate: swallowing to end-of-string is what a browser does, but it
  // would silently delete the rest of a question if a teacher wrote a raw
  // `<script>` while explaining HTML. Obviously wrong beats quietly truncated.
  assert.equal(toPlainText('before<script>alert(1)'), 'before alert(1)');
});

test('script/style removal does not touch a maths inequality', () => {
  // The body-swallowing patterns must be as safe as the tag allowlist.
  assert.equal(toPlainText('x < 5 and y > 3'), 'x < 5 and y > 3');
  assert.equal(toPlainText('<p>If x < 5 then y > 3</p>'), 'If x < 5 then y > 3');
});

// ---------------------------------------------------------- whitespace / input

test('toPlainText collapses whitespace and handles empty input', () => {
  assert.equal(toPlainText('  <p>a</p>\n\n  <p>b</p>  '), 'a b');
  assert.equal(toPlainText(''), '');
  assert.equal(toPlainText(null), '');
  assert.equal(toPlainText(undefined), '');
});

// ---------------------------------------------------------- former call sites

/**
 * The behaviours the six replaced copies had that this one has to keep. Each
 * `it used to…` line is a real local implementation that existed before the
 * consolidation, so a future edit that breaks one of these breaks a shipped
 * screen rather than a hypothetical.
 */
test('every behaviour the replaced local copies relied on still holds', () => {
  // draft-questions.ts (admin + teacher): `&nbsp;` → space, then trim. Used for
  // "is this stem/option blank" — so a whitespace-only stem must come out ''.
  assert.equal(toPlainText('&nbsp;'), '');
  assert.equal(toPlainText('<p>&nbsp;</p>'), '');
  assert.equal(toPlainText('<p><br></p>'), '');

  // ReviewQuestionCard.tsx: emptiness of an authored stem.
  assert.equal(toPlainText('<p></p>'), '');
  assert.ok(toPlainText('<p>real text</p>').length > 0);

  // paper-utils.ts `stripRichText`: measures option length for the two-column
  // heuristic. It replaced entities with a space; decoding gives the same or a
  // shorter string, so an option can only get MORE likely to fit, never less.
  assert.ok(toPlainText('3 &times; 5').length <= '3 &times; 5'.length);
  assert.ok(toPlainText('<strong>a</strong>').length <= '<strong>a</strong>'.length);

  // ExamRichContent (web + ahmed-yousef): the SSR/pre-hydration fallback. Runs
  // with no DOM at all — this file has no jsdom and never touches `document`.
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(toPlainText('<p>Question <strong>important</strong></p>'), 'Question important');
});
