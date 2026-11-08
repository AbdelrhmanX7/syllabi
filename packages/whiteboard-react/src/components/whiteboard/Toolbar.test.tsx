import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React from 'react';

import { DEFAULT_TABLET_INPUT_SETTINGS } from './types';

// The toolbar is popover-driven, so jsdom needs the observers and frame APIs react-aria's overlays and
// motion/react reach for — jsdom 26 ships none of them.
before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const { window } = dom;
  const domGlobals = globalThis as unknown as {
    window?: unknown;
    document?: unknown;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    ResizeObserver?: unknown;
    requestAnimationFrame?: unknown;
    cancelAnimationFrame?: unknown;
  };

  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverPolyfill;
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });

  // motion/react and react-aria read these off the GLOBAL, not off `window`.
  for (const name of ['Element', 'HTMLElement', 'SVGElement', 'Node', 'MouseEvent', 'Event', 'KeyboardEvent']) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }

  domGlobals.window = window;
  domGlobals.document = window.document;
  domGlobals.ResizeObserver = ResizeObserverPolyfill;
  domGlobals.requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  domGlobals.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as NodeJS.Timeout);
  domGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: window.navigator,
  });
});

// Tooltip labels only mount on hover, so buttons are identified by the lucide icon they carry.
const buttonWithIcon = (root: ParentNode, iconClass: string): HTMLButtonElement | null =>
  (root.querySelector(`svg.${iconClass}`)?.closest('button') as HTMLButtonElement | null) ?? null;

const countIcon = (root: ParentNode, iconClass: string): number => root.querySelectorAll(`svg.${iconClass}`).length;

// react-aria treats a detail-0 click as a "virtual" press — the only press path that needs no pointer
// geometry, which jsdom cannot provide.
const virtualClick = (element: HTMLElement) => {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
};

const toolbarProps = (calls: string[]) => ({
  activeTool: 'pen' as const,
  backgroundImageOpacity: 1,
  backgroundType: 'blank' as const,
  canRedo: true,
  canUndo: true,
  dock: 'top' as const,
  eraserMode: 'partial' as const,
  eraserSize: 24,
  fillColor: 'transparent',
  hasPdfPageBackground: false,
  hasSharedBackgroundImage: false,
  isExportingPdf: false,
  isFullscreen: false,
  isLocked: false,
  openToolSettings: null,
  smoothingEnabled: true,
  strokeSettings: { color: '#1f2937', secondaryColor: '#ef4444', width: 4, opacity: 1 },
  tabletInputSettings: DEFAULT_TABLET_INPUT_SETTINGS,
  zoom: 1,
  onBackgroundImageOpacityChange: () => {},
  onBackgroundTypeChange: () => {},
  onClear: () => {},
  onClearSharedBackground: () => {},
  onDockChange: () => {},
  onDuplicatePage: () => {},
  onEnterFocusMode: () => {},
  onEraserModeChange: () => {},
  onEraserSizeChange: () => {},
  onExportDocument: () => calls.push('document'),
  onExportImage: () => calls.push('image'),
  onExportPdf: () => calls.push('pdf'),
  onFillColorChange: () => {},
  onInsertGeometryStencil: () => {},
  onInsertImage: () => {},
  onOpenToolSettings: () => {},
  onRedo: () => {},
  onResetZoom: () => {},
  onRotatePageBackground: () => {},
  onSmoothingChange: () => {},
  onStrokeSettingsChange: () => {},
  onTabletInputSettingsChange: () => {},
  onToggleFullscreen: () => {},
  onToggleLock: () => {},
  onToolChange: () => {},
  onUndo: () => {},
  onUploadPdf: () => calls.push('import'),
  onUploadSharedBackground: () => {},
  onZoomIn: () => {},
  onZoomOut: () => {},
});

