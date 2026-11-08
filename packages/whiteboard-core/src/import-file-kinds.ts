/**
 * What a picked/dropped file IS, decided by name alone.
 *
 * One module, because the same question is asked from four places that must never disagree: the
 * board's import modal, the canvas drop zone, the home-page picker, and the LAN inbox. When they
 * disagreed, a photo the inbox happily called "an image" was refused by the modal as "PDF only".
 *
 * Name-based on purpose. A `File` picked through a native Tauri dialog can arrive with an empty
 * `type`, and a file re-wrapped from raw bytes carries whatever MIME the wrapper guessed — so the
 * extension is the only field that is reliably present on every path.
 */

/**
 * Image formats the board can actually draw.
 *
 * HEIC is deliberately absent: it is what an iPhone sends by default and WebView2 cannot decode it,
 * so a HEIC "import" would put a blank page on the board. It gets its own rejection
 * ({@link HEIC_IMPORT_REJECTION}) rather than falling into the generic "unsupported file" message,
 * because the teacher needs to be told the fix (export as JPEG), not just that it failed.
 */
export const IMPORTABLE_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const;

/** Formats an iPhone/modern camera produces that no WebView on our devices can decode. */
export const UNDECODABLE_IMAGE_EXTENSIONS = ['heic', 'heif'] as const;

/** PowerPoint files, importable only where the host can convert them to PDF first. */
export const OFFICE_IMPORT_EXTENSIONS = ['pptx', 'ppt'] as const;

/** `accept` fragment for the image half of a file input. */
export const IMAGE_IMPORT_ACCEPT =
  '.png,.jpg,.jpeg,.webp,.gif,.bmp,image/png,image/jpeg,image/webp,image/gif,image/bmp';

/** User-presentable: the file is an image, but not one this board can decode. */
export const HEIC_IMPORT_REJECTION =
  "iPhone HEIC photos can't be opened on the board. Switch the camera format to JPEG, or export the photo as JPEG and try again.";

/** User-presentable: a selection that mixes PDFs and images. */
export const MIXED_IMPORT_REJECTION = 'Choose only PDFs or only images — import them separately.';

/** User-presentable: nothing in the selection can go on a board. */
export const UNSUPPORTED_IMPORT_REJECTION = "This file isn't a PDF or an image that can go on the board.";

/** The extension of a file name, lower-cased, without the dot; `''` when it has none. */
export function fileExtensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());

  return match?.[1]?.toLowerCase() ?? '';
}

/** Whether this name is a PDF. */
export function isPdfFileName(name: string): boolean {
  return fileExtensionOf(name) === 'pdf';
}

/** Whether this name is an image the board can draw — see {@link IMPORTABLE_IMAGE_EXTENSIONS}. */
export function isImportableImageFileName(name: string): boolean {
  return (IMPORTABLE_IMAGE_EXTENSIONS as readonly string[]).includes(fileExtensionOf(name));
}

/** Whether this name is an image format the WebView cannot decode (HEIC/HEIF). */
export function isUndecodableImageFileName(name: string): boolean {
  return (UNDECODABLE_IMAGE_EXTENSIONS as readonly string[]).includes(fileExtensionOf(name));
}

/** Whether this name is a PowerPoint file (importable only with a host-side converter). */
export function isOfficeImportFileName(name: string): boolean {
  return (OFFICE_IMPORT_EXTENSIONS as readonly string[]).includes(fileExtensionOf(name));
}

