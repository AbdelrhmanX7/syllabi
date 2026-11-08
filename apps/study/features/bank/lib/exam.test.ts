import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LATE_GRACE_MS,
  answeredCount,
  draftAnswered,
  examDeadline,
  examState,
  isResumable,
  scoreFraction,
} from './exam';

test('scoreFraction: 0–100 and 0..1 both land on 0..1, clamped, null → 0', () => {
  assert.equal(scoreFraction(72.5), 0.725);
  assert.equal(scoreFraction(100), 1);
  assert.equal(scoreFraction(0.4), 0.4);
  assert.equal(scoreFraction(0), 0);
  assert.equal(scoreFraction(null), 0);
  assert.equal(scoreFraction(undefined), 0);
  assert.equal(scoreFraction(250), 1);
  assert.equal(scoreFraction(Number.NaN), 0);
});

test('examDeadline uses startedAt + minutes, falling back to now', () => {
  const start = Date.parse('2026-10-05T10:00:00Z');

  assert.equal(examDeadline('2026-10-05T10:00:00Z', 30), start + 30 * 60_000);
  assert.equal(examDeadline(null, 10, 1000), 1000 + 10 * 60_000);
  assert.equal(examDeadline('garbage', 10, 1000), 1000 + 10 * 60_000);
});

test('examState: open → late (grace) → expired; submitted wins', () => {
  const start = Date.parse('2026-10-05T10:00:00Z');
  const row = { startedAt: '2026-10-05T10:00:00Z', submittedAt: null, minutes: 30 };
  const end = start + 30 * 60_000;

  assert.equal(examState(row, start + 1000), 'open');
  assert.equal(examState(row, end), 'open');
  assert.equal(examState(row, end + 1000), 'late');
  assert.equal(examState(row, end + LATE_GRACE_MS), 'late');
  assert.equal(examState(row, end + LATE_GRACE_MS + 1), 'expired');
  assert.equal(examState({ ...row, submittedAt: '2026-10-05T10:20:00Z' }, start), 'submitted');
  assert.ok(isResumable('open') && isResumable('late'));
  assert.ok(!isResumable('expired') && !isResumable('submitted'));
});

test('answeredCount counts ink, typed or a choice, from a Map or a record', () => {
  const drafts = {
    a: { strokes: [{}], typed: '', choice: null },
    b: { strokes: [], typed: '  ', choice: null },
    c: { strokes: [], typed: 'x', choice: null },
    d: { strokes: [], typed: '', choice: 0 },
  };

  assert.equal(answeredCount(drafts), 3);
  assert.equal(answeredCount(new Map(Object.entries(drafts))), 3);
});

test('draftAnswered: matches and filled blanks count; empty ones and old drafts without them do not', () => {
  const base = { strokes: [], typed: '', choice: null };

  assert.equal(draftAnswered(base), false);
  assert.equal(draftAnswered(null), false);
  assert.equal(draftAnswered({ ...base, matches: {} }), false);
  assert.equal(draftAnswered({ ...base, matches: { a: 'x' } }), true);
  assert.equal(draftAnswered({ ...base, blanks: ['', ' '] }), false);
  assert.equal(draftAnswered({ ...base, blanks: ['', 'quartz'] }), true);
  assert.equal(answeredCount({ q1: { ...base, blanks: ['x'] }, q2: base }), 1);
});
