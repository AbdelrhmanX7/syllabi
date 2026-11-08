import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampMenuCenter,
  clampTriggerCenter,
  dragAnchor,
  getDefaultTriggerCenter,
  getQuickPenTriggerStorageKey,
  QUICK_PEN_TRIGGER_MARGIN,
  QUICK_PEN_TRIGGER_OUTER_EXTENT,
  resolveMenuCenterForAnchor,
  resolveTriggerCenter,
  fromViewportFraction,
  getDefaultMenuCenter,
  getQuickMenuSlots,
  getQuickMenuStorageKey,
  getRingSlotOffsets,
  getVisibleBounds,
  parseStoredFraction,
  QUICK_MENU_EXTENT,
  QUICK_MENU_ITEM_SIZE,
  QUICK_MENU_OUTER_EXTENT,
  QUICK_MENU_RING_RADIUS,
  QUICK_MENU_VIEWPORT_MARGIN,
  resolveMenuCenter,
  serializeFraction,
  toViewportFraction,
} from './quickGestureMenuLayout';

const EDGE = QUICK_MENU_OUTER_EXTENT + QUICK_MENU_VIEWPORT_MARGIN;

test('ring slots sit on the radius, evenly spaced, starting at 12 o\'clock by default', () => {
  const slots = getRingSlotOffsets(4, 10);

  assert.deepEqual(slots, [
    { x: 0, y: -10 },
    { x: 10, y: 0 },
    { x: 0, y: 10 },
    { x: -10, y: 0 },
  ]);
  for (const slot of getRingSlotOffsets(8, 72)) {
    assert.ok(Math.abs(Math.hypot(slot.x, slot.y) - 72) < 0.01);
  }
  assert.deepEqual(getRingSlotOffsets(0, 10), []);
});

test('adjacent ring slots never overlap their 44px touch targets', () => {
  const slots = getRingSlotOffsets(8, QUICK_MENU_RING_RADIUS);
  for (let index = 0; index < slots.length; index += 1) {
    const next = slots[(index + 1) % slots.length];
    const gap = Math.hypot(next.x - slots[index].x, next.y - slots[index].y);
    assert.ok(gap >= QUICK_MENU_ITEM_SIZE, `slots ${index}/${index + 1} are ${gap}px apart`);
  }
});

test('menu slots: width −/+ straddle the bottom, six colours fill the top arc left→right', () => {
  const { colors, decrease, increase } = getQuickMenuSlots();

  assert.equal(colors.length, 6);
  assert.ok(decrease.y > 0 && increase.y > 0, 'width buttons are below the hub');
  assert.ok(decrease.x < 0 && increase.x > 0, '− on the left, + on the right');
  assert.equal(Math.round(decrease.y), Math.round(increase.y));
  assert.equal(Math.round(decrease.x), -Math.round(increase.x));
  assert.ok(colors[0].x < 0 && colors[5].x > 0, 'colours run left to right');
  for (const color of colors) {
    assert.ok(color.y < decrease.y, 'every colour sits above the width buttons');
  }
});

test('clamp keeps the whole disc inside the viewport', () => {
  const viewport = { width: 800, height: 600 };

  assert.deepEqual(clampMenuCenter({ x: -50, y: -50 }, viewport), { x: EDGE, y: EDGE });
  assert.deepEqual(clampMenuCenter({ x: 5000, y: 5000 }, viewport), { x: 800 - EDGE, y: 600 - EDGE });
  assert.deepEqual(clampMenuCenter({ x: 400, y: 300 }, viewport), { x: 400, y: 300 });
});

test('clamp centres an axis that is too small to fit the menu', () => {
  assert.deepEqual(clampMenuCenter({ x: 10, y: 10 }, { width: 100, height: 900 }), { x: 50, y: EDGE });
});

test('default position is left edge, vertically centred', () => {
  assert.deepEqual(getDefaultMenuCenter({ width: 1280, height: 720 }), { x: EDGE, y: 360 });
});

test('storage key is per board with a shared fallback', () => {
  assert.equal(getQuickMenuStorageKey('board-1'), 'whiteboard:quick-pen-menu:position:board-1');
  assert.notEqual(getQuickMenuStorageKey('board-1'), getQuickMenuStorageKey('board-2'));
  assert.equal(getQuickMenuStorageKey(), 'whiteboard:quick-pen-menu:position:default');
  assert.equal(getQuickMenuStorageKey(''), getQuickMenuStorageKey(null));
});

