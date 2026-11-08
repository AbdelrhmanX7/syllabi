import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React from 'react';

// A minimal DOM is required: error boundaries only catch during a real (client) render — server
// rendering re-throws — so we mount into jsdom and assert on the resulting markup.
before(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const domGlobals = globalThis as unknown as {
    window?: unknown;
    document?: unknown;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  domGlobals.window = dom.window;
  domGlobals.document = dom.window.document;
  domGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  // `navigator` is a read-only getter on the global object, so it cannot be reassigned — redefine it.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
});

function Boom(): React.ReactElement {
  throw new Error('boom');
}

test('renders the fallback when a child throws and keeps sibling content rendered', async () => {
  // Imported lazily so the JSDOM globals exist before react-dom/@repo/ui touch `document`.
  const { WhiteboardErrorBoundary } = await import('./WhiteboardErrorBoundary');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);
  let caughtError: Error | null = null;

  // Silence React's expected error logging for the deliberate throw.
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement('span', { 'data-testid': 'sibling' }, 'sibling stays'),
          React.createElement(
            WhiteboardErrorBoundary,
            {
              onError: (error: Error) => {
                caughtError = error;
              },
              fallback: (error: Error) =>
                React.createElement('div', { 'data-testid': 'fallback' }, `fallback: ${error.message}`),
            },
            React.createElement(Boom),
          ),
        ),
      );
    });
  } finally {
    console.error = originalConsoleError;
  }

  const fallback = container.querySelector('[data-testid="fallback"]');
  const sibling = container.querySelector('[data-testid="sibling"]');

  assert.ok(fallback, 'fallback should render when the child throws');
  assert.equal(fallback?.textContent, 'fallback: boom');
  assert.ok(sibling, 'sibling content outside the boundary should still render');
  assert.equal(sibling?.textContent, 'sibling stays');
  assert.ok(caughtError, 'onError should be invoked with the caught error');
  assert.equal((caughtError as unknown as Error).message, 'boom');

  await act(async () => {
    root.unmount();
  });
});

test('renders the default fallback when no custom fallback is provided', async () => {
  const { WhiteboardErrorBoundary } = await import('./WhiteboardErrorBoundary');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);
  const originalConsoleError = console.error;

  console.error = () => {};

  try {
    await act(async () => {
      root.render(React.createElement(WhiteboardErrorBoundary, null, React.createElement(Boom)));
    });
  } finally {
    console.error = originalConsoleError;
  }

  const { wbT } = await import('../../i18n/strings');

  assert.ok((container.textContent ?? '').includes(wbT('en', 'editor.crash.title')));
  assert.ok((container.textContent ?? '').includes(wbT('en', 'editor.boundary.retry')));

  await act(async () => {
    root.unmount();
  });
});
