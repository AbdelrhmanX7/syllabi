import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideTranscript, UNAVAILABLE_MESSAGE } from '../videoTranscript';

const ctx = { deviceAvailable: true, triedDevice: false, queued: false, now: 1000, summaryUntil: 5000 };
const seg = [{ start: 0, end: 2, text: 'hi' }];

test('segments are shown; summary polled only until the deadline', () => {
  const dto = { segments: seg, summary: null, keyPoints: [], transcriptStatus: 'ready' as const };

  assert.deepEqual(decideTranscript(dto, ctx), {
    kind: 'show',
    transcript: { segments: seg, summary: null, keyPoints: [] },
    pollForSummary: true,
  });
  assert.equal((decideTranscript(dto, { ...ctx, now: 9000 }) as { pollForSummary: boolean }).pollForSummary, false);
  assert.equal((decideTranscript({ ...dto, summary: 'S' }, ctx) as { pollForSummary: boolean }).pollForSummary, false);
});

test('pending waits', () => {
  assert.deepEqual(decideTranscript({ segments: [], summary: null, keyPoints: [], transcriptStatus: 'pending' }, ctx), {
    kind: 'wait',
  });
});

test('YOUTUBE_BLOCKED / none → device first, once', () => {
  const blocked = {
    segments: [],
    summary: null,
    keyPoints: [],
    transcriptStatus: 'failed' as const,
    error: { code: 'YOUTUBE_BLOCKED', message: 'blocked' },
  };

  assert.deepEqual(decideTranscript(blocked, ctx), { kind: 'device' });
  assert.deepEqual(decideTranscript(null, ctx), { kind: 'device' });
  assert.deepEqual(decideTranscript(blocked, { ...ctx, triedDevice: true }), {
    kind: 'unavailable',
    message: UNAVAILABLE_MESSAGE,
  });
});

test('no device (browser dev): ask the server once, then give up gracefully', () => {
  const none = { segments: [], summary: null, keyPoints: [], transcriptStatus: 'none' as const };
  const browser = { ...ctx, deviceAvailable: false };

  assert.deepEqual(decideTranscript(none, browser), { kind: 'queue' });
  assert.equal(decideTranscript(none, { ...browser, queued: true }).kind, 'unavailable');
});
