import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BUDDY_THINKING_LINES, buddyStatus, buddyStatusLine } from './status';

test('listening wins over the board phase, then the board phase, else nothing', () => {
  assert.equal(buddyStatusLine({ phase: 'reading', dictation: 'recording' }), 'Listening… let go to ask');
  assert.equal(buddyStatusLine({ phase: 'idle', dictation: 'transcribing' }), 'Writing down what you said…');
  assert.equal(buddyStatusLine({ phase: 'reading', dictation: 'idle' }), 'Reading your page…');
  assert.equal(buddyStatusLine({ phase: 'drawing', dictation: 'idle' }), 'Marking your page…');
  assert.equal(buddyStatusLine({ phase: 'kept', dictation: 'idle' }), 'Saved to your page.');
  assert.equal(buddyStatusLine({ phase: 'done', dictation: 'idle' }), null);
});

test('while it thinks the lines turn over, each with its own orb, and it rests on the last one', () => {
  const lines = [0, 1, 2, 3, 4, 9].map((tick) => buddyStatus({ phase: 'planning', dictation: 'idle', tick })!);

  assert.equal(lines[0]!.line, 'Working it out myself first…');
  assert.equal(new Set(lines.slice(0, 5).map((entry) => entry.line)).size, 5, 'five different lines');
  assert.deepEqual(lines[5], BUDDY_THINKING_LINES[BUDDY_THINKING_LINES.length - 1]);
  assert.ok(lines.every((entry) => ['searching', 'composing', 'shaping', 'solving'].includes(entry.orb)));
  assert.ok(!lines.some((entry) => entry.line === 'Thinking…'));
});