test('fraction round-trip survives a serialize/parse cycle', () => {
  const viewport = { width: 1280, height: 800 };
  const center = { x: 640, y: 200 };
  const fraction = toViewportFraction(center, viewport);
  const parsed = parseStoredFraction(serializeFraction(fraction));

  assert.ok(parsed);
  assert.deepEqual(fromViewportFraction(parsed, viewport), center);
  assert.deepEqual(toViewportFraction(center, { width: 0, height: 0 }), { x: 0, y: 0 });
});

test('a saved spot follows the viewport through a rotation, clamped', () => {
  const landscape = { width: 1600, height: 900 };
  const portrait = { width: 900, height: 1600 };
  const raw = serializeFraction(toViewportFraction({ x: 1200, y: 450 }, landscape));

  assert.deepEqual(resolveMenuCenter(raw, landscape), { x: 1200, y: 450 });
  assert.deepEqual(resolveMenuCenter(raw, portrait), { x: 675, y: 800 });
  // Bottom-right corner fraction can't put the disc off-screen.
  assert.deepEqual(resolveMenuCenter(serializeFraction({ x: 1, y: 1 }), portrait), {
    x: 900 - EDGE,
    y: 1600 - EDGE,
  });
});

test('malformed stored values fall back to the default spot', () => {
  const viewport = { width: 1000, height: 700 };
  const fallback = getDefaultMenuCenter(viewport);

  for (const raw of [null, '', 'nope', '{}', '{"x":"1","y":0}', '{"x":2,"y":0.5}', 'null', '{"x":-0.1,"y":0.5}']) {
    assert.equal(parseStoredFraction(raw), null, `parse ${raw}`);
    assert.deepEqual(resolveMenuCenter(raw, viewport), fallback);
  }
});

test('outer extent covers the ring, the slots, the selected ring and the disc drop shadow', () => {
  // slot edge + ring-2 ring-offset-2 on the active swatch
  assert.ok(QUICK_MENU_RING_RADIUS + QUICK_MENU_ITEM_SIZE / 2 + 4 <= QUICK_MENU_EXTENT);
  // shadow-sk-xl drops 10px past the disc
  assert.ok(QUICK_MENU_OUTER_EXTENT >= QUICK_MENU_EXTENT + 10);
});

test('default spot keeps the whole menu, shadow included, inside the viewport with a margin', () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 800, height: 1280 },
    { width: 2560, height: 1600 },
  ]) {
    const center = getDefaultMenuCenter(viewport);
    assert.ok(center.x - QUICK_MENU_OUTER_EXTENT >= QUICK_MENU_VIEWPORT_MARGIN, `left edge in ${viewport.width}`);
    assert.ok(center.y - QUICK_MENU_OUTER_EXTENT >= QUICK_MENU_VIEWPORT_MARGIN);
    assert.ok(center.y + QUICK_MENU_OUTER_EXTENT <= viewport.height - QUICK_MENU_VIEWPORT_MARGIN);
  }
});

test('visible bounds trim a container that hangs off the window', () => {
  // container starts 12px left of the screen and is wider than the window
  assert.deepEqual(getVisibleBounds({ left: -12, top: 0, width: 1300, height: 800 }, { width: 1280, height: 800 }), {
    left: 12,
    top: 0,
    right: 1292,
    bottom: 800,
  });
  // fully on screen → the container itself
  assert.deepEqual(getVisibleBounds({ left: 0, top: 50, width: 1280, height: 700 }, { width: 1280, height: 800 }), {
    left: 0,
    top: 0,
    right: 1280,
    bottom: 700,
  });
  // off screen entirely → fall back to the container
  assert.deepEqual(getVisibleBounds({ left: 5000, top: 0, width: 100, height: 100 }, { width: 1280, height: 800 }), {
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
  });
});

test('default spot and clamp respect the visible bounds, not just the container box', () => {
  const viewport = { width: 1300, height: 800 };
  const bounds = getVisibleBounds({ left: -12, top: 0, width: 1300, height: 800 }, { width: 1280, height: 800 });

  assert.deepEqual(getDefaultMenuCenter(viewport, bounds), { x: 12 + EDGE, y: 400 });
  assert.deepEqual(clampMenuCenter({ x: 5000, y: 400 }, viewport, bounds), { x: 1292 - EDGE, y: 400 });
  assert.deepEqual(resolveMenuCenter(serializeFraction({ x: 0, y: 0.5 }), viewport, bounds), { x: 12 + EDGE, y: 400 });
});

const TRIGGER_EDGE = QUICK_PEN_TRIGGER_OUTER_EXTENT + QUICK_PEN_TRIGGER_MARGIN;

