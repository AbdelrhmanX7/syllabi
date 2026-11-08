import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REMAKE_ORB_COLORS,
  REMAKE_QUESTIONS_READY_LINE,
  chromeHideStyle,
  remakeChromeHidden,
  remakeGeneratingInfo,
  remakeOrbState,
  remakeStatusText,
  sameGeneratingInfo,
} from './generatingState';
import { REMAKE_STAGE_LINES, remakeDraftReducer } from './remakeDraft';

import type { RemakeDraft } from './remakeDraft';
import type { RemakeImageResult } from './types';

const RESULT: RemakeImageResult = { src: 'data:image/png;base64,AAAA', width: 10, height: 10, newQuestions: [], verification: { ok: true, mismatches: [] } };

const started = () => remakeDraftReducer(null, { type: 'start', pageId: 'draft', originalPageId: 'orig', request: { mode: 'similar' }, now: 0 })!;
const atStage = (line: string, now = 1000) => remakeDraftReducer(started(), { type: 'status', run: 1, line, now })!;

test('step → orb: reading=searching, writing=composing, drawing=shaping, verifying=solving, done=breathing', () => {
  assert.equal(remakeOrbState(started()), 'searching', 'before any status line the page is being read');
  assert.equal(remakeOrbState(atStage(REMAKE_STAGE_LINES[0])), 'searching');
  assert.equal(remakeOrbState(atStage(REMAKE_STAGE_LINES[1])), 'composing');
  assert.equal(remakeOrbState(atStage(REMAKE_STAGE_LINES[2])), 'shaping');
  assert.equal(remakeOrbState(atStage(REMAKE_STAGE_LINES[3])), 'solving');
  assert.equal(remakeOrbState(atStage('Working…')), 'searching', 'an unknown line keeps the current stage');

  const revealing = remakeDraftReducer(atStage(REMAKE_STAGE_LINES[3]), { type: 'result', run: 1, result: RESULT, onPage: true })!;

  assert.equal(remakeOrbState(revealing), 'breathing');
  assert.equal(remakeOrbState(remakeDraftReducer(revealing, { type: 'revealed' })), 'breathing');
  assert.equal(remakeOrbState(null), 'breathing');

  for (const state of ['searching', 'composing', 'shaping', 'solving', 'breathing'] as const) assert.match(REMAKE_ORB_COLORS[state], /^#[0-9a-f]{6}$/);
});

test('the streamed questions frame moves the orb to shaping and the card to «Questions ready»', () => {
  const writing = atStage(REMAKE_STAGE_LINES[1]);
  const ready = remakeDraftReducer(writing, { type: 'questions', run: 1, now: 5000 })!;

  assert.equal(ready.questionsReady, true);
  assert.deepEqual(ready.clock, { stage: 2, since: 5000 });
  assert.equal(remakeOrbState(ready), 'shaping');
  assert.equal(remakeStatusText(ready, REMAKE_STAGE_LINES[1]), REMAKE_QUESTIONS_READY_LINE);

  // Stale run / twice / after the result: ignored.
  assert.equal(remakeDraftReducer(writing, { type: 'questions', run: 7, now: 1 }), writing);
  assert.equal(remakeDraftReducer(ready, { type: 'questions', run: 1, now: 9 }), ready);

  // A later verifying line still moves the clock forward from the jump.
  assert.equal(remakeDraftReducer(ready, { type: 'status', run: 1, line: REMAKE_STAGE_LINES[3], now: 6000 })!.clock.stage, 3);
});

test('the final result after an early picture only replaces the result, never the phase', () => {
  const landed = remakeDraftReducer(atStage(REMAKE_STAGE_LINES[2]), { type: 'result', run: 1, result: RESULT, onPage: true })!;
  const verified = { ...RESULT, verification: { ok: false, mismatches: ['Q1: …'] } };
  const final = remakeDraftReducer(landed, { type: 'final', run: 1, result: verified })!;

  assert.equal(final.phase, 'revealing');
  assert.equal(final.result, verified);
  assert.equal(remakeDraftReducer(landed, { type: 'final', run: 2, result: verified }), landed, 'another run');
  assert.equal(remakeDraftReducer(started(), { type: 'final', run: 1, result: verified })!.result, null, 'still generating: the picture path owns it');
});

test('status text: the stage line (the server line only moves the stage)', () => {
  assert.equal(remakeStatusText(started(), null), REMAKE_STAGE_LINES[0]);
  assert.equal(remakeStatusText(atStage(REMAKE_STAGE_LINES[2]), '  '), REMAKE_STAGE_LINES[2]);
  assert.equal(remakeStatusText(atStage(REMAKE_STAGE_LINES[2]), 'Drawing the new page… (attempt 2)'), REMAKE_STAGE_LINES[2]);
});

test('chrome lifecycle: hidden from start through the reveal on the draft page; back for review, cancel, or leaving', () => {
  let draft: RemakeDraft | null = started();

  assert.equal(remakeChromeHidden(null, true), false, 'no draft');
  assert.equal(remakeChromeHidden(draft, true), true, 'generating on the page');
  assert.equal(remakeChromeHidden(draft, false), false, 'the teacher went back to another page');

  draft = remakeDraftReducer(draft, { type: 'status', run: 1, line: REMAKE_STAGE_LINES[2], now: 10 });
  assert.equal(remakeChromeHidden(draft, true), true);

  draft = remakeDraftReducer(draft, { type: 'result', run: 1, result: RESULT, onPage: true });
  assert.equal(draft!.phase, 'revealing');
  assert.equal(remakeChromeHidden(draft, true), true, 'kept hidden through the finishing reveal');

  draft = remakeDraftReducer(draft, { type: 'revealed' });
  assert.equal(draft!.phase, 'review');
  assert.equal(remakeChromeHidden(draft, true), false, 'the review card comes with the chrome');

  draft = remakeDraftReducer(draft, { type: 'retry', now: 20 });
  assert.equal(remakeChromeHidden(draft, true), true, '«Try again» hides it again');

  draft = remakeDraftReducer(draft, { type: 'end' });
  assert.equal(remakeChromeHidden(draft, true), false, 'cancel / keep / discard');

  // Finished off-page: straight to review, chrome never hidden.
  const elsewhere = remakeDraftReducer(started(), { type: 'result', run: 1, result: RESULT, onPage: false });

  assert.equal(remakeChromeHidden(elsewhere, true), false);
});

test('generating info: the thumbnail orb only while generating; equality skips no-op reports', () => {
  const draft = atStage(REMAKE_STAGE_LINES[1]);
  const info = remakeGeneratingInfo(draft, true)!;

  assert.deepEqual(info, { pageId: 'draft', generating: true, chromeHidden: true, orb: 'composing' });
  assert.equal(remakeGeneratingInfo(null, true), null);
  assert.equal(sameGeneratingInfo(info, { ...info }), true);
  assert.equal(sameGeneratingInfo(info, { ...info, chromeHidden: false }), false);
  assert.equal(sameGeneratingInfo(null, null), true);
  assert.equal(sameGeneratingInfo(info, null), false);

  const review = remakeDraftReducer(remakeDraftReducer(draft, { type: 'result', run: 1, result: RESULT, onPage: false }), { type: 'opened' });

  assert.equal(remakeGeneratingInfo(review, true)!.generating, false);
});

test('chromeHideStyle: out of hit-testing when hidden, no transform when shown, fade-only edge keeps its own transform', () => {
  const hidden = chromeHideStyle(true, 'bottom');

  assert.equal(hidden.opacity, 0);
  assert.equal(hidden.visibility, 'hidden');
  assert.equal(hidden.pointerEvents, 'none');
  assert.equal(hidden.transform, 'translateY(16px)');
  assert.match(String(hidden.transition), /visibility 0s linear 200ms/);

  const shown = chromeHideStyle(false, 'top', { paddingInlineStart: '1rem' });

  assert.equal(shown.opacity, 1);
  assert.equal(shown.visibility, 'visible');
  assert.equal(shown.transform, undefined);
  assert.equal(shown.pointerEvents, undefined);
  assert.equal(shown.paddingInlineStart, '1rem');
  assert.equal('transform' in chromeHideStyle(true, 'none'), false);
});
