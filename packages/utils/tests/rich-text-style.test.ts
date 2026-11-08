import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSafeInlineStyle, sanitizeInlineStyle } from '../src/rich-text-style';

/* -------------------------------------------------------------------------- */
/* The bug this exists for                                                     */
/* -------------------------------------------------------------------------- */

test('a pasted white-space:nowrap is dropped — the stem must wrap on a phone', () => {
  assert.equal(sanitizeInlineStyle('white-space: nowrap'), undefined);
  assert.equal(sanitizeInlineStyle('white-space:pre'), undefined);
});

test('wrapping white-space values survive', () => {
  assert.deepEqual(sanitizeInlineStyle('white-space: pre-wrap'), { whiteSpace: 'pre-wrap' });
  assert.deepEqual(sanitizeInlineStyle('white-space: pre-line'), { whiteSpace: 'pre-line' });
  assert.deepEqual(sanitizeInlineStyle('white-space: normal'), { whiteSpace: 'normal' });
});

test('an absolute width cannot exceed a phone screen', () => {
  assert.equal(sanitizeInlineStyle('width: 900px'), undefined);
  assert.equal(sanitizeInlineStyle('min-width: 42cm'), undefined);
  assert.equal(sanitizeInlineStyle('max-width: 10in'), undefined);
});

test('relative sizes are kept — they shrink to fit by construction', () => {
  assert.deepEqual(sanitizeInlineStyle('width: 50%'), { width: '50%' });
  assert.deepEqual(sanitizeInlineStyle('width: auto'), { width: 'auto' });
});

test('positioning is never a stem’s business', () => {
  assert.equal(sanitizeInlineStyle('position: absolute; left: -9999px'), undefined);
  assert.equal(sanitizeInlineStyle('float: left'), undefined);
  assert.equal(sanitizeInlineStyle('transform: scale(4)'), undefined);
  assert.equal(sanitizeInlineStyle('z-index: 99'), undefined);
});

test('overflow is dropped — a pasted wrapper must not clip the question', () => {
  assert.equal(sanitizeInlineStyle('overflow: hidden'), undefined);
});

/* -------------------------------------------------------------------------- */
/* What teachers actually chose, and must keep                                 */
/* -------------------------------------------------------------------------- */

test('decorative styling survives untouched', () => {
  assert.deepEqual(sanitizeInlineStyle('color: red; font-weight: bold; text-align: center'), {
    color: 'red',
    fontWeight: 'bold',
    textAlign: 'center',
  });
});

test('a real Word paste keeps its colour and loses only the layout', () => {
  const pasted = 'color:#c00000; white-space:nowrap; width:850px; font-family:Arial; text-decoration:underline';

  assert.deepEqual(sanitizeInlineStyle(pasted), {
    color: '#c00000',
    fontFamily: 'Arial',
    textDecoration: 'underline',
  });
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

test('values containing colons survive — split on the FIRST colon only', () => {
  assert.deepEqual(sanitizeInlineStyle('background: url(https://x.test/a.png)'), {
    background: 'url(https://x.test/a.png)',
  });
});

test('kebab-case becomes camelCase, custom properties stay verbatim', () => {
  assert.deepEqual(sanitizeInlineStyle('font-size: 12px'), { fontSize: '12px' });
  assert.deepEqual(sanitizeInlineStyle('--brand: red'), { '--brand': 'red' });
});

test('empty, malformed and absent input all return undefined', () => {
  assert.equal(sanitizeInlineStyle(null), undefined);
  assert.equal(sanitizeInlineStyle(undefined), undefined);
  assert.equal(sanitizeInlineStyle(''), undefined);
  assert.equal(sanitizeInlineStyle('not-a-declaration'), undefined);
  assert.equal(sanitizeInlineStyle(':;:;'), undefined);
});

test('font-size in px is NOT a layout property and stays', () => {
  // Guards against over-broad filtering: only the size BOX properties are unit-checked.
  assert.equal(isSafeInlineStyle('fontSize', '12px'), true);
  assert.equal(isSafeInlineStyle('width', '12px'), false);
});
