import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyLine } from './rules';

const words = (...texts: string[]) => texts.map((text) => ({ text }));
const classes = (...texts: string[]) => classifyLine(words(...texts)).map((c) => c.cls);

test('a heading cue word colours the whole line', () => {
  assert.deepEqual(classes('Chapter', '2:', 'Cells'), ['heading', 'heading', 'heading']);
});

test('example and key-point cues colour the rest of the line', () => {
  assert.deepEqual(classes('Example:', 'bees'), ['example', 'example']);
  assert.deepEqual(classes('e.g.', 'dogs'), ['example', 'example']);
  assert.deepEqual(classes('for', 'example', 'dogs'), ['example', 'example', 'example']);
  assert.deepEqual(classes('Important:', 'do', 'not', 'forget'), ['keypoint', 'keypoint', 'keypoint', 'keypoint']);
  assert.deepEqual(classes('Remember', 'enzymes'), ['keypoint', 'keypoint']);
  assert.deepEqual(classes('!!', 'exam'), ['keypoint', 'keypoint']);
});

test('«for» alone and «notebook» are not cues', () => {
  assert.deepEqual(classes('for', 'the', 'class'), ['plain', 'plain', 'plain']);
  assert.notEqual(classes('notebook', 'is', 'blue')[0], 'keypoint');
});

test('term then definition: «X:», «X is», an acronym lead', () => {
  assert.deepEqual(classes('Cell:', 'building', 'block'), ['term', 'definition', 'definition']);
  assert.deepEqual(classes('Osmosis', 'is', 'movement'), ['term', 'definition', 'definition']);
  assert.deepEqual(classes('DNA', 'genetic', 'material'), ['term', 'definition', 'definition']);
  assert.deepEqual(classes('Air', 'pressure', 'means', 'weight'), ['term', 'term', 'definition', 'definition']);
});

test('formula lines and number-with-unit words', () => {
  assert.deepEqual(classes('F', '=', 'm', '×', 'a'), ['formula', 'formula', 'formula', 'formula', 'formula']);
  // A number with a unit has no operator: digits alone never make a formula.
  assert.deepEqual(classes('the', 'car', 'went', '30km'), ['plain', 'plain', 'plain', 'plain']);
  assert.deepEqual(classes('x=2'), ['formula']);
});

test('a line that is only «X:» is a section heading — re-classified as term + definition when the line grows', () => {
  assert.deepEqual(classes('Osmosis:'), ['heading']);
  assert.deepEqual(classes('Osmosis:', 'water'), ['term', 'definition']);
});

test('layout cues: big ink → heading; a box → key point; an underlined lead word → term', () => {
  assert.deepEqual(
    classifyLine(words('Photosynthesis'), { sizeRatio: 1.6 }).map((c) => c.cls),
    ['heading'],
  );
  assert.deepEqual(
    classifyLine([{ text: 'enzymes', cues: { boxed: true } }, { text: 'proteins' }]).map((c) => c.cls),
    ['keypoint', 'plain'],
  );
  assert.deepEqual(
    classifyLine([{ text: 'mitosis', cues: { underlined: true } }, { text: 'cell' }, { text: 'division' }]).map((c) => c.cls),
    ['term', 'definition', 'definition'],
  );
});

test('plain words are ambiguous (low confidence) so the cloud may look at them', () => {
  const [word] = classifyLine(words('random'));

  assert.equal(word.cls, 'plain');
  assert.ok(word.conf < 0.6);
  assert.deepEqual(classifyLine([]), []);
});

const segs = (...texts: string[]) => classifyLine(words(...texts)).map((c) => c.seg);

test('owner screenshot: «Definition:» alone is a heading, whatever the fragments', () => {
  assert.deepEqual(classes('Definition:'), ['heading']);
  assert.deepEqual(classes('Def', 'inition:'), ['heading', 'heading']);
  // The recogniser lost the colon; the ink's two stacked dots still close the label.
  assert.deepEqual(
    classifyLine([{ text: 'Defin' }, { text: 'ition', cues: { colon: true } }]).map((c) => c.cls),
    ['heading', 'heading'],
  );
});

