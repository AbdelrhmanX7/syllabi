import test from 'node:test';
import assert from 'node:assert/strict';

import { isPenTwinTouchContact } from '../src/pen-twin-touch';

// Mirrors the live guard's constants: PEN_TIP_MAX_CONTACT_RADIUS = 8, PEN_TWIN_MAX_DISTANCE_PX = 64.
const OPTS = { maxRadius: 8, maxDistance: 64 };
const PEN = { x: 500, y: 400 };

test('tiny positive radius is the pen tip → passes (even with no pen point yet, raced touchstart)', () => {
  assert.equal(isPenTwinTouchContact({ radiusX: 4, radiusY: 4, clientX: 999, clientY: 999 }, null, OPTS), true);
});

test('radius exactly at the tip ceiling still passes', () => {
  assert.equal(isPenTwinTouchContact({ radiusX: 8, radiusY: 0, clientX: 999, clientY: 999 }, null, OPTS), true);
});

test('unknown radius (0) NEAR the live pen → passes (bias-to-pen: could be the pen twin)', () => {
  assert.equal(
    isPenTwinTouchContact({ radiusX: 0, radiusY: 0, clientX: PEN.x + 10, clientY: PEN.y + 10 }, PEN, OPTS),
    true,
  );
});

test('unknown radius (0) FAR from the pen → fails (a finger/palm away from the tip)', () => {
  assert.equal(
    isPenTwinTouchContact({ radiusX: 0, radiusY: 0, clientX: PEN.x + 150, clientY: PEN.y + 150 }, PEN, OPTS),
    false,
  );
});

test('unknown radius (0) with NO pen point → fails (nothing to match against)', () => {
  assert.equal(isPenTwinTouchContact({ radiusX: 0, radiusY: 0, clientX: 100, clientY: 100 }, null, OPTS), false);
});

test('moderate radius (between tip and 2× tip) NEAR the pen → passes (plausible fat pen contact)', () => {
  // 12 is > maxRadius (8) but <= 2× maxRadius (16): ambiguous, so proximity decides.
  assert.equal(
    isPenTwinTouchContact({ radiusX: 12, radiusY: 12, clientX: PEN.x + 5, clientY: PEN.y + 5 }, PEN, OPTS),
    true,
  );
});

test('moderate radius FAR from the pen → fails (a small finger away from the tip)', () => {
  assert.equal(
    isPenTwinTouchContact({ radiusX: 12, radiusY: 12, clientX: PEN.x + 200, clientY: PEN.y }, PEN, OPTS),
    false,
  );
});

test('LARGE radius (> 2× tip) NEAR the pen → FAILS (palm heel can rest against the pen hand)', () => {
  // The safety property: a definitively large contact is a palm — proximity must NOT rescue it.
  assert.equal(
    isPenTwinTouchContact({ radiusX: 40, radiusY: 40, clientX: PEN.x + 3, clientY: PEN.y + 3 }, PEN, OPTS),
    false,
  );
});

test('LARGE radius FAR from the pen → fails', () => {
  assert.equal(
    isPenTwinTouchContact({ radiusX: 40, radiusY: 40, clientX: PEN.x + 300, clientY: PEN.y + 300 }, PEN, OPTS),
    false,
  );
});

test('no pen point + large radius → fails (a finger on a pen device must not ink)', () => {
  assert.equal(isPenTwinTouchContact({ radiusX: 30, radiusY: 30, clientX: 100, clientY: 100 }, null, OPTS), false);
});

test('distance is radial: within maxDistance on the diagonal passes, just outside fails', () => {
  // ~45px each axis → hypot ≈ 63.6 < 64 → passes.
  assert.equal(
    isPenTwinTouchContact({ radiusX: 0, radiusY: 0, clientX: PEN.x + 45, clientY: PEN.y + 45 }, PEN, OPTS),
    true,
  );
  // ~46px each axis → hypot ≈ 65.1 > 64 → fails.
  assert.equal(
    isPenTwinTouchContact({ radiusX: 0, radiusY: 0, clientX: PEN.x + 46, clientY: PEN.y + 46 }, PEN, OPTS),
    false,
  );
});

