import { test, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The double-load regression, pinned.
 *
 * A rendered PDF page used to be fetched and decoded TWICE per page view (once by
 * `usePdfPageImage` to verify it, once by `WhiteboardCanvas` to paint it) because the two loads
 * disagreed about `crossOrigin` and therefore never shared a browser cache entry — and the desktop
 * shell has no HTTP cache for the `pdfpage://` protocol at all (WebView2Feedback#4687). At the
 * default `high` quality that is ~37 MB of RGBA decoded on the main thread, twice, while the
 * teacher writes.
 */

interface FakeImage {
  crossOrigin: string | null;
  decoding: string;
  naturalHeight: number;
  naturalWidth: number;
  onerror: (() => void) | null;
  onload: (() => void) | null;
  src: string;
  decode: () => Promise<void>;
}

/** Every image the module constructed, in order — the load counter these tests assert on. */
let constructed: FakeImage[] = [];
/** URLs that should fail to load (everything else resolves with a real pixel size). */
let failing = new Set<string>();

before(() => {
  class StubImage implements FakeImage {
    crossOrigin: string | null = null;
    decoding = '';
    naturalHeight = 0;
    naturalWidth = 0;
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    private srcValue = '';

    get src(): string {
      return this.srcValue;
    }

    set src(value: string) {
      this.srcValue = value;
      constructed.push(this);

      // Resolve asynchronously, like a real load.
      queueMicrotask(() => {
        if (failing.has(value)) {
          this.onerror?.();

          return;
        }

        this.naturalWidth = 2546;
        this.naturalHeight = 3600;
        this.onload?.();
      });
    }

    async decode(): Promise<void> {
      if (failing.has(this.srcValue)) {
        throw new Error('decode failed');
      }
    }
  }

  (globalThis as unknown as { Image: unknown }).Image = StubImage;
});

beforeEach(async () => {
  const { __resetPdfPageImageCache } = await import('./pdfPageImageLoader');

  __resetPdfPageImageCache();
  constructed = [];
  failing = new Set<string>();
});

test('the same raster is fetched and decoded once, not once per consumer', async () => {
  const { loadPdfPageImage } = await import('./pdfPageImageLoader');
  const url = 'http://pdfpage.localhost/render?asset=a&page=3&edge=3584';

  // The hook verifies the URL...
  const verified = await loadPdfPageImage(url);
  // ...and the canvas painter then asks for the very same URL.
  const painted = await loadPdfPageImage(url);

  assert.ok(verified, 'the verification load must resolve an image');
  assert.equal(constructed.length, 1, 'the second consumer must NOT issue a second load');
  assert.equal(painted, verified, 'both consumers must share one decoded element');
});

test('concurrent consumers of one URL share a single in-flight load', async () => {
  const { loadPdfPageImage } = await import('./pdfPageImageLoader');
  const url = 'http://pdfpage.localhost/render?asset=a&page=0&edge=3584';

  const [a, b, c] = await Promise.all([loadPdfPageImage(url), loadPdfPageImage(url), loadPdfPageImage(url)]);

  assert.equal(constructed.length, 1, 'racing callers must coalesce onto one load');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('every load sets crossOrigin — a mismatch is what made the two loads miss each other', async () => {
  const { loadPdfPageImage } = await import('./pdfPageImageLoader');

  await loadPdfPageImage('http://pdfpage.localhost/render?asset=a&page=1&edge=3584');

  assert.equal(constructed[0]?.crossOrigin, 'anonymous');
  assert.equal(constructed[0]?.decoding, 'async', 'async decoding keeps the decode off the main thread');
});

test('a failed load resolves null and is NOT cached, so it can be retried', async () => {
  const { loadPdfPageImage } = await import('./pdfPageImageLoader');
  const url = 'http://pdfpage.localhost/render?asset=missing&page=0&edge=3584';

  failing.add(url);

  assert.equal(await loadPdfPageImage(url), null, 'a broken URL must resolve null (→ pdf.js fallback)');

  failing.delete(url);

  const retried = await loadPdfPageImage(url);

  assert.ok(retried, 'the retry must actually reload — a 404 before the PDF was cached is transient');
  assert.equal(constructed.length, 2);
});

test('the cache stays small enough not to pin hundreds of MB of RGBA', async () => {
  const { loadPdfPageImage, PDF_PAGE_IMAGE_CACHE_SIZE } = await import('./pdfPageImageLoader');

  assert.equal(PDF_PAGE_IMAGE_CACHE_SIZE, 2, 'one page on screen + the one being switched to');

  const url = (page: number) => `http://pdfpage.localhost/render?asset=a&page=${page}&edge=3584`;

  for (let page = 0; page < PDF_PAGE_IMAGE_CACHE_SIZE + 1; page += 1) {
    await loadPdfPageImage(url(page));
  }

  assert.equal(constructed.length, 3);

  // Page 0 was evicted by the third load; the two most recent are still hits.
  await loadPdfPageImage(url(2));
  await loadPdfPageImage(url(1));

  assert.equal(constructed.length, 3, 'recent pages stay resident');

  await loadPdfPageImage(url(0));

  assert.equal(constructed.length, 4, 'the oldest page was evicted and must reload');
});

test('an empty URL resolves null without touching the network', async () => {
  const { loadPdfPageImage } = await import('./pdfPageImageLoader');

  assert.equal(await loadPdfPageImage(undefined), null);
  assert.equal(await loadPdfPageImage(''), null);
  assert.equal(constructed.length, 0);
});
