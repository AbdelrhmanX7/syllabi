import {
  DEFAULT_PDF_PAGE_RANGE,
  createWhiteboardId,
  formatPdfPageRange,
  MAX_PDF_IMPORT_FILE_SIZE,
  MAX_PDF_IMPORT_PAGE_COUNT,
  parsePdfPageRange,
} from '@repo/whiteboard-core';

import type { WhiteboardPdfAsset } from '@repo/whiteboard-core';

import {
  getActivePdfQualityTuning,
  resolvePdfExportRenderEdge,
  resolvePdfLiveRenderEdge,
  resolvePdfPreviewJpegQuality,
  resolvePdfPreviewRenderEdge,
} from './pdfRenderSizing';
import { extractPdfSubset } from './pdfSubset';
import { yieldToBrowserDuringImport } from './pdfYieldScheduler';
import { userFacingError, wbT, type WbLocale } from '../../../i18n/strings';

const DEFAULT_PDF_MODULE_SRC = '/pdf.min.mjs';
const DEFAULT_PDF_WORKER_SRC = '/pdf.worker.min.mjs';
const PDF_PAGE_IMAGE_TYPE = 'image/jpeg';
const MAX_PDF_DOCUMENT_CACHE_ENTRIES = 2;
const MAX_PDF_ASSET_CACHE_ENTRIES = 2;
const MAX_RENDERED_PAGE_CACHE_ENTRIES = 36;

/**
 * A4 portrait aspect (595×842 pt) — the shape a placeholder falls back to when the page's own
 * viewport can't be read, which is exactly the case when `getPage` itself rejected on a damaged
 * page tree and we never got a page object to measure.
 */
const FALLBACK_PAGE_ASPECT_RATIO = 595 / 842;
/**
 * The blank-raster floor for the tier-2 rescue (see {@link PdfImportNativeRescue}). The probe
 * downscales the rescued page to at most this longest edge before sampling it, so the whole check is
 * one `drawImage` plus one `getImageData` over a few thousand pixels instead of a megapixel scan.
 */
const RESCUE_BLANK_PROBE_EDGE = 64;
/**
 * A pixel counts as PAINTED when any channel is at or below this — the same predicate the PDFium
 * measurement used, so "blank" here means exactly what it meant in that evidence table.
 */
const RESCUE_PAINTED_CHANNEL_MAX = 250;
// i18n-ignore: baked into the stand-in page image itself (board content, persisted with the board)
const PLACEHOLDER_PAGE_NOTICE = "Couldn't process this page";
/** Beyond this many page numbers the warning collapses the tail into «and N more». */
const MAX_LISTED_FAILED_PAGES = 8;
/**
 * A partial failure is ordinary — one malformed transparency group or one broken font inside an
 * otherwise fine 45-page file — and must never cost the teacher the whole import. A file where
 * (nearly) every page fails is a different animal: it is corrupt or encrypted, and returning a deck
 * of placeholders would read as a successful import of blank pages. So the import aborts when EVERY
 * selected page failed, or when a selection of at least {@link MIN_PAGES_FOR_FAILURE_RATIO} pages
 * came back more than {@link IMPORT_FAILURE_RATIO_LIMIT} placeholders. The page floor is what keeps
 * a 1–4 page selection from tripping the ratio on a single bad page.
 */
const MIN_PAGES_FOR_FAILURE_RATIO = 5;
const IMPORT_FAILURE_RATIO_LIMIT = 0.8;

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfJsDocument = Awaited<ReturnType<PdfJsModule['getDocument']>['promise']>;
type PdfJsPage = Awaited<ReturnType<PdfJsDocument['getPage']>>;

export interface WhiteboardRemotePdfAsset {
  fileName?: string;
  headers?: Record<string, string>;
  id: string;
  pageCount: number;
  readUrl: string;
  size: number;
}

export type ResolveRemotePdfAsset = (assetId: string) => Promise<WhiteboardRemotePdfAsset | null>;
export type ResolvedWhiteboardPdfAsset = WhiteboardPdfAsset | WhiteboardRemotePdfAsset;

/**
 * TIER-2 RESCUE for a page pdf.js refuses to rasterize.
 *
 * pdf.js and PDFium are two INDEPENDENT parsers: the malformed transparency group that makes pdf.js
 * throw «Bounding box is required.» is something PDFium rasterizes without complaint. So a page the
 * fast path drops is re-rendered by the host's native renderer and comes out as a REAL page — the
 * placeholder is demoted to the third and last resort.
 *
 * This package is also consumed by plain web apps with NO native shell, so the capability is
 * INJECTED, never imported: nothing here touches a Tauri API, and a host that passes no rescue
 * keeps exactly the previous two tiers (pdf.js → placeholder).
 */
export interface PdfImportNativePageRequest {
  /** Identifier the SOURCE bytes were cached under — the very id `ensureSourceCached` was given. */
  assetId: string;
  /** 1-based page number in the source file, for the host's diagnostics. */
  pageNumber: number;
  /** JPEG quality (0..1) the pdf.js preview path would have used for this import. */
  quality: number;
  /**
   * 0-based page index IN THE SOURCE FILE (`pageNumber - 1`). Deliberately NOT the preview's
   * `pageIndex`: the native side renders the ORIGINAL file's page tree, which a subset import's
   * indices do not describe.
   */
  sourcePageIndex: number;
  /** Longest-edge target in px — the same pixel box a successful pdf.js render would have produced. */
  targetLongestEdge: number;
}

/** What a rescued page hands back: the same preview shape the good path produces. */
export interface PdfImportNativePagePreview {
  height: number;
  /** A data URL — import previews are persisted with the board, so an object URL would not survive. */
  previewImageUrl: string;
  width: number;
}

export interface PdfImportNativeRescue {
  /**
   * Stream the SOURCE file's bytes into the native cache under `assetId`, resolving `true` once they
   * are there. Called AT MOST ONCE per import, lazily, on the first page that actually needs a
   * rescue — see the memo inside {@link importPdfFile} for why.
   */
  ensureSourceCached: (args: { assetId: string; blob: Blob }) => Promise<boolean>;
  /** Whether native rendering works in this runtime at all; checked before a single byte is read. */
  isAvailable?: () => boolean;
  /** Render ONE page natively. Resolve `null` (or throw) when it cannot be produced → tier 3. */
  renderPage: (request: PdfImportNativePageRequest) => Promise<PdfImportNativePagePreview | null>;
}

export interface PdfImportDeviceProfile {
  availableStorageBytes?: number;
  deviceMemoryGb?: number;
  storageQuotaBytes?: number;
  storageUsageBytes?: number;
}

