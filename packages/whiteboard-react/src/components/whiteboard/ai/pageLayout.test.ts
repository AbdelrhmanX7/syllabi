import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectInkLines } from './lassoGeometry';
import { layoutToPlacements, parsePageLayout } from './pageLayout';

// The shape the guest model returns for a 1000×1414 worksheet, single-backslash LaTeX included.
const MODEL_ANSWER =
  'Sure:\n```json\n' +
  '{"page":{"w":1000,"h":1414},"blocks":[' +
  '{"kind":"header","bbox":[0.1,0.03,0.8,0.04],"style":{"fontSize":40,"weight":"bold","align":"center"},"content":"Worksheet — Physics"},' +
  '{"kind":"question","n":"1","bbox":[0.08,0.12,0.84,0.03],"style":{"fontSize":28},"content":"1) A $5\\,kg$ body accelerates at $2\\,m/s^2$. Find the force."},' +
  '{"kind":"choices","n":"1","bbox":[0.1,0.16,0.8,0.03],"choices":["10 N","5 N","2.5 N","7 N"]},' +
  '{"kind":"math","bbox":[0.3,0.21,0.4,0.04],"content":"F = m \\times a"},' +
  '{"kind":"figure","bbox":[0.55,0.3,0.35,0.2]},' +
  '{"kind":"answer_lines","bbox":[0.08,0.52,0.84,0.08],"lines":3},' +
  '{"kind":"table","bbox":[0.1,0.62,0.8,0.1],"rows":[["Quantity","Unit"],["Force","N"]]},' +
  '{"kind":"text","bbox":[0.1,0.8,0.8,0.03]},' +
  '{"kind":"sticker","bbox":[0.1,0.9,0.1,0.1],"content":"?"},' +
  '{"kind":"question","bbox":[2,2,0.1,0.1],"content":"off the page"}' +
  ']}\n```';

test('parsePageLayout: kinds, styles, LaTeX repair, table header from first row, junk dropped', () => {
  const layout = parsePageLayout(MODEL_ANSWER);

  assert.ok(layout);
  assert.deepEqual(layout.page, { w: 1000, h: 1414 });
  assert.deepEqual(
    layout.blocks.map((b) => b.kind),
    ['header', 'question', 'choices', 'math', 'figure', 'answer_lines', 'table'],
    'empty text, unknown kind and off-page box are dropped',
  );
  assert.equal(layout.blocks[3]?.content, 'F = m \\times a');
  assert.deepEqual(layout.blocks[6]?.header, ['Quantity', 'Unit']);
  assert.deepEqual(layout.blocks[6]?.rows, [['Force', 'N']]);
  assert.deepEqual(layout.blocks[0]?.style, { fontSize: 40, weight: 'bold', align: 'center' });
});

test('layoutToPlacements maps boxes onto the original page rect and scales font sizes', () => {
  const layout = parsePageLayout(MODEL_ANSWER)!;
  // The original page sits at scene (0, 50), 1200 wide → 1.2 scene units per image px.
  const placements = layoutToPlacements(layout, { left: 0, top: 50, width: 1200, height: 1696.8 });
  const header = placements[0]!;

  assert.equal(header.kind, 'text');
  assert.deepEqual(header.rect, { left: 120, top: 50 + 0.03 * 1696.8, width: 960, height: 0.04 * 1696.8 });
  assert.ok(header.kind === 'text' && Math.abs(header.fontSize - 48) < 1e-9 && header.bold && header.align === 'center');

  const choices = placements[2]!;

  assert.ok(choices.kind === 'text' && choices.text === 'A) 10 N      B) 5 N      C) 2.5 N      D) 7 N', 'short options on one line');
  assert.equal(placements[3]?.kind, 'math');
  assert.deepEqual(placements[4], { kind: 'figure', rect: { left: 660, top: 50 + 0.3 * 1696.8, width: 420, height: 0.2 * 1696.8 }, source: { x: 0.55, y: 0.3, w: 0.35, h: 0.2 } });
  assert.ok(placements[5]?.kind === 'lines' && placements[5].count === 3);
  // A font size larger than its box is clamped to fit.
  const question = placements[1]!;

  assert.ok(question.kind === 'text' && question.fontSize <= question.rect.height * 0.85 + 1e-9);
});

