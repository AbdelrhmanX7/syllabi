/**
 * Turn an image FILE into a page background.
 *
 * A photographed worksheet and a rasterized PDF page are the same thing to the renderer: both land
 * in `WhiteboardPage.pdfImageUrl`, so the page fits and centres them and the teacher writes on top.
 * This module is the one place that decodes the bytes and decides how big the stored copy may be —
 * shared by the LAN "open this photo as a board" path and the editor's "add these photos as pages"
 * path, so a page built either way has identical geometry and weight.
 */

/**
 * Longest edge, in px, a stored page background may have.
 *
 * A phone camera sends 4000+ px and the board draws it at a fraction of that, so the extra pixels
 * buy nothing and cost real money: the background is persisted INSIDE the document as a data URL,
 * and an untouched 8 MP photo is ~6 MB of base64 per page. 2400 px still outruns a 4K board's fit
 * width.
 */
export const IMAGE_PAGE_MAX_EDGE = 2400;

/** Longest edge of a library/page-rail thumbnail. Matches the scale those surfaces paint at. */
export const IMAGE_PAGE_THUMBNAIL_EDGE = 320;

/** JPEG quality for anything this module re-encodes. High enough that handwriting stays crisp. */
const JPEG_QUALITY = 0.9;

/** A decoded image, ready to be written onto a page. */
export interface DecodedImagePageBackground {
  /** The background data URL to store in `pdfImageUrl`. */
  dataUrl: string;
  /** A small data URL, for a DOCUMENT cover only — never stored on a page (see `persistedPageThumbnail`). */
  thumbnail: string;
  /** Natural pixel size of the decoded source, for fit/placement maths. */
  width: number;
  height: number;
}

/** User-presentable, for every failure in here. */
const DECODE_FAILURE_MESSAGE = "This file isn't an image the board can display.";
const CANVAS_FAILURE_MESSAGE = "Couldn't prepare the image on this device.";

/** Whether a source format must keep its alpha channel (so it cannot be re-encoded as JPEG). */
function keepsAlpha(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/gif';
}

/** Draw `image` into a canvas scaled to `maxEdge` and read it back as a data URL. */
function rasterize(image: HTMLImageElement, maxEdge: number, mimeType: string): string {
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const canvas = document.createElement('canvas');

  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error(CANVAS_FAILURE_MESSAGE);
  }

  // A JPEG has no alpha, so an unpainted canvas would show through as black rather than white.
  if (!keepsAlpha(mimeType)) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return keepsAlpha(mimeType) ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

/** Read a blob as a data URL, with a user-facing message on the (rare) read failure. */
function blobToDataUrl(blob: Blob, failureMessage: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);

        return;
      }

      reject(new Error(failureMessage));
    };
    reader.onerror = () => reject(new Error(failureMessage));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode an image blob into a page background + a cover thumbnail.
 *
 * The original bytes are embedded verbatim when the image is already small enough — re-encoding a
 * file that needs no resizing would only throw away quality (and, for a PNG screenshot, size).
 *
 * @param blob - The image bytes. Its own `type` is used when `mimeType` is not given.
 * @param mimeType - Override for a blob that arrived without a usable type (a native file dialog).
 * @throws {Error} User-presentable, when the WebView cannot decode the file.
 */
export async function decodeImagePageBackground(blob: Blob, mimeType?: string): Promise<DecodedImagePageBackground> {
  const effectiveType = mimeType || blob.type || 'application/octet-stream';
  const typedBlob = blob.type === effectiveType ? blob : new Blob([blob], { type: effectiveType });
  const objectUrl = URL.createObjectURL(typedBlob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();

      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(DECODE_FAILURE_MESSAGE));
      element.src = objectUrl;
    });

    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error(DECODE_FAILURE_MESSAGE);
    }

    const needsResize = Math.max(image.naturalWidth, image.naturalHeight) > IMAGE_PAGE_MAX_EDGE;
    const dataUrl = needsResize
      ? rasterize(image, IMAGE_PAGE_MAX_EDGE, effectiveType)
      : await blobToDataUrl(typedBlob, "Couldn't read the image.");

    return {
      dataUrl,
      height: image.naturalHeight,
      thumbnail: rasterize(image, IMAGE_PAGE_THUMBNAIL_EDGE, 'image/jpeg'),
      width: image.naturalWidth,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