test('trigger storage key is per board and distinct from the menu key', () => {
  assert.equal(getQuickPenTriggerStorageKey('b1'), 'whiteboard:quick-pen-trigger:position:b1');
  assert.equal(getQuickPenTriggerStorageKey(), 'whiteboard:quick-pen-trigger:position:default');
  assert.notEqual(getQuickPenTriggerStorageKey('b1'), getQuickMenuStorageKey('b1'));
});

test('trigger default is the inline-end edge, vertically centred (left in RTL, right in LTR)', () => {
  const viewport = { width: 1280, height: 800 };

  assert.deepEqual(getDefaultTriggerCenter(viewport), { x: TRIGGER_EDGE, y: 400 });
  assert.deepEqual(getDefaultTriggerCenter(viewport, undefined, false), { x: 1280 - TRIGGER_EDGE, y: 400 });
  assert.deepEqual(resolveTriggerCenter(null, viewport), getDefaultTriggerCenter(viewport));
});

test('trigger clamp keeps the button and its shadow inside the visible viewport', () => {
  const viewport = { width: 1280, height: 800 };

  assert.deepEqual(clampTriggerCenter({ x: -100, y: 9999 }, viewport), { x: TRIGGER_EDGE, y: 800 - TRIGGER_EDGE });
  const bounds = getVisibleBounds({ left: -12, top: 0, width: 1300, height: 800 }, viewport);
  assert.equal(clampTriggerCenter({ x: 0, y: 400 }, { width: 1300, height: 800 }, bounds).x, 12 + TRIGGER_EDGE);
});

test('the menu opens centred on the trigger wherever there is room for the ring', () => {
  const viewport = { width: 1280, height: 800 };
  const anchor = { x: 0.5, y: 0.5 };

  assert.deepEqual(resolveMenuCenterForAnchor(anchor, viewport), resolveTriggerCenter(anchor, viewport));
  assert.deepEqual(resolveMenuCenterForAnchor(anchor, viewport), { x: 640, y: 400 });
});

test('a trigger near an edge opens the menu pulled inward just enough to fit', () => {
  const viewport = { width: 1280, height: 800 };
  const trigger = resolveTriggerCenter(null, viewport); // default edge spot

  assert.deepEqual(resolveMenuCenterForAnchor(null, viewport), { x: EDGE, y: trigger.y });
  assert.deepEqual(resolveMenuCenterForAnchor({ x: 1, y: 0 }, viewport), { x: 1280 - EDGE, y: EDGE });
});

test('dragging the menu hub moves the shared anchor so the trigger lands under the hub', () => {
  const viewport = { width: 1280, height: 800 };
  const origin = resolveMenuCenterForAnchor({ x: 0.5, y: 0.5 }, viewport);
  const next = dragAnchor(origin, { x: 200, y: -100 }, viewport, clampMenuCenter);
  const menuCenter = resolveMenuCenterForAnchor(next, viewport);

  assert.deepEqual(menuCenter, { x: 840, y: 300 });
  assert.deepEqual(resolveTriggerCenter(next, viewport), menuCenter);
});

test('a hub drag past the edge stops where the ring fits — and the trigger follows to that spot', () => {
  const viewport = { width: 1280, height: 800 };
  const origin = resolveMenuCenterForAnchor({ x: 0.5, y: 0.5 }, viewport);
  const next = dragAnchor(origin, { x: -5000, y: 0 }, viewport, clampMenuCenter);

  assert.deepEqual(resolveMenuCenterForAnchor(next, viewport), { x: EDGE, y: 400 });
  assert.deepEqual(resolveTriggerCenter(next, viewport), { x: EDGE, y: 400 });
});

test('dragging the trigger moves the shared anchor; the menu then opens on it', () => {
  const viewport = { width: 1280, height: 800 };
  const origin = resolveTriggerCenter(null, viewport);
  const next = dragAnchor(origin, { x: 600, y: 0 }, viewport, clampTriggerCenter);

  assert.deepEqual(resolveTriggerCenter(next, viewport), { x: origin.x + 600, y: 400 });
  assert.deepEqual(resolveMenuCenterForAnchor(next, viewport), { x: origin.x + 600, y: 400 });
});

test('the shared anchor survives a rotation for both the trigger and the menu', () => {
  const landscape = { width: 1600, height: 900 };
  const portrait = { width: 900, height: 1600 };
  const anchor = parseStoredFraction(serializeFraction(toViewportFraction({ x: 1200, y: 450 }, landscape)));

  assert.ok(anchor);
  assert.deepEqual(resolveTriggerCenter(anchor, portrait), { x: 675, y: 800 });
  assert.deepEqual(resolveMenuCenterForAnchor(anchor, portrait), { x: 675, y: 800 });
});
