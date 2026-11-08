import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assignMatch,
  blankCount,
  clearMatch,
  decodeBlankAnswer,
  encodeBlankAnswer,
  encodeMatching,
  fillBlankPayload,
  leftsHolding,
  matchingChoices,
  matchingIsUnique,
  matchingPayload,
  nextUnmatched,
  pairsRevealed,
  parseBlankStem,
  sizeBlanks,
  splitBlanks,
  stemWithGaps,
  stepMarks,
} from './questionTypes';

test('splitBlanks: numbers each run of 3+ underscores, keeps the text around it', () => {
  const { segments, next } = splitBlanks('The ___ is made of ____ and ___.');

  assert.equal(next, 3);
  assert.deepEqual(segments, [
    { kind: 'text', text: 'The ' },
    { kind: 'blank', index: 0 },
    { kind: 'text', text: ' is made of ' },
    { kind: 'blank', index: 1 },
    { kind: 'text', text: ' and ' },
    { kind: 'blank', index: 2 },
    { kind: 'text', text: '.' },
  ]);
  assert.equal(splitBlanks('a __ b', 2).next, 2);
  assert.deepEqual(splitBlanks('___', 4).segments, [{ kind: 'blank', index: 4 }]);
});

test('blankCount matches the BE: every run of ≥3 underscores, math and code included', () => {
  assert.equal(blankCount('Let $x_{___}$ and `a___b` be __ then ___'), 3);
  assert.equal(blankCount('no blanks __ here'), 0);
});

test('parseBlankStem: numbering across paragraphs, lists and blank-bearing code/math matches blankCount', () => {
  const stem = [
    'First ___.',
    '',
    '- one ___',
    '- two ___',
    '',
    '```',
    'x = ___',
    '```',
    '',
    '$$a + b$$',
    '',
    'Last ___',
  ].join('\n');
  const { blocks, count } = parseBlankStem(stem);

  assert.equal(count, 5);
  assert.equal(count, blankCount(stem));
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['p', 'list', 'p', 'math', 'p'],
  );
  const list = blocks[1] as { type: 'list'; items: { kind: string; index?: number }[][] };

  assert.deepEqual(
    list.items.map((item) => item.find((s) => s.kind === 'blank')?.index),
    [1, 2],
  );
});

test('stemWithGaps: blanks become a visible gap, not markdown emphasis', () => {
  const out = stemWithGaps('a ___ b ____ c');

  assert.ok(!out.includes('_'));
  assert.equal(out.split('＿＿＿').length, 3);
});

test('blanks: sizing and payload', () => {
  assert.deepEqual(sizeBlanks(['a'], 3), ['a', '', '']);
  assert.deepEqual(sizeBlanks(['a', 'b', 'c'], 2), ['a', 'b']);
  assert.deepEqual(fillBlankPayload([' quartz ', ''], 3), { blanks: ['quartz', '', ''] });
});

test('fill_blank answer encoding: lines → JSON key with | alternatives; count must match', () => {
  const stem = 'Molten rock below is ___, above it is ___.';

  assert.deepEqual(encodeBlankAnswer('magma\n lava | lava flow \n', stem), { answer: '["magma","lava|lava flow"]' });
  assert.ok('error' in encodeBlankAnswer('magma', stem));
  assert.ok('error' in encodeBlankAnswer('x', 'no blanks'));
  assert.deepEqual(decodeBlankAnswer('["magma","lava|lava flow"]'), [['magma'], ['lava', 'lava flow']]);
  assert.deepEqual(decodeBlankAnswer('plain'), [['plain']]);
  assert.deepEqual(decodeBlankAnswer(''), []);
});

test('matching answer encoding: "left => right" lines, distractors join the rights', () => {
  const out = encodeMatching('Basalt => Extrusive\nGranite → Intrusive\n\nMarble->Metamorphic', 'Sedimentary');

  assert.ok(!('error' in out));
  if ('error' in out) return;
  assert.deepEqual(out.pairs, [
    { left: 'Basalt', right: 'Extrusive' },
    { left: 'Granite', right: 'Intrusive' },
    { left: 'Marble', right: 'Metamorphic' },
  ]);
  assert.deepEqual(out.choices, ['Extrusive', 'Intrusive', 'Metamorphic', 'Sedimentary']);
  assert.equal(out.answer, '{"Basalt":"Extrusive","Granite":"Intrusive","Marble":"Metamorphic"}');
  const plain = encodeMatching('a => 1\nb => 2');

  assert.ok(!('error' in plain) && plain.choices === undefined);
  assert.ok('error' in encodeMatching('a => 1'));
  assert.ok('error' in encodeMatching('a => 1\nA => 2'));
  assert.ok('error' in encodeMatching('a => 1\nb'));
});

const PAIRS = [
  { left: 'Basalt', right: 'Extrusive' },
  { left: 'Granite', right: 'Intrusive' },
];

test('matchingChoices / pairsRevealed: server choices win; open-exam null rights', () => {
  assert.deepEqual(matchingChoices({ pairs: PAIRS, choices: ['x', 'y'] }), ['x', 'y']);
  assert.deepEqual(matchingChoices({ pairs: [...PAIRS, { left: 'Obsidian', right: 'Extrusive' }] }), [
    'Extrusive',
    'Intrusive',
  ]);
  assert.deepEqual(matchingChoices({ pairs: [{ left: 'a', right: null }] }), []);
  assert.equal(pairsRevealed({ pairs: PAIRS }), true);
  assert.equal(pairsRevealed({ pairs: [{ left: 'a', right: null }] }), false);
  assert.equal(pairsRevealed({ pairs: [] }), false);
});

test('assignMatch: unique mode moves the option; repeat mode lets it be reused', () => {
  let m = assignMatch({}, 'Basalt', 'Extrusive', true);

  m = assignMatch(m, 'Granite', 'Extrusive', true);
  assert.deepEqual(m, { Granite: 'Extrusive' });
  m = assignMatch(m, 'Basalt', 'Extrusive', false);
  assert.deepEqual(m, { Granite: 'Extrusive', Basalt: 'Extrusive' });
  m = assignMatch(m, 'Basalt', 'Intrusive', true);
  assert.deepEqual(m, { Granite: 'Extrusive', Basalt: 'Intrusive' });
  assert.deepEqual(clearMatch(m, 'Granite'), { Basalt: 'Intrusive' });
  assert.deepEqual(leftsHolding({ a: 'x', b: 'x', c: 'y' }, 'x'), ['a', 'b']);
  assert.equal(matchingIsUnique(3, 5), true);
  assert.equal(matchingIsUnique(4, 2), false);
});

test('nextUnmatched: wraps after the current left, null when all matched', () => {
  const lefts = ['a', 'b', 'c'];

  assert.equal(nextUnmatched(lefts, {}, null), 'a');
  assert.equal(nextUnmatched(lefts, { a: '1' }, 'a'), 'b');
  assert.equal(nextUnmatched(lefts, { b: '1', c: '2' }, 'b'), 'a');
  assert.equal(nextUnmatched(lefts, { a: '1', b: '2', c: '3' }, 'c'), null);
});

test('matchingPayload: only the question lefts go to the server', () => {
  assert.deepEqual(matchingPayload(['a', 'b'], { a: 'x', z: 'q' }), { matches: { a: 'x' } });
});

test('stepMarks: one ✓/✗ per item when the step count lines up', () => {
  assert.deepEqual(stepMarks([{ ok: true }, { ok: false }], 2), [true, false]);
  assert.deepEqual(stepMarks([{ ok: true }], 2), [null, null]);
  assert.deepEqual(stepMarks(undefined, 1), [null]);
});
