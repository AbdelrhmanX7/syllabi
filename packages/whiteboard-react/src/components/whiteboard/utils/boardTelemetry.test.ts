import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  emitBoardGesture,
  getBoardTelemetryContext,
  hasBoardTelemetryListeners,
  publishBoardTelemetryContext,
  setBoardObjectCounter,
  subscribeBoardGestures,
} from './boardTelemetry';

test('context: null until published; object count only when asked', () => {
  assert.equal(getBoardTelemetryContext(), null);
  publishBoardTelemetryContext({ tool: 'select', pages: 3, page: 1, zoom: 1.5, layout: 'continuous' });
  let counted = 0;

  setBoardObjectCounter(() => {
    counted += 1;

    return 42;
  });
  assert.deepEqual(getBoardTelemetryContext(false), {
    tool: 'select',
    pages: 3,
    page: 1,
    zoom: 1.5,
    layout: 'continuous',
  });
  assert.equal(counted, 0);
  assert.equal(getBoardTelemetryContext()?.objects, 42);
  setBoardObjectCounter(() => {
    throw new Error('disposed');
  });
  assert.equal(getBoardTelemetryContext()?.objects, undefined);
  publishBoardTelemetryContext(null);
  setBoardObjectCounter(null);
  assert.equal(getBoardTelemetryContext(), null);
});

test('gesture edges reach subscribers; a throwing one never breaks the rest', () => {
  const seen: string[] = [];

  assert.equal(hasBoardTelemetryListeners(), false);
  emitBoardGesture({ phase: 'start', kind: 'pen', at: 0 });
  const offBad = subscribeBoardGestures(() => {
    throw new Error('bad');
  });
  const off = subscribeBoardGestures((edge) => seen.push(`${edge.phase}:${edge.kind}`));

  emitBoardGesture({ phase: 'start', kind: 'pen', at: 1 });
  emitBoardGesture({ phase: 'end', kind: 'pinch', at: 2 });
  assert.deepEqual(seen, ['start:pen', 'end:pinch']);
  off();
  offBad();
  assert.equal(hasBoardTelemetryListeners(), false);
});

test('trackBoardGestures: a lost lift closes after the silence ceiling; a lift elsewhere closes after the tail', async (t) => {
  const { BOARD_GESTURE_SILENCE_MS, BOARD_GESTURE_TAIL_MS, trackBoardGestures } = await import('./boardTelemetry');
  // The root doubles as the canvas target (events dispatched on it have it as their target).
  class FakeCanvas extends EventTarget {}
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadCanvas = 'HTMLCanvasElement' in globals;

  globals.HTMLCanvasElement = FakeCanvas;
  t.after(() => {
    if (!hadCanvas) delete globals.HTMLCanvasElement;
  });
  let clock = 0;

  t.mock.method(performance, 'now', () => clock);
  // @types/node here predates the `{ apis }` form the Node 24 runtime takes.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] } as never);
  const pointer = (type: string, pointerId: number, pointerType = 'pen') =>
    Object.assign(new Event(type), { pointerId, pointerType });
  const root = new FakeCanvas();
  const edges: string[] = [];
  const off = subscribeBoardGestures((edge) => edges.push(`${edge.phase}:${edge.kind}`));
  const stop = trackBoardGestures(root as unknown as HTMLElement);

  root.dispatchEvent(pointer('pointerdown', 1));
  assert.deepEqual(edges, ['start:pen']);
  // No up ever arrives: silence past the ceiling closes it.
  clock += BOARD_GESTURE_SILENCE_MS + 1;
  t.mock.timers.tick(1_000);
  assert.deepEqual(edges, ['start:pen', 'end:pen']);

  // A one-finger drag that becomes a pinch, lifted normally: closes after the fling tail.
  root.dispatchEvent(pointer('pointerdown', 2, 'touch'));
  root.dispatchEvent(pointer('pointerdown', 3, 'touch'));
  root.dispatchEvent(pointer('pointerup', 2, 'touch'));
  root.dispatchEvent(pointer('pointerup', 3, 'touch'));
  t.mock.timers.tick(BOARD_GESTURE_TAIL_MS);
  assert.deepEqual(edges.slice(2), ['start:touch', 'end:pinch']);
  stop();
  off();
});
