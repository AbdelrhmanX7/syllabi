import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inlineMathToText, latexToText, splitInlineMath } from './latexText';
import { blocksToMarkdown, extractJsonObject, markdownToBlocks, resolveAnswerIndex, stripInlineMarkdown } from './markdownBlocks';

const strip = (text: string) => text.replace(/\u00A0/g, ' ');

test('the real prod answer shape: heading, bold step lines, display math, rule, question', () => {
  // Shape captured from POST /ai/chat on 2026-10-04 (2x + 3 = 11 image).
  const answer =
    '## Solving $2x + 3 = 11$\n\n**Idea:** a first-degree equation.\n\n**Step 1 — remove the constant term:**\nSubtract $3$ from both sides:\n\n$$2x + 3 - 3 = 11 - 3$$\n\n$$2x = 8$$\n\n---\n\nNote: the picture has only one question.';
  const blocks = markdownToBlocks(answer);

  assert.deepEqual(
    blocks.map((block) => block.type),
    ['heading', 'paragraph', 'paragraph', 'math', 'math', 'paragraph'],
  );
  assert.deepEqual(blocks[0], { type: 'heading', level: 2, text: 'Solving $2x + 3 = 11$' });
  assert.deepEqual(blocks[3], { type: 'math', text: '2x + 3 - 3 = 11 - 3' });
  assert.equal((blocks[2] as { text: string }).text, '**Step 1 — remove the constant term:**\nSubtract $3$ from both sides:');
});

test('multi-line display math and \\[ \\] delimiters', () => {
  const blocks = markdownToBlocks('before\n$$\n\\frac{a}{b}\n= c\n$$\nafter\n\\[ x^2 \\]');

  assert.deepEqual(blocks, [
    { type: 'paragraph', text: 'before' },
    { type: 'math', text: '\\frac{a}{b}\n= c' },
    { type: 'paragraph', text: 'after' },
    { type: 'math', text: 'x^2' },
  ]);
});

test('an unclosed $$ while streaming becomes the math block it is turning into', () => {
  assert.deepEqual(markdownToBlocks('text\n$$\nx = \\frac{1'), [
    { type: 'paragraph', text: 'text' },
    { type: 'math', text: 'x = \\frac{1' },
  ]);
});

test('GFM table with alignment row, ragged rows padded to the header', () => {
  const blocks = markdownToBlocks('| Substance | State | Formula |\n|:---|:---:|---:|\n| Water | liquid | $H_2O$ |\n| Ice | solid |');

  assert.deepEqual(blocks, [
    {
      type: 'table',
      header: ['Substance', 'State', 'Formula'],
      rows: [
        ['Water', 'liquid', '$H_2O$'],
        ['Ice', 'solid', ''],
      ],
    },
  ]);
});

test('ordered and unordered lists, continuation lines', () => {
  const blocks = markdownToBlocks('- first\n- second\n  continued\n\n1. step\n2. next step');

  assert.deepEqual(blocks, [
    { type: 'list', ordered: false, items: ['first', 'second continued'] },
    { type: 'list', ordered: true, items: ['step', 'next step'] },
  ]);
});

test('mermaid fence → diagram; other fences → paragraph; json fence dropped', () => {
  const blocks = markdownToBlocks('```mermaid\nflowchart TD\nA-->B\n```\n```python\nprint(1)\n```\n```json\n{"a":1}\n```');

  assert.deepEqual(blocks, [
    { type: 'diagram', mermaid: 'flowchart TD\nA-->B' },
    { type: 'paragraph', text: 'print(1)' },
  ]);
});

test('MCQ: stem, choices, answer letter, explanation', () => {
  const blocks = markdownToBlocks(
    '**Q1:** What is the capital of Egypt?\na) Alexandria\nb) Cairo\nc) Aswan\nd) Tanta\nAnswer: b\nExplanation: Cairo is the capital.\n\n**Q2:** What is $2+2$?\n- a) 3\n- b) 4\n**Correct answer:** (b) 4',
  );

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: 'question',
    stem: 'What is the capital of Egypt?',
    choices: ['Alexandria', 'Cairo', 'Aswan', 'Tanta'],
    answerIndex: 1,
    explanation: 'Cairo is the capital.',
  });
  assert.deepEqual(blocks[1], { type: 'question', stem: 'What is $2+2$?', choices: ['3', '4'], answerIndex: 1 });
});

test('a numbered list of solution steps is NOT mistaken for a question', () => {
  const blocks = markdownToBlocks('1. Subtract 3 from both sides\n2. Divide by 2\n3. Check\n\nAnswer: x = 4');

  assert.equal(blocks[0]?.type, 'list');
  assert.equal(blocks.some((block) => block.type === 'question'), false);
});

test('written question with a free-text answer', () => {
  assert.deepEqual(markdownToBlocks('Q3: Define speed.\nAnswer: distance travelled per unit time.'), [
    { type: 'question', stem: 'Define speed.', answer: 'distance travelled per unit time.' },
  ]);
});

test('resolveAnswerIndex accepts letters in either case and the choice text', () => {
  const choices = ['10', '20', '30'];

  assert.equal(resolveAnswerIndex('a', choices), 0);
  assert.equal(resolveAnswerIndex('(C)', choices), 2);
  assert.equal(resolveAnswerIndex('b', choices), 1);
  assert.equal(resolveAnswerIndex('**20**', choices), 1);
  assert.equal(resolveAnswerIndex('e', choices), undefined);
});

test('blocksToMarkdown round-trips through the parser', () => {
  const source = markdownToBlocks('## Title\n\nParagraph\n\n- a\n- b\n\n$$\nx^2\n$$\n\n| a | b |\n|---|---|\n| 1 | 2 |');

  assert.deepEqual(markdownToBlocks(blocksToMarkdown(source)), source);
});

