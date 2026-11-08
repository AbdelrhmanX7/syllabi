// Picked files → PDFs the notebook import understands. A PDF passes through; Word / PowerPoint /
// Excel / text files are converted by the backend (`POST /convert/pdf`, LibreOffice); photos (camera JPEGs,
// HEIF, WebP, screenshots) are re-encoded through a canvas — pdf-lib embeds only JPG/PNG and ignores
// EXIF rotation, and a 12 MP photo is too heavy for the tablet — then laid out one per A4-wide page.

import { studyPostRawBlob } from '@/lib/api/http';

const A4_WIDTH = 595.28;
const MAX_EDGE = 2400;
const OFFICE_EXT = ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'odp', 'ods', 'rtf', 'txt'];

export const PICKER_ACCEPT = ['application/pdf', '.pdf', 'image/*', ...OFFICE_EXT.map((ext) => `.${ext}`)].join(',');

export const isOfficeFile = (file: Pick<File, 'name'>) =>
  OFFICE_EXT.includes(file.name.split('.').pop()?.toLowerCase() ?? '');

export const isPdfFile = (file: Pick<File, 'name' | 'type'>) =>
  file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

export const isImageFile = (file: Pick<File, 'name' | 'type'>) =>
  file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(file.name);

export const pdfNameFor = (name: string) => `${name.replace(/\.[^./]+$/, '').trim() || 'Photo'}.pdf`;

async function photoToJpeg(file: File): Promise<{ bytes: ArrayBuffer; width: number; height: number }> {
  // createImageBitmap applies EXIF orientation by default ('from-image').
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`Could not read the photo «${file.name}»`);
  });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');

  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  if (!context) throw new Error('This device cannot convert photos');
  // White under transparent PNGs, not black.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));

  if (!blob) throw new Error(`Could not convert the photo «${file.name}»`);

  return { bytes: await blob.arrayBuffer(), width, height };
}

/** Photos → one PDF, a page per photo in the order given. */
export async function photosToPdf(photos: File[], fileName: string): Promise<File> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();

  for (const photo of photos) {
    const { bytes, width, height } = await photoToJpeg(photo);
    const image = await pdf.embedJpg(bytes);
    const pageHeight = A4_WIDTH * (height / width);
    const page = pdf.addPage([A4_WIDTH, pageHeight]);

    page.drawImage(image, { x: 0, y: 0, width: A4_WIDTH, height: pageHeight });
  }

  const bytes = await pdf.save();

  return new File([bytes as BlobPart], fileName, { type: 'application/pdf' });
}

/** Word / PowerPoint / Excel / text → PDF on the backend (~2 s; up to 55 s for a big deck). */
export async function officeToPdf(file: File): Promise<File> {
  const res = await studyPostRawBlob('/convert/pdf', file, {
    'Content-Type': file.type || 'application/octet-stream',
    'X-File-Name': encodeURIComponent(file.name),
  });
  const blob = await res.blob();

  // Our own name (keeps non-ASCII characters intact; the header's ASCII form turns them into "_").
  return new File([blob], pdfNameFor(file.name), { type: 'application/pdf' });
}

/** Any supported file → a PDF; throws a readable error for anything else. */
export async function fileToPdf(file: File): Promise<File> {
  if (isPdfFile(file)) return file;
  if (isImageFile(file)) return photosToPdf([file], pdfNameFor(file.name));
  if (isOfficeFile(file)) return officeToPdf(file);
  throw new Error(`«${file.name}» is not a PDF, an Office file or a photo`);
}
