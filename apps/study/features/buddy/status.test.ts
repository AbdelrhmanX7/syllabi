import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buddyStatusLine } from './status';

test('listening wins over the board phase, then the board phase, else nothing', () => {
  assert.equal(buddyStatusLine({ phase: 'reading', dictation: 'recording' }), 'Listening… let go to ask');
  assert.equal(buddyStatusLine({ phase: 'idle', dictation: 'transcribing' }), 'Got it, one sec…');
  assert.equal(buddyStatusLine({ phase: 'planning', dictation: 'idle' }), 'Thinking…');
  assert.equal(buddyStatusLine({ phase: 'done', dictation: 'idle' }), null);
});
