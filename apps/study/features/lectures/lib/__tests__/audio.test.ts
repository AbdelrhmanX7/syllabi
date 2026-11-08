import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createElapsedClock, pickAudioMime } from '../audio';

test('pickAudioMime prefers opus/webm, falls back to mp4/aac', () => {
  assert.equal(
    pickAudioMime(() => true),
    'audio/webm;codecs=opus',
  );
  assert.equal(
    pickAudioMime((m) => m.startsWith('audio/mp4')),
    'audio/mp4;codecs=mp4a.40.2',
  );
  assert.equal(
    pickAudioMime(() => false),
    null,
  );
  assert.equal(
    pickAudioMime((m) => {
      if (m.includes('webm')) throw new Error('nope');

      return m === 'audio/aac';
    }),
    'audio/aac',
  );
});

test('elapsed clock excludes paused time', () => {
  let now = 0;
  const clock = createElapsedClock(() => now);

  clock.start();
  now = 1000;
  clock.pause();
  now = 5000;
  assert.equal(clock.elapsedMs(), 1000);
  clock.resume();
  now = 5500;
  assert.equal(clock.elapsedMs(), 1500);
});
