import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reaskPrompt, typeCorrectionPrompt } from './clientPrompts';
import { blocksToMarkdown, markdownToBlocks } from './markdownBlocks';
import { parseMermaidFlowchart } from './mermaidFlow';
import { parsePageAnalysis } from './pageAnalysis';
import { describeTypeViolation } from './pageLayout';
import { remakeStageOf, REMAKE_STAGE_LINES } from './remakeDraft';

import type { BoardAiBlock } from './types';

type Question = Extract<BoardAiBlock, { type: 'question' }>;

const questionOf = (markdown: string): Question => {
  const question = markdownToBlocks(markdown).find((block): block is Question => block.type === 'question');

  assert.ok(question, 'parsed a question');

  return question;
};

test('an MCQ parses: choices, answer letter, explanation', () => {
  const question = questionOf('**Q1:** What is 2 + 2?\nA) 3\nB) 4\nC) 5\nAnswer: B\nExplanation: two and two make four.');

  assert.deepEqual(question.choices, ['3', '4', '5']);
  assert.equal(question.answerIndex, 1);
  assert.ok(question.explanation);
  assert.equal(questionOf('Question 2) Name a mammal.\nCorrect answer: a whale').answer, 'a whale');
});

test('blocksToMarkdown writes English board labels and round-trips', () => {
  const block: Question = { type: 'question', stem: '2 + 2', choices: ['3', '4'], answerIndex: 1, explanation: 'sum' };
  const markdown = blocksToMarkdown([block]);

  assert.match(markdown, /^\*\*Q1:\*\* 2 \+ 2\nA\) 3\nB\) 4\nAnswer: B\) 4\nExplanation: sum$/);
  assert.equal(blocksToMarkdown([block], { lang: 'en' }), markdown);

  const back = questionOf(markdown);

  assert.equal(back.answerIndex, 1);
  assert.equal(back.explanation, 'sum');
});

test('page analysis reads verdicts and page types', () => {
  const analysis = parsePageAnalysis(
    '{"pageType":"questions","questions":[{"n":1,"text":"a","verdict":"wrong"},{"n":2,"text":"b","verdict":"incorrect"},{"n":3,"text":"c","verdict":"correct"}]}',
  );

  assert.equal(analysis?.pageType, 'questions');
  assert.deepEqual(
    analysis?.questions.map((question) => question.verdict),
    ['wrong', 'wrong', 'correct'],
  );
});

test('mermaid flowcharts parse', () => {
  const graph = parseMermaidFlowchart('flowchart TD\nStart[Begin] --> Next[Solve]');

  assert.equal(graph?.nodes.length, 2);
  assert.equal(graph?.edges.length, 1);
});

test('remake status lines map to stages', () => {
  REMAKE_STAGE_LINES.forEach((line, stage) => assert.equal(remakeStageOf(line), stage));
  ['Reading the page…', 'Writing the new questions…', 'Drawing the new page…', 'Checking the writing…'].forEach((line, stage) =>
    assert.equal(remakeStageOf(line), stage),
  );
});

test('type violations and client prompts are English', () => {
  const violation = { n: '2', expected: 'mcq' as const, got: 'mcq' as const, gotChoices: 5, expectedChoices: 4 };

  assert.equal(describeTypeViolation(violation), 'Q2: 5 choices, the original had 4');
  assert.match(typeCorrectionPrompt([violation]), /^These questions changed type.*Q2: 5 choices/);
  assert.match(reaskPrompt('solve', undefined, 'x = 2', 'en'), /^Solve step by step this writing from the board/);
});