export interface PdfImportSummary {
  deviceProfile: PdfImportDeviceProfile;
  fileSize: number;
  fileName: string;
  fingerprint: string;
  normalizedPageRange: string;
  /**
   * Pages pdf.js could not rasterize but the native tier-2 rescue rendered anyway, in import order.
   * These are NOT failures — the pages are real and complete — so they are reported here as data and
   * never appended to {@link PdfImportSummary.warnings}, whose «Couldn't process …» copy says the
   * opposite. {@link formatRescuedPdfPagesNotice} is the calm line that describes them.
   */
  rescuedPageNumbers: number[];
  selectedPageCount: number;
  selectedPageNumbers: number[];
  totalPages: number;
  warnings: string[];
}

export interface ImportedPdfPagePreview {
  /**
   * Index of this page INTO the produced asset blob. For a whole-file import this equals
   * `pageNumber - 1`; for a subset import it is the page's position within the uploaded subset
   * (0..N-1). The server-merge manifest and the local renderer both index the asset by this.
   */
  pageIndex: number;
  /** 1-based page number in the ORIGINAL source file (stable across subset/whole; used for dedup). */
  pageNumber: number;
  previewImageUrl: string;
  /** Rendered preview pixel dimensions — carries the page's aspect ratio so the importer can open a
   *  new PDF page scrolled to its TOP (offset the initial viewport) without loading the image again. */
  width: number;
  height: number;
}

export interface PdfImportResult {
  asset: WhiteboardPdfAsset;
  pages: ImportedPdfPagePreview[];
  summary: PdfImportSummary;
  /**
   * True when only a strict subset of the source pages was imported, so `asset.blob` is a freshly
   * built standalone PDF containing ONLY those pages (in import order). Whole-file imports keep
   * `asset.blob` = the original file. Consumers use this to decide that each subset import is its own
   * distinct asset (never reuse a prior asset id for it).
   */
  isSubset: boolean;
}

interface PdfDocumentCacheEntry {
  cleanup: () => void;
  documentPromise: Promise<PdfJsDocument>;
}

interface RenderedPageCacheEntry {
  url: string;
}

const pdfDocumentCache = new Map<string, PdfDocumentCacheEntry>();
const pdfAssetCache = new Map<string, WhiteboardPdfAsset>();

/** Drop the in-memory copy of an asset (after its bytes were (re)written to storage) so the next
 * `loadCachedPdfAsset` re-reads the record instead of serving the stale remote-only view. */
export function forgetCachedPdfAsset(assetId: string): void {
  pdfAssetCache.delete(assetId);
}
const renderedPageCache = new Map<string, RenderedPageCacheEntry>();
const pendingRenderedPageCache = new Map<string, Promise<string>>();

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function touchMapEntry<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
}

function pruneRenderedPageCache(): void {
  while (renderedPageCache.size > MAX_RENDERED_PAGE_CACHE_ENTRIES) {
    const oldestEntry = renderedPageCache.entries().next().value as [string, RenderedPageCacheEntry] | undefined;

    if (!oldestEntry) {
      return;
    }

    const [oldestKey, oldestValue] = oldestEntry;

    URL.revokeObjectURL(oldestValue.url);
    renderedPageCache.delete(oldestKey);
  }
}

function prunePdfDocumentCache(): void {
  while (pdfDocumentCache.size > MAX_PDF_DOCUMENT_CACHE_ENTRIES) {
    const oldestEntry = pdfDocumentCache.entries().next().value as [string, PdfDocumentCacheEntry] | undefined;

    if (!oldestEntry) {
      return;
    }

    const [oldestKey, oldestValue] = oldestEntry;
    oldestValue.cleanup();
    pdfDocumentCache.delete(oldestKey);
  }
}

function prunePdfAssetCache(): void {
  while (pdfAssetCache.size > MAX_PDF_ASSET_CACHE_ENTRIES) {
    const oldestEntry = pdfAssetCache.entries().next().value as [string, WhiteboardPdfAsset] | undefined;

    if (!oldestEntry) {
      return;
    }

    const [oldestKey] = oldestEntry;

    pdfAssetCache.delete(oldestKey);
  }
}

/**
 * Cheap, synchronous device-memory read for the render hot path. Unlike
 * {@link getPdfImportDeviceProfile} it does NOT call `navigator.storage.estimate()` (which walks
 * local storage and can be slow when many PDF blobs are cached). The live page renderer only needs
 * `deviceMemory` to pick a resolution, so it uses this instead of the full async profile.
 */
export function getRenderDeviceMemoryGb(): number | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  return typeof deviceMemory === 'number' ? deviceMemory : undefined;
}

/**
 * Eagerly load the pdf.js module + worker so the first PDF page render doesn't pay the dynamic-import
 * and worker spin-up cost inline. Safe to call repeatedly (the module promise is memoized) and on the
 * web/SSR boundary (it simply no-ops if the import fails). Best-effort: failures are swallowed.
 */
export function warmPdfRuntime(moduleSrc = DEFAULT_PDF_MODULE_SRC, workerSrc = DEFAULT_PDF_WORKER_SRC): void {
  void loadPdfJsModule(moduleSrc)
    .then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
    })
    .catch(() => {
      // Warming is best-effort; the real render path will surface any genuine load error.
    });
}

export async function getPdfImportDeviceProfile(): Promise<PdfImportDeviceProfile> {
  if (typeof navigator === 'undefined') {
    return {};
  }

  const deviceMemoryGb =
    typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number'
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined;
  const storageManager = navigator.storage;

  if (!storageManager?.estimate) {
    return { deviceMemoryGb };
  }

  try {
    const estimate = await storageManager.estimate();

    return {
      availableStorageBytes:
        typeof estimate.quota === 'number' && typeof estimate.usage === 'number'
          ? estimate.quota - estimate.usage
          : undefined,
      deviceMemoryGb,
      storageQuotaBytes: estimate.quota,
      storageUsageBytes: estimate.usage,
    };
  } catch {
    return { deviceMemoryGb };
  }
}

function buildPdfImportWarnings({
  deviceProfile,
  fileSize,
  locale,
  selectedPageCount,
}: {
  deviceProfile: PdfImportDeviceProfile;
  fileSize: number;
  locale: WbLocale;
  selectedPageCount: number;
}): string[] {
  const warnings: string[] = [];

  if (fileSize >= 250 * 1024 * 1024 || selectedPageCount >= 250) {
    warnings.push(wbT(locale, 'pdfimport.warn.heavy'));
  }

  if (typeof deviceProfile.deviceMemoryGb === 'number' && deviceProfile.deviceMemoryGb <= 4) {
    warnings.push(wbT(locale, 'pdfimport.warn.lowMemory'));
  }

  if (
    typeof deviceProfile.availableStorageBytes === 'number' &&
    deviceProfile.availableStorageBytes > 0 &&
    deviceProfile.availableStorageBytes < Math.max(fileSize * 1.35, 180 * 1024 * 1024)
  ) {
    warnings.push(wbT(locale, 'pdfimport.warn.lowStorage'));
  }

  return warnings;
}

