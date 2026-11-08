const SMALL_PDF_RENDER_SCALE = 1.5;
const MEDIUM_PDF_RENDER_SCALE = 1.2;
const LARGE_PDF_RENDER_SCALE = 0.95;
const XL_PDF_RENDER_SCALE = 0.8;
const MEDIUM_PDF_PAGE_COUNT = 40;
const LARGE_PDF_PAGE_COUNT = 120;
const XL_PDF_PAGE_COUNT = 280;
const LARGE_PDF_FILE_SIZE = 120 * 1024 * 1024;
const XL_PDF_FILE_SIZE = 280 * 1024 * 1024;
const LOW_MEMORY_THRESHOLD_GB = 4;

export const MAX_PDF_RENDER_EDGE = 1440;

/** Absolute ceiling for a single rendered page edge (matches the native PDFium clamp, pdf_render.rs). */
const MAX_PDF_LIVE_RENDER_EDGE = 4096;

/**
 * User-selectable PDF rendering quality.
 * - `balanced`  — lowest memory/CPU (JPEG q85, no edge boost, DPR≤1.5). Best for weak tablets.
 * - `high`      — the DEFAULT: crisp JPEG q94, ~1.25× edge boost, DPR≤2. Little extra memory.
 * - `max`       — LOSSLESS PNG display, edge pushed to 4096, DPR≤3. Sharpest; heaviest memory.
 */
export type PdfQualityMode = 'balanced' | 'high' | 'max';

export interface PdfQualityTuning {
  /** Multiplier applied to the device/size-derived live & export edge caps (clamped to 4096). */
  edgeFactor: number;
  /** Mime the on-screen (web) page is encoded to. PNG is lossless (no JPEG ringing on text). */
  liveMime: 'image/jpeg' | 'image/png';
  /** JPEG quality (0..1) for the on-screen page when `liveMime` is JPEG. Ignored for PNG. */
  liveJpegQuality: number;
  /** Native (desktop PDFium) page format. */
  nativeFormat: 'jpeg' | 'png';
  /** Native JPEG quality (1..100) when `nativeFormat` is jpeg. */
  nativeJpegQuality: number;
  /** Upper bound for the zoom multiplier that drives live re-render resolution. */
  zoomClampMax: number;
  /** Upper bound for the background canvas device-pixel-ratio (HiDPI sharpness vs VRAM). */
  maxBackgroundPixelRatio: number;
}

const PDF_QUALITY_TUNING: Record<PdfQualityMode, PdfQualityTuning> = {
  balanced: {
    edgeFactor: 1,
    liveMime: 'image/jpeg',
    liveJpegQuality: 0.85,
    nativeFormat: 'jpeg',
    nativeJpegQuality: 85,
    zoomClampMax: 2.25,
    maxBackgroundPixelRatio: 1.5,
  },
  high: {
    edgeFactor: 1.25,
    liveMime: 'image/jpeg',
    liveJpegQuality: 0.94,
    nativeFormat: 'jpeg',
    nativeJpegQuality: 94,
    zoomClampMax: 2.75,
    maxBackgroundPixelRatio: 2,
  },
  max: {
    edgeFactor: 1.6,
    liveMime: 'image/png',
    liveJpegQuality: 1,
    nativeFormat: 'png',
    nativeJpegQuality: 100,
    zoomClampMax: 3.5,
    maxBackgroundPixelRatio: 3,
  },
};

/** New installs default to `high` — visibly crisper than the old q85/no-boost baseline at little cost. */
const DEFAULT_PDF_QUALITY_MODE: PdfQualityMode = 'high';
let activePdfQualityMode: PdfQualityMode = DEFAULT_PDF_QUALITY_MODE;

export function isPdfQualityMode(value: unknown): value is PdfQualityMode {
  return value === 'balanced' || value === 'high' || value === 'max';
}

/**
 * Set the process-wide PDF quality mode. The whiteboard app calls this on boot (from the persisted
 * setting) and whenever the user changes it; the plain web build leaves it at the default.
 */
export function setPdfQualityMode(mode: PdfQualityMode): void {
  if (isPdfQualityMode(mode)) {
    activePdfQualityMode = mode;
  }
}

export function getPdfQualityMode(): PdfQualityMode {
  return activePdfQualityMode;
}

