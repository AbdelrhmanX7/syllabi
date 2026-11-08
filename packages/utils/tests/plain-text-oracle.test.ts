/**
 * ORACLE TESTS — `toPlainText` vs the browser's own parser.
 *
 * Every other test in this package asserts `toPlainText` against a string I
 * typed by hand, which is exactly how three bugs got in: a hand-written
 * expectation is only ever as correct as the author's mental model, and all
 * three failures produced *plausible-looking* output rather than an error.
 *
 *   `/<[^>]*>/g` ate `x < 5 and y > 3` into `x 3`
 *   `H<sub>2</sub>O` became `H 2 O`
 *   `&Delta;` case-folded to `delta` and returned δ
 *
 * A real HTML parser has an opinion on all three, and it is right. So these
 * tests compare against `textContent` from jsdom instead of against me.
 *
 * `ay-share-pages` named the property this protects, having diffed the
 * server-rendered text against the live hydrated DOM for every question on a
 * real page: **whatever the entity table contains, the two passes must not
 * disagree.** An app whose hydrated render goes through `DOMParser` agrees
 * with this package by construction only as long as this holds.
 *
 * ⚠️ ONE DELIBERATE DIVERGENCE, asserted separately below: `textContent` is raw
 * concatenation with no rendering, so `<p>a</p><p>b</p>` gives `ab`. We emit
 * `a b`, matching what a browser DISPLAYS rather than what `textContent`
 * returns. That is why the oracle is applied to inline markup and entities —
 * the cases where the two must agree exactly — and block spacing is pinned by
 * its own test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import { toPlainText } from '../src/to-plain-text';

const { document } = new JSDOM('').window;

/** What a browser reads out of this markup, whitespace collapsed as we collapse it. */
function browserText(html: string): string {
  const host = document.createElement('div');

  host.innerHTML = html;

  return (host.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Inline markup and entities — the parser is the authority, not me. */
const ORACLE_CASES = [
  // chemistry and exponents: the case that made the block/inline split necessary
  'H<sub>2</sub>O',
  'Sulfuric acid H<sub>2</sub>SO<sub>4</sub>',
  'Area = x<sup>2</sup>',
  'n<sub>1</sub> + n<sub>2</sub>',
  'one<strong>joined</strong>word',
  '<em>italic</em> and<strong>bold</strong>',
  '<span>text</span><span>glued</span>',
  'a<code>x</code>b',
  // entities, including every shape that has bitten
  'Compute 3 &times; 5',
  'Angle 90&deg;',
  '&frac12; + &frac14; = &frac34;',
  'x &le; 5 and y &ge; 3',
  '&radic;9 = 3 &plusmn; 0',
  '&Delta;v versus &delta;v',
  '&Sigma; and &sigma;',
  '&Omega; and &omega;',
  '&rArr; and &rarr;',
  '&alpha; + &beta; &rarr; &theta;',
  '&sect; Clause',
  'Algebra &amp; Geometry',
  '&quot;x&quot; and&hellip;',
  '&#233; and &#xe9;',
  '&nbsp;x&nbsp;',
  // the maths inequality — a parser treats `< 5` as text, and so must we
  'If x < 5 and y > 3, what is x?',
  'Find x where 3 < x',
  // mixed
  '<strong>Compute</strong> 3 &times; 5 and x<sup>2</sup>',
];

for (const html of ORACLE_CASES) {
  test(`oracle: ${html}`, () => {
    assert.equal(toPlainText(html), browserText(html));
  });
}

test('the oracle would have caught all three historical bugs', () => {
  // Not a re-test of the fixes — a check that this file has teeth. Each of
  // these is what the buggy implementation produced; the parser disagrees with
  // every one, so the oracle fails loudly if any regresses.
  const wouldHaveBeenWrong: [string, string][] = [
    ['If x < 5 and y > 3, what is x?', 'If x 3, what is x?'],
    ['H<sub>2</sub>O', 'H 2 O'],
    ['&Delta;v', 'δv'],
  ];

  for (const [html, buggyOutput] of wouldHaveBeenWrong) {
    assert.notEqual(browserText(html), buggyOutput, `the oracle would not have caught: ${html}`);
    assert.equal(toPlainText(html), browserText(html));
  }
});

test('BLOCK spacing matches innerText semantics, not textContent', () => {
  // ⚠️ `toPlainText` models `innerText` (render-aware), NOT `textContent` (raw
  // concatenation). `textContent` fuses adjacent blocks; a browser displays a
  // break between them, and so do we.
  //
  // An earlier version of this comment claimed the apps' hydrated passes agree
  // with us "because editor HTML carries whitespace between block elements,
  // which textContent then reports". That is FALSE, and `ay-share-pages`
  // disproved it by measuring: their fixture concatenates `'…</p>' + '<p>…'`
  // with no whitespace at all and still agreed. The agreement comes from the
  // hydrated pass building real <p> elements, where CSS block layout inserts
  // the break regardless of what the source looked like — which matters,
  // because machine-generated HTML (a backend template) has no such whitespace.
  //
  // The oracle compares against `textContent` because **jsdom does not
  // implement `innerText`** — verified, it is `undefined` here. So block
  // spacing gets its own assertion instead of going through the oracle, and
  // the ORACLE_CASES above are inline and entity inputs, where the two agree.
  assert.equal(browserText('<p>a</p><p>b</p>'), 'ab');
  assert.equal(toPlainText('<p>a</p><p>b</p>'), 'a b');

  // Consequence for anyone diffing a server-rendered string against a live DOM:
  // use `innerText`. `textContent` reports a false divergence on every stem
  // with more than one block.
  assert.equal('innerText' in document.createElement('div'), false, 'jsdom gained innerText — revisit this');
});

test('script and style bodies: we drop them, textContent does not', () => {
  // The other intentional divergence. `textContent` returns script source as
  // text; that is never display content and must not reach a title.
  assert.equal(browserText('before<script>alert(1)</script>after'), 'beforealert(1)after');
  assert.equal(toPlainText('before<script>alert(1)</script>after'), 'before after');
});
