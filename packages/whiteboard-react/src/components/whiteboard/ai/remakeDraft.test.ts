import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REMAKE_BANDS,
  REMAKE_PROGRESS_CAP,
  REMAKE_STAGE_LINES,
  advanceStage,
  draftProgress,
  endEffect,
  excludeTransientPages,
  finishingProgress,
  generatingProgress,
  remakeDraftReducer,
  remakeStageOf,
} from './remakeDraft';

import type { RemakeDraft } from './remakeDraft';
import type { RemakeImageResult } from './types';

const RESULT: RemakeImageResult = {
  src: 'data:image/png;base64,AAAA',
  width: 1000,
  height: 1414,
  newQuestions: [],
  verification: { ok: true, mismatches: [] },
};

test('each SSE status line maps to its stage; unknown lines map to -1', () => {
  REMAKE_STAGE_LINES.forEach((line, index) => assert.equal(remakeStageOf(line), index));
  assert.equal(remakeStageOf('Checking the writing… (attempt 2)'), 3, '«writing» must not read as stage 1');
  assert.equal(remakeStageOf('Working…'), -1);
  assert.equal(remakeStageOf(null), -1);
});

test('the stage clock is monotonic', () => {
  let clock = { stage: -1, since: 0 };

  clock = advanceStage(clock, REMAKE_STAGE_LINES[0], 1000);
  assert.deepEqual(clock, { stage: 0, since: 1000 });
  clock = advanceStage(clock, REMAKE_STAGE_LINES[2], 5000);
  assert.deepEqual(clock, { stage: 2, since: 5000 });

  const same = advanceStage(clock, REMAKE_STAGE_LINES[1], 9000);

  assert.equal(same, clock, 'a lower stage never moves the bar back');
  assert.equal(advanceStage(clock, REMAKE_STAGE_LINES[2], 9000), clock, 'a repeated stage keeps its clock');
});

test('generating progress stays inside its band, grows with time, and never reaches the cap', () => {
  REMAKE_BANDS.forEach((band, stage) => {
    const start = generatingProgress(stage, 0);
    const later = generatingProgress(stage, 20);
    const forever = generatingProgress(stage, 1e6);

    assert.ok(Math.abs(start - band.from) < 1e-9, `stage ${stage} starts at its band`);
    assert.ok(later > start);
    assert.ok(forever < band.to, `stage ${stage} never reaches the next band`);
    assert.ok(forever <= REMAKE_PROGRESS_CAP);
  });

  // Each stage starts at or above anything the previous stage could show.
  for (let stage = 1; stage < REMAKE_BANDS.length; stage += 1) {
    assert.ok(generatingProgress(stage, 0) >= generatingProgress(stage - 1, 1e6));
  }

  assert.equal(generatingProgress(-1, 3), generatingProgress(0, 3), 'before the first status = stage 0');
  assert.ok(generatingProgress(99, 1e6) < 1);
});

test('the finishing reveal runs from where it was to exactly 1', () => {
  assert.equal(finishingProgress(0.6, 0, 1200), 0.6);
  assert.ok(finishingProgress(0.6, 600, 1200) > 0.6 && finishingProgress(0.6, 600, 1200) < 1);
  assert.equal(finishingProgress(0.6, 1200, 1200), 1);
  assert.equal(finishingProgress(0.6, 5000, 1200), 1);
});

const start = (): RemakeDraft =>
  remakeDraftReducer(null, { type: 'start', pageId: 'draft', originalPageId: 'orig', request: { mode: 'similar', quality: 'normal' }, now: 0 })!;

test('lifecycle: start → stages → result on the page → reveal → review', () => {
  let draft = start();

  assert.equal(draft.phase, 'generating');
  assert.equal(draft.pageId, 'draft');
  assert.equal(draft.run, 1);

  draft = remakeDraftReducer(draft, { type: 'status', run: 1, line: REMAKE_STAGE_LINES[2], now: 4000 })!;
  assert.equal(draft.clock.stage, 2);
  assert.ok(draftProgress(draft, 34000) > REMAKE_BANDS[2]!.from);

  // A stale run's frames are ignored.
  assert.equal(remakeDraftReducer(draft, { type: 'status', run: 0, line: REMAKE_STAGE_LINES[3], now: 5000 }), draft);

  draft = remakeDraftReducer(draft, { type: 'result', run: 1, result: RESULT, onPage: true })!;
  assert.equal(draft.phase, 'revealing');
  assert.equal(draft.result, RESULT);

  draft = remakeDraftReducer(draft, { type: 'revealed' })!;
  assert.equal(draft.phase, 'review');
  assert.equal(draft.readyElsewhere, false);
});

test('lifecycle: a result while the teacher is elsewhere skips the reveal and owes the toast', () => {
  let draft = remakeDraftReducer(start(), { type: 'result', run: 1, result: RESULT, onPage: false })!;

  assert.equal(draft.phase, 'review');
  assert.equal(draft.readyElsewhere, true);

  draft = remakeDraftReducer(draft, { type: 'opened' })!;
  assert.equal(draft.readyElsewhere, false);
});

test('lifecycle: «Try again» re-runs on the SAME placeholder page with a new run id', () => {
  let draft = remakeDraftReducer(start(), { type: 'result', run: 1, result: RESULT, onPage: false })!;

  draft = remakeDraftReducer(draft, { type: 'retry', now: 9000 })!;
  assert.equal(draft.phase, 'generating');
  assert.equal(draft.pageId, 'draft');
  assert.equal(draft.originalPageId, 'orig');
  assert.equal(draft.run, 2);
  assert.equal(draft.result, null);
  assert.deepEqual(draft.clock, { stage: -1, since: 9000 });

  // The first run's late result cannot land on the second.
  assert.equal(remakeDraftReducer(draft, { type: 'result', run: 1, result: RESULT, onPage: true }), draft);
  // Retry only from review.
  assert.equal(remakeDraftReducer(draft, { type: 'retry', now: 1 }), draft);
});

test('lifecycle: keep keeps the page; discard / cancel / error / no-changes remove it and go home', () => {
  assert.equal(remakeDraftReducer(start(), { type: 'end' }), null);
  assert.deepEqual(endEffect('keep'), { removePage: false, returnToOriginal: false });

  for (const outcome of ['discard', 'cancel', 'error', 'no-changes'] as const) {
    assert.deepEqual(endEffect(outcome), { removePage: true, returnToOriginal: true });
  }
});

test('transient pages never reach the persisted document', () => {
  const pages = [{ id: 'a' }, { id: 'orig' }, { id: 'draft' }, { id: 'z' }];
  const none = excludeTransientPages(pages, 2, new Set());

  assert.equal(none.pages, pages, 'nothing transient = same array (keeps the autosave diff cheap)');

  const onDraft = excludeTransientPages(pages, 2, new Set(['draft']));

  assert.deepEqual(onDraft.pages.map((page) => page.id), ['a', 'orig', 'z']);
  assert.equal(onDraft.currentIndex, 1, 'standing on the draft persists the original as current');
  assert.equal(onDraft.pages[0], pages[0], 'page identity survives (page-only saves diff by reference)');

  assert.equal(excludeTransientPages(pages, 3, new Set(['draft'])).currentIndex, 2);
  assert.equal(excludeTransientPages(pages, 0, new Set(['draft'])).currentIndex, 0);
  assert.equal(excludeTransientPages([{ id: 'draft' }, { id: 'b' }], 0, new Set(['draft'])).currentIndex, 0);
});
