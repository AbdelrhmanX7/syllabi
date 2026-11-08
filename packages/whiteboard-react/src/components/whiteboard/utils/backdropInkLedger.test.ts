import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInkLedger, sceneRectToBackdropPixels, type SceneRect } from './backdropInkLedger';

const entry = (object: object, r: SceneRect) => [object, r] as const;
const rect = (left: number, top: number, width = 10, height = 10): SceneRect => ({ height, left, top, width });

test('a removed object yields the rect it was DRAWN at, once', () => {
  const ledger = createInkLedger<object>();
  const a = {};
  const b = {};

  ledger.reset([entry(a, rect(0, 0)), entry(b, rect(100, 50))]);

  assert.deepEqual(ledger.onRemoved(b), rect(100, 50));
  assert.equal(ledger.onRemoved(b), null);
  assert.equal(ledger.size(), 1);
});

test('an object added after the last build was never drawn: removing it clears nothing', () => {
  const ledger = createInkLedger<object>();

  ledger.reset([entry({}, rect(0, 0))]);
  assert.equal(ledger.onRemoved({}), null);
});

test('a modified object (moved) clears its OLD rect and is forgotten', () => {
  const ledger = createInkLedger<object>();
  const moved = {};
  const other = {};

  ledger.reset([entry(moved, rect(10, 10)), entry(other, rect(500, 500))]);

  assert.deepEqual(ledger.onModified([moved]), [rect(10, 10)]);
  assert.deepEqual(ledger.onModified([moved]), []);
  assert.equal(ledger.size(), 1);
});

test('a multi-selection modification clears every drawn member', () => {
  const ledger = createInkLedger<object>();
  const a = {};
  const b = {};
  const fresh = {};

  ledger.reset([entry(a, rect(0, 0)), entry(b, rect(40, 40))]);

  assert.deepEqual(ledger.onModified([a, fresh, b]), [rect(0, 0), rect(40, 40)]);
});

test('only an ERASING stroke being added clears anything — its own current rect', () => {
  const ledger = createInkLedger<object>();

  assert.deepEqual(ledger.onAdded({}, true, rect(5, 5, 30, 4)), rect(5, 5, 30, 4));
  assert.equal(ledger.onAdded({}, false, rect(5, 5)), null);
  assert.equal(ledger.onAdded({}, true, null), null);
});

test('clear() forgets everything (layer hidden on page switch / undo restore)', () => {
  const ledger = createInkLedger<object>();
  const a = {};

  ledger.reset([entry(a, rect(0, 0))]);
  ledger.clear();
  assert.equal(ledger.onRemoved(a), null);
  assert.equal(ledger.size(), 0);
});

test('scene → backdrop pixels: scaled, offset, grown by the margin, snapped outward', () => {
  const px = sceneRectToBackdropPixels(
    rect(100, 50, 20, 10),
    { originX: -400, originY: -200, pixelHeight: 1000, pixelWidth: 1000, scale: 0.5 },
    2,
  );

  assert.deepEqual(px, { height: 9, width: 14, x: 248, y: 123 });
});

test('scene → backdrop pixels: clamped to the canvas, null when fully outside', () => {
  const mapping = { originX: 0, originY: 0, pixelHeight: 100, pixelWidth: 100, scale: 1 };

  assert.deepEqual(sceneRectToBackdropPixels(rect(-5, 90, 20, 50), mapping, 0), { height: 10, width: 15, x: 0, y: 90 });
  assert.equal(sceneRectToBackdropPixels(rect(200, 0), mapping, 3), null);
  assert.equal(sceneRectToBackdropPixels(rect(Number.NaN, 0), mapping, 3), null);
});
