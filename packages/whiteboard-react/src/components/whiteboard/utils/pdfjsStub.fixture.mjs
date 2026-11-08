/**
 * Stand-in for the vendored pdf.js ESM build that the apps serve at `/pdf.min.mjs`.
 *
 * `pdfAssetRenderer.ts` loads the real engine through a dynamic `import(moduleSrc)`, so a test swaps
 * the whole engine out simply by pointing `moduleSrc` at this file — no fixture PDF to ship, and
 * every page's behaviour is scriptable: renders fine, render rejects (the production bug: a
 * malformed transparency group throws «Bounding box is required.»), or the page object itself is
 * unreadable (`getPage` rejects on a corrupt page tree).
 *
 * The script lives on `globalThis.__pdfjsStubState` because the importer owns the import call — the
 * test never gets to pass anything through it.
 */

export const GlobalWorkerOptions = { workerSrc: '' };

function readStubState() {
  const state = globalThis.__pdfjsStubState;

  if (!state) {
    throw new Error('pdfjsStub: globalThis.__pdfjsStubState was never set by the test.');
  }

  return state;
}

export function getDocument() {
  const state = readStubState();

  state.openedDocuments += 1;

  const stubDocument = {
    destroy: () => Promise.resolve(),
    fingerprints: ['stub-fingerprint'],
    getPage: async (pageNumber) => {
      state.requestedPages.push(pageNumber);

      if (state.unreadablePageNumbers.includes(pageNumber)) {
        throw new Error(`stub: page ${pageNumber} has an unreadable page dictionary.`);
      }

      return {
        cleanup: () => {
          state.cleanedUpPages.push(pageNumber);
        },
        getViewport: ({ scale }) => ({
          height: state.pageHeight * scale,
          scale,
          width: state.pageWidth * scale,
        }),
        render: () => ({
          promise: state.failingPageNumbers.includes(pageNumber)
            ? Promise.reject(new Error('Bounding box is required.'))
            : Promise.resolve(),
        }),
      };
    },
    numPages: state.numPages,
  };

  return { promise: Promise.resolve(stubDocument) };
}