test('stripInlineMarkdown leaves math alone', () => {
  assert.equal(stripInlineMarkdown('**important** and *italic* and `code` and $a*b$'), 'important and italic and code and $a*b$');
});

test('extractJsonObject: fenced, prose-wrapped, trailing commas', () => {
  assert.deepEqual(extractJsonObject('Here is the analysis:\n```json\n{"a": [1, 2,],}\n```\nDone'), { a: [1, 2] });
  assert.deepEqual(extractJsonObject('Result {"pageType":"blank"} ok'), { pageType: 'blank' });
  assert.equal(extractJsonObject('no json here'), null);
});

test('extractJsonObject repairs single-backslash LaTeX inside JSON strings (real prod failure)', () => {
  // From /ai/chat 2026-10-04: "\times" arrived unescaped and parsed as TAB + "imes".
  const raw = '```json\n{"text":"Compute: $7 \\times 8 =$","why":"$\\frac{1}{2}$ and \\{4\\}\\n2nd line","ok":"\\\\alpha","u":"\\u0041"}\n```';
  const parsed = extractJsonObject(raw) as Record<string, string>;

  assert.equal(parsed.text, 'Compute: $7 \\times 8 =$');
  assert.equal(parsed.why, '$\\frac{1}{2}$ and \\{4\\}\n2nd line');
  assert.equal(parsed.ok, '\\alpha', 'an already-doubled backslash stays one backslash');
  assert.equal(parsed.u, 'A');
});

test('latexToText: fractions, roots, scripts, greek, degree, text', () => {
  assert.equal(strip(latexToText('\\frac{2x}{2} = 4')), '2x/2 = 4');
  assert.equal(strip(latexToText('\\frac{a+b}{c}')), '(a+b)/c');
  assert.equal(strip(latexToText('x^{2} + y_1 = \\sqrt{9}')), 'x² + y₁ = √9');
  assert.equal(strip(latexToText('\\alpha + \\beta \\times 30^\\circ')), 'α + β × 30°');
  assert.equal(strip(latexToText('v = \\text{speed} \\cdot t')), 'v = speed · t');
  assert.equal(strip(latexToText('e^{i\\pi}')), 'e^(iπ)');
  assert.equal(strip(latexToText('x = \\{4\\} \\quad \\checkmark')), 'x = {4} ✓');
  assert.equal(latexToText('x'), 'x');
});

test('a formula run never holds a breakable space (Fabric wraps at plain spaces)', () => {
  const wrapped = latexToText('2H_2 + O_2 \\rightarrow 2H_2O');

  assert.ok(!wrapped.includes(' '));
  assert.equal(wrapped, '2H₂\u00A0+\u00A0O₂\u00A0→\u00A02H₂O');

  // The prose around it keeps its ordinary, breakable spaces.
  const line = inlineMathToText('the equation $a + b = c$ holds');

  assert.equal(line.split(' ').length, 4);
  assert.equal(strip(line), 'the equation a + b = c holds');
  // Callers that lay the formula out themselves get plain spaces.
  assert.equal(latexToText('a + b', { isolate: false }), 'a + b');
});

test('inlineMathToText and splitInlineMath', () => {
  assert.equal(strip(inlineMathToText('value $x^2$ is \\$5')), 'value x² is $5');
  assert.deepEqual(splitInlineMath('a $x$ b'), [
    { kind: 'text', value: 'a ' },
    { kind: 'math', value: 'x' },
    { kind: 'text', value: ' b' },
  ]);
});

test('extractJsonObject: over-escaped TeX (four backslashes) collapses to one TeX backslash', () => {
  const parsed = extractJsonObject('{"c":"$8\\\\\\\\,\\\\\\\\mathrm{kg}$","d":"a\\\\nb"}') as Record<string, string>;

  assert.equal(parsed.c, '$8\\,\\mathrm{kg}$');
  assert.equal(parsed.d, 'a\\nb', 'a JSON-escaped literal backslash before a single letter is untouched');
});

test('a `> [!tone]` callout tones its blocks; an unknown name stays plain text', () => {
  const blocks = markdownToBlocks('Intro\n\n> [!wrong] You dropped the sign.\n> - step 2 is off\n\n> [!foo] not a tone\n\nafter');

  assert.deepEqual(blocks, [
    { type: 'paragraph', text: 'Intro' },
    { type: 'paragraph', text: 'You dropped the sign.', tone: 'wrong' },
    { type: 'list', ordered: false, items: ['step 2 is off'], tone: 'wrong' },
    { type: 'paragraph', text: '> [!foo] not a tone' },
    { type: 'paragraph', text: 'after' },
  ]);
});

test('a `:::tone` fence (aliases too) tones its body, even while still streaming', () => {
  assert.deepEqual(markdownToBlocks(':::correct\nRight answer.\n:::\nnext'), [
    { type: 'paragraph', text: 'Right answer.', tone: 'success' },
    { type: 'paragraph', text: 'next' },
  ]);
  assert.deepEqual(markdownToBlocks(':::tip\nhalf writ'), [{ type: 'paragraph', text: 'half writ', tone: 'info' }]);
  assert.deepEqual(markdownToBlocks('> [!CAUTION]\n> careful'), [{ type: 'paragraph', text: 'careful', tone: 'warning' }]);
});

test('inline tone spans flatten to their text for the board; unknown ones are left alone', () => {
  assert.equal(stripInlineMarkdown('this is :wrong[x = 3] and :success[**ok**] :foo[bar]'), 'this is x = 3 and ok :foo[bar]');
});