test('owner screenshot: «-> Part 1: Mitosis» — bullet keeps ink, label heading, rest keeps ink, never formula', () => {
  assert.deepEqual(classes('->', 'Part', '1:', 'Mitosis'), ['plain', 'heading', 'heading', 'definition']);
  // «Mitosis» read as garbage fragments: the line's structure decides, both fragments alike.
  assert.deepEqual(classes('->', 'Part', '1:', 'Mi', 'tO$is'), ['plain', 'heading', 'heading', 'definition', 'definition']);
  assert.deepEqual(classes('→', 'Part 1:', 'Mitosis'), ['plain', 'heading', 'definition']);
  // The arrow split into its shaft and head, each read alone.
  assert.deepEqual(classes('-', '>', 'Part', '1:', 'Mitosis'), ['plain', 'plain', 'heading', 'heading', 'definition']);
  // The arrow glued to the first word: stripped before the line is read.
  assert.deepEqual(classes('->Part', '1:', 'Mitosis'), ['heading', 'heading', 'definition']);
});

test('owner screenshot: «-> Part 2:» and «-> Part3:» are bullet + heading', () => {
  assert.deepEqual(classes('->', 'Part', '2', ':'), ['plain', 'heading', 'heading', 'heading']);
  assert.deepEqual(classes('->', 'Part3:'), ['plain', 'heading']);
  assert.deepEqual(classes('->', 'Par', 't3:'), ['plain', 'heading', 'heading']);
  // The arrow's ink read as a non-word («-s») but shaped like a bullet.
  assert.deepEqual(
    classifyLine([{ text: '-s', cues: { bullet: true } }, { text: 'Part' }, { text: '2:' }]).map((c) => c.cls),
    ['plain', 'heading', 'heading'],
  );
});

test('every word of a segment shares its segment id (the colour unit)', () => {
  const s = segs('->', 'Part', '1:', 'Mi', 'tosis');

  assert.equal(s[1], s[2]);
  assert.equal(s[3], s[4]);
  assert.notEqual(s[0], s[1]);
  assert.notEqual(s[2], s[3]);
});

test('bullets: «-», «•», «*», «1.», «1)» keep the ink and never make the line a formula', () => {
  assert.deepEqual(classes('-', 'cells', 'divide'), ['plain', 'plain', 'plain']);
  assert.deepEqual(classes('•', 'Osmosis:', 'water'), ['plain', 'term', 'definition']);
  assert.deepEqual(classes('*', 'enzymes'), ['plain', 'plain']);
  assert.deepEqual(classes('1.', 'Mitosis:', 'cell', 'division'), ['plain', 'term', 'definition', 'definition']);
  assert.deepEqual(classes('2)', 'Step', '3'), ['plain', 'heading', 'heading']);
  assert.ok(classifyLine(words('->'))[0].conf >= 0.6, 'a lone bullet is not ambiguous');
});

test('labels with numbers are headings, not formulas: Part / Step / Chapter / Lesson', () => {
  assert.deepEqual(classes('Step', '2:'), ['heading', 'heading']);
  assert.deepEqual(classes('Step', '2:', 'heat', 'it'), ['heading', 'heading', 'definition', 'definition']);
  assert.deepEqual(classes('Chapter', '3'), ['heading', 'heading']);
  assert.deepEqual(classes('Part', '2', 'Mitosis'), ['heading', 'heading', 'plain']);
  assert.deepEqual(classes('Part', 'iv:'), ['heading', 'heading']);
  assert.deepEqual(classes('Lesson', '2'), ['heading', 'heading']);
  assert.deepEqual(classes('Part', '1'), ['heading', 'heading']);
});

test('formula needs an operator between operands; a leading arrow bullet does not count', () => {
  assert.deepEqual(classes('2n', '->', '2n'), ['formula', 'formula', 'formula']);
  assert.deepEqual(classes('6CO2', '+', '6H2O'), ['formula', 'formula', 'formula']);
  assert.deepEqual(classes('->', '2n', '->', '2n'), ['plain', 'formula', 'formula', 'formula']);
  assert.deepEqual(classes('->', 'cells'), ['plain', 'plain']);
  assert.deepEqual(classes('1', '2', '3'), ['plain', 'plain', 'plain']);
  assert.deepEqual(classes('Law:', 'F', '=', 'm', 'a'), ['term', 'formula', 'formula', 'formula', 'formula']);
});

test('«X:» + text: X is the term, the text its definition', () => {
  assert.deepEqual(classes('Mitosis:', 'cell', 'division'), ['term', 'definition', 'definition']);
  assert.deepEqual(classes('Definition:'), ['heading']);
});

test('cue words do not fire inside longer words («notebook» is not «note», «units» is not «unit»)', () => {
  assert.notEqual(classes('notebook', 'pages')[0], 'keypoint');
  assert.notEqual(classes('units', 'of', 'mass')[0], 'heading');
  assert.notEqual(classes('examples', 'below')[0], 'example');
});