function validatePdfFileSize(fileSize: number, locale: WbLocale): void {
  if (fileSize > MAX_PDF_IMPORT_FILE_SIZE) {
    throw userFacingError(
      wbT(locale, 'pdfimport.fileTooLarge', { mb: Math.round(MAX_PDF_IMPORT_FILE_SIZE / (1024 * 1024)) }),
    );
  }
}

async function loadPdfJsModule(moduleSrc = DEFAULT_PDF_MODULE_SRC): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = (import(/* webpackIgnore: true */ moduleSrc) as Promise<PdfJsModule>).catch((error) => {
      pdfJsModulePromise = null;
      throw error;
    });
  }

  return pdfJsModulePromise;
}

async function openPdfDocumentFromBlob(
  blob: Blob,
  {
    moduleSrc = DEFAULT_PDF_MODULE_SRC,
    workerSrc = DEFAULT_PDF_WORKER_SRC,
  }: {
    moduleSrc?: string;
    workerSrc?: string;
  } = {},
): Promise<{ cleanup: () => void; document: PdfJsDocument }> {
  const pdfjsLib = await loadPdfJsModule(moduleSrc);

  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

  const objectUrl = URL.createObjectURL(blob);
  const loadingTask = pdfjsLib.getDocument({ isEvalSupported: false, url: objectUrl });

  try {
    const document = await loadingTask.promise;

    return {
      cleanup: () => {
        try {
          void document.destroy();
        } catch {
          // Ignore destroy errors during cleanup.
        }
        URL.revokeObjectURL(objectUrl);
      },
      document,
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function openPdfDocumentFromUrl(
  readUrl: string,
  {
    headers,
    moduleSrc = DEFAULT_PDF_MODULE_SRC,
    workerSrc = DEFAULT_PDF_WORKER_SRC,
  }: {
    headers?: Record<string, string>;
    moduleSrc?: string;
    workerSrc?: string;
  } = {},
): Promise<{ cleanup: () => void; document: PdfJsDocument }> {
  const pdfjsLib = await loadPdfJsModule(moduleSrc);

  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

  const loadingTask = pdfjsLib.getDocument({
    httpHeaders: headers,
    isEvalSupported: false,
    url: readUrl,
    withCredentials: false,
  });

  try {
    const document = await loadingTask.promise;

    return {
      cleanup: () => {
        try {
          void document.destroy();
        } catch {
          // Ignore destroy errors during cleanup.
        }
      },
      document,
    };
  } catch (error) {
    throw error;
  }
}

async function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read PDF page image.'));
    reader.readAsDataURL(blob);
  });
}

async function encodeCanvasAsDataUrl(canvas: HTMLCanvasElement, quality: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          resolve(canvas.toDataURL(PDF_PAGE_IMAGE_TYPE, quality));
          return;
        }

        try {
          resolve(await readBlobAsDataUrl(blob));
        } catch (error) {
          reject(error);
        }
      },
      PDF_PAGE_IMAGE_TYPE,
      quality,
    );
  });
}

async function encodeCanvasAsObjectUrl(
  canvas: HTMLCanvasElement,
  quality: number,
  mime: 'image/jpeg' | 'image/png' = PDF_PAGE_IMAGE_TYPE,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to encode the PDF page.'));
          return;
        }

        resolve(URL.createObjectURL(blob));
      },
      mime,
      // PNG ignores the quality arg; passing it is harmless.
      quality,
    );
  });
}

/**
 * `page.cleanup()` frees the page's parsed operator list. It can itself throw on a page pdf.js only
 * half-parsed — which is precisely the page we call it for — and a throw out of a `finally` would
 * replace the real failure with a bogus one, so swallow it: there is nothing left to free anyway.
 */
function cleanupPdfPageSafely(page: PdfJsPage | null): void {
  if (!page) {
    return;
  }

  try {
    page.cleanup();
  } catch {
    // Nothing to free — the page never finished parsing.
  }
}

/** Decode an image URL for the blankness probe, or `null` when this runtime cannot decode one. */
async function decodeImageForProbe(imageUrl: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') {
    return null;
  }

  return await new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();

    image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null);
    image.onerror = () => resolve(null);
    image.src = imageUrl;
  });
}

/**
 * Whether a rescued raster is entirely (near-)white, i.e. carries no content at all.
 *
 * MEASURED 2026-09-12 against both the Linux `libpdfium.so` and the `pdfium.dll` teachers actually
 * run, which agreed on every number: PDFium rescues the reported crash class with its real content
 * (an absent `/BBox`, a singular CTM, an SMask group, a nested group — all pixel-identical to the
 * patched pdf.js), but for a SHORT `/BBox` array (`[0 0]`, `[0 0 200]`) it pads the array with zeros
 * → a zero-area clip → a render that REPORTS SUCCESS and hands back a megapixel of pure white.
 * Poppler does the same, so the class is genuinely undefined and nothing in the native layer can
 * tell that bitmap from a page that is simply empty.
 *
 * Fails OPEN (`false`): a raster we could not inspect is kept, never discarded.
 */
async function isBlankRescuedRaster(previewImageUrl: string): Promise<boolean> {
  if (typeof document === 'undefined') {
    return false;
  }

  try {
    const image = await decodeImageForProbe(previewImageUrl);

    if (!image) {
      return false;
    }

    const scale = Math.min(1, RESCUE_BLANK_PROBE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const probeWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const probeHeight = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });

    if (!context) {
      return false;
    }

    canvas.width = probeWidth;
    canvas.height = probeHeight;
    // Paint the ground white first: if `drawImage` no-ops for any reason we read white and would
    // wrongly call a real page blank, so the probe only ever reports blank for pixels it truly saw.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, probeWidth, probeHeight);
    context.drawImage(image, 0, 0, probeWidth, probeHeight);

    const { data } = context.getImageData(0, 0, probeWidth, probeHeight);

    for (let offset = 0; offset + 2 < data.length; offset += 4) {
      // Early exit on the FIRST painted pixel — a page with content costs a handful of reads.
      if (
        (data[offset] ?? 255) <= RESCUE_PAINTED_CHANNEL_MAX ||
        (data[offset + 1] ?? 255) <= RESCUE_PAINTED_CHANNEL_MAX ||
        (data[offset + 2] ?? 255) <= RESCUE_PAINTED_CHANNEL_MAX
      ) {
        canvas.width = 0;
        canvas.height = 0;

        return false;
      }
    }

    canvas.width = 0;
    canvas.height = 0;

    return true;
  } catch {
    return false;
  }
}

/**
 * Natural (scale-1) page dimensions, or `null` when there is no page object or the page dict is so
 * damaged that even `getViewport` throws.
 */
