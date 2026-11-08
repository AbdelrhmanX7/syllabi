export interface PdfExportPage {
  dataUrl: string;
  height: number;
  pixelHeight: number;
  pixelWidth: number;
  width: number;
}

const PDF_HEADER = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xff, 0xff, 0xff, 0xff, 0x0a,
]);
const PX_TO_POINTS = 72 / 96;

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function getJpegBytes(dataUrl: string): Uint8Array {
  const match = dataUrl.match(/^data:image\/jpeg;base64,(.+)$/i);

  if (!match) {
    throw new Error('PDF export expects JPEG page snapshots.');
  }

  return decodeBase64(match[1]);
}

function formatPdfNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export async function buildPdfFromJpegPages(pages: PdfExportPage[]): Promise<Blob> {
  const chunks: Uint8Array[] = [PDF_HEADER];
  const offsets: number[] = [0];
  let byteLength = PDF_HEADER.length;
  let objectCount = 2;

  const pageObjectIds: number[] = [];
  const contentObjectIds: number[] = [];
  const imageObjectIds: number[] = [];

  for (let index = 0; index < pages.length; index += 1) {
    const baseId = 3 + index * 3;

    pageObjectIds.push(baseId);
    contentObjectIds.push(baseId + 1);
    imageObjectIds.push(baseId + 2);
    objectCount += 3;
  }

  const pushBytes = (bytes: Uint8Array) => {
    chunks.push(bytes);
    byteLength += bytes.length;
  };

  const pushText = (value: string) => {
    pushBytes(encodeText(value));
  };

  const startObject = (id: number) => {
    offsets[id] = byteLength;
    pushText(`${id} 0 obj\n`);
  };

  const endObject = () => {
    pushText('endobj\n');
  };

  startObject(1);
  pushText('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObject();

  startObject(2);
  pushText(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>\n`);
  endObject();

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];

    if (!page) {
      continue;
    }

    const pageWidth = Math.max(1, page.width * PX_TO_POINTS);
    const pageHeight = Math.max(1, page.height * PX_TO_POINTS);
    const imageBytes = getJpegBytes(page.dataUrl);
    const imageName = `/Im${index + 1}`;
    const pageObjectId = pageObjectIds[index];
    const contentObjectId = contentObjectIds[index];
    const imageObjectId = imageObjectIds[index];
    const contentStream = encodeText(
      `q\n${formatPdfNumber(pageWidth)} 0 0 ${formatPdfNumber(pageHeight)} 0 0 cm\n${imageName} Do\nQ\n`,
    );

    startObject(pageObjectId);
    pushText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatPdfNumber(pageWidth)} ${formatPdfNumber(pageHeight)}] /Resources << /XObject << ${imageName} ${imageObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>\n`,
    );
    endObject();

    startObject(contentObjectId);
    pushText(`<< /Length ${contentStream.length} >>\nstream\n`);
    pushBytes(contentStream);
    pushText('endstream\n');
    endObject();

    startObject(imageObjectId);
    pushText(
      `<< /Type /XObject /Subtype /Image /Width ${Math.max(1, Math.round(page.pixelWidth))} /Height ${Math.max(1, Math.round(page.pixelHeight))} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`,
    );
    pushBytes(imageBytes);
    pushText('\nendstream\n');
    endObject();
  }

  const xrefOffset = byteLength;

  pushText(`xref\n0 ${objectCount + 1}\n`);
  pushText('0000000000 65535 f \n');

  for (let id = 1; id <= objectCount; id += 1) {
    pushText(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }

  pushText(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob(chunks, { type: 'application/pdf' });
}
