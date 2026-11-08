import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React from 'react';

import type { Canvas, FabricObject, StaticCanvas } from 'fabric';

import type { UseWhiteboardHistoryReturn } from './useWhiteboardHistory';

before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const domGlobals = globalThis as unknown as {
    window?: unknown;
    document?: unknown;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  domGlobals.window = dom.window;
  (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = dom.window.requestAnimationFrame;
  (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = dom.window.cancelAnimationFrame;
  domGlobals.document = dom.window.document;
  domGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  // jsdom has no 2D context; fabric only needs one to paint, which these tests never look at.
  const noop = () => undefined;
  const context = new Proxy({}, { get: (_target, key) => (key === 'canvas' ? undefined : noop) });

  (dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => context;
});

interface Harness {
  canvas: StaticCanvas;
  history: () => UseWhiteboardHistoryReturn;
  renders: () => number;
  setPage: (pageId: string) => Promise<void>;
  /** A stroke whose gesture has ended; resolves once its checkpoint is taken. */
  draw: (name: string) => Promise<FabricObject>;
  /** Strokes the gesture-end checkpoint has not taken yet. */
  drawPending: (name: string) => FabricObject;
  act: (fn: () => Promise<unknown> | unknown) => Promise<void>;
  names: () => string[];
  unmount: () => Promise<void>;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function mount(): Promise<Harness> {
  const { StaticCanvas: FabricStaticCanvas, Path } = await import('fabric');
  const { useWhiteboardHistory } = await import('./useWhiteboardHistory');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const canvas = new FabricStaticCanvas(undefined, { renderOnAddRemove: false });
  let latest!: UseWhiteboardHistoryReturn;
  let renders = 0;
  let pageId = 'p1';
  let rerender: () => void = () => undefined;

  function Host({ page }: { page: string }): null {
    renders += 1;
    latest = useWhiteboardHistory({ canvas: canvas as unknown as Canvas, currentPageId: page });

    return null;
  }

  const container = document.createElement('div');

  document.body.appendChild(container);

  const root = createRoot(container);

  rerender = () => root.render(<Host page={pageId} />);
  await act(async () => rerender());

  // A stroke's identity rides in its stroke colour, so the canvas reads back as names.
  const makeStroke = (name: string) => new Path(`M 0 0 L ${name.length * 10} 10`, { fill: '', stroke: name });

  const harness: Harness = {
    act: async (fn) => {
      await act(async () => {
        await fn();
      });
    },
    canvas,
    draw: async (name) => {
      const stroke = makeStroke(name);

      await act(async () => {
        canvas.add(stroke);
        latest.noteMutation();
        await settle();
      });

      return stroke;
    },
    drawPending: (name) => {
      const stroke = makeStroke(name);

      canvas.add(stroke);
      latest.noteMutation();

      return stroke;
    },
    history: () => latest,
    names: () => canvas.getObjects().map((object) => String(object.stroke)),
    renders: () => renders,
    setPage: async (next) => {
      pageId = next;
      await act(async () => rerender());
    },
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };

  return harness;
}

test('draw A, B, C → undo ×2 → redo ×1, one stroke per step', async () => {
  const board = await mount();

  board.history().seedLoadedPage('p1', []);
  await board.draw('A');
  await board.draw('B');
  await board.draw('C');
  assert.equal(board.history().canUndo, true);

  await board.act(() => board.history().undo());
  await board.act(() => board.history().undo());
  assert.deepEqual(board.names(), ['A']);
  assert.equal(board.history().canRedo, true);

  await board.act(() => board.history().redo());
  assert.deepEqual(board.names(), ['A', 'B']);

  // A new stroke after an undo drops the redo branch.
  await board.draw('D');
  assert.equal(board.history().canRedo, false);
  await board.act(() => board.history().undo());
  assert.deepEqual(board.names(), ['A', 'B']);
  await board.unmount();
});

test('undo right after a stroke (checkpoint still pending) takes only that stroke', async () => {
  const board = await mount();

  board.history().seedLoadedPage('p1', []);
  await board.draw('A');
  board.drawPending('B');
  // The pending stroke already counts: the button must not look disabled after the first stroke.
  await board.act(() => undefined);
  assert.equal(board.history().canUndo, true);

  await board.act(() => board.history().undo());
  assert.deepEqual(board.names(), ['A']);
  await board.act(() => board.history().undo());
  assert.deepEqual(board.names(), []);
  await board.act(() => board.history().redo());
  await board.act(() => board.history().redo());
  assert.deepEqual(board.names(), ['A', 'B']);
  await board.unmount();
});

test('an erase swipe that removed many strokes is ONE undo, restored in z-order', async () => {
  const board = await mount();

  board.history().seedLoadedPage('p1', []);

  const strokes: FabricObject[] = [];

  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) strokes.push(await board.draw(name));

  // One gesture: every removal notes a mutation, the checkpoint waits for the lift.
  await board.act(async () => {
    for (const stroke of [strokes[1], strokes[2], strokes[4]]) {
      board.canvas.remove(stroke as FabricObject);
      board.history().noteMutation();
    }

    await settle();
  });
  assert.deepEqual(board.names(), ['a', 'd', 'f']);

  await board.act(() => board.history().undo());
  assert.deepEqual(board.names(), ['a', 'b', 'c', 'd', 'e', 'f']);
  // Untouched strokes kept their instances (no page reload).
  assert.equal(board.canvas.getObjects()[0], strokes[0]);
  await board.unmount();
});

test('an autosave reload of the same content keeps undo working; changed content resets it', async () => {
  const board = await mount();

  board.history().seedLoadedPage('p1', []);
  await board.draw('A');
  await board.draw('B');

  // Leave and come back: the page is reloaded from its stored JSON (new instances).
  const stored = JSON.stringify(board.canvas.toJSON());

  await board.act(async () => {
    board.history().pause();
    board.canvas.clear();
    const parsed = JSON.parse(stored) as { objects: unknown[] };

    await board.canvas.loadFromJSON(parsed);
    board.history().seedLoadedPage(
      'p1',
      parsed.objects.map((object) => JSON.stringify(object)),
    );
    board.history().resume();
  });
  assert.equal(board.history().canUndo, true);
  await board.act(() => board.history().undo());
  assert.deepEqual(board.names(), ['A']);

  // Content changed outside the history (another device): its stack is cleared, not undone onto.
  await board.act(async () => {
    board.history().pause();
    board.canvas.clear();
    await board.canvas.loadFromJSON(JSON.parse(stored));
    board.canvas.add(new (await import('fabric')).Path('M 0 0 L 5 5', { stroke: 'remote' }));
    board.history().seedLoadedPage('p1');
    board.history().resume();
  });
  assert.equal(board.history().canUndo, false);
  assert.equal(board.history().canRedo, false);
  await board.unmount();
});

test('paged board: each page keeps its own stack', async () => {
  const board = await mount();

  board.history().seedLoadedPage('p1', []);
  await board.draw('one');

  const pageOne = JSON.stringify(board.canvas.toJSON());

  await board.act(async () => {
    board.history().commitNow();
    board.history().pause();
    board.canvas.clear();
  });
  await board.setPage('p2');
  await board.act(() => {
    board.history().seedLoadedPage('p2', []);
    board.history().resume();
  });
  assert.equal(board.history().canUndo, false);
  await board.draw('two');
  await board.act(() => board.history().undo());
  assert.deepEqual(board.names(), []);

  await board.act(async () => {
    board.history().pause();
    board.canvas.clear();
    const parsed = JSON.parse(pageOne) as { objects: unknown[] };

    await board.canvas.loadFromJSON(parsed);
  });
  await board.setPage('p1');
  await board.act(() => {
    board.history().seedLoadedPage('p1', (JSON.parse(pageOne) as { objects: unknown[] }).objects.map((o) => JSON.stringify(o)));
    board.history().resume();
  });
  assert.equal(board.history().canUndo, true);
  await board.act(() => board.history().undo());
  assert.deepEqual(board.names(), []);
  await board.unmount();
});

test('a checkpoint per stroke does not re-render once canUndo is already true', async () => {
  const board = await mount();

  board.history().seedLoadedPage('p1', []);
  await board.draw('first');

  const rendersAfterFirstStroke = board.renders();

  for (let index = 0; index < 5; index += 1) await board.draw(`s${index}`);

  assert.equal(board.renders(), rendersAfterFirstStroke, 'unchanged flags must not re-render the host');
  await board.unmount();
});

test('a double tap on undo is two undos, even while the first restore is still in flight', async () => {
  const board = await mount();

  board.history().seedLoadedPage('p1', []);
  await board.draw('A');
  await board.draw('B');
  await board.draw('C');
  await board.act(() => Promise.all([board.history().undo(), board.history().undo()]));
  assert.deepEqual(board.names(), ['A']);
  await board.unmount();
});