function readNaturalPageSize(page: PdfJsPage | null): { height: number; width: number } | null {
  if (!page) {
    return null;
  }

  try {
    const viewport = page.getViewport({ scale: 1 });

    if (!(viewport.width > 0) || !(viewport.height > 0)) {
      return null;
    }

    return { height: viewport.height, width: viewport.width };
  } catch {
    return null;
  }
}

/**
 * Pixel box for a placeholder: the real page's aspect ratio when we could read it, else A4 portrait,
 * scaled so the longest edge matches what a successful render would have produced. Matching a real
 * render's box matters — the importer opens a freshly added PDF page scrolled to its top using these
 * dimensions, so a placeholder of the wrong shape would land the teacher on a mispositioned page.
 */
function resolvePlaceholderPageSize(
  page: PdfJsPage | null,
  targetLongestEdge: number,
): { height: number; width: number } {
  const naturalSize = readNaturalPageSize(page);
  const aspectRatio = naturalSize ? naturalSize.width / naturalSize.height : FALLBACK_PAGE_ASPECT_RATIO;
  const longestEdge = Math.max(1, Math.round(targetLongestEdge));

  return aspectRatio >= 1
    ? { height: Math.max(1, Math.round(longestEdge / aspectRatio)), width: longestEdge }
    : { height: longestEdge, width: Math.max(1, Math.round(longestEdge * aspectRatio)) };
}

/**
 * A page-shaped white canvas carrying the «Couldn't process this page» note. Returns `null` when
 * the runtime hands back no 2D context at all (SSR, a canvas-less test environment) so callers can
 * fall back to the SVG data URL below, which needs no canvas.
 */
function createPlaceholderPageCanvas({
  height,
  pageNumber,
  width,
}: {
  height: number;
  pageNumber: number;
  width: number;
}): HTMLCanvasElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });

    if (!context) {
      return null;
    }

    canvas.width = width;
    canvas.height = height;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);

    const shortestEdge = Math.min(width, height);
    const noticeFontSize = Math.max(11, Math.round(shortestEdge * 0.055));

    // A hairline frame so the near-empty page reads as a deliberate placeholder rather than as an
    // image that failed to load.
    context.strokeStyle = '#e2e8f0';
    context.lineWidth = Math.max(1, Math.round(shortestEdge * 0.004));
    context.strokeRect(
      context.lineWidth / 2,
      context.lineWidth / 2,
      width - context.lineWidth,
      height - context.lineWidth,
    );

    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#475569';
    context.font = `600 ${noticeFontSize}px "Segoe UI", system-ui, sans-serif`;
    context.fillText(PLACEHOLDER_PAGE_NOTICE, width / 2, height / 2 - noticeFontSize);
    context.fillStyle = '#94a3b8';
    context.font = `400 ${Math.round(noticeFontSize * 0.8)}px "Segoe UI", system-ui, sans-serif`;
    context.fillText(`Page ${pageNumber}`, width / 2, height / 2 + noticeFontSize * 0.6); // i18n-ignore: page image content

    return canvas;
  } catch {
    return null;
  }
}

/**
 * Canvas-free placeholder. Pure string work, so this path cannot itself fail — which is the point:
 * the last resort of every degraded render has to be total, otherwise one bad page still takes the
 * import (or the board) down with it. An `<img>` renders an SVG data URL the same as a JPEG one.
 */
