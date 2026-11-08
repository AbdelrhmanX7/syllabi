import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickLineScript, pickScript, scriptOfText, similarity, splitByScript, symbolRatio, textInScript } from './script';

const en = (texts: string[], lang = 'en') => texts.map((text) => ({ text, lang }));

test('a word is read by the English model, best candidate first', () => {
  const pick = pickScript(en(['cell', 'cell', 'cells']), 'ltr', null);

  assert.equal(pick?.script, 'en');
  assert.equal(pick?.text, 'cell');
  assert.ok((pick?.confidence ?? 0) > 0.8, 'a self-consistent model is confident');
});

test('candidates from any other model are ignored', () => {
  assert.equal(pickScript([{ text: 'x', lang: 'fr' }], null, null), null);
  assert.equal(pickScript([...en(['dog']), { text: 'z', lang: 'de' }], 'rtl', null)?.text, 'dog');
  assert.equal(pickScript([], null, null), null);
});

test('digits and operators keep their reading', () => {
  assert.equal(pickScript(en(['F=ma']), 'ltr', null)?.text, 'F=ma');
  assert.ok(symbolRatio('30=5+25') > 0.8);
});

test('helpers', () => {
  assert.equal(similarity('cell', 'cell'), 1);
  assert.ok(similarity('cell', 'cel') > 0.7);
  assert.equal(scriptOfText('hi there'), 'en');
  assert.equal(scriptOfText('123'), null);
  assert.deepEqual(splitByScript([{ text: 'x', lang: 'en-US' }, { text: ' ', lang: 'en' }]).en.length, 1);
});

test('one script per LINE: English whenever a word was read, else the previous line', () => {
  const words = [
    { candidates: en(['Part', 'Port', 'Pant']), weight: 6 },
    { candidates: en(['1', 'l', 'I']), weight: 1 },
    { candidates: en(['Mitosis', 'Mitoses', 'Mitosis']), weight: 8 },
  ];

  assert.equal(pickLineScript(words, 'ltr', null), 'en');
  assert.equal(pickLineScript(words, null, null), 'en');
  assert.equal(textInScript(words[1].candidates, 'en'), '1');
  assert.equal(pickLineScript([], null, 'en'), 'en');
  assert.equal(pickLineScript([], null, null), null);
});
