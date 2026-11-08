import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAuthoredHtml } from '../src/rich-text-html';

const NBSP = ' ';

test('the shape the editor actually stores: every space is an entity', () => {
  assert.equal(
    normalizeAuthoredHtml('<h1>What&nbsp;is&nbsp;the&nbsp;sum?</h1>'),
    '<h1>What is the sum?</h1>',
  );
});

test('the decoded character is caught too — a round-trip through a parser leaves no entity', () => {
  assert.equal(normalizeAuthoredHtml(`what${NBSP}is`), 'what is');
});

test('numeric entities, decimal and hex, with and without padding', () => {
  assert.equal(normalizeAuthoredHtml('a&#160;b&#xa0;c&#xA0;d&#00160;e'), 'a b c d e');
});

test('the entity name is case-insensitive — Word emits &NBSP;', () => {
  assert.equal(normalizeAuthoredHtml('a&NBSP;b'), 'a b');
});

/**
 * The one case where a non-breaking space is intentional: an author writing
 * ABOUT the entity. `&amp;nbsp;` must survive, or their text silently changes
 * meaning.
 */
test('an escaped entity is left alone', () => {
  assert.equal(normalizeAuthoredHtml('write &amp;nbsp; instead of a space'), 'write &amp;nbsp; instead of a space');
});

test('nothing else about the markup moves', () => {
  const html = '<p style="color: red">x &lt; 5 and y &gt; 3 — <strong>important</strong></p>';

  assert.equal(normalizeAuthoredHtml(html), html);
});

test('nullish input is the empty string, not a crash', () => {
  assert.equal(normalizeAuthoredHtml(null), '');
  assert.equal(normalizeAuthoredHtml(undefined), '');
  assert.equal(normalizeAuthoredHtml(''), '');
});

/**
 * The two halves of the fix have to agree. `toPlainText` collapses `\s+`, and
 * `\s` matches `U+00A0`, so the pre-hydration pass was always readable — which
 * is exactly why this bug only ever showed up after hydration. Pinning it here
 * so a future whitespace change to one path cannot silently desync them.
 */
test('the plain-text path already agreed, and must keep agreeing', async () => {
  const { toPlainText } = await import('../src/to-plain-text');

  assert.equal(toPlainText('what&nbsp;is'), 'what is');
  assert.equal(toPlainText(`what${NBSP}is`), 'what is');
});
