import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tokenizeCode } from './codeHighlight';

test('tokenizeCode classifies C++ tokens and round-trips the source', () => {
  const src = '#include <iostream>\n// hi\nclass A { virtual int f(std::string s) { return 42; } };\ncout << "x\\"y";';
  const tokens = tokenizeCode(src);

  assert.equal(tokens.map((t) => t.text).join(''), src, 'tokens concatenate back to the source');
  const kinds = new Map(tokens.map((t) => [t.text, t.kind]));

  assert.equal(kinds.get('#include <iostream>'), 'pre');
  assert.equal(kinds.get('// hi'), 'cmt');
  assert.equal(kinds.get('class'), 'kw');
  assert.equal(kinds.get('virtual'), 'kw');
  assert.equal(kinds.get('int'), 'type');
  assert.equal(kinds.get('f'), 'fn');
  assert.equal(kinds.get('std'), 'type');
  assert.equal(kinds.get('42'), 'num');
  assert.equal(kinds.get('"x\\"y"'), 'str');
  assert.equal(kinds.get('cout'), 'type');
  assert.equal(kinds.get('A'), 'plain');
});
