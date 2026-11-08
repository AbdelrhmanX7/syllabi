import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EMPTY_STREAM, parseQuizTurn, parseSource, quizScore, reduceAskFrame, reduceAskFrames } from './stream';

test('meta → delta… → sources → done folds into one answer', () => {
  const state = reduceAskFrames([
    { event: 'meta', data: { conversationId: 'cv_1' } },
    { event: 'delta', data: { text: 'A limit ' } },
    { event: 'delta', data: { text: 'is a value…' } },
    {
      event: 'sources',
      data: {
        sources: [{ kind: 'transcript', id: 'itm_1', title: 'Lesson 1', snippet: 'we approach', t: 42, week: 1 }],
      },
    },
    { event: 'done', data: null },
  ]);

  assert.equal(state.conversationId, 'cv_1');
  assert.equal(state.text, 'A limit is a value…');
  assert.deepEqual(state.sources, [
    { kind: 'transcript', id: 'itm_1', title: 'Lesson 1', snippet: 'we approach', t: 42, week: 1 },
  ]);
  assert.equal(state.done, true);
  assert.equal(state.error, null);
  assert.equal(state.sample, false);
});

test('whiteboard spellings: `text` string frames and `done {content}` fallback', () => {
  const streamed = reduceAskFrames([
    { event: 'text', data: 'hello ' },
    { event: 'text', data: 'world' },
    { event: 'done', data: { content: 'IGNORED — deltas win', conversationId: 'cv_9' } },
  ]);

  assert.equal(streamed.text, 'hello world');
  assert.equal(streamed.conversationId, 'cv_9');

  const whole = reduceAskFrames([{ event: 'done', data: { content: 'the whole answer' } }]);

  assert.equal(whole.text, 'the whole answer');
});

test('error frames end the stream with a message; status frames are ignored', () => {
  const state = reduceAskFrames([
    { event: 'status', data: 'reading…' },
    { event: 'delta', data: { text: 'partial' } },
    { event: 'error', data: { message: 'quota', code: 'AI_QUOTA' } },
  ]);

  assert.equal(state.text, 'partial');
  assert.equal(state.done, true);
  assert.equal(state.error, 'quota');
  assert.equal(reduceAskFrame(EMPTY_STREAM, { event: 'status', data: 'x' }), EMPTY_STREAM);
});

test('the mock marker on any frame flags the answer as sample', () => {
  const state = reduceAskFrames([
    { event: 'meta', data: { conversationId: 'cv_1', __sample: true } },
    { event: 'delta', data: { text: 'x' } },
  ]);

  assert.equal(state.sample, true);
});

test('parseSource: unknown kinds read as item, bad rows are dropped', () => {
  assert.equal(parseSource({ kind: 'item', title: 'no id' }), null);
  assert.deepEqual(parseSource({ kind: 'weird', id: 7, title: ' T ', snippet: 's' }), {
    kind: 'item',
    id: '7',
    title: 'T',
    snippet: 's',
  });
  assert.equal(parseSource({ kind: 'transcript', id: 'a', title: 'b', snippet: '', start: 12 })?.t, 12);
  assert.equal(reduceAskFrames([{ event: 'sources', data: [{ title: 'x' }] }]).sources.length, 0);
});

test('live #577 wire: null week / t on non-transcript sources are dropped, not read as 0', () => {
  const state = reduceAskFrames([
    { event: 'meta', data: { conversationId: '6700000000000000000000aa' } },
    { event: 'delta', data: { text: 'Answer' } },
    {
      event: 'sources',
      data: {
        sources: [
          { kind: 'item', id: 'i1', title: 'Syllabus', snippet: 's', week: null, t: null },
          { kind: 'transcript', id: 'v1', title: 'Lecture 4', snippet: 's', week: 4, t: 0 },
          { kind: 'guide', id: 'c1', title: 'Class guide', snippet: 'g' },
        ],
      },
    },
    { event: 'done', data: {} },
  ]);

  assert.deepEqual(state.sources[0], { kind: 'item', id: 'i1', title: 'Syllabus', snippet: 's' });
  assert.equal(state.sources[1].t, 0);
  assert.equal(state.sources[1].week, 4);
  assert.equal(state.sources[2].kind, 'guide');
  assert.equal(state.quiz, null);
  assert.equal(state.done, true);
});

test('quiz turn: done {quiz} carries the score and the verdict', () => {
  const first = reduceAskFrames([
    { event: 'meta', data: { conversationId: 'cv' } },
    { event: 'delta', data: { text: '**Question 1:** What is 2+2?' } },
    { event: 'sources', data: { sources: [] } },
    {
      event: 'done',
      data: { quiz: { questionId: null, questionKind: 'free', asked: 1, right: 0, partial: 0, wrong: 0 } },
    },
  ]);

  assert.deepEqual(first.quiz, { questionId: null, questionKind: 'free', asked: 1, right: 0, partial: 0, wrong: 0 });

  const second = reduceAskFrames([
    { event: 'meta', data: { conversationId: 'cv' } },
    { event: 'delta', data: { text: '✅ **Correct!** ' } },
    {
      event: 'done',
      data: {
        quiz: {
          questionId: 'q2',
          questionKind: 'bank',
          asked: 2,
          right: 1,
          partial: 0,
          wrong: 0,
          graded: { result: 'right', correctAnswer: '4', stats: {}, srs: {} },
        },
      },
    },
  ]);

  assert.equal(second.quiz?.questionKind, 'bank');
  assert.equal(second.quiz?.questionId, 'q2');
  assert.deepEqual(second.quiz?.graded, { result: 'right', correctAnswer: '4' });
});

test('parseQuizTurn: junk counts read as 0, an unknown verdict is dropped', () => {
  assert.equal(parseQuizTurn(null), null);
  assert.deepEqual(parseQuizTurn({ asked: '3', right: -1, partial: 'x', wrong: 2.7, graded: { result: 'maybe' } }), {
    asked: 3,
    right: 0,
    partial: 0,
    wrong: 2,
    questionId: null,
    questionKind: 'free',
  });
});

test('quizScore: partial counts half; nothing graded yet has no percent', () => {
  assert.equal(quizScore(null), null);
  assert.deepEqual(quizScore({ asked: 1, right: 0, partial: 0, wrong: 0 }), {
    answered: 0,
    right: 0,
    partial: 0,
    wrong: 0,
    percent: null,
    label: '0 / 0',
  });
  const mixed = quizScore({ asked: 4, right: 2, partial: 1, wrong: 0 });

  assert.equal(mixed?.answered, 3);
  assert.equal(mixed?.label, '2.5 / 3');
  assert.equal(mixed?.percent, 83);
  assert.equal(quizScore({ asked: 3, right: 2, partial: 0, wrong: 0 })?.label, '2 / 2');
});
