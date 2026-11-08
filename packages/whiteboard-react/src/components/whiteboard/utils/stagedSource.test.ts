import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStagedSourceTracker } from './stagedSource';

const track = () => {
  const discarded: string[] = [];
  const tracker = createStagedSourceTracker<string>((value) => discarded.push(value));

  return { discarded, tracker };
};

test('a staged value that is released is discarded once', () => {
  const { discarded, tracker } = track();

  tracker.stage('deck.pptx');
  tracker.release();
  tracker.release();

  assert.deepEqual(discarded, ['deck.pptx']);
});

test('a consumed value is never discarded, even if release runs afterwards', () => {
  const { discarded, tracker } = track();

  tracker.stage('deck.pptx');
  tracker.consume();
  tracker.release();

  assert.deepEqual(discarded, []);
});

test('staging a second value discards the first', () => {
  const { discarded, tracker } = track();

  tracker.stage('first.pptx');
  tracker.stage('second.pptx');

  assert.deepEqual(discarded, ['first.pptx']);
  assert.equal(tracker.peek(), 'second.pptx');
});

test('re-staging the SAME value discards nothing', () => {
  const { discarded, tracker } = track();

  tracker.stage('deck.pptx');
  tracker.stage('deck.pptx');

  assert.deepEqual(discarded, []);
  assert.equal(tracker.peek(), 'deck.pptx');
});

test('releasing with nothing staged does nothing', () => {
  const { discarded, tracker } = track();

  tracker.release();

  assert.deepEqual(discarded, []);
  assert.equal(tracker.peek(), null);
});

test('a discard handler that re-enters cannot double-discard', () => {
  const discarded: string[] = [];
  // A close handler firing a release from inside a release is exactly the modal's cancel path.
  const tracker = createStagedSourceTracker<string>((value) => {
    discarded.push(value);
    tracker.release();
  });

  tracker.stage('deck.pptx');
  tracker.release();

  assert.deepEqual(discarded, ['deck.pptx']);
});
