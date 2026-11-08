import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React from 'react';

import { createInsertedSheet } from '@repo/whiteboard-core';

import type { Canvas, FabricObject } from 'fabric';

import type { WhiteboardPage } from '../types';
import type { PdfScrollSession } from '../utils/pdfScrollSession';
import type { UseWhiteboardHistoryReturn } from './useWhiteboardHistory';

/**
 * The continuous PDF layout's history against a REAL scroll session on a Fabric canvas: pages hydrate
 * and dehydrate as the view moves, and the document keeps one stack through all of it.
 */

before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const domGlobals = globalThis as unknown as Record<string, unknown>;

  domGlobals.window = dom.window;
  domGlobals.document = dom.window.document;
  domGlobals.requestAnimationFrame = dom.window.requestAnimationFrame;
  domGlobals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  domGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

  const noop = () => undefined;
  const context = new Proxy({}, { get: (_target, key) => (key === 'canvas' ? undefined : noop) });

  (dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => context;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

interface Board {
  canvas: Canvas;
  session: PdfScrollSession;
  history: () => UseWhiteboardHistoryReturn;
  pages: () => WhiteboardPage[];
  act: (fn: () => Promise<unknown> | unknown) => Promise<void>;
  /** A stroke at scene `y`, gesture ended, checkpoint taken. */
  drawAt: (name: string, y: number) => Promise<FabricObject>;
  pageTop: (index: number) => number;
  /** Names of the strokes stored on page `index` after a flush. */
  storedOn: (index: number) => string[];
  hydratedNames: () => string[];
  unmount: () => Promise<void>;
}

async function mountScrollBoard(pageCount: number): Promise<Board> {
  const { Canvas: FabricCanvas, Path } = await import('fabric');
  const { PdfScrollSession: Session } = await import('../utils/pdfScrollSession');
  const { useWhiteboardHistory } = await import('./useWhiteboardHistory');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const canvas = new FabricCanvas(document.createElement('canvas'), { height: 600, renderOnAddRemove: false, width: 400 });
  let pages: WhiteboardPage[] = Array.from({ length: pageCount }, (_, index) => ({
    ...createInsertedSheet(1.4, 'blank'),
    id: `page-${index + 1}`,
  }));
  let latest!: UseWhiteboardHistoryReturn;
  let external = false;
  // eslint-disable-next-line prefer-const
  let session!: PdfScrollSession;

  function Host(): null {
    latest = useWhiteboardHistory({
      canvas: canvas,
      currentPageId: 'document',
      getScrollSession: () => session,
    });

    return null;
  }

  const container = document.createElement('div');

  document.body.appendChild(container);

  const root = createRoot(container);

  await act(async () => root.render(<Host />));

  session = new Session({
    beforeDehydrate: () => latest.commitNow(),
    canvas: canvas,
    isWriteBlocked: () => external,
    maxZoom: 4,
    objectCache: latest.objectCache,
    onCurrentPageChange: () => undefined,
    onPageHydrated: (pageId, objects, sources) => latest.seedHydratedPage(pageId, objects, sources),
    onPagesPatched: (patch) => {
      pages = patch(pages);
      session.syncPages(pages);
    },
    onWindowChange: () => undefined,
    overscanViewports: 0,
    requestRepaint: () => undefined,
    resolveImage: async () => null,
    setExternalWrite: (active) => {
      external = active;
    },
    width: 400,
  });
  session.syncPages(pages);
  await act(async () => {
    await session.enter(0);
  });

  const flushed = () => {
    pages = session.flush(pages);

    return pages;
  };

  return {
    act: async (fn) => {
      await act(async () => {
        await fn();
      });
    },
    canvas,
    drawAt: async (name, y) => {
      const stroke = new Path('M 0 0 L 20 20', { fill: '', left: 100, stroke: name, top: y });

      await act(async () => {
        canvas.add(stroke);
        latest.noteMutation();
        await settle();
      });

      return stroke;
    },
    history: () => latest,
    hydratedNames: () => canvas.getObjects().map((object) => String(object.stroke)),
    pageTop: (index) => session.layout.entries[index]?.top ?? 0,
    pages: flushed,
    session,
    storedOn: (index) => {
      const page = flushed()[index];
      const json = page?.canvasJSON ? (JSON.parse(page.canvasJSON) as { objects: Array<{ stroke: string }> }) : { objects: [] };

      return json.objects.map((object) => object.stroke);
    },
    unmount: async () => {
      session.dispose();
      await act(async () => root.unmount());
    },
  };
}

test('scroll layout: write on page 1, scroll to page 4, write → undo ×2 walks back through both pages', async () => {
  const board = await mountScrollBoard(5);

  await board.drawAt('one', board.pageTop(0) + 100);
  assert.deepEqual(board.storedOn(0), ['one']);

  // Scroll to page 4: page 1 leaves the window (written back, taken off the canvas).
  await board.act(() => board.session.enter(3));
  assert.deepEqual(board.hydratedNames(), []);

  await board.drawAt('four', board.pageTop(3) + 100);
  assert.deepEqual(board.storedOn(3), ['four']);

  await board.act(() => board.history().undo());
  assert.deepEqual(board.storedOn(3), []);

  // Page 1 is not on the canvas: the undo brings it into view and takes its stroke.
  await board.act(() => board.history().undo());
  assert.deepEqual(board.storedOn(0), []);
  assert.equal(board.session.getCurrentIndex(), 0);
  assert.equal(board.history().canUndo, false);

  // Redo puts them back in order.
  await board.act(() => board.history().redo());
  assert.deepEqual(board.storedOn(0), ['one']);
  await board.act(() => board.history().redo());
  assert.deepEqual(board.storedOn(3), ['four']);
  await board.unmount();
});

test('scroll layout: A, B, C on one page → undo ×2 → redo ×1', async () => {
  const board = await mountScrollBoard(3);
  const top = board.pageTop(0);

  await board.drawAt('A', top + 50);
  await board.drawAt('B', top + 150);
  await board.drawAt('C', top + 250);
  await board.act(() => board.history().undo());
  await board.act(() => board.history().undo());
  assert.deepEqual(board.storedOn(0), ['A']);
  await board.act(() => board.history().redo());
  assert.deepEqual(board.storedOn(0), ['A', 'B']);
  await board.unmount();
});

test('scroll layout: a page scrolling out and back in keeps its undo (no reset by the round trip)', async () => {
  const board = await mountScrollBoard(5);

  await board.drawAt('kept', board.pageTop(0) + 100);
  await board.act(() => board.session.enter(4));
  await board.act(() => board.session.enter(0));
  assert.deepEqual(board.hydratedNames(), ['kept']);
  assert.equal(board.history().canUndo, true);
  await board.act(() => board.history().undo());
  assert.deepEqual(board.storedOn(0), []);
  await board.unmount();
});

test('scroll layout: an unchanged page flushes back to byte-identical JSON', async () => {
  const board = await mountScrollBoard(2);

  await board.drawAt('x', board.pageTop(0) + 100);

  const first = board.pages()[0]?.canvasJSON;

  await board.act(() => board.session.enter(1));
  await board.act(() => board.session.enter(0));
  board.session.markAllDirty();
  assert.equal(board.pages()[0]?.canvasJSON, first);
  await board.unmount();
});