test('detectInkLines finds text bands and their extents', () => {
  const width = 100;
  const height = 60;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const ink = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  };

  ink(60, 95, 5, 12); // a right-aligned title
  ink(10, 95, 25, 30); // a full line
  ink(10, 95, 33, 37); // its second row (gap 2 → merged)

  const lines = detectInkLines(data, width, height, { mergeGap: 3 });

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { x: 0.6, y: 5 / 60, w: 0.36, h: 8 / 60 });
  assert.deepEqual(lines[1], { x: 0.1, y: 25 / 60, w: 0.86, h: 13 / 60 });
});

test('snapLayoutToLines pins a guessed figure to the measured drawing and text to its ink band', async () => {
  const { snapLayoutToLines } = await import('./pageLayout');
  const layout = parsePageLayout({
    page: { w: 1000, h: 1000 },
    blocks: [
      { kind: 'question', bbox: [0.1, 0.11, 0.8, 0.05], content: 'Question' },
      { kind: 'figure', bbox: [0.2, 0.35, 0.4, 0.2] },
    ],
  })!;
  const lines = [
    { x: 0.1, y: 0.1, w: 0.8, h: 0.03 },
    { x: 0.1, y: 0.2, w: 0.8, h: 0.03 },
    { x: 0.08, y: 0.3, w: 0.35, h: 0.15 }, // the real drawing
  ];
  const snapped = snapLayoutToLines(layout, lines);

  assert.deepEqual(snapped.blocks[0]?.bbox, { x: 0.1, y: 0.1, w: 0.8, h: 0.03 });
  assert.deepEqual(snapped.blocks[1]?.bbox, { x: 0.08, y: 0.3, w: 0.35, h: 0.15 });
});

test('question types: violations found, then forced back to the original shape', async () => {
  const { findTypeViolations, enforceQuestionTypes, describeTypeViolation } = await import('./pageLayout');
  const layout = parsePageLayout({
    page: { w: 1000, h: 1000 },
    blocks: [
      // A written question that came back with options.
      { kind: 'question', n: '1', bbox: [0.1, 0.1, 0.8, 0.04], content: 'Define force', type: 'mcq', originalType: 'written', originalChoiceCount: 0 },
      { kind: 'choices', n: '1', bbox: [0.1, 0.15, 0.8, 0.03], choices: ['a', 'b', 'c'] },
      // An MCQ of 4 that came back with 5.
      { kind: 'question', n: '2', bbox: [0.1, 0.3, 0.8, 0.04], content: 'Unit of force?', type: 'mcq', originalType: 'mcq', originalChoiceCount: 4 },
      { kind: 'choices', n: '2', bbox: [0.1, 0.35, 0.8, 0.03], choices: ['newton', 'joule', 'watt', 'pascal', 'ampere'] },
      // A true/false that came back as an MCQ.
      { kind: 'question', n: '3', bbox: [0.1, 0.5, 0.8, 0.04], content: 'Force is a vector', originalType: 'true_false' },
      { kind: 'choices', n: '3', bbox: [0.1, 0.55, 0.8, 0.03], choices: ['yes', 'no', 'sometimes'] },
      // A fine fill-blank and a fine T/F.
      { kind: 'question', n: '4', bbox: [0.1, 0.7, 0.8, 0.04], content: 'The unit of mass is ______', originalType: 'fill_blank' },
      { kind: 'question', n: '5', bbox: [0.1, 0.8, 0.8, 0.04], content: 'Mass is a vector', originalType: 'tf' },
      { kind: 'choices', n: '5', bbox: [0.1, 0.85, 0.8, 0.03], choices: ['True', 'False'] },
    ],
  })!;
  const violations = findTypeViolations(layout);

  assert.deepEqual(
    violations.map((v) => [v.n, v.expected, v.got, v.gotChoices]),
    [
      ['1', 'written', 'mcq', 3],
      ['2', 'mcq', 'mcq', 5],
      ['3', 'true_false', 'mcq', 3],
    ],
  );
  assert.equal(describeTypeViolation(violations[0]!), 'Q1: got choices, but it is a written question');
  assert.equal(describeTypeViolation(violations[1]!), 'Q2: 5 choices, the original had 4');

  const fixed = enforceQuestionTypes(layout, violations);

  assert.equal(fixed.blocks.filter((b) => b.kind === 'choices' && b.n === '1').length, 0, 'written lost its options');
  assert.deepEqual(fixed.blocks.find((b) => b.kind === 'choices' && b.n === '2')?.choices, ['newton', 'joule', 'watt', 'pascal']);
  assert.deepEqual(fixed.blocks.find((b) => b.kind === 'choices' && b.n === '3')?.choices, ['True', 'False']);
  assert.deepEqual(findTypeViolations(fixed), []);
});
