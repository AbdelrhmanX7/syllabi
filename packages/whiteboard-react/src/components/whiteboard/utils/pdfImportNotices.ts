/**
 * The calm, non-blocking side of a PDF import: the advisory notes the inspection pass produces
 * before anything is imported (low memory, tight storage) and the "some pages could not be
 * processed" notes the resilient importer appends to `summary.warnings` after a PARTIAL success.
 *
 * A partial success is not a failure — the rest of the pages are ready — so it must never render
 * as a red error. It also must not be swallowed: the modal closes on success, so the notice is
 * shown FIRST and the pages land when the teacher acknowledges it.
 */

import type { WbStringKey } from '../../../i18n/strings';

export const PDF_IMPORT_ADVISORY_TITLE: WbStringKey = 'pdfnotice.advisoryTitle';

export const PDF_PARTIAL_IMPORT_TITLE: WbStringKey = 'pdfnotice.partialTitle';

export const PDF_PARTIAL_IMPORT_REASSURANCE: WbStringKey = 'pdfnotice.partialReassurance';

/**
 * Pages the importer's SECOND engine rendered after the first one gave up (`summary.rescuedPageNumbers`
 * + `formatRescuedPdfPagesNotice`). Deliberately its own calm title: these pages imported COMPLETE,
 * so they belong nowhere near {@link PDF_PARTIAL_IMPORT_TITLE}, and the line must never hold the
 * modal open — nothing is owed to the teacher here beyond "we handled it".
 */
export const PDF_RESCUED_PAGES_TITLE: WbStringKey = 'pdfnotice.rescuedTitle';

/**
 * The warnings an import added on top of what the teacher already saw during inspection — those
 * pre-import notes are still on screen, so repeating them in the result notice is just noise.
 */
export function selectNewPdfImportWarnings(before: string[] | undefined, after: string[] | undefined): string[] {
  const alreadySeen = new Set(before ?? []);
  const fresh: string[] = [];

  for (const warning of after ?? []) {
    if (!warning || alreadySeen.has(warning)) {
      continue;
    }

    alreadySeen.add(warning);
    fresh.push(warning);
  }

  return fresh;
}
