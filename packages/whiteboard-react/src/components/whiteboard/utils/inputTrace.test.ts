import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clearInputTrace, getInputTrace, refreshInputTraceEnabled, traceInput } from './inputTrace';

// The trace reads `window.localStorage` lazily (refreshInputTraceEnabled), so a minimal window with an
// in-memory storage is all it needs — no jsdom. Installed after the (hoisted) import: the module's load-time
// read sees no window and starts disabled, which is what the first test pins.
const storage = new Map<string, string>();

(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
};

const entry = {
  kind: 'pen' as const,
  phase: 'move' as const,
  decision: 'hover-commit',
  pointerId: 7,
  pointerType: 'pen',
  width: 0,
  height: 0,
  buttons: 0,
  hasSeenRealPen: true,
  activePen: 0,
  activeTouch: 0,
};

test('the trace is off until something arms it', () => {
  storage.clear();
  clearInputTrace();

  assert.equal(refreshInputTraceEnabled(), false);
  traceInput(entry);
  assert.equal(getInputTrace().length, 0);
});

// The on-device debug flags log to a console nobody can read on a tablet. Each of them also arms the
// trace, so the same decisions come out of the touch-probe page's JSON export.
test('each console-debug flag arms the exportable trace', () => {
  for (const key of ['wb-debug-pen', 'wb-debug-input', 'whiteboard-debug-input']) {
    storage.clear();
    clearInputTrace();
    storage.set(key, '1');

    assert.equal(refreshInputTraceEnabled(), true, `${key} did not arm the trace`);
    traceInput(entry);
    assert.equal(getInputTrace().length, 1, `${key}: the decision was not recorded`);
  }
});

test('the Settings toggle still arms it on its own', () => {
  storage.clear();
  clearInputTrace();
  storage.set('whiteboard-input-trace', '1');

  assert.equal(refreshInputTraceEnabled(), true);
});
