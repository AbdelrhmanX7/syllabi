/**
 * ONE fetch + ONE decode per rendered PDF page raster, shared by every consumer.
 *
 * # Why this module exists
 *
 * The same page image used to be loaded TWICE for a single page view:
 *
 * 1. `usePdfPageImage` loaded the `pdfpage://` URL into a throwaway `new Image()` purely to verify
 *    it renders (and to read `naturalWidth/Height` for the next render's aspect), with NO
 *    `crossOrigin`.
 * 2. `WhiteboardCanvas` then loaded THE SAME URL again with `crossOrigin = 'anonymous'`.
 *
 * A different `crossOrigin` is a different Chromium image-cache key, so load 2 could never reuse
 * load 1 — and the desktop shell has no HTTP cache to fall back on either: WebView2 ignores
 * `Cache-Control` on custom-protocol responses (WebView2Feedback#4687, documented in
 * `apps/whiteboard/lib/platform/pdf.ts`), so BOTH loads reached Rust and shipped the whole
 * multi-MB image across the protocol boundary. The export path had the identical pair
 * (`resolveNativePdfPageImageUrl`'s verification load, then `loadCanvasImage`).
 *
 * At the default `high` quality a page raster is ~2546x3600 = ~9.2 megapixels = ~37 MB decoded
 * RGBA, and every decode in this tree is a main-thread `HTMLImageElement` decode. Halving the
 * decodes (and the protocol transfers) is worth real milliseconds on the studio touchscreen, where
 * the teacher is writing while this happens.
 *
 * # What it does
 *
 * - One in-flight promise per URL, so two callers racing the same raster share a single load.
 * - A tiny LRU of already-decoded images so the second caller (the canvas painter, a moment after
 *   the hook's verification) gets the SAME `HTMLImageElement` with no network and no decode.
 * - `crossOrigin = 'anonymous'` unconditionally: the export compositor needs an untainted canvas
 *   for `toDataURL`, and a single shared cache key is the whole point. The native protocol answers
 *   `Access-Control-Allow-Origin: *` on every response (including 404s), and `data:` URLs (the OLF
 *   template pages) are unaffected by the attribute.
 * - `img.decode()` before handing the image out: in Chromium that moves the decode OFF the main
 *   thread, so the first `drawImage` no longer stalls the compositor. `createImageBitmap` would
 *   also decode off-thread, but every consumer here is typed on `HTMLImageElement` and reads
 *   `naturalWidth`/`naturalHeight` (the painter, the frame publisher, the export compositor, Fabric),
 *   so it would buy little over `decode()` for a much wider blast radius. A rejected `decode()`
 *   falls back to the plain `load` event.
 *
 * # Memory
 *
 * {@link PDF_PAGE_IMAGE_CACHE_SIZE} entries x ~37 MB worst case. Kept at 2 deliberately: that is
 * exactly "the page on screen + the one being switched to", which is what makes the double-load
 * collapse, and no more — a bigger cache would pin hundreds of MB of RGBA on the weak board.
 */

/** How many decoded page rasters stay resident. See the "Memory" note above before raising this. */
export const PDF_PAGE_IMAGE_CACHE_SIZE = 2;

/** Insertion-ordered (Map iteration order) LRU of decoded rasters, keyed by URL. */
const decoded = new Map<string, HTMLImageElement>();

/** Loads currently in flight, keyed by URL, so concurrent callers share one network load. */
const inFlight = new Map<string, Promise<HTMLImageElement | null>>();

function remember(url: string, image: HTMLImageElement): void {
  // Re-insert so a hit refreshes recency (Map keeps insertion order).
  decoded.delete(url);
  decoded.set(url, image);

  while (decoded.size > PDF_PAGE_IMAGE_CACHE_SIZE) {
    const oldest = decoded.keys().next();

    if (oldest.done) {
      break;
    }

    decoded.delete(oldest.value);
  }
}

async function loadOnce(url: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') {
    return null;
  }

  const image = new Image();
  // Both halves of the former double-load must agree on crossOrigin or they are two cache entries.
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';

  const settled = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });

  image.src = url;

  try {
    // Off-main-thread decode. Resolves only after `load`, so it never races the event below.
    await image.decode();
  } catch {
    // Older WebViews (and the odd spurious EncodingError) reject here even for an image that
    // loads fine — the `load`/`error` race below is the authority either way.
  }

  const loaded = await settled;

  if (!loaded || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return null;
  }

  return image;
}

/**
 * Load (or reuse) the decoded raster at `url`.
 *
 * Resolves `null` when the URL does not render — callers treat that as "fall back to pdf.js" /
 * "leave the page blank", exactly as the hand-rolled `new Image()` promises they replaced did.
 * Failures are deliberately NOT cached: a native render that 404'd because the PDF was not cached
 * yet must be retryable.
 */
export async function loadPdfPageImage(url: string | undefined): Promise<HTMLImageElement | null> {
  if (!url) {
    return null;
  }

  const cached = decoded.get(url);

  if (cached) {
    remember(url, cached);

    return cached;
  }

  const pending = inFlight.get(url);

  if (pending) {
    return await pending;
  }

  const load = loadOnce(url)
    .then((image) => {
      if (image) {
        remember(url, image);
      }

      return image;
    })
    .finally(() => {
      inFlight.delete(url);
    });

  inFlight.set(url, load);

  return await load;
}

/** Test-only: drop every cached/in-flight raster so cases cannot leak into each other. */
export function __resetPdfPageImageCache(): void {
  decoded.clear();
  inFlight.clear();
}