function buildPlaceholderPageSvgDataUrl({
  height,
  pageNumber,
  width,
}: {
  height: number;
  pageNumber: number;
  width: number;
}): string {
  const noticeFontSize = Math.max(11, Math.round(Math.min(width, height) * 0.055));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#e2e8f0"/>`,
    `<text x="${width / 2}" y="${height / 2 - noticeFontSize}" fill="#475569" font-family="system-ui, sans-serif" font-size="${noticeFontSize}" font-weight="600" text-anchor="middle">${PLACEHOLDER_PAGE_NOTICE}</text>`,
    // i18n-ignore: page image content
    `<text x="${width / 2}" y="${height / 2 + noticeFontSize * 0.6}" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="${Math.round(noticeFontSize * 0.8)}" text-anchor="middle">Page ${pageNumber}</text>`,
    '</svg>',
  ].join('');

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Import-path placeholder: a data URL, because import previews are persisted with the board. */
async function renderPlaceholderPagePreview({
  page,
  pageNumber,
  quality,
  targetLongestEdge,
}: {
  page: PdfJsPage | null;
  pageNumber: number;
  quality: number;
  targetLongestEdge: number;
}): Promise<{ height: number; previewImageUrl: string; width: number }> {
  const { height, width } = resolvePlaceholderPageSize(page, targetLongestEdge);
  const canvas = createPlaceholderPageCanvas({ height, pageNumber, width });

  if (!canvas) {
    return { height, previewImageUrl: buildPlaceholderPageSvgDataUrl({ height, pageNumber, width }), width };
  }

  try {
    const previewImageUrl = await encodeCanvasAsDataUrl(canvas, quality);

    return { height, previewImageUrl, width };
  } catch {
    return { height, previewImageUrl: buildPlaceholderPageSvgDataUrl({ height, pageNumber, width }), width };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Live/export-path placeholder: an object URL, matching what a successful render hands back. */
async function renderPlaceholderPageImageUrl({
  mime,
  page,
  pageNumber,
  quality,
  targetLongestEdge,
}: {
  mime: 'image/jpeg' | 'image/png';
  page: PdfJsPage | null;
  pageNumber: number;
  quality: number;
  targetLongestEdge: number;
}): Promise<string> {
  const { height, width } = resolvePlaceholderPageSize(page, targetLongestEdge);
  const canvas = createPlaceholderPageCanvas({ height, pageNumber, width });

  if (!canvas) {
    return buildPlaceholderPageSvgDataUrl({ height, pageNumber, width });
  }

  try {
    return await encodeCanvasAsObjectUrl(canvas, quality, mime);
  } catch {
    return buildPlaceholderPageSvgDataUrl({ height, pageNumber, width });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** «1 page» / «12 pages». */
function formatPageCount(count: number, locale: WbLocale): string {
  return count === 1 ? wbT(locale, 'pdfimport.pages.one') : wbT(locale, 'pdfimport.pages.many', { n: count });
}

function formatPageList(pageNumbers: number[], locale: WbLocale): string {
  const listedNumbers = pageNumbers.slice(0, MAX_LISTED_FAILED_PAGES).join(wbT(locale, 'pdfimport.listSeparator'));
  const hiddenCount = pageNumbers.length - MAX_LISTED_FAILED_PAGES;

  return hiddenCount > 0 ? wbT(locale, 'pdfimport.andMore', { list: listedNumbers, n: hiddenCount }) : listedNumbers;
}

/**
 * One warning line naming the pages that came back as placeholders. A 90-page file can fail on
 * dozens of pages, so the list collapses after {@link MAX_LISTED_FAILED_PAGES} numbers instead of
 * overflowing the modal.
 */
function formatFailedPagesWarning(failedPageNumbers: number[], locale: WbLocale): string {
  return wbT(locale, 'pdfimport.failedPages', {
    list: formatPageList(failedPageNumbers, locale),
    pages: formatPageCount(failedPageNumbers.length, locale),
  });
}

/**
 * The calm counterpart to {@link formatFailedPagesWarning}: pages that needed the native renderer
 * and came out COMPLETE. Deliberately not pushed into `summary.warnings` by the importer (see
 * {@link PdfImportSummary.rescuedPageNumbers}) so that no host can mistake a fixed page for a lost
 * one; a host that wants to mention them renders this line itself.
 */
export function formatRescuedPdfPagesNotice(rescuedPageNumbers: number[], locale: WbLocale = 'en'): string {
  return wbT(locale, 'pdfimport.rescuedPages', {
    list: formatPageList(rescuedPageNumbers, locale),
    pages: formatPageCount(rescuedPageNumbers.length, locale),
  });
}

/** See {@link MIN_PAGES_FOR_FAILURE_RATIO} for why the ratio has a page floor. */
function isPdfImportBeyondRepair({
  failedPageCount,
  selectedPageCount,
}: {
  failedPageCount: number;
  selectedPageCount: number;
}): boolean {
  if (failedPageCount === 0 || selectedPageCount === 0) {
    return false;
  }

  if (failedPageCount === selectedPageCount) {
    return true;
  }

  return (
    selectedPageCount >= MIN_PAGES_FOR_FAILURE_RATIO && failedPageCount / selectedPageCount > IMPORT_FAILURE_RATIO_LIMIT
  );
}

function createRenderViewport(
  page: PdfJsPage,
  targetLongestEdge: number,
): { height: number; scale: number; width: number } {
  const baseViewport = page.getViewport({ scale: 1 });
  const baseLongestEdge = Math.max(baseViewport.width, baseViewport.height, 1);
  const scale = Math.min(4, Math.max(0.35, targetLongestEdge / baseLongestEdge));
  const viewport = page.getViewport({ scale });

  return {
    height: Math.max(1, Math.ceil(viewport.height)),
    scale,
    width: Math.max(1, Math.ceil(viewport.width)),
  };
}

async function renderPdfPageToCanvas(page: PdfJsPage, targetLongestEdge: number): Promise<HTMLCanvasElement> {
  const { height, scale, width } = createRenderViewport(page, targetLongestEdge);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });

  if (!context) {
    // i18n-ignore: technical detail; describePdfImportError maps it to localized out-of-memory copy
    throw new Error('Could not create a drawing surface to process the PDF pages');
  }

  canvas.width = width;
  canvas.height = height;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  await page.render({
    canvas,
    canvasContext: context,
    viewport,
  }).promise;

  return canvas;
}

function buildRenderedPageCacheKey({
  assetId,
  mime,
  pageIndex,
  quality,
  targetLongestEdge,
  variant,
}: {
  assetId: string;
  mime: 'image/jpeg' | 'image/png';
  pageIndex: number;
  quality: number;
  targetLongestEdge: number;
  variant: 'export' | 'live';
}): string {
  const roundedEdge = Math.max(256, Math.round(targetLongestEdge / 128) * 128);
  // `mime` must be part of the key: switching quality mode (JPEG↔PNG) at the same edge/quality
  // would otherwise return a stale entry of the wrong format.
  const format = mime === 'image/png' ? 'png' : 'jpg';

  return `${variant}:${format}:${assetId}:${pageIndex}:${roundedEdge}:${quality.toFixed(2)}`;
}

function isLocalPdfAsset(asset: ResolvedWhiteboardPdfAsset): asset is WhiteboardPdfAsset {
  return 'blob' in asset;
}

async function getCachedPdfDocument({
  asset,
  moduleSrc = DEFAULT_PDF_MODULE_SRC,
  workerSrc = DEFAULT_PDF_WORKER_SRC,
}: {
  asset: ResolvedWhiteboardPdfAsset;
  moduleSrc?: string;
  workerSrc?: string;
}): Promise<PdfJsDocument> {
  const cacheKey = isLocalPdfAsset(asset)
    ? `${asset.id}:${moduleSrc}:${workerSrc}:blob`
    : `${asset.id}:${moduleSrc}:${workerSrc}:remote:${asset.readUrl}:${JSON.stringify(asset.headers ?? {})}`;
  const cachedEntry = pdfDocumentCache.get(cacheKey);

  if (cachedEntry) {
    touchMapEntry(pdfDocumentCache, cacheKey, cachedEntry);
    return await cachedEntry.documentPromise;
  }

  const openResult = isLocalPdfAsset(asset)
    ? await openPdfDocumentFromBlob(asset.blob, { moduleSrc, workerSrc })
    : await openPdfDocumentFromUrl(asset.readUrl, {
        headers: asset.headers,
        moduleSrc,
        workerSrc,
      });
  const documentPromise = Promise.resolve(openResult.document);

  const entry: PdfDocumentCacheEntry = {
    cleanup: openResult.cleanup,
    documentPromise,
  };

  touchMapEntry(pdfDocumentCache, cacheKey, entry);
  prunePdfDocumentCache();

  return await documentPromise;
}

export async function loadCachedPdfAsset(
  assetId: string,
  loadPdfAsset: (id: string) => Promise<WhiteboardPdfAsset | null>,
): Promise<WhiteboardPdfAsset | null> {
  const cachedAsset = pdfAssetCache.get(assetId);

  if (cachedAsset) {
    touchMapEntry(pdfAssetCache, assetId, cachedAsset);
    return cachedAsset;
  }

  const asset = await loadPdfAsset(assetId);

  if (!asset) {
    return null;
  }

  touchMapEntry(pdfAssetCache, assetId, asset);
  prunePdfAssetCache();

  return asset;
}

export async function inspectPdfFile(
  file: File,
  {
    moduleSrc = DEFAULT_PDF_MODULE_SRC,
    pageRange = DEFAULT_PDF_PAGE_RANGE,
    workerSrc = DEFAULT_PDF_WORKER_SRC,
    locale = 'en',
  }: {
    moduleSrc?: string;
    pageRange?: string;
    workerSrc?: string;
    /** Kept for host compatibility; warnings and errors are English. */
    locale?: WbLocale;
  } = {},
): Promise<PdfImportSummary> {
  validatePdfFileSize(file.size, locale);

  const deviceProfile = await getPdfImportDeviceProfile();
  const { cleanup, document } = await openPdfDocumentFromBlob(file, { moduleSrc, workerSrc });

  try {
    const totalPages = document.numPages;
    const selectedPageNumbers = parsePdfPageRange(pageRange, totalPages);
    const fingerprint = document.fingerprints?.[0] ?? `${file.name}:${file.size}:${totalPages}`;

    if (selectedPageNumbers.length > MAX_PDF_IMPORT_PAGE_COUNT) {
      throw userFacingError(
        wbT(locale, 'pdfimport.tooManyPages', { max: MAX_PDF_IMPORT_PAGE_COUNT, n: selectedPageNumbers.length }),
      );
    }

    return {
      deviceProfile,
      fileSize: file.size,
      fileName: file.name,
      fingerprint,
      normalizedPageRange:
        selectedPageNumbers.length === totalPages ? DEFAULT_PDF_PAGE_RANGE : formatPdfPageRange(selectedPageNumbers),
      // Filled in by the import pass; an inspection has rendered nothing yet, so nothing was rescued.
      rescuedPageNumbers: [],
      selectedPageCount: selectedPageNumbers.length,
      selectedPageNumbers,
      totalPages,
      warnings: buildPdfImportWarnings({
        deviceProfile,
        fileSize: file.size,
        locale,
        selectedPageCount: selectedPageNumbers.length,
      }),
    };
  } finally {
    cleanup();
  }
}

export async function importPdfFile(
  file: File,
  {
    moduleSrc = DEFAULT_PDF_MODULE_SRC,
    nativeRescue,
    onProgress,
    pageRange = DEFAULT_PDF_PAGE_RANGE,
    workerSrc = DEFAULT_PDF_WORKER_SRC,
    locale = 'en',
    previews = true,
  }: {
    moduleSrc?: string;
    /** Kept for host compatibility; warnings and errors are English. */
    locale?: WbLocale;
    /**
     * Host-provided tier-2 renderer (see {@link PdfImportNativeRescue}). Absent on every web
     * consumer, which then behaves exactly as before: pdf.js, then the placeholder.
     */
    nativeRescue?: PdfImportNativeRescue;
    onProgress?: (progress: number) => void;
    pageRange?: string;
    workerSrc?: string;
    /**
     * `false` = sizes only: each page's preview dimensions come from its viewport and nothing is drawn
     * (`previewImageUrl` is ''). For hosts that render pages lazily on the board and never show the
     * import previews — drawing + encoding every page was ~40 ms a page, 8.5 s for a 200-page reader on
     * the S10 Ultra profile. A page pdf.js cannot open still takes the rescue / placeholder tiers.
     */
    previews?: boolean;
  } = {},
): Promise<PdfImportResult> {
  const summary = await inspectPdfFile(file, { locale, moduleSrc, pageRange, workerSrc });
  // A strict subset → the uploaded asset will be a NEW PDF holding only the selected pages (built
  // below), so each page's index INTO that asset is its position in `selectedPageNumbers`. A whole
  // import keeps the original file, so the index is the original `pageNumber - 1`.
  const isSubset = summary.selectedPageNumbers.length < summary.totalPages;
  const { cleanup, document } = await openPdfDocumentFromBlob(file, { moduleSrc, workerSrc });
  const pages: ImportedPdfPagePreview[] = [];
  const previewMaxEdge = resolvePdfPreviewRenderEdge({
    deviceMemoryGb: summary.deviceProfile.deviceMemoryGb,
    fileSize: file.size,
    totalPages: summary.selectedPageCount,
  });
  const previewQuality = resolvePdfPreviewJpegQuality({
    deviceMemoryGb: summary.deviceProfile.deviceMemoryGb,
    fileSize: file.size,
    totalPages: summary.selectedPageCount,
  });

  // Pages that failed to rasterize on EVERY tier, in import order. ONE bad page used to reject the
  // whole import — a real teacher lost a 45-page upload to a single malformed transparency group. A
  // per-page guard is the whole point of this loop: a bad page costs that page, never the file.
  const failedPageNumbers: number[] = [];
  // Pages pdf.js dropped and the native renderer saved. Reported as DATA, never as a warning: they
  // are complete pages, so the «Couldn't process …» copy would be a lie about them.
  const rescuedPageNumbers: number[] = [];
  // The final asset's id is minted HERE rather than at the return, because the native rescue caches
  // the source bytes under an id and a whole-file import can share the asset's own id — which makes
  // the board's first native page render a straight cache HIT later on.
  const assetId = createWhiteboardId();
  // CACHE ORDERING (measured against `apps/whiteboard/lib/platform/pdf.ts`): the native cache is
  // filled LAZILY — the desktop shell only pushes a PDF's bytes when a page is first rendered from
  // the board, or when `archiveSourcePdf` explicitly ensures them. At import time nothing is cached
  // yet, and this asset id has never existed before, so the FIRST page that needs a rescue must
  // stream the file in (chunked, by the host). `nativeSourcePushed` memoizes that one push — a
  // rejected promise memoizes too — so a file with 12 bad pages uploads its 86 MB ONCE, not twelve
  // times. A healthy import never triggers it at all.
  //
  // For a SUBSET import the cached bytes are the ORIGINAL file while the produced asset is a freshly
  // built subset PDF, so they must not share an id: the board would then render the wrong page at
  // every index (the host's own session memo would even report the id as already cached). Hence the
  // `-src` sibling id, which the native side's `[A-Za-z0-9._-]` sanitizer keeps intact.
  const nativeSourceAssetId = isSubset ? `${assetId}-src` : assetId;
  let nativeSourcePushed: Promise<boolean> | null = null;

  const rescuePageNatively = async (pageNumber: number): Promise<PdfImportNativePagePreview | null> => {
    if (!nativeRescue || nativeRescue.isAvailable?.() === false) {
      return null;
    }

    try {
      nativeSourcePushed ??= nativeRescue.ensureSourceCached({ assetId: nativeSourceAssetId, blob: file });

      if (!(await nativeSourcePushed)) {
        return null;
      }

      const rendered = await nativeRescue.renderPage({
        assetId: nativeSourceAssetId,
        pageNumber,
        quality: previewQuality,
        sourcePageIndex: pageNumber - 1,
        targetLongestEdge: previewMaxEdge,
      });

      // A rescue that hands back no image, or a degenerate box, is no rescue: the importer opens a
      // new PDF page scrolled to its top using these dimensions, so a 0-sized one would misposition
      // the page. Fall through to the placeholder instead.
      if (!rendered?.previewImageUrl || !(rendered.width > 0) || !(rendered.height > 0)) {
        return null;
      }

      // BLANK-RASTER FLOOR — the RESCUE path only. A successful native render can still be a page of
      // pure white (see {@link isBlankRescuedRaster} for the measurement), and we only reach this
      // branch because pdf.js ALREADY threw on this page: an all-white bitmap here is far likelier a
      // zero-area clip than a genuinely empty page. An honest «Couldn't process this page» plus the
      // warning beats a silent blank the teacher discovers mid-lesson, so discard it and take
      // tier 3.
      //
      // The board-DISPLAY native path (`usePdfPageImage`, `WhiteboardEditor`) deliberately carries no
      // such floor: nothing failed before it, so a blank page there is usually a page that is blank,
      // and rejecting those would replace real pages with notices.
      if (await isBlankRescuedRaster(rendered.previewImageUrl)) {
        return null;
      }

      return rendered;
    } catch {
      // Tier 2 is additive: any failure in it must read exactly like "no rescue available".
      return null;
    }
  };

  try {
    for (let index = 0; index < summary.selectedPageNumbers.length; index += 1) {
      const pageNumber = summary.selectedPageNumbers[index];

      if (pageNumber === undefined) {
        continue;
      }

      // Index INTO the produced asset: position within the subset, or original index for a whole
      // import. Computed up front so a failed page still lands at the SAME index a good one would,
      // keeping previews aligned with the uploaded asset and with the server-merge manifest.
      const pageIndex = isSubset ? index : pageNumber - 1;
      let page: PdfJsPage | null = null;
      let canvas: HTMLCanvasElement | null = null;

      try {
        // `getPage` is inside the guard too: it rejects on its own for a corrupt page tree, before
        // any rendering happens.
        page = await document.getPage(pageNumber);

        if (!previews) {
          // Same box the preview canvas would get, without drawing it.
          const { height, width } = createRenderViewport(page, previewMaxEdge);

          pages.push({ pageIndex, pageNumber, previewImageUrl: '', width, height });
          continue;
        }

        canvas = await renderPdfPageToCanvas(page, previewMaxEdge);

        const previewImageUrl = await encodeCanvasAsDataUrl(canvas, previewQuality);

        pages.push({
          pageIndex,
          pageNumber,
          previewImageUrl,
          // The rendered dimensions (page aspect ratio) are read BEFORE the canvas is freed below.
          width: canvas.width,
          height: canvas.height,
        });
      } catch {
        // TIER 2 — a different parser. pdf.js has given up on this page; PDFium (via the host) very
        // often has not, and a real rendered page beats a white notice every single time.
        const rescued = await rescuePageNatively(pageNumber);

        if (rescued) {
          rescuedPageNumbers.push(pageNumber);

          pages.push({
            pageIndex,
            pageNumber,
            previewImageUrl: rescued.previewImageUrl,
            width: rescued.width,
            height: rescued.height,
          });
        } else {
          // TIER 3 — last resort. Only now is the page genuinely lost.
          failedPageNumbers.push(pageNumber);

          const placeholder = await renderPlaceholderPagePreview({
            page,
            pageNumber,
            quality: previewQuality,
            targetLongestEdge: previewMaxEdge,
          });

          pages.push({
            pageIndex,
            pageNumber,
            previewImageUrl: placeholder.previewImageUrl,
            width: placeholder.width,
            height: placeholder.height,
          });
        }
      } finally {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }

        cleanupPdfPageSafely(page);
        // Progress advances in the `finally` so the bar never stalls on a bad page.
        onProgress?.(Math.round(((index + 1) / summary.selectedPageNumbers.length) * 100));
      }

      // Hand the main thread back to the browser after every page so it can paint
      // and process input. Rasterization (`page.render`) and JPEG encoding run on
      // the main thread even though pdf.js parses on its worker, so without this
      // a large PDF import freezes the UI between yields.
      // (Sizes only draws nothing on the main thread; `getPage` already awaits the worker.)
      if (previews && index < summary.selectedPageNumbers.length - 1) {
        await yieldToBrowserDuringImport();
      }
    }
  } finally {
    cleanup();
  }

  if (
    isPdfImportBeyondRepair({
      failedPageCount: failedPageNumbers.length,
      selectedPageCount: pages.length,
    })
  ) {
    throw userFacingError(wbT(locale, 'pdfimport.beyondRepair'));
  }

  // Rescued pages are recorded on the summary so the host can mention them calmly (see
  // `formatRescuedPdfPagesNotice`). They are deliberately NOT pushed into `summary.warnings`: that
  // channel is rendered as «some pages couldn't be processed», and these pages were processed.
  summary.rescuedPageNumbers = rescuedPageNumbers;

  if (failedPageNumbers.length > 0) {
    // Appended to the summary the modal already renders, so the teacher is told which pages came
    // back as placeholders instead of discovering it later on the board.
    summary.warnings.push(formatFailedPagesWarning(failedPageNumbers, locale));
  }

  // For a strict subset, build a NEW standalone PDF containing ONLY the selected pages (in import
  // order) — this is what gets uploaded, so the teacher never sends pages they aren't using. The
  // split is local (pdf-lib, no network); a failure falls back to the whole file so import never
  // breaks (the upload path stays correct, just larger). A whole-file import keeps the original blob.
  let assetBlob: Blob = file;
  let assetIsSubset = isSubset;

  if (isSubset) {
    try {
      assetBlob = await extractPdfSubset(file, summary.selectedPageNumbers);
    } catch {
      // Split failed → fall back to the original file. The pages were indexed by subset position, so
      // remap them to their ORIGINAL indices to stay consistent with the whole-file blob we now use.
      assetBlob = file;
      assetIsSubset = false;

      for (const page of pages) {
        page.pageIndex = page.pageNumber - 1;
      }
    }
  }

  return {
    asset: {
      blob: assetBlob,
      createdAt: Date.now(),
      fileName: file.name,
      fingerprint: summary.fingerprint,
      id: assetId,
      mimeType: file.type || 'application/pdf',
      pageCount: assetIsSubset ? summary.selectedPageNumbers.length : summary.totalPages,
      size: assetBlob.size,
    },
    isSubset: assetIsSubset,
    pages,
    summary,
  };
}

export async function renderPdfAssetPageImageUrl({
  asset,
  containerHeight,
  containerWidth,
  deviceMemoryGb,
  maxEdge,
  mode = 'live',
  moduleSrc = DEFAULT_PDF_MODULE_SRC,
  onRenderError = 'placeholder',
  pageIndex,
  workerSrc = DEFAULT_PDF_WORKER_SRC,
  zoom,
}: {
  asset: ResolvedWhiteboardPdfAsset;
  containerHeight: number;
  containerWidth: number;
  deviceMemoryGb?: number;
  mode?: 'export' | 'live';
  moduleSrc?: string;
  /**
   * What a page that refuses to rasterize resolves to. `'placeholder'` (the default) keeps the board
   * and the export alive — one bad page shows the placeholder notice instead of taking the whole render
   * down. `'reject'` is for callers that would rather do nothing than hold a placeholder, i.e. the
   * prefetch path, which has no viewer to show it to and would only leak the object URL.
   */
  onRenderError?: 'placeholder' | 'reject';
  pageIndex: number;
  /**
   * Upper bound on the raster's longest edge. The desktop shell passes one when pdf.js is only a
   * STOPGAP for a page whose bytes are not local yet: pdf.js rasterizes on the main thread, and a
   * full-quality 3,400 px page took 6.5 s on a 2-core studio PC — the pen froze for that long
   * (2026-09-13). Half the edge is a quarter of the pixels; the native render replaces it soon after.
   */
  maxEdge?: number;
  workerSrc?: string;
  zoom: number;
}): Promise<string> {
  const uncappedEdge =
    mode === 'export'
      ? resolvePdfExportRenderEdge({
          deviceMemoryGb,
          fileSize: asset.size,
          totalPages: asset.pageCount,
        })
      : resolvePdfLiveRenderEdge({
          containerHeight,
          containerWidth,
          deviceMemoryGb,
          fileSize: asset.size,
          totalPages: asset.pageCount,
          zoom,
        });
  const targetLongestEdge = maxEdge ? Math.min(uncappedEdge, maxEdge) : uncappedEdge;
  const tuning = getActivePdfQualityTuning();
  // Export always stays JPEG q0.92 — the export→PDF wrapper (pdfExport.ts) requires DCTDecode/JPEG.
  // The on-screen LIVE page follows the active quality mode: crisp JPEG or lossless PNG (no ringing).
  const liveMime = tuning.liveMime;
  const mime: 'image/jpeg' | 'image/png' = mode === 'export' ? 'image/jpeg' : liveMime;
  const quality = mode === 'export' ? 0.92 : tuning.liveJpegQuality;
  const cacheKey = buildRenderedPageCacheKey({
    assetId: asset.id,
    mime,
    pageIndex,
    quality,
    targetLongestEdge,
    variant: mode,
  });
  const cachedRender = renderedPageCache.get(cacheKey);

  if (cachedRender) {
    touchMapEntry(renderedPageCache, cacheKey, cachedRender);
    return cachedRender.url;
  }

  const pendingRender = pendingRenderedPageCache.get(cacheKey);

  if (pendingRender) {
    return await pendingRender;
  }

  const renderPromise = (async () => {
    let page: PdfJsPage | null = null;
    let canvas: HTMLCanvasElement | null = null;

    try {
      const pdfDocument = await getCachedPdfDocument({ asset, moduleSrc, workerSrc });

      page = await pdfDocument.getPage(pageIndex + 1);
      canvas = await renderPdfPageToCanvas(page, targetLongestEdge);

      const url = await encodeCanvasAsObjectUrl(canvas, quality, mime);

      touchMapEntry(renderedPageCache, cacheKey, { url });
      pruneRenderedPageCache();

      return url;
    } catch (error) {
      if (onRenderError === 'reject') {
        throw error;
      }

      // The placeholder is deliberately NOT written to `renderedPageCache`. Failures here are often
      // transient — a worker restart, an OOM at a deep zoom level, a signed URL that expired between
      // two renders — and caching one under the key a real render uses would poison that page for the
      // rest of the session: every later zoom/export would serve the notice instead of retrying.
      // The cost of not caching is a re-attempt per paint and an object URL we never revoke (it is
      // still on screen, so we can't), both bounded by how many pages actually fail.
      return await renderPlaceholderPageImageUrl({
        mime,
        page,
        pageNumber: pageIndex + 1,
        quality,
        targetLongestEdge,
      });
    } finally {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }

      cleanupPdfPageSafely(page);
    }
  })();

  pendingRenderedPageCache.set(cacheKey, renderPromise);

  try {
    return await renderPromise;
  } finally {
    pendingRenderedPageCache.delete(cacheKey);
  }
}

