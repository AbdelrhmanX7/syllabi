import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ContactRecorder,
  markContactsUndone,
  MAX_FRAMES_PER_CONTACT,
  scoreContactPriority,
  UNDO_ATTRIBUTION_WINDOW_MS,
  UNDO_PRIORITY_WEIGHT,
  type CapturedContact,
  type CapturedFrame,
} from '../src/contact-capture';
import { createContactState, updateContactState, type DualTipConfig } from '../src/dual-tip-contact';

const CONFIG: DualTipConfig = { smallHeadMaxWidth: 5, bigHeadMaxWidth: 10, fingerMinWidth: 11 };

const recorder = () => {
  let counter = 0;

  return new ContactRecorder({ newId: () => `c${++counter}` });
};

const frame = (overrides: Partial<CapturedFrame> = {}): CapturedFrame => ({
  t: 0,
  w: 6,
  h: 9,
  x: 100,
  y: 100,
  pressure: 0.5,
  tiltX: 0,
  tiltY: 0,
  twist: 0,
  coalesced: false,
  ...overrides,
});

const context = {
  startedAt: 1_755_600_000_000,
  pointerType: 'touch',
  palmRejectActive: false,
  activeTool: 'pen',
  effectiveTool: 'pen',
};

/** Drive frames through the REAL classifier, exactly as the board does, and record each result. */
function record(rec: ContactRecorder, pointerId: number, frames: CapturedFrame[]) {
  let state = createContactState();
  const [first] = frames;

  for (const f of frames) {
    state = updateContactState(
      state,
      { width: f.w, height: f.h, travelPx: Math.hypot(f.x - first.x, f.y - first.y), elapsedMs: f.t },
      CONFIG,
    );
    rec.frame(pointerId, f, state);
  }
}

test('a contact carries its frames, its duration and what the board decided', () => {
  const rec = recorder();

  rec.begin(1, context);
  record(rec, 1, [frame({ t: 0 }), frame({ t: 25 }), frame({ t: 60, x: 140 })]);

  const contact = rec.end(1);

  assert.ok(contact);
  assert.equal(contact.frames.length, 3);
  assert.equal(contact.durationMs, 60);
  assert.equal(contact.pointerType, 'touch');
  // 6px minor axis, under the finger threshold → it writes, in the big head's colour (above small).
  assert.equal(contact.decision.routing, false);
  assert.equal(contact.decision.head, 'big');
  assert.equal(contact.decision.colourRole, 'secondary');
});

test('WHEN a verdict latched is recorded, not just what it was', () => {
  const rec = recorder();

  rec.begin(1, context);
  // A placeholder frame first, then real ones. The verdict waits for the settle window (50ms) — it is
  // deliberately NOT taken on the touch-down frame, which is the most tilt-corrupted reading there is.
  record(rec, 1, [frame({ t: 0, w: 1, h: 1 }), frame({ t: 16 }), frame({ t: 60 })]);

  const contact = rec.end(1);

  assert.equal(contact?.decision.routingLatchedFrame, 2, 'not the touch-down frame');
  assert.equal(contact?.decision.routingLatchedAtMs, 60);
  // A verdict taken on the touch-down frame is the known failure mode, so this pair is the point of
  // the capture: a trainer can ask "what was knowable by the frame the board committed?"
  assert.equal(contact?.decision.colourLockedAtMs, 60);
});

test('the routing verdict is recorded as first latched, never overwritten later', () => {
  const rec = recorder();

  rec.begin(1, context);
  // A fat frame after the verdict has already latched on a thin one. The board acts on the FIRST
  // verdict, so that is the one a training row must carry.
  record(rec, 1, [frame({ t: 0, w: 6, h: 9 }), frame({ t: 60, w: 6, h: 9 }), frame({ t: 80, w: 14, h: 16 })]);

  assert.equal(rec.end(1)?.decision.routing, false);
});

