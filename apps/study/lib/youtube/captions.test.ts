import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeCaptionSegments, parseJson3 } from './captions';

// A manual track: one cue per event, line breaks inside `utf8`.
const MANUAL = {
  events: [
    { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'Welcome back.' }] },
    { tStartMs: 2500, dDurationMs: 3000, segs: [{ utf8: 'Today we look at\nclasses in C++' }] },
    { tStartMs: 5500, dDurationMs: 2000, segs: [{ utf8: 'and why they matter.' }] },
    { tStartMs: 7500, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
  ],
};

// An ASR track: word-level segs, rolling "append" events that only carry a newline.
const ASR = {
  events: [
    {
      tStartMs: 0,
      dDurationMs: 4000,
      segs: [{ utf8: 'so' }, { utf8: ' the', tOffsetMs: 400 }, { utf8: ' first', tOffsetMs: 900 }],
    },
    { tStartMs: 3990, dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] },
    {
      tStartMs: 4000,
      dDurationMs: 3000,
      segs: [{ utf8: 'thing' }, { utf8: ' is', tOffsetMs: 300 }, { utf8: ' encapsulation.', tOffsetMs: 800 }],
    },
    { tStartMs: 7000, segs: [{ utf8: 'next topic' }] },
    { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: 'is inheritance' }] },
  ],
};

describe('parseJson3', () => {
  it('turns timed events into fragments and flattens line breaks', () => {
    assert.deepEqual(parseJson3(MANUAL), [
      { start: 0, end: 2.5, text: 'Welcome back.' },
      { start: 2.5, end: 5.5, text: 'Today we look at classes in C++' },
      { start: 5.5, end: 7.5, text: 'and why they matter.' },
    ]);
  });

  it('joins word segs, drops append/newline events, and runs an undated event to the next one', () => {
    assert.deepEqual(parseJson3(ASR), [
      { start: 0, end: 4, text: 'so the first' },
      { start: 4, end: 7, text: 'thing is encapsulation.' },
      { start: 7, end: 9, text: 'next topic' },
      { start: 9, end: 10, text: 'is inheritance' },
    ]);
  });

  it('clamps overlapping cues so one ends where the next begins', () => {
    assert.deepEqual(
      parseJson3({
        events: [
          { tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: 'one' }] },
          { tStartMs: 3000, dDurationMs: 5000, segs: [{ utf8: 'two' }] },
          { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: 'three' }] },
        ],
      }),
      [
        { start: 1, end: 3, text: 'one' },
        { start: 3, end: 8, text: 'two' },
        { start: 9, end: 10, text: 'three' },
      ],
    );
  });

  it('is empty for anything that is not a json3 document', () => {
    assert.deepEqual(parseJson3(null), []);
    assert.deepEqual(parseJson3({}), []);
    assert.deepEqual(parseJson3({ events: 'nope' }), []);
  });
});

describe('mergeCaptionSegments', () => {
  it('glues fragments up to a sentence end', () => {
    assert.deepEqual(mergeCaptionSegments(parseJson3(MANUAL)), [
      { start: 0, end: 2.5, text: 'Welcome back.' },
      { start: 2.5, end: 7.5, text: 'Today we look at classes in C++ and why they matter.' },
    ]);
  });

  it('closes a segment at the duration cap even without punctuation', () => {
    const fragments = Array.from({ length: 6 }, (_, index) => ({
      start: index * 3,
      end: index * 3 + 3,
      text: `w${index}`,
    }));

    assert.deepEqual(mergeCaptionSegments(fragments, { maxDurationSec: 8 }), [
      { start: 0, end: 6, text: 'w0 w1' },
      { start: 6, end: 12, text: 'w2 w3' },
      { start: 12, end: 18, text: 'w4 w5' },
    ]);
  });

  it('closes a segment at the character cap', () => {
    const fragments = [
      { start: 0, end: 1, text: 'a'.repeat(100) },
      { start: 1, end: 2, text: 'b'.repeat(100) },
      { start: 2, end: 3, text: 'done.' },
    ];

    assert.deepEqual(mergeCaptionSegments(fragments, { maxChars: 160 }), [
      { start: 0, end: 1, text: 'a'.repeat(100) },
      { start: 1, end: 3, text: `${'b'.repeat(100)} done.` },
    ]);
  });

  it('rounds times to milliseconds and keeps an open tail', () => {
    assert.deepEqual(mergeCaptionSegments([{ start: 0.12345, end: 1.98765, text: 'tail without period' }]), [
      { start: 0.123, end: 1.988, text: 'tail without period' },
    ]);
  });
});
