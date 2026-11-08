import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  READ_TIMEOUT_MESSAGE,
  addToTally,
  annotateSteps,
  attemptErrorMessage,
  emptyTally,
  formatClock,
  isDue,
  nextDueLabel,
  normalizeStep,
  pct,
  stepMarkdown,
} from './verdict';

const step = (line: number, ok: boolean, note = '') => ({ line, ok, note, latex: `s${line}` });

test('annotateSteps: all ok → all ok', () => {
  const out = annotateSteps({ steps: [step(1, true), step(2, true)], firstErrorStep: null });

  assert.deepEqual(
    out.map((s) => s.status),
    ['ok', 'ok'],
  );
});

test('annotateSteps: first error highlighted, later steps dimmed as `after`, earlier stay ok', () => {
  const out = annotateSteps({
    steps: [step(1, true), step(2, false, 'sign'), step(3, true), step(4, false)],
    firstErrorStep: 2,
  });

  assert.deepEqual(
    out.map((s) => s.status),
    ['ok', 'error', 'ok', 'after'],
  );
});

test('annotateSteps: earliest ok:false wins over a later firstErrorStep, and unsorted input is sorted', () => {
  const out = annotateSteps({ steps: [step(3, false), step(1, true), step(2, false)], firstErrorStep: 3 });

  assert.deepEqual(
    out.map((s) => [s.line, s.status]),
    [
      [1, 'ok'],
      [2, 'error'],
      [3, 'after'],
    ],
  );
});

test('annotateSteps: firstErrorStep without a flagged step still marks that line', () => {
  const out = annotateSteps({ steps: [step(1, true), step(2, true)], firstErrorStep: 2 });

  assert.deepEqual(
    out.map((s) => s.status),
    ['ok', 'error'],
  );
});

test('nextDueLabel buckets', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();

  assert.equal(nextDueLabel(at(-5000), now), 'due now');
  assert.equal(nextDueLabel(at(30 * 60_000), now), 'in 30 min');
  assert.equal(nextDueLabel(at(5 * 3_600_000), now), 'in 5 h');
  assert.equal(nextDueLabel(at(26 * 3_600_000), now), 'tomorrow');
  assert.equal(nextDueLabel(at(12 * 86_400_000), now), 'in 12 days');
  assert.equal(nextDueLabel(at(35 * 86_400_000), now), 'in a month');
  assert.equal(nextDueLabel(at(100 * 86_400_000), now), 'in 3 months');
  assert.equal(nextDueLabel('garbage', now), 'scheduled');
  assert.ok(isDue(at(-1), now));
  assert.ok(!isDue(at(1000), now));
});

test('tally + clock + pct', () => {
  let tally = emptyTally();

  tally = addToTally(tally, 'right', 1000);
  tally = addToTally(tally, 'wrong', 2000);
  tally = addToTally(tally, 'right', 500);
  assert.deepEqual(tally, { right: 2, wrong: 1, partial: 0, total: 3, timeMs: 3500 });
  assert.equal(formatClock(65_000), '1:05');
  assert.equal(formatClock(-5), '0:00');
  assert.equal(pct(0.456), 46);
  assert.equal(pct(2), 100);
});

test('stepMarkdown: prose stays text, math is wrapped, markdown with $ is left alone', () => {
  assert.equal(stepMarkdown('The function cannot modify the object;'), 'The function cannot modify the object;');
  assert.equal(stepMarkdown('`bump` modifies a copy; `v` unchanged.'), '`bump` modifies a copy; `v` unchanged.');
  assert.equal(stepMarkdown('2x e^{x} + x^2 e^{x}'), '$2x e^{x} + x^2 e^{x}$');
  assert.equal(stepMarkdown('v = 5'), '$v = 5$');
  assert.equal(stepMarkdown('\\frac{d}{dx} x^2 = 2x'), '$\\frac{d}{dx} x^2 = 2x$');
  assert.equal(stepMarkdown('so $x = 2$ here'), 'so $x = 2$ here');
});

test('normalizeStep: v2 {index, text, latex|null} keeps prose and formula apart', () => {
  assert.deepEqual(
    normalizeStep({ index: 2, text: 'Differentiate both sides', latex: '2x = y', ok: true, note: null }, 9),
    {
      line: 2,
      text: 'Differentiate both sides',
      latex: '2x = y',
      ok: true,
      note: '',
    },
  );
  assert.deepEqual(normalizeStep({ index: 0, text: 'Plain reasoning', latex: null, ok: false, note: 'sign' }, 0), {
    line: 0,
    text: 'Plain reasoning',
    latex: null,
    ok: false,
    note: 'sign',
  });
  assert.equal(normalizeStep({ index: 1, text: '', latex: '   ', ok: true }, 0).latex, null, 'blank latex → null');
});

test('normalizeStep: v1 {line, latex} routes prose to text and TeX to inline math, never a display block', () => {
  assert.deepEqual(normalizeStep({ line: 3, latex: 'The function cannot modify the object', ok: true, note: '' }, 0), {
    line: 3,
    text: 'The function cannot modify the object',
    latex: null,
    ok: true,
    note: '',
  });
  assert.equal(normalizeStep({ line: 1, latex: 'v = 5', ok: true, note: '' }, 0).text, '$v = 5$');
  assert.equal(normalizeStep({ line: Number.NaN, latex: 'x', ok: true, note: '' }, 4).line, 4, 'bad line → position');
});

test('annotateSteps accepts the v2 shape: index orders, firstErrorStep is an index', () => {
  const out = annotateSteps({
    steps: [
      { index: 1, text: 'b', latex: null, ok: true },
      { index: 0, text: 'a', latex: 'a=1', ok: true },
      { index: 2, text: 'c', latex: null, ok: true },
    ],
    firstErrorStep: 1,
  });

  assert.deepEqual(
    out.map((s) => [s.line, s.text, s.status]),
    [
      [0, 'a', 'ok'],
      [1, 'b', 'error'],
      [2, 'c', 'ok'],
    ],
  );
  assert.equal(out[0]!.latex, 'a=1');
});

test('attemptErrorMessage: READ_TIMEOUT gets the friendly line + retry, anything else passes through', () => {
  const timeout = Object.assign(new Error('read timed out'), { code: 'READ_TIMEOUT' });

  assert.deepEqual(attemptErrorMessage(timeout), { message: READ_TIMEOUT_MESSAGE, retry: true });
  assert.deepEqual(attemptErrorMessage(new Error('boom')), { message: 'boom', retry: false });
  assert.deepEqual(attemptErrorMessage('plain'), { message: 'plain', retry: false });
  assert.deepEqual(attemptErrorMessage(null), { message: 'Something went wrong', retry: false });
});