test('marks record that a contact actually panned', () => {
  const rec = recorder();

  rec.begin(1, context);
  record(rec, 1, [frame({ w: 15, h: 16 })]);
  rec.mark(1, 'panStarted');

  assert.equal(rec.end(1)?.decision.panStarted, true);
});

test('a dropped pointerup does not leak the contact — the next down returns it', () => {
  const rec = recorder();

  rec.begin(1, context);
  record(rec, 1, [frame()]);

  // The OS drops the release (routine on this hardware) and the same pointer id lands again.
  const abandoned = rec.begin(1, context);

  assert.equal(abandoned?.contactId, 'c1', 'the abandoned contact is handed back, not dropped');
  assert.equal(rec.openCount, 1);
  assert.equal(rec.end(1)?.contactId, 'c2');
});

test('frames are capped, but the frame index of a verdict stays truthful', () => {
  const rec = recorder();

  rec.begin(1, context);
  record(
    rec,
    1,
    Array.from({ length: MAX_FRAMES_PER_CONTACT + 50 }, (_unused, index) => frame({ t: index * 8 })),
  );

  const contact = rec.end(1);

  assert.equal(contact?.frames.length, MAX_FRAMES_PER_CONTACT, 'a contact resting on the glass cannot grow forever');
  assert.equal(contact?.durationMs, (MAX_FRAMES_PER_CONTACT + 49) * 8, 'time keeps running past the cap');
});

test('endAll closes every open contact (unmount, or the self-heal reaper)', () => {
  const rec = recorder();

  rec.begin(1, context);
  rec.begin(2, context);
  record(rec, 1, [frame()]);
  record(rec, 2, [frame()]);

  assert.equal(rec.endAll().length, 2);
  assert.equal(rec.openCount, 0);
  assert.equal(rec.endAll().length, 0);
});

test('ending an unknown pointer is a no-op, not a crash', () => {
  assert.equal(recorder().end(99), null);
});

test('priority puts an undone contact above a disagreement above a marginal size', () => {
  const bands = { smallHeadMaxWidth: 5, bigHeadMaxWidth: 10, fingerMinWidth: 11 };
  const base = { head: 'big' as const, routing: false, size: 8, bands };

  const undone = scoreContactPriority({ ...base, undoFollowed: true });
  const disagreed = scoreContactPriority({ ...base, altHead: 'small' });
  const marginal = scoreContactPriority({ ...base, size: 5 });
  const obvious = scoreContactPriority({ ...base, size: 8 });

  assert.ok(undone.score > disagreed.score);
  assert.ok(disagreed.score > marginal.score);
  assert.ok(marginal.score > obvious.score, 'a size sitting on a band edge outranks one mid-band');
  assert.equal(disagreed.rulebookDisagrees, true);
  assert.equal(obvious.rulebookDisagrees, false);
});

test('priority: a routing disagreement counts even when the heads match', () => {
  const bands = { smallHeadMaxWidth: 5, bigHeadMaxWidth: 10, fingerMinWidth: 11 };

  // The same head, but one rulebook would have sent it to pan — the lost-ink case, top of the pile.
  const verdict = scoreContactPriority({ head: 'big', altHead: 'big', routing: false, altRouting: true, size: 8, bands });

  assert.equal(verdict.rulebookDisagrees, true);
});

test('priority: a contact that never resolved is not worth reviewing', () => {
  const bands = { smallHeadMaxWidth: 5, bigHeadMaxWidth: 10, fingerMinWidth: 11 };

  assert.equal(scoreContactPriority({ head: null, routing: null, size: 0, bands }).score, 0);
});

// --- Retro-marking an undo -------------------------------------------------------------------
// The undo signal always arrives after the contact is sealed, so these cover the reach-back.

const NOW = 1_755_600_100_000;

