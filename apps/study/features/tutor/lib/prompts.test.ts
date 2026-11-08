import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ANSWER_TONE_HINT, boardAskQuestion, classKind, quickPromptsFor, quickPromptsForClass, withAnswerToneHint } from './prompts';

test('classKind recognises typical class codes and names', () => {
  assert.equal(classKind({ code: 'EAS 101', name: 'Earth Science' }), 'geology');
  assert.equal(classKind({ code: 'EAS 102', name: 'Earth Science Lab' }), 'geology');
  assert.equal(classKind({ code: 'MATH 101', name: 'Calculus I' }), 'calc');
  assert.equal(classKind({ code: 'CS 101', name: 'Intro to Programming (C++)' }), 'cpp');
  assert.equal(classKind({ code: 'HIST 101', name: 'World History' }), 'other');
  assert.equal(classKind(null), 'other');
});

test('every kind has three prompts with non-empty labels and questions', () => {
  for (const kind of ['geology', 'calc', 'cpp', 'other'] as const) {
    const prompts = quickPromptsFor(kind);

    assert.equal(prompts.length, 3, kind);
    for (const prompt of prompts) {
      assert.ok(prompt.label.trim() && prompt.question.trim());
    }
  }
  assert.equal(quickPromptsForClass({ code: 'EAS 101', name: '' })[0].mode, 'quiz');
  assert.equal(quickPromptsForClass({ code: 'MATH 101', name: '' })[0].pen, true);
  assert.match(quickPromptsForClass({ code: 'CS 101', name: '' })[0].label, /Trace/);
});

test('boardAskQuestion: the panel prompt wins, actions map to a sentence', () => {
  assert.equal(boardAskQuestion('solve', '  why?  '), 'why?');
  assert.match(boardAskQuestion('solve'), /Solve/);
  assert.match(boardAskQuestion('check_answer'), /mistake/);
  assert.match(boardAskQuestion('nonsense'), /Explain/);
});

test('a board ask carries the colour-callout instruction after the question', () => {
  const sent = withAnswerToneHint(boardAskQuestion('check_answer'));

  assert.ok(sent.startsWith(boardAskQuestion('check_answer')));
  assert.match(sent, /> \[!wrong\]/);
  assert.match(sent, /:success\[phrase\]/);
  assert.ok(ANSWER_TONE_HINT.length < 600);
});