/** The MIME type to stamp on an image's `File`/`Blob`, so the WebView decodes it. */
export function imageMimeTypeForFileName(name: string): string {
  switch (fileExtensionOf(name)) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

/** The `accept` attribute for an import picker, given what the host can handle. */
export function buildImportAccept(opts?: { office?: boolean; images?: boolean; pdf?: boolean }): string {
  const parts: string[] = [];

  if (opts?.pdf !== false) {
    parts.push('.pdf');
  }

  if (opts?.office) {
    parts.push('.pptx', '.ppt');
  }

  if (opts?.images !== false) {
    parts.push(IMAGE_IMPORT_ACCEPT);
  }

  return parts.join(',');
}

/** A selection split by what each file can become on a board. Input order is preserved in each bucket. */
export interface ImportFilePartition<T> {
  /** Real PDFs. */
  pdfs: T[];
  /** PowerPoint files — PDFs only after a host-side conversion. */
  office: T[];
  /** Images the board can draw. */
  images: T[];
  /** Images no WebView here can decode (HEIC/HEIF) — rejected with their own message. */
  undecodableImages: T[];
  /** Everything else: videos, archives, folders. */
  other: T[];
}

/**
 * Split a picked/dropped selection into what the board can do with each file.
 *
 * Pure and name-only, so the drop zone, the modal and the home page all reach the same verdict —
 * and so it is testable without a DOM.
 */
export function partitionImportFiles<T>(files: readonly T[], nameOf: (file: T) => string): ImportFilePartition<T> {
  const partition: ImportFilePartition<T> = { images: [], office: [], other: [], pdfs: [], undecodableImages: [] };

  for (const file of files) {
    const name = nameOf(file);

    if (isPdfFileName(name)) {
      partition.pdfs.push(file);
    } else if (isImportableImageFileName(name)) {
      partition.images.push(file);
    } else if (isUndecodableImageFileName(name)) {
      partition.undecodableImages.push(file);
    } else if (isOfficeImportFileName(name)) {
      partition.office.push(file);
    } else {
      partition.other.push(file);
    }
  }

  return partition;
}

/** What an import surface should DO with a selection. */
export type ImportRouteKind = 'pdf' | 'images' | 'rejected';

export type ImportRoute<T> =
  | { kind: 'pdf'; file: T }
  | { kind: 'images'; files: T[] }
  | { kind: 'rejected'; message: string };

/**
 * Decide, for one selection, which import path it takes — or why it takes none.
 *
 * The rules, in the order a teacher would expect them:
 *
 * 1. PDFs (and PowerPoint where a converter exists) win when the selection is all documents. The
 *    PDF path is single-file because the page-range picker is per-file, so the first one is taken.
 * 2. An all-image selection goes to the image path, every file, in the order they were picked.
 * 3. A MIXED selection is refused with one message rather than half-processed: silently importing
 *    the PDFs and dropping the photos would look like the photos simply vanished.
 * 4. A HEIC in the selection is named specifically, since the teacher can fix it on the phone.
 */
export function routeImportSelection<T>(
  files: readonly T[],
  nameOf: (file: T) => string,
  opts?: { office?: boolean },
): ImportRoute<T> {
  const { images, office, other, pdfs, undecodableImages } = partitionImportFiles(files, nameOf);
  const documents = opts?.office ? [...pdfs, ...office] : pdfs;

  if (documents.length > 0 && images.length > 0) {
    return { kind: 'rejected', message: MIXED_IMPORT_REJECTION };
  }

  const firstDocument = documents[0];

  if (firstDocument !== undefined) {
    return { file: firstDocument, kind: 'pdf' };
  }

  if (images.length > 0) {
    return { files: images, kind: 'images' };
  }

  if (undecodableImages.length > 0) {
    return { kind: 'rejected', message: HEIC_IMPORT_REJECTION };
  }

  // A PowerPoint on a host with no converter: say what is missing rather than "not a PDF".
  if (office.length > 0) {
    return { kind: 'rejected', message: 'PowerPoint conversion is only available in the desktop app.' };
  }

  if (other.length > 0 || files.length > 0) {
    return { kind: 'rejected', message: UNSUPPORTED_IMPORT_REJECTION };
  }

  return { kind: 'rejected', message: UNSUPPORTED_IMPORT_REJECTION };
}
