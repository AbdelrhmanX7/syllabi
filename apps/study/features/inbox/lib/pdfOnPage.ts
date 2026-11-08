// Is a queued inbox PDF already wholly in the note? Claude can file the same PDF into a note twice
// (`add_inbox_to_page` re-queues an item, a REST PATCH too). The import sheet then disables Import
// («All the selected pages are already there») and Cancel sends no signal, so the item would stay
// queued on every open, on every device. The queue skips such a PDF and marks it used instead.

/** The fields of a board page this check reads (`WhiteboardPage`). */
export interface PdfPageRef {
  pdfAssetId?: string;
  pdfSourceName?: string;
  pdfPageIndex?: number;
  pdfSourcePageNumber?: number;
}

/** The fields of a stored PDF asset this check reads (`WhiteboardPdfAsset`). */
export interface PdfAssetRef {
  pageCount: number;
  size: number;
}

/**
 * True when every page of the downloaded file (`fileName` = `phone-<itemId>.pdf`, `fileSize` bytes)
 * is on the note. The page total comes from a WHOLE-file asset (same byte size as the download);
 * a subset import stores a cut-down asset whose `pageCount` is not the file's, so with only those
 * the total is unknown and this answers false (the sheet opens and offers the missing pages).
 */
export function pdfWhollyOnPage({
  pages,
  assets,
  fileName,
  fileSize,
}: {
  pages: readonly PdfPageRef[];
  assets: ReadonlyMap<string, PdfAssetRef | null>;
  fileName: string;
  fileSize: number;
}): boolean {
  const present = new Set<number>();
  let total = 0;

  for (const page of pages) {
    if (page.pdfSourceName !== fileName || !page.pdfAssetId) continue;
    const number = page.pdfSourcePageNumber ?? (page.pdfPageIndex !== undefined ? page.pdfPageIndex + 1 : undefined);

    if (number !== undefined) present.add(number);
    const asset = assets.get(page.pdfAssetId);

    if (asset && asset.size === fileSize) total = Math.max(total, asset.pageCount);
  }
  if (total <= 0) return false;
  for (let number = 1; number <= total; number++) if (!present.has(number)) return false;

  return true;
}
