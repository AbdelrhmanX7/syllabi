import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PEN_BUTTON_GESTURE_IDLE,
  PEN_BUTTON_LONG_PRESS_MS,
  stepPenButtonGesture,
  type PenButtonGestureInput,
  type PenButtonGestureState,
} from './penButtonGesture';

function run(inputs: PenButtonGestureInput[], state: PenButtonGestureState = PEN_BUTTON_GESTURE_IDLE) {
  const effects: string[] = [];
  let current = state;

  for (const input of inputs) {
    const step = stepPenButtonGesture(current, input);

    current = step.state;
    effects.push(...step.effects);
  }

  return { state: current, effects };
}

test('short hover press fires on RELEASE, never on press', () => {
  const press = stepPenButtonGesture(PEN_BUTTON_GESTURE_IDLE, { type: 'press', contact: false, now: 0 });

  assert.deepEqual(press.effects, []);
  assert.equal(press.tickIn, PEN_BUTTON_LONG_PRESS_MS);
  assert.deepEqual(
    run([
      { type: 'press', contact: false, now: 0 },
      { type: 'release', now: 200 },
    ]).effects,
    ['short-hover'],
  );
});

test('long hover press fires AT the threshold; its release ends the hold', () => {
  const result = run([
    { type: 'press', contact: false, now: 0 },
    { type: 'tick', now: 449 },
    { type: 'tick', now: 450 },
    { type: 'release', now: 900 },
  ]);

  assert.deepEqual(result.effects, ['long-hover', 'long-hover-end']);
  assert.deepEqual(result.state, PEN_BUTTON_GESTURE_IDLE);
  // An early tick asks to be called back for the rest.
  assert.equal(stepPenButtonGesture({ phase: 'hover-pressed', at: 0 }, { type: 'tick', now: 300 }).tickIn, 150);
});

test('a late timer never turns a long hold into a short press', () => {
  assert.deepEqual(
    run([
      { type: 'press', contact: false, now: 0 },
      { type: 'release', now: 700 },
    ]).effects,
    ['long-hover', 'long-hover-end'],
  );
});

test('pressed on the glass: contact hold from press to release', () => {
  assert.deepEqual(
    run([
      { type: 'press', contact: true, now: 0 },
      { type: 'tick', now: 600 },
      { type: 'contact-start', now: 700 },
      { type: 'release', now: 900 },
    ]).effects,
    ['contact-start', 'contact-end'],
  );
});

test('pressed in the air then put down: the pending hover gesture is cancelled and becomes a contact hold', () => {
  assert.deepEqual(
    run([
      { type: 'press', contact: false, now: 0 },
      { type: 'contact-start', now: 100 },
      { type: 'tick', now: 450 },
      { type: 'release', now: 900 },
    ]).effects,
    ['contact-start', 'contact-end'],
  );
  // Even after the long-press already fired in the air.
  assert.deepEqual(
    run([
      { type: 'press', contact: false, now: 0 },
      { type: 'tick', now: 450 },
      { type: 'contact-start', now: 600 },
      { type: 'release', now: 900 },
    ]).effects,
    ['long-hover', 'long-hover-end', 'contact-start', 'contact-end'],
  );
});

test('duplicates and strays are ignored', () => {
  assert.deepEqual(
    run([
      { type: 'release', now: 0 },
      { type: 'contact-start', now: 1 },
      { type: 'tick', now: 2 },
    ]).effects,
    [],
  );
  assert.deepEqual(
    run([
      { type: 'press', contact: true, now: 0 },
      { type: 'press', contact: false, now: 10 },
      { type: 'release', now: 20 },
    ]).effects,
    ['contact-start', 'contact-end'],
  );
});

// Owner default (2026-10-04): the in-air long press does nothing, so there is no timer at all.
const noLong = { longPress: false };

function runNoLong(inputs: PenButtonGestureInput[]) {
  const effects: string[] = [];
  let current: PenButtonGestureState = PEN_BUTTON_GESTURE_IDLE;

  for (const input of inputs) {
    const step = stepPenButtonGesture(current, input, noLong);

    assert.equal(step.tickIn, null, 'no long-press timer when the long action is «Nothing»');
    current = step.state;
    effects.push(...step.effects);
  }

  return effects;
}

test('long press = «Nothing»: press in the air and release opens the menu however long it was held', () => {
  assert.deepEqual(
    runNoLong([
      { type: 'press', contact: false, now: 0 },
      { type: 'release', now: 120 },
    ]),
    ['short-hover'],
  );
  assert.deepEqual(
    runNoLong([
      { type: 'press', contact: false, now: 0 },
      { type: 'tick', now: 450 },
      { type: 'release', now: 3000 },
    ]),
    ['short-hover'],
  );
});

test('long press = «Nothing»: held in the air then touching is the eraser hold; the release never opens the menu', () => {
  assert.deepEqual(
    runNoLong([
      { type: 'press', contact: false, now: 0 },
      { type: 'contact-start', now: 900 },
      { type: 'release', now: 2000 },
    ]),
    ['contact-start', 'contact-end'],
  );
  assert.deepEqual(
    runNoLong([
      { type: 'press', contact: true, now: 0 },
      { type: 'release', now: 2000 },
    ]),
    ['contact-start', 'contact-end'],
  );
});

// The native touch-down MainActivity now forwards (button already held) is a `contact-start` like a DOM
// pen-down: it promotes the air press, so the release is the end of the eraser hold, never a menu.
test('a native touch-down with the button held promotes the air press; touch-up alone changes nothing', () => {
  const pressed = stepPenButtonGesture(PEN_BUTTON_GESTURE_IDLE, { type: 'press', contact: false, now: 0 }, noLong);
  const landed = stepPenButtonGesture(pressed.state, { type: 'contact-start', now: 300 }, noLong);

  assert.deepEqual(landed.effects, ['contact-start']);
  assert.equal(landed.state.phase, 'contact-held');
  // Lifting the pen (no input) keeps the hold until the button itself is released.
  assert.deepEqual(stepPenButtonGesture(landed.state, { type: 'release', now: 900 }, noLong).effects, ['contact-end']);
});