export async function prefetchPdfAssetPageImage({
  asset,
  containerHeight,
  containerWidth,
  deviceMemoryGb,
  moduleSrc = DEFAULT_PDF_MODULE_SRC,
  pageIndex,
  workerSrc = DEFAULT_PDF_WORKER_SRC,
  zoom,
}: {
  asset: ResolvedWhiteboardPdfAsset;
  containerHeight: number;
  containerWidth: number;
  deviceMemoryGb?: number;
  moduleSrc?: string;
  pageIndex: number;
  workerSrc?: string;
  zoom: number;
}): Promise<void> {
  try {
    await renderPdfAssetPageImageUrl({
      asset,
      containerHeight,
      containerWidth,
      deviceMemoryGb,
      mode: 'live',
      moduleSrc,
      // A prefetch has no viewer: a placeholder here would be an object URL nobody ever paints or
      // revokes, and it would hide the failure from the real render that follows. Reject instead and
      // swallow below — the page simply isn't warmed, and the on-demand render decides what to show.
      onRenderError: 'reject',
      pageIndex,
      workerSrc,
      zoom,
    });
  } catch {
    // Prefetch should stay best-effort.
  }
}

export async function resolveStoredPdfPageImageUrl({
  containerHeight,
  containerWidth,
  deviceMemoryGb,
  loadPdfAsset,
  maxEdge,
  moduleSrc = DEFAULT_PDF_MODULE_SRC,
  page,
  resolveRemotePdfAsset,
  workerSrc = DEFAULT_PDF_WORKER_SRC,
  zoom,
}: {
  containerHeight: number;
  containerWidth: number;
  deviceMemoryGb?: number;
  loadPdfAsset: (id: string) => Promise<WhiteboardPdfAsset | null>;
  /** See {@link renderPdfAssetPageImageUrl}: cap for the main-thread stopgap render. */
  maxEdge?: number;
  moduleSrc?: string;
  page: { pdfAssetId?: string; pdfImageUrl?: string; pdfPageIndex?: number };
  resolveRemotePdfAsset?: ResolveRemotePdfAsset;
  workerSrc?: string;
  zoom: number;
}): Promise<string | undefined> {
  if (!page.pdfAssetId || page.pdfPageIndex === undefined) {
    return page.pdfImageUrl;
  }

  // Resolving the asset can fail on its own — an evicted local blob, a signed read URL that expired,
  // a host resolver that throws. The board must still paint something, and the preview captured at
  // import time is a better answer than a synthetic placeholder, so prefer it whenever it exists.
  let resolvedAsset: ResolvedWhiteboardPdfAsset | null = null;

  try {
    const asset = await loadCachedPdfAsset(page.pdfAssetId, loadPdfAsset);

    resolvedAsset = asset ?? (resolveRemotePdfAsset ? await resolveRemotePdfAsset(page.pdfAssetId) : null);
  } catch {
    return page.pdfImageUrl;
  }

  if (!resolvedAsset) {
    return page.pdfImageUrl;
  }

  try {
    return await renderPdfAssetPageImageUrl({
      asset: resolvedAsset,
      containerHeight,
      containerWidth,
      deviceMemoryGb,
      maxEdge,
      moduleSrc,
      pageIndex: page.pdfPageIndex,
      workerSrc,
      zoom,
    });
  } catch {
    // The renderer degrades to a placeholder rather than throwing, so this is the outer belt: if it
    // ever does throw, the stored import-time preview still beats an undefined background.
    return page.pdfImageUrl;
  }
}