export function getActivePdfQualityTuning(): PdfQualityTuning {
  return PDF_QUALITY_TUNING[activePdfQualityMode];
}

/**
 * Device-pixel-ratio the hand-managed background/overlay canvases should rasterize at so the PDF
 * matches the (already retina-scaled) Fabric ink layer. Clamped by the active quality mode.
 */
export function getPdfBackgroundPixelRatio(): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  return clampNumber(dpr, 1, getActivePdfQualityTuning().maxBackgroundPixelRatio);
}

export interface PdfRenderProfile {
  exportMaxEdge: number;
  liveMaxEdge: number;
  previewJpegQuality: number;
  previewMaxEdge: number;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Apply the active quality mode's edge boost to a base cap, clamped to the hard ceiling. */
function boostRenderEdge(baseEdge: number): number {
  return Math.min(MAX_PDF_LIVE_RENDER_EDGE, Math.round(baseEdge * getActivePdfQualityTuning().edgeFactor));
}

export function getPdfImportBaseRenderScale(totalPages: number): number {
  if (totalPages >= XL_PDF_PAGE_COUNT) {
    return XL_PDF_RENDER_SCALE;
  }

  if (totalPages >= LARGE_PDF_PAGE_COUNT) {
    return LARGE_PDF_RENDER_SCALE;
  }

  if (totalPages >= MEDIUM_PDF_PAGE_COUNT) {
    return MEDIUM_PDF_RENDER_SCALE;
  }

  return SMALL_PDF_RENDER_SCALE;
}

export function resolvePdfImportRenderScale(totalPages: number, pageWidth: number, pageHeight: number): number {
  const baseScale = getPdfImportBaseRenderScale(totalPages);
  const longestEdge = Math.max(pageWidth, pageHeight) * baseScale;

  if (longestEdge <= MAX_PDF_RENDER_EDGE || longestEdge === 0) {
    return baseScale;
  }

  return (MAX_PDF_RENDER_EDGE / longestEdge) * baseScale;
}

export function resolvePdfRenderProfile({
  deviceMemoryGb,
  fileSize,
  totalPages,
}: {
  deviceMemoryGb?: number;
  fileSize: number;
  totalPages: number;
}): PdfRenderProfile {
  const isLowMemoryDevice =
    typeof deviceMemoryGb === 'number' && deviceMemoryGb > 0 && deviceMemoryGb <= LOW_MEMORY_THRESHOLD_GB;
  const isLargePdf = totalPages >= LARGE_PDF_PAGE_COUNT || fileSize >= LARGE_PDF_FILE_SIZE;
  const isExtraLargePdf = totalPages >= XL_PDF_PAGE_COUNT || fileSize >= XL_PDF_FILE_SIZE;

  // Device/size-derived BASE caps keep huge PDFs and weak devices safe; the active quality mode then
  // boosts the live/export edges (bounded by 4096) so the common case renders sharper. Preview
  // thumbnails are intentionally left un-boosted (they're tiny by design).
  if (isExtraLargePdf || isLowMemoryDevice) {
    return {
      exportMaxEdge: boostRenderEdge(2048),
      liveMaxEdge: boostRenderEdge(1600),
      previewJpegQuality: 0.42,
      previewMaxEdge: 192,
    };
  }

  if (isLargePdf) {
    return {
      exportMaxEdge: boostRenderEdge(2600),
      liveMaxEdge: boostRenderEdge(2200),
      previewJpegQuality: 0.46,
      previewMaxEdge: 224,
    };
  }

  return {
    exportMaxEdge: boostRenderEdge(3200),
    liveMaxEdge: boostRenderEdge(2880),
    previewJpegQuality: 0.52,
    previewMaxEdge: 256,
  };
}

/**
 * A4 portrait aspect (width/height ≈ 0.707) — the assumed page shape BEFORE the real one is known
 * (first render, before the image loads). Sizing to this never UNDER-renders a portrait page's width.
 */
const DEFAULT_PORTRAIT_ASPECT = 0.7071;

/** Small supersample over the exact display width so edges/anti-aliasing stay crisp (not just 1:1). */
const LIVE_RENDER_SUPERSAMPLE = 1.15;

/**
 * Quantization step (px) for the live render edge. Each DISTINCT edge value is a distinct native render
 * + render-cache entry, so a continuous zoom would mint endless near-duplicate rasters (and never hit
 * the cache). Rounding the edge UP to the next 128px bucket turns the zoom continuum into a handful of
 * cacheable rasters — and because it only ever rounds UP, the raster is never smaller than the needed
 * display width (no quality regression).
 */
const PDF_LIVE_EDGE_QUANTUM = 128;

export function resolvePdfLiveRenderEdge({
  containerWidth,
  deviceMemoryGb,
  fileSize,
  pageAspectRatio,
  totalPages,
  zoom,
}: {
  containerHeight?: number;
  containerWidth: number;
  deviceMemoryGb?: number;
  fileSize: number;
  /**
   * The rendered page's aspect ratio (width ÷ height). Portrait pages (< 1) need a TALLER raster so the
   * fit-to-width edge still reaches the display's pixel width. Omitted on the first render (image not
   * loaded yet) → we assume A4 portrait so we never under-render; callers pass the real value afterward.
   */
  pageAspectRatio?: number;
  totalPages: number;
  zoom: number;
}): number {
  const profile = resolvePdfRenderProfile({ deviceMemoryGb, fileSize, totalPages });
  const zoomMultiplier = clampNumber(zoom, 1, getActivePdfQualityTuning().zoomClampMax);
  // Render in device pixels, not CSS pixels — otherwise the page is rasterized at a
  // fraction of the screen's real resolution and looks soft on high-DPI / large boards.
  const pixelRatio = clampNumber(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 1, 3);

  // The PDF page is displayed FIT-TO-WIDTH (see getScreenFitPlacement: scale = canvasWidth/imageWidth),
  // so the rendered raster's WIDTH — not its longest edge — must reach the display's device-pixel width,
  // or the page is upscaled onto the canvas → soft. The native/pdf.js renderers cap the LONGEST edge, so
  // for a portrait page (aspect < 1, longest = height) that edge must be scaled up by 1/aspect to bring
  // the width up to par. Basing the OLD formula on the viewport's longest edge × 1.2 left a portrait A4
  // page at only 1.2 × 0.707 ≈ 0.85 of the needed width (measured on-device: raster 1625 vs needed 1916)
  // — and that shortfall is zoom-invariant, which is why zooming in never sharpened it.
  const neededWidthDevicePx = Math.max(containerWidth, 1) * zoomMultiplier * pixelRatio;
  const aspect = pageAspectRatio && pageAspectRatio > 0 ? pageAspectRatio : DEFAULT_PORTRAIT_ASPECT;
  const widthCoverageScale = 1 / Math.min(1, aspect); // portrait → 1/aspect (>1); landscape/square → 1
  const targetLongestEdge = neededWidthDevicePx * widthCoverageScale * LIVE_RENDER_SUPERSAMPLE;

  // Quantize UP to the next PDF_LIVE_EDGE_QUANTUM multiple BEFORE capping, so zoom changes map to a
  // small set of cacheable edges instead of endless distinct cache keys (see the const's doc above).
  const quantizedEdge = Math.ceil(targetLongestEdge / PDF_LIVE_EDGE_QUANTUM) * PDF_LIVE_EDGE_QUANTUM;

  return Math.min(profile.liveMaxEdge, quantizedEdge);
}

export function resolvePdfPreviewRenderEdge({
  deviceMemoryGb,
  fileSize,
  totalPages,
}: {
  deviceMemoryGb?: number;
  fileSize: number;
  totalPages: number;
}): number {
  return resolvePdfRenderProfile({ deviceMemoryGb, fileSize, totalPages }).previewMaxEdge;
}

export function resolvePdfPreviewJpegQuality({
  deviceMemoryGb,
  fileSize,
  totalPages,
}: {
  deviceMemoryGb?: number;
  fileSize: number;
  totalPages: number;
}): number {
  return resolvePdfRenderProfile({ deviceMemoryGb, fileSize, totalPages }).previewJpegQuality;
}

export function resolvePdfExportRenderEdge({
  deviceMemoryGb,
  fileSize,
  totalPages,
}: {
  deviceMemoryGb?: number;
  fileSize: number;
  totalPages: number;
}): number {
  return resolvePdfRenderProfile({ deviceMemoryGb, fileSize, totalPages }).exportMaxEdge;
}
