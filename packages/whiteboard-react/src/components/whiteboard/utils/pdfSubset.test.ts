import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PDFDocument } from 'pdf-lib';

import { extractPdfSubset } from './pdfSubset';

async function makePdf(pageCount: number): Promise<Blob> {
  const doc = await PDFDocument.create();

  for (let i = 0; i < pageCount; i += 1) {
    const page = doc.addPage([200, 300]);

    page.drawText(`Page ${i + 1}`, { size: 24, x: 20, y: 260 });
  }

  const bytes = await doc.save();

  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

async function pageCountOf(blob: Blob): Promise<number> {
  const doc = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()));

  return doc.getPageCount();
}

test('extractPdfSubset keeps only the requested pages, in order', async () => {
  const source = await makePdf(5);
  const subset = await extractPdfSubset(source, [2, 4]);

  assert.equal(await pageCountOf(subset), 2);
});

test('extractPdfSubset drops out-of-range and duplicate page numbers', async () => {
  const source = await makePdf(3);
  // 1 and 2 survive (deduped); 99 is out of range and dropped.
  const subset = await extractPdfSubset(source, [1, 1, 99, 2]);

  assert.equal(await pageCountOf(subset), 2);
});

test('extractPdfSubset throws when no valid page is selected', async () => {
  const source = await makePdf(2);

  await assert.rejects(() => extractPdfSubset(source, [5, 6]));
});
