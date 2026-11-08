import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseInline, parseMarkdown, plainPreview } from './markdown';

test('parseMarkdown: fenced code, display math, image, lists, heading, paragraphs', () => {
  const blocks = parseMarkdown(
    [
      '# Limits',
      'Evaluate the limit:',
      '$$',
      '\\lim_{x \\to 0} \\frac{\\sin x}{x}',
      '$$',
      '![graph](https://x/y.png)',
      '- a',
      '- b',
      '1. one',
      '2. two',
      '```cpp',
      'int main() {}',
      '```',
      'tail $x^2$ text',
    ].join('\n'),
  );

  assert.deepEqual(blocks, [
    { type: 'h', level: 1, text: 'Limits' },
    { type: 'p', text: 'Evaluate the limit:' },
    { type: 'math', tex: '\\lim_{x \\to 0} \\frac{\\sin x}{x}' },
    { type: 'img', alt: 'graph', src: 'https://x/y.png' },
    { type: 'list', ordered: false, items: ['a', 'b'] },
    { type: 'list', ordered: true, items: ['one', 'two'] },
    { type: 'code', lang: 'cpp', code: 'int main() {}' },
    { type: 'p', text: 'tail $x^2$ text' },
  ]);
});

test('parseMarkdown tolerates an unclosed fence and a one-line $$…$$', () => {
  assert.deepEqual(parseMarkdown('```\nstream'), [{ type: 'code', lang: '', code: 'stream' }]);
  assert.deepEqual(parseMarkdown('$$ a = b $$'), [{ type: 'math', tex: 'a = b' }]);
});

test('parseInline: math, code, bold, em, text', () => {
  assert.deepEqual(parseInline('Find $x^2$ and **bold** with `f()` and *em* end'), [
    { kind: 'text', value: 'Find ' },
    { kind: 'math', value: 'x^2' },
    { kind: 'text', value: ' and ' },
    { kind: 'bold', value: 'bold' },
    { kind: 'text', value: ' with ' },
    { kind: 'code', value: 'f()' },
    { kind: 'text', value: ' and ' },
    { kind: 'em', value: 'em' },
    { kind: 'text', value: ' end' },
  ]);
  assert.deepEqual(parseInline('cost \\$5'), [{ kind: 'text', value: 'cost \\$5' }]);
  assert.deepEqual(parseInline('\\(a+b\\)'), [{ kind: 'math', value: 'a+b' }]);
});

test('parseInline: prices, file names and links stay text', () => {
  const prices = 'permits are $4, and citations are $40.';

  assert.deepEqual(parseInline(prices), [{ kind: 'text', value: prices }]);
  assert.deepEqual(parseInline('a $x$ b'), [
    { kind: 'text', value: 'a ' },
    { kind: 'math', value: 'x' },
    { kind: 'text', value: ' b' },
  ]);
  assert.deepEqual(parseInline('Sign_Small-1.png and map_icon'), [
    { kind: 'text', value: 'Sign_Small-1.png and map_icon' },
  ]);
  assert.deepEqual(parseInline('[Sign_Small.png](https://x.test/a.png) — Sign'), [
    { kind: 'link', value: 'Sign_Small.png', href: 'https://x.test/a.png' },
    { kind: 'text', value: ' — Sign' },
  ]);
});

test('plainPreview flattens and truncates', () => {
  assert.equal(plainPreview('**Find** $x$\n\n```cpp\nint a;\nint b;\n```'), 'Find x int a;');
  assert.equal(plainPreview('a'.repeat(200), 10).length, 10);
});
