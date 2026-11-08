import type { TutorConversation, TutorConversationDetail } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendMessages,
  applyQuizTurn,
  conversationRow,
  conversationTitle,
  mergeConversation,
  newConversation,
  pendingQuizQuestion,
  previewOf,
  threadMode,
} from './conversations';

const row = (id: string, updatedAt: string): TutorConversation => ({
  id,
  classId: 'cls_1',
  title: id,
  mode: 'explain',
  createdAt: updatedAt,
  updatedAt,
});

test('conversationTitle: first line, word-trimmed with an ellipsis', () => {
  assert.equal(conversationTitle('  Explain\n this  limit '), 'Explain this limit');
  assert.equal(conversationTitle(''), 'New chat');
  const long = conversationTitle('Trace this code and tell me why the destructor runs before the copy constructor');

  assert.ok(long.endsWith('…'));
  assert.ok(long.length <= 58);
  assert.ok(!long.includes('  '));
});

test('mergeConversation upserts by id and sorts newest first', () => {
  const list = [row('a', '2026-10-01T00:00:00Z'), row('b', '2026-10-03T00:00:00Z')];
  const merged = mergeConversation(list, { ...row('a', '2026-10-05T00:00:00Z'), title: 'renamed' });

  assert.deepEqual(
    merged.map((item) => item.id),
    ['a', 'b'],
  );
  assert.equal(merged[0].title, 'renamed');
  assert.equal(
    mergeConversation(list, row('c', '2026-10-02T00:00:00Z'))
      .map((item) => item.id)
      .join(),
    'b,c,a',
  );
});

test('appendMessages bumps updatedAt, count and preview from the last assistant turn', () => {
  const detail: TutorConversationDetail = { ...row('a', '2026-10-01T00:00:00Z'), messages: [] };
  const next = appendMessages(
    detail,
    { role: 'user', text: 'q', createdAt: '2026-10-02T00:00:00Z' },
    { role: 'assistant', text: '**Short** answer\n\n```cpp\nint x;\n```', createdAt: '2026-10-02T00:00:05Z' },
  );

  assert.equal(next.messages.length, 2);
  assert.equal(next.updatedAt, '2026-10-02T00:00:05Z');
  assert.equal(next.messageCount, 2);
  assert.equal(next.preview, 'Short answer');
  assert.equal(previewOf('a'.repeat(200)).length, 121);
});

test('newConversation + pendingQuizQuestion', () => {
  const thread = newConversation('cv_1', 'cls_1', 'Quiz me on this week', 'quiz', '2026-10-05T00:00:00Z');

  assert.equal(thread.title, 'Quiz me on this week');
  assert.equal(pendingQuizQuestion(thread.messages), null);
  const asked = appendMessages(thread, { role: 'assistant', text: 'Q1?', createdAt: '2026-10-05T00:00:01Z' });

  assert.equal(pendingQuizQuestion(asked.messages)?.text, 'Q1?');
});

test('a server detail (no updatedAt, no mode) still makes a list row and a thread mode', () => {
  const detail: TutorConversationDetail = {
    id: 'cv',
    classId: null,
    title: 'Quiz me',
    quiz: { asked: 2, right: 1, partial: 0, wrong: 0, pending: { kind: 'free', stem: 'Q2', choices: [] } },
    messages: [
      { role: 'user', text: 'Quiz me', mode: 'quiz', createdAt: '2026-10-05T00:00:00.000Z' },
      { role: 'assistant', text: '**Question 1:** Q1', mode: 'quiz', createdAt: '2026-10-05T00:00:00.001Z' },
    ],
  };
  const listRow = conversationRow(detail);

  assert.equal(listRow.updatedAt, '2026-10-05T00:00:00.001Z');
  assert.equal(listRow.messageCount, 2);
  assert.equal('quiz' in listRow, false);
  assert.equal(threadMode(detail), 'quiz');
  assert.equal(threadMode({ messages: [] }), null);
  assert.equal(threadMode(null), null);
});

test('applyQuizTurn writes the new running score onto the cached thread', () => {
  const detail: TutorConversationDetail = { id: 'cv', classId: null, title: 't', messages: [], quiz: null };
  const next = applyQuizTurn(detail, {
    asked: 3,
    right: 1,
    partial: 1,
    wrong: 0,
    questionId: null,
    questionKind: 'free',
    graded: { result: 'partial', correctAnswer: 'x' },
  });

  assert.deepEqual(next.quiz, { asked: 3, right: 1, partial: 1, wrong: 0 });
  assert.equal(next.mode, 'quiz');
});