/** A finished contact, built through the REAL recorder so its startedAt/durationMs are honest. */
function finished(
  options: { endedAgoMs: number; durationMs?: number; width?: number; pan?: boolean } = { endedAgoMs: 0 },
): CapturedContact {
  const durationMs = options.durationMs ?? 80;
  const startedAt = NOW - options.endedAgoMs - durationMs;
  const width = options.width ?? 6;
  const rec = recorder();

  rec.begin(1, { ...context, startedAt });
  record(rec, 1, [frame({ t: 0, w: width, h: width + 3 }), frame({ t: durationMs, w: width, h: width + 3 })]);

  if (options.pan) rec.mark(1, 'panStarted');

  const contact = rec.end(1);

  assert.ok(contact);

  return contact;
}

test('an undo right after a contact promotes it to the top of the review queue', () => {
  const contact = finished({ endedAgoMs: 400 });

  assert.equal(markContactsUndone([contact], NOW), 1);
  assert.equal(contact.priority?.undoFollowed, true);
  assert.equal(contact.priority?.score, UNDO_PRIORITY_WEIGHT, 'the maximum an automatic signal can award');
  assert.equal(contact.priority?.undoneAtMs, NOW);
});

test('the undo bump stacks on top of a score the board already gave the contact', () => {
  const bands = { smallHeadMaxWidth: 5, bigHeadMaxWidth: 10, fingerMinWidth: 11 };
  const contact = finished({ endedAgoMs: 100 });

  // Scored live at capture time — the rulebooks had already disagreed about this one.
  contact.priority = scoreContactPriority({ head: 'big', altHead: 'small', routing: false, size: 8, bands });

  const before = contact.priority.score;

  markContactsUndone([contact], NOW);

  assert.equal(contact.priority?.score, before + UNDO_PRIORITY_WEIGHT);
  assert.equal(contact.priority?.rulebookDisagrees, true, 'the signals it already carried survive');
});

test('an undo long after the stroke is about something else and is not credited to it', () => {
  const contact = finished({ endedAgoMs: UNDO_ATTRIBUTION_WINDOW_MS + 1 });

  assert.equal(markContactsUndone([contact], NOW), 0);
  assert.equal(contact.priority, undefined);
});

test('a contact that panned is never credited with an undo — it put no ink on the page', () => {
  const contact = finished({ endedAgoMs: 200, width: 15, pan: true });

  assert.equal(markContactsUndone([contact], NOW), 0);
});

test('a contact routed to navigate is never credited with an undo', () => {
  // A wide contact the classifier sent to pan: undo could not have removed anything it left.
  const contact = finished({ endedAgoMs: 200, width: 20, durationMs: 200 });

  assert.equal(contact.decision.routing, true, 'guard: this fixture must actually have been routed to pan');
  assert.equal(markContactsUndone([contact], NOW), 0);
});

test('a whole page of recent strokes is marked, not just the last one to lift', () => {
  // One stroke arrives as several contacts here (dropped pointerups, the stylus re-landing), so
  // crediting only the last would routinely miss the contact the teacher actually rejected.
  const contacts = [finished({ endedAgoMs: 1_800 }), finished({ endedAgoMs: 900 }), finished({ endedAgoMs: 50 })];

  assert.equal(markContactsUndone(contacts, NOW), 3);
});

test('a second undo does not stack another bump, and the first timestamp is the one kept', () => {
  const contact = finished({ endedAgoMs: 300 });

  markContactsUndone([contact], NOW);
  markContactsUndone([contact], NOW + 500);

  assert.equal(contact.priority?.score, UNDO_PRIORITY_WEIGHT, 'idempotent — a redo/undo dance cannot inflate a row');
  assert.equal(contact.priority?.undoneAtMs, NOW, 'the prompt undo is the informative one');
});

test('an undo pressed before the contact ended is not attributed to it', () => {
  const contact = finished({ endedAgoMs: -500 });

  assert.equal(markContactsUndone([contact], NOW), 0, 'nothing to reject yet');
});
