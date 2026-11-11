import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { StrokeSettings } from '../types';

import {
  getBoardPenStorageKey,
  isBoardPenTool,
  nextBoardPenMemory,
  openBoardPen,
  parseBoardPenMemory,
  readBoardPenRaw,
  resolveInitialBoardPen,
  serializeBoardPenMemory,
  writeBoardPenMemory,
} from './boardPenMemory';

const DEVICE_DEFAULT: StrokeSettings = { color: '#000000', secondaryColor: '#2563EB', width: 4, opacity: 1 };
const RED_BRUSH: StrokeSettings = { color: '#EF4444', secondaryColor: '#22C55E', width: 9, opacity: 1 };

function installMemoryStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  return store;
}

beforeEach(() => {
  installMemoryStorage();
});

test('storage key carries the board id', () => {
  assert.equal(getBoardPenStorageKey('board-7'), 'whiteboard:board-pen:board-7');
});

test('pen tools include the highlighter; eraser / hand / select / shapes do not count', () => {
  for (const tool of ['pen', 'brush', 'marker', 'highlighter']) assert.ok(isBoardPenTool(tool), tool);
  for (const tool of ['eraser', 'pan', 'select', 'rect', 'text', 'laser', 42, null]) {
    assert.ok(!isBoardPenTool(tool), String(tool));
  }
});

test('save then restore round-trips the nib, both colours and the width', () => {
  writeBoardPenMemory('b1', { tool: 'brush', strokeSettings: RED_BRUSH });

  assert.deepEqual(resolveInitialBoardPen(readBoardPenRaw('b1'), DEVICE_DEFAULT), {
    tool: 'brush',
    strokeSettings: RED_BRUSH,
  });
});

test('boards are independent', () => {
  writeBoardPenMemory('b1', { tool: 'marker', strokeSettings: RED_BRUSH });

  assert.deepEqual(resolveInitialBoardPen(readBoardPenRaw('b2'), DEVICE_DEFAULT), {
    tool: 'pen',
    strokeSettings: DEVICE_DEFAULT,
  });
});

test('a board never opened on this device falls back to the plain pen with the device-wide settings', () => {
  assert.deepEqual(resolveInitialBoardPen(null, DEVICE_DEFAULT), { tool: 'pen', strokeSettings: DEVICE_DEFAULT });
});

test('left on eraser / hand / select → the last PEN is remembered, with the current settings', () => {
  assert.deepEqual(nextBoardPenMemory('brush', 'eraser', RED_BRUSH), { tool: 'brush', strokeSettings: RED_BRUSH });
  assert.deepEqual(nextBoardPenMemory('marker', 'pan', DEVICE_DEFAULT).tool, 'marker');
  assert.deepEqual(nextBoardPenMemory('highlighter', 'select', DEVICE_DEFAULT).tool, 'highlighter');
  assert.deepEqual(nextBoardPenMemory('pen', 'highlighter', DEVICE_DEFAULT).tool, 'highlighter');
});

test('a barrel COLOR toggle mid-erase still saves the swapped colours', () => {
  const swapped = { ...RED_BRUSH, color: RED_BRUSH.secondaryColor, secondaryColor: RED_BRUSH.color };
  writeBoardPenMemory('b1', nextBoardPenMemory('pen', 'eraser', swapped));

  assert.deepEqual(resolveInitialBoardPen(readBoardPenRaw('b1'), DEVICE_DEFAULT), { tool: 'pen', strokeSettings: swapped });
});

test('malformed entries are ignored; bad fields fall back one by one; width is clamped', () => {
  for (const raw of ['', 'nope', 'null', '{}', '{"tool":"eraser"}', '{"tool":5}']) {
    assert.equal(parseBoardPenMemory(raw, DEVICE_DEFAULT), null, raw);
  }
  assert.deepEqual(
    parseBoardPenMemory('{"tool":"marker","strokeSettings":{"color":"","width":9999,"opacity":"x"}}', DEVICE_DEFAULT),
    { tool: 'marker', strokeSettings: { ...DEVICE_DEFAULT, width: 64 } },
  );
  assert.deepEqual(parseBoardPenMemory('{"tool":"pen"}', DEVICE_DEFAULT), {
    tool: 'pen',
    strokeSettings: DEVICE_DEFAULT,
  });
});

test('serialized entries hold only the tool and the four stroke fields', () => {
  const extra = { ...RED_BRUSH, junk: true } as StrokeSettings;

  assert.deepEqual(JSON.parse(serializeBoardPenMemory({ tool: 'pen', strokeSettings: extra })), {
    tool: 'pen',
    strokeSettings: RED_BRUSH,
  });
});

test('blocked storage never throws: reads as nothing, writes are dropped', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError');
    },
  });

  assert.equal(readBoardPenRaw('b1'), null);
  assert.doesNotThrow(() => writeBoardPenMemory('b1', { tool: 'pen', strokeSettings: DEVICE_DEFAULT }));
  assert.deepEqual(resolveInitialBoardPen(readBoardPenRaw('b1'), DEVICE_DEFAULT).tool, 'pen');
});

test('the highlighter out: the PEN colour is remembered, not the highlighter colour', () => {
  const live = { ...DEVICE_DEFAULT, color: '#ffd60a' };

  assert.equal(nextBoardPenMemory('brush', 'highlighter', live, '#000000').strokeSettings.color, '#000000');
  assert.equal(nextBoardPenMemory('brush', 'highlighter', live, '#000000').tool, 'highlighter');
  // Nothing parked (e.g. a stale caller): the live settings as before.
  assert.equal(nextBoardPenMemory('brush', 'highlighter', live).strokeSettings.color, '#ffd60a');
  // Any other tool ignores the parked colour.
  assert.equal(nextBoardPenMemory('brush', 'brush', RED_BRUSH, '#000000').strokeSettings.color, RED_BRUSH.color);
});

test('reopening: a pen keeps its colour; the highlighter takes its own and parks the pen colour', () => {
  assert.deepEqual(openBoardPen({ tool: 'brush', strokeSettings: RED_BRUSH }, '#00ff00'), {
    tool: 'brush',
    strokeSettings: RED_BRUSH,
    parkedPenColor: null,
  });
  const reopened = openBoardPen({ tool: 'highlighter', strokeSettings: RED_BRUSH }, '#00ff00');

  assert.equal(reopened.strokeSettings.color, '#00ff00');
  assert.equal(reopened.parkedPenColor, RED_BRUSH.color);
  assert.equal(openBoardPen({ tool: 'highlighter', strokeSettings: RED_BRUSH }, null).strokeSettings.color, '#ffd60a');
});
