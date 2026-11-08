import { createWhiteboardId } from './id';
import { normalizePaperSpacingMm, normalizeSheetAspect } from './page-geometry';

import type { BackgroundType, WhiteboardPage } from './types';

/**
 * Blank writing sheets inserted among a PDF's pages («Insert blank page», opt-in per host through
 * `WhiteboardEditor.allowInsertBlankPages`).
 *
 * A sheet is an ordinary {@link WhiteboardPage} in the document's page list — no PDF, its own
 * `canvasJSON`, `backgroundType` as its paper — plus {@link WhiteboardPage.sheetAspect} so the
 * continuous layout sizes it like the PDF page it follows. Ink is stored per page in a page-local
 * frame, so inserting or deleting a sheet only moves where later pages are STACKED; no stored
 * coordinate on any other page changes.
 *
 * Labels: a PDF page shows the PDF's OWN page number (`pdfSourcePageNumber`, else `pdfPageIndex + 1`);
 * any other page counts among the non-sheet pages (`index + 1` on a document without sheets); a sheet
 * is named after the page it follows with a letter: «3a», «3b». A sheet before every page is «0a».
 */

const hasBackground = (page: Pick<WhiteboardPage, 'pdfAssetId' | 'pdfImageUrl'>): boolean =>
  Boolean(page.pdfAssetId || page.pdfImageUrl);

export function isInsertedSheet(page: Pick<WhiteboardPage, 'pdfAssetId' | 'pdfImageUrl' | 'sheetAspect'> | undefined | null): boolean {
  return Boolean(page) && !hasBackground(page!) && normalizeSheetAspect(page!.sheetAspect) !== undefined;
}

export function createInsertedSheet(aspect: number, backgroundType: BackgroundType, paperSpacingMm?: number): WhiteboardPage {
  const spacing = normalizePaperSpacingMm(paperSpacingMm);

  return {
    ...(spacing !== undefined ? { paperSpacingMm: spacing } : {}),
    id: createWhiteboardId(),
    canvasJSON: '',
    thumbnail: '',
    backgroundType,
    sheetAspect: normalizeSheetAspect(aspect) ?? 297 / 210,
    viewportOffsetX: 0,
    viewportOffsetY: 0,
  };
}

/** `count`-th letter suffix: a … z, then aa, ab … */
function sheetSuffix(count: number): string {
  let n = count;
  let out = '';

  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);

  return out;
}

/** The label shown for every page (see the module note). */
export function resolvePageLabels(
  pages: ReadonlyArray<Pick<WhiteboardPage, 'pdfAssetId' | 'pdfImageUrl' | 'pdfPageIndex' | 'pdfSourcePageNumber' | 'sheetAspect'>>,
): string[] {
  let ordinal = 0;
  let anchor = '0';
  let sheetsSinceAnchor = 0;

  return pages.map((page) => {
    if (isInsertedSheet(page)) {
      const label = `${anchor}${sheetSuffix(sheetsSinceAnchor)}`;

      sheetsSinceAnchor += 1;

      return label;
    }

    ordinal += 1;
    sheetsSinceAnchor = 0;

    const own = hasBackground(page) ? (page.pdfSourcePageNumber ?? (typeof page.pdfPageIndex === 'number' ? page.pdfPageIndex + 1 : undefined)) : undefined;

    anchor = String(own !== undefined && Number.isFinite(own) && own >= 1 ? Math.floor(own) : ordinal);

    return anchor;
  });
}

/**
 * Where «insert after page `index`» puts the sheet: right after it, but after any sheets that already
 * follow it, so «3a» stays before a new «3b» and the PDF page that comes next stays next.
 */
export function resolveSheetInsertIndex(pages: ReadonlyArray<Pick<WhiteboardPage, 'pdfAssetId' | 'pdfImageUrl' | 'sheetAspect'>>, index: number): number {
  if (pages.length === 0) return 0;

  let insertAt = Math.min(Math.max(index, 0), pages.length - 1) + 1;

  while (insertAt < pages.length && isInsertedSheet(pages[insertAt])) insertAt += 1;

  return insertAt;
}

/** True when the page carries any ink (an empty canvas serializes with an empty `objects` array). */
export function pageHasInk(page: Pick<WhiteboardPage, 'canvasJSON'>): boolean {
  const json = page.canvasJSON?.trim();

  if (!json) return false;

  return !/"objects"\s*:\s*\[\s*\]/.test(json);
}
