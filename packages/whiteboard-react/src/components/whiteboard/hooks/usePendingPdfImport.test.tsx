import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React from 'react';

// jsdom global setup mirrors WhiteboardErrorBoundary.test.tsx: client-render needs a real DOM.
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
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
});

interface Probe {
  pdfModalOpen: boolean;
  setPdfModalOpen: (open: boolean) => void;
  pendingImportFiles: File[] | null;
  hostPending: File | null;
  setHostPending: (file: File | null) => void;
}

// Regression: the host (pages/board/[id].tsx) nulls its file reference inside the handled-callback,
// and React batches that clear into the SAME commit that opens the modal. The hook must therefore
// hand the modal its own captured copy — reading the host prop on the open render always saw null,
// which is how «Add to current board» degraded into an empty generic add-PDF picker.
test('the modal-open render still has the file although the host cleared its reference in the same batch', async () => {
  const { usePendingPdfImport } = await import('./usePendingPdfImport');
  const { createRoot } = await import('react-dom/client');
  const { act, useState } = await import('react');

  let probe!: Probe;

  function Host(): null {
    const [hostPending, setHostPending] = useState<File | null>(null);
    // Inline callback on purpose — the board page passes a fresh closure every render too.
    const hook = usePendingPdfImport(hostPending, () => setHostPending(null));

    probe = { ...hook, hostPending, setHostPending };

    return null;
  }

  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<Host />);
  });

  const file = new File(['%PDF-1.4'], 'lesson.pdf', { type: 'application/pdf' });

  await act(async () => {
    probe.setHostPending(file);
  });

  assert.equal(probe.pdfModalOpen, true);
  assert.deepEqual(probe.pendingImportFiles, [file]);
  // The one-shot contract still holds: the host reference was consumed immediately.
  assert.equal(probe.hostPending, null);

  // Closing the modal drops the capture, so a later toolbar open does not preload a stale file.
  await act(async () => {
    probe.setPdfModalOpen(false);
  });

  assert.equal(probe.pendingImportFiles, null);

  root.unmount();
});

// The board's drag-and-drop import has no host prop to go through: the canvas captures the File
// itself and hands it straight to the modal, so the same preload + one-shot contract has to hold on
// this path too.
test('a file captured by the board opens the modal already preloaded, and is dropped when it closes', async () => {
  const { usePendingPdfImport } = await import('./usePendingPdfImport');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  interface DropProbe {
    pdfModalOpen: boolean;
    setPdfModalOpen: (open: boolean) => void;
    pendingImportFiles: File[] | null;
    startImportWithFile: (file: File) => void;
  }

  let probe!: DropProbe;

  function Host(): null {
    probe = usePendingPdfImport(null, undefined);

    return null;
  }

  const container = document.createElement('div');

  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<Host />);
  });

  assert.equal(probe.pdfModalOpen, false, 'the modal stays shut until something is dropped');

  const dropped = new File(['%PDF-1.4'], 'dropped.pdf', { type: 'application/pdf' });

  await act(async () => {
    probe.startImportWithFile(dropped);
  });

  assert.equal(probe.pdfModalOpen, true, 'the drop opens the import modal');
  assert.deepEqual(probe.pendingImportFiles, [dropped], 'the modal is preloaded with the dropped file');

  await act(async () => {
    probe.setPdfModalOpen(false);
  });

  assert.equal(probe.pendingImportFiles, null, 'cancelling the modal does not leave the file armed');

  root.unmount();
});
