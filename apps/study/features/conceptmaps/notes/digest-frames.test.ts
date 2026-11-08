import type { DigestState } from './digest-frames';
import type { SseFrame } from '@/lib/api/http';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { digestErrorMessage, digestProgress, INITIAL_DIGEST, reduceDigestFrame, skippedPages } from './digest-frames';
import { normalizeDigest } from './api';

const run = (frames: SseFrame[], from: DigestState = INITIAL_DIGEST) => frames.reduce(reduceDigestFrame, from);

const DIGEST = {
  concepts: [
    { term: 'Lithosphere', definitionFromNotes: 'rigid outer layer', matchesProfessor: true },
    { term: 'Asthenosphere', definitionFromNotes: 'soft layer', matchesProfessor: false, professorWording: 'ductile' },
  ],
  questions: [{ q: 'What is the continental drift?', answerFromNotes: 'Wegener' }, 'Bare question?'],
  missingFromNotes: ['Plate tectonics'],
  conflicts: [{ term: 'Asthenosphere', notes: 'soft layer', professor: 'ductile' }],
};

test('page frames → progress, digest → done', () => {
  const reading = run([
    { event: 'page', data: { pageId: 'p1', version: 3, cached: false } },
    { event: 'page', data: { pageId: 'p2', version: 1, cached: true } },
  ]);

  assert.equal(reading.phase, 'reading');
  assert.deepEqual(reading.pages, [
    { pageId: 'p1', version: 3, cached: false, error: null },
    { pageId: 'p2', version: 1, cached: true, error: null },
  ]);
  assert.equal(digestProgress(reading, 3), 'Read page 2 of 3');

  const done = run(
    [
      { event: 'digest', data: DIGEST },
      { event: 'done', data: { usageId: 'u1' } },
    ],
    reading,
  );

  assert.equal(done.phase, 'done');
  assert.equal(done.digest?.concepts.length, 2);
  assert.equal(done.digest?.concepts[1]!.professorWording, 'ductile');
  assert.deepEqual(
    done.digest?.questions.map((row) => row.q),
    ['What is the continental drift?', 'Bare question?'],
  );
  assert.deepEqual(done.digest?.missingFromNotes, ['Plate tectonics']);
  assert.equal(digestProgress(done, 3), null);
});

test('a repeated page frame updates in place; a frame without pageId is ignored', () => {
  const state = run([
    { event: 'page', data: { pageId: 'p1', version: 1, cached: false } },
    { event: 'page', data: { pageId: 'p1', version: 2, cached: true } },
    { event: 'page', data: { version: 9 } },
  ]);

  assert.deepEqual(state.pages, [{ pageId: 'p1', version: 2, cached: true, error: null }]);
});

test('error frame and done-without-digest both end in error', () => {
  const failed = run([
    { event: 'page', data: { pageId: 'p1' } },
    { event: 'error', data: { message: 'Vision quota' } },
  ]);

  assert.equal(failed.phase, 'error');
  assert.equal(failed.error, 'Vision quota');
  assert.equal(run([{ event: 'done', data: null }]).phase, 'error');
  assert.equal(run([{ event: 'error', data: null }]).error, 'The notes could not be read.');
});

test('sample marker on any frame is kept; progress text before the first page', () => {
  const state = run([{ event: 'page', data: { pageId: 'p1', __sample: true } }]);

  assert.equal(state.sample, true);
  assert.equal(digestProgress({ ...INITIAL_DIGEST, phase: 'reading' }, 2), 'Reading your notes…');
  assert.equal(
    digestProgress(
      run([
        { event: 'page', data: { pageId: 'p1' } },
        { event: 'page', data: { pageId: 'p2' } },
      ]),
      2,
    ),
    'Comparing with the term list…',
  );
});

test('page frames carry the per-page error; skipped pages are named', () => {
  const state = run([
    { event: 'page', data: { pageId: 'p1', version: 1, cached: false } },
    { event: 'page', data: { pageId: 'p2', version: 1, cached: false, error: 'TIMEOUT' } },
    { event: 'page', data: { pageId: 'p3', version: 2, cached: true, error: 'EMPTY_PAGE' } },
    { event: 'page', data: { pageId: 'p4', version: 2, cached: false, error: 'READ_FAILED' } },
  ]);

  assert.equal(state.phase, 'reading');
  assert.equal(state.pages[0]!.error, null);
  assert.equal(state.pages[1]!.error, 'TIMEOUT');
  assert.deepEqual(skippedPages(state.pages), ['Page 2 couldn’t be read', 'Page 4 couldn’t be read']);
});

test('error frame codes get friendly messages; unknown codes keep the server message', () => {
  const msg = (data: unknown) => run([{ event: 'error', data }]).error;

  assert.match(msg({ code: 'NO_NOTES', message: 'x' })!, /Link a notes page/);
  assert.match(msg({ code: 'NOTHING_READ', message: 'x' })!, /Could not read anything/);
  assert.match(msg({ code: 'AI_EMPTY', message: 'x' })!, /try again/);
  assert.equal(msg({ code: 'WHATEVER', message: 'server words' }), 'server words');
  assert.equal(digestErrorMessage('NO_NOTES'), 'Link a notes page to this map first.');
  assert.equal(digestErrorMessage(undefined), null);
});

test('digest keeps generatedAt from the cached map digest', () => {
  assert.equal(
    normalizeDigest({ ...DIGEST, generatedAt: '2026-10-05T10:00:00.000Z' }).generatedAt,
    '2026-10-05T10:00:00.000Z',
  );
  assert.equal(normalizeDigest(DIGEST).generatedAt, null);
});

test('done {model, sources} lands on the digest; a cached digest without them reads as empty', () => {
  const state = run([
    {
      event: 'digest',
      data: { concepts: [{ term: 'Fault', definitionFromNotes: 'a crack', matchesProfessor: true }] },
    },
    {
      event: 'done',
      data: { usageId: 'u1', model: 'deepseek-chat', sources: [{ kind: 'notes', title: 'Week 3', itemId: 'n3' }] },
    },
  ]);

  assert.equal(state.phase, 'done');
  assert.deepEqual(state.digest?.provenance, {
    model: 'deepseek-chat',
    sources: [{ kind: 'notes', title: 'Week 3', itemId: 'n3' }],
  });
  assert.deepEqual(normalizeDigest({ concepts: [] }).provenance, { model: null, sources: [] });
  assert.equal(
    normalizeDigest({ model: 'openrouter/openai/gpt-6.1-sol', sources: [{ kind: 'slides', title: 'L4' }] }).provenance
      ?.model,
    'openrouter/openai/gpt-6.1-sol',
  );
});
