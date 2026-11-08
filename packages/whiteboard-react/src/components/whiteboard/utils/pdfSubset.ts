/**
 * Extract a SUBSET of pages from a PDF into a new standalone PDF blob.
 *
 * The board only uploads the pages the teacher actually imported (e.g. 10 of 200) instead of the
 * whole source file — the driver for this feature is the teacher's low upload speed, so we never
 * send pages they aren't using.
 *
 * `pageNumbers` are 1-based page numbers in the ORIGINAL file, in the order they should appear in the
 * produced subset. The returned blob's page order matches `pageNumbers`, so a board page's
 * `pdfPageIndex` (its position in this subset) is exactly the index into the returned asset — which
 * is also what the server-merge manifest embeds.
 *
 * pdf-lib is dynamic-imported so it only loads when a subset is actually built (keeps ~300KB out of
 * the initial bundle for apps/flows that never split a PDF).
 */
export async function extractPdfSubset(file: Blob, pageNumbers: number[]): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib');

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  // ignoreEncryption: some teacher PDFs carry a (permission-only) owner password; we still need to
  // copy their pages. updateMetadata:false keeps pdf-lib from stamping a producer string.
  const source = await PDFDocument.load(sourceBytes, { ignoreEncryption: true, updateMetadata: false });
  const totalPages = source.getPageCount();

  // Map 1-based original page numbers to 0-based pdf-lib indices, dropping out-of-range/duplicate
  // entries while preserving the requested order.
  const seen = new Set<number>();
  const indices: number[] = [];

  for (const pageNumber of pageNumbers) {
    const index = pageNumber - 1;

    if (!Number.isInteger(index) || index < 0 || index >= totalPages || seen.has(index)) {
      continue;
    }

    seen.add(index);
    indices.push(index);
  }

  if (indices.length === 0) {
    throw new Error('PDF subset would be empty.');
  }

  const target = await PDFDocument.create();
  const copiedPages = await target.copyPages(source, indices);

  for (const page of copiedPages) {
    target.addPage(page);
  }

  const outBytes = await target.save();

  return new Blob([outBytes as BlobPart], { type: 'application/pdf' });
}
