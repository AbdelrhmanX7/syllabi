/**
 * Saving a remote file to the user's disk, correctly.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The HTML `download` attribute is **silently ignored for cross-origin URLs**.
 * Every file we serve lives on another origin (Backblaze B2, CloudFront, or the
 * API subdomain), so this — which appears in several places across the repo —
 * has never once saved a file:
 *
 *     const link = document.createElement('a');
 *     link.href = remoteUrl;      // different origin → attribute ignored
 *     link.download = 'file.pdf';
 *     link.click();               // NAVIGATES. Opens a tab. Saves nothing.
 *
 * There is no error and no console warning; it reads and reviews as working
 * code. A second, independent trap sits on the same buttons: a plain navigation
 * carries **no Authorization header**, so an auth-guarded file route answers 401
 * — which is why `window.open(apiUrl)` is broken too, even where nobody meant
 * it as a download.
 *
 * The fix in both cases is to fetch the bytes ourselves and hand the browser a
 * blob URL. Blob URLs ARE same-origin, so the attribute works there.
 */

/** Options for {@link fetchAndSave}. */
export interface FetchAndSaveOptions {
  /**
   * Performs the request. Pass the app's authenticated axios client (or any
   * fetcher) so the Authorization header rides along — that is the whole point
   * for guarded routes. Must resolve the body as a Blob.
   */
  request: (url: string) => Promise<{ blob: Blob; contentDisposition?: string }>;
  /** Used when the server sends no usable filename. */
  fallbackFilename: string;
}

/**
 * Pulls the filename the server asked us to save under.
 *
 * Reads the RFC 5987 `filename*=UTF-8''<pct-encoded>` form FIRST. That matters
 * here specifically: titles may carry non-ASCII characters, and the plain quoted `filename=`
 * parameter cannot legally carry non-ASCII — it arrives mojibake or dropped,
 * browser-dependent. The quoted form is only a fallback for ASCII titles.
 *
 * Returns undefined when the header is absent, which is itself worth knowing:
 * a cross-origin response hides `Content-Disposition` from JS unless the server
 * sends `Access-Control-Expose-Headers: Content-Disposition`.
 */
export const filenameFromContentDisposition = (header?: string): string | undefined => {
  if (!header) return undefined;

  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);

  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // A malformed percent-sequence is not worth failing the download over.
    }
  }

  const quoted = /filename="?([^";]+)"?/i.exec(header);

  return quoted?.[1]?.trim();
};

/**
 * Strips the characters an OS refuses in a filename — and ONLY those.
 *
 * A lecture or board title containing `/` would otherwise write to a path that
 * does not exist. Non-ASCII characters are left alone: they are legal on every
 * filesystem we target, and mangling them would defeat the point of carrying the
 * real title through `filename*=UTF-8''` in the first place.
 *
 * **Spaces and hyphens are legal and must survive.** They look illegal at a
 * glance because they sit beside the forbidden set, and the first version of
 * this line had a literal `| -` where `|\x00-\x1f` belonged — a control-character
 * range collapsed into a space and a hyphen. It silently turned
 * «Unit summary 3.pdf» into «Unitsummary3.pdf» for every caller. Do not tidy them
 * back in.
 */
export const sanitizeFilename = (name: string, fallback = 'download'): string => {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '').trim();

  return cleaned || fallback;
};

/**
 * Hands an already-fetched blob to the browser's save dialog.
 *
 * Use this when you already hold the bytes. If you have a URL, use
 * {@link fetchAndSave} instead — never point an `<a download>` at a remote URL.
 */
export const saveBlobAs = (blob: Blob, filename: string): void => {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = objectUrl;
  link.download = sanitizeFilename(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoking synchronously can cancel the save in some browsers (Safari most
  // reliably). One frame is enough for the click to have been consumed.
  requestAnimationFrame(() => URL.revokeObjectURL(objectUrl));
};

/**
 * Fetches a remote file through the caller's client and saves it to disk.
 *
 * The `request` indirection exists so each app supplies its OWN authenticated
 * client — this package must not know about any app's axios instance or token
 * storage, and a guarded route needs that header to answer anything but 401.
 *
 * Example:
 * ```ts
 * await fetchAndSave(url, {
 *   fallbackFilename: `${lecture.title}.pdf`,
 *   request: async (u) => {
 *     const res = await api.get(u, { responseType: 'blob' });
 *     return { blob: res.data, contentDisposition: res.headers?.['content-disposition'] };
 *   },
 * });
 * ```
 */
export const fetchAndSave = async (url: string, options: FetchAndSaveOptions): Promise<void> => {
  const { blob, contentDisposition } = await options.request(url);

  saveBlobAs(blob, filenameFromContentDisposition(contentDisposition) || options.fallbackFilename);
};