test('the collapsed row trades the arrow for import + export, keeps the eraser, and repeats nothing', async () => {
  const { default: Toolbar } = await import('./Toolbar');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const calls: string[] = [];
  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);

  const props = toolbarProps(calls);

  await act(async () => {
    root.render(React.createElement(Toolbar, props));
  });

  // `pen` is a core tool, so the toolbar renders collapsed.
  assert.equal(buttonWithIcon(container, 'lucide-mouse-pointer-2'), null, 'the select arrow left the collapsed row');
  assert.ok(buttonWithIcon(container, 'lucide-eraser'), 'the eraser button stayed in the collapsed row');

  const importButton = buttonWithIcon(container, 'lucide-file-up');
  const exportButton = buttonWithIcon(container, 'lucide-file-down');

  assert.ok(importButton, 'the collapsed row offers import');
  assert.ok(exportButton, 'the collapsed row offers export');

  await act(async () => {
    virtualClick(importButton as HTMLElement);
  });

  assert.deepEqual(calls, ['import'], 'import opens the PDF upload modal');

  await act(async () => {
    virtualClick(exportButton as HTMLElement);
  });

  assert.deepEqual(calls, ['import', 'pdf'], 'export runs the PDF export');

  // Select lost its slot in the collapsed row but not its button: it lives under «All tools».
  const expandToggle = buttonWithIcon(container, 'lucide-menu');

  assert.ok(expandToggle, 'the toolbar has its expand toggle');

  await act(async () => {
    virtualClick(expandToggle as HTMLElement);
  });

  assert.ok(buttonWithIcon(container, 'lucide-mouse-pointer-2'), 'select is reachable in the expanded toolbar');
  // Expanding reveals the file section, which must not repeat what the always-visible row carries.
  assert.equal(countIcon(container, 'lucide-file-up'), 1, 'import renders exactly once');
  assert.equal(countIcon(container, 'lucide-file-down'), 1, 'the PDF export renders exactly once');
  assert.equal(countIcon(container, 'lucide-download'), 1, 'the image export kept its only home');
  assert.equal(countIcon(container, 'lucide-file-json'), 1, 'the board-file export kept its only home');

  await act(async () => {
    root.unmount();
  });
});

test('full-scroll: one row, every tool in it, no ☰ drawer, select / undo / paper spacing once', async () => {
  const { default: Toolbar } = await import('./Toolbar');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(Toolbar, {
        ...toolbarProps([]),
        compactSelectTool: true,
        compactUndoRedo: true,
        layout: 'full-scroll' as const,
        onPaperSpacingChange: () => {},
        paperSpacingMm: 8,
      }),
    );
  });

  const row = container.querySelector('[data-wb-toolbar-row="scroll"]');

  assert.ok(row, 'the row is the scrolling viewport');
  assert.match(row.className, /overflow-x-auto/, 'the row scrolls sideways');
  assert.equal(row.firstElementChild?.className.includes('flex-nowrap'), true, 'the tools never wrap');
  assert.equal(buttonWithIcon(container, 'lucide-menu'), null, 'nothing hides behind ☰');
  assert.equal(countIcon(container, 'lucide-mouse-pointer-2'), 1, 'select renders once');
  assert.equal(countIcon(container, 'lucide-undo-2'), 1, 'undo renders once');
  assert.equal(countIcon(container, 'lucide-redo-2'), 1, 'redo renders once');
  assert.ok(buttonWithIcon(container, 'lucide-highlighter'), 'the drawer tools sit in the row');
  assert.ok(buttonWithIcon(container, 'lucide-grid-3x3'), 'the paper / spacing picker sits in the row');

  await act(async () => {
    root.unmount();
  });
});

test('full-scroll bottom: a flush bar, the page group pinned at the end outside the scrolling row', async () => {
  const { default: Toolbar } = await import('./Toolbar');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(Toolbar, {
        ...toolbarProps([]),
        dock: 'bottom' as const,
        layout: 'full-scroll' as const,
        trailing: React.createElement('div', { 'data-test-pages': true }, 'pages'),
      }),
    );
  });

  const bar = container.querySelector<HTMLElement>('[data-wb-toolbar-bar="flush"]');
  const row = container.querySelector('[data-wb-toolbar-row="scroll"]');
  const trailing = container.querySelector('[data-wb-toolbar-trailing]');

  assert.ok(bar, 'the bottom row is the flush bar');
  assert.doesNotMatch(bar.className, /rounded|shadow/, 'square, no elevation');
  assert.match(bar.className, /border-t/, 'a 1px top rule');
  assert.ok(trailing?.querySelector('[data-test-pages]'), 'the trailing group renders');
  assert.equal(row?.contains(trailing), false, 'the page group does not scroll away with the tools');

  await act(async () => {
    root.render(React.createElement(Toolbar, { ...toolbarProps([]), dock: 'top' as const, trailing: 'x' }));
  });
  assert.equal(container.querySelector('[data-wb-toolbar-trailing]'), null, 'the wrap layout ignores trailing');

  await act(async () => {
    root.unmount();
  });
});