test('undefined radii treated as 0 (unknown) → proximity decides', () => {
  assert.equal(isPenTwinTouchContact({ clientX: PEN.x, clientY: PEN.y }, PEN, OPTS), true);
  assert.equal(isPenTwinTouchContact({ clientX: PEN.x + 500, clientY: PEN.y }, PEN, OPTS), false);
});

// --- Touch.touchType (Touch Events L2) is AUTHORITATIVE when the browser reports it -----------------
//
// The Android "a finger leaves a dot" bug: some panels report a finger's radius tiny or 0, so it passed
// the radius rule as a "pen tip" and Fabric opened a stroke before the pan ever activated. When the
// browser says what the contact IS, no footprint guess may override it.
test("touchType 'direct' is a finger even with a tip-sized radius → fails", () => {
  assert.equal(
    isPenTwinTouchContact({ touchType: 'direct', radiusX: 3, radiusY: 3, clientX: 100, clientY: 100 }, null, OPTS),
    false,
  );
});

test("touchType 'direct' is a finger even right next to the live pen with unknown radius → fails", () => {
  assert.equal(
    isPenTwinTouchContact(
      { touchType: 'direct', radiusX: 0, radiusY: 0, clientX: PEN.x + 2, clientY: PEN.y + 2 },
      PEN,
      OPTS,
    ),
    false,
  );
});

test("touchType 'stylus' is the pen even with a palm-sized radius far from any pen point → passes", () => {
  assert.equal(
    isPenTwinTouchContact({ touchType: 'stylus', radiusX: 40, radiusY: 40, clientX: 999, clientY: 999 }, null, OPTS),
    true,
  );
});

test('an absent or empty touchType falls back to the radius/proximity heuristics unchanged', () => {
  assert.equal(isPenTwinTouchContact({ touchType: '', radiusX: 4, radiusY: 4, clientX: 999, clientY: 999 }, null, OPTS), true);
  assert.equal(
    isPenTwinTouchContact({ touchType: undefined, radiusX: 40, radiusY: 40, clientX: 999, clientY: 999 }, null, OPTS),
    false,
  );
});

// --- isPenTwinTouchStart: POSITIVE identification of the pen's own touch contact ---------------------
//
// Blink dispatches a contact's `pointerdown` ('pen' for the stylus) BEFORE its `touchstart`, in the same
// task, at the same position. A touchstart is the pen's twin iff such a pen-down is live, fresh, and
// there. Everything else — including a palm whose radius reads like a pen tip (the Samsung tablet) — is
// starved from Fabric on a pen device.

import { isPenTwinTouchStart } from '../src/pen-twin-touch';

const TWIN = { maxDistance: 24, maxWindowMs: 150 };

test('a touchstart right after the pen pointerdown, at its position, is the twin', () => {
  const penDown = { x: 100.4, y: 200.6, at: 1_000 };

  assert.equal(isPenTwinTouchStart({ clientX: 100, clientY: 201 }, penDown, 1_001, TWIN), true);
  assert.equal(isPenTwinTouchStart({ clientX: 120, clientY: 220 }, penDown, 1_050, TWIN), true, 'within tolerance');
});

test('a contact far from the pen-down is not the twin, however fresh', () => {
  const penDown = { x: 100, y: 200, at: 1_000 };

  assert.equal(isPenTwinTouchStart({ clientX: 400, clientY: 300 }, penDown, 1_001, TWIN), false);
  assert.equal(isPenTwinTouchStart({ clientX: 125, clientY: 200 }, penDown, 1_001, TWIN), false, 'one px past tolerance');
});

test('a contact that lands near the pen long after it went down is a finger, not the twin', () => {
  // The twin touchstart is dispatched in the same task as the pen-down; a contact that arrives later is a
  // second contact (a finger landing next to the tip mid-stroke).
  const penDown = { x: 100, y: 200, at: 1_000 };

  assert.equal(isPenTwinTouchStart({ clientX: 100, clientY: 200 }, penDown, 1_000 + TWIN.maxWindowMs, TWIN), true);
  assert.equal(isPenTwinTouchStart({ clientX: 100, clientY: 200 }, penDown, 1_000 + TWIN.maxWindowMs + 1, TWIN), false);
});

test('with no pen down nothing is the twin — a tip-sized palm contact is starved', () => {
  assert.equal(isPenTwinTouchStart({ clientX: 100, clientY: 200 }, null, 1_000, TWIN), false);
});
