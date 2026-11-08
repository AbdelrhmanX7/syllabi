import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeCanvasHtml } from './sanitize-html';

test('strips Canvas stylesheet links and scripts without a DOM', () => {
  const html =
    '<link rel="stylesheet" href="https://x/mobiledp_app.css"><p>Quiz 5 due date extended</p><script src="https://x/a.js"></script>';

  assert.equal(sanitizeCanvasHtml(html), '<p>Quiz 5 due date extended</p>');
});

test('keeps ordinary content', () => {
  assert.equal(sanitizeCanvasHtml('<h2>Week 7</h2><ul><li>a</li></ul>'), '<h2>Week 7</h2><ul><li>a</li></ul>');
  assert.equal(sanitizeCanvasHtml(''), '');
});
