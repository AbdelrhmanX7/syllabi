import type { WhiteboardDocument, WhiteboardPage } from './types';
import { strFromU8, unzip } from 'fflate';

import { createWhiteboardId } from './id';
import { WHITEBOARD_SCHEMA_VERSION } from './types';

/**
 * OLF (ViewSonic "Open Learning Format") → native whiteboard converter.
 *
 * An `.olf` file is a ZIP archive holding a single `content.json` PLUS an `images/` folder of PNG/JPEG
 * assets. The JSON encodes a set of pages, each holding: ink strokes (`element.stroke`) in a GLOBAL raw
 * coordinate space; raster IMAGES (`element.image`, e.g. a PDF page pasted onto the board) with a
 * per-element affine `matrix`; and page BACKGROUNDS (`page.backgrounds[].background`) which are either a
 * solid `type:"color"` fill or a full-page `type:"image"` raster (`image-source`). We unzip in-browser
 * (fflate), parse the JSON, embed the referenced images as `data:` URLs, and assemble a
 * {@link WhiteboardDocument} ready to persist via the whiteboard storage layer.
 *
 * PDF-derived boards (the ViewSonic "annotate a PDF" flow) export each PDF page as image content — a
 * full-page raster plus smaller overlay images — NOT as strokes. So faithfully importing them means
 * importing those rasters, otherwise every page lands blank. Handling per element kind:
 *  - The full-page raster (an image element that covers most of the viewport, or a `type:"image"`
 *    background) becomes the page's {@link WhiteboardPage.pdfImageUrl}. That renders through the existing
 *    pdfImageUrl path (whiteboard-react `usePdfPageImage` draws `page.pdfImageUrl` directly when there is
 *    no `pdfAssetId`) with zero native-cache involvement — semantically the immovable page backdrop.
 *  - Smaller image elements (overlays) become Fabric `image` objects positioned by their per-element
 *    `matrix` (a REAL transform for image elements — unlike the page viewport matrix, see below).
 *
 * Stroke coordinate handling (verified on 11,898 real strokes): the page `matrix` is only the SAVED
 * VIEWPORT (where the author had panned/zoomed when exporting) — applying its inverse throws the bulk of
 * the ink thousands of px off-canvas. So for STROKES we IGNORE the matrix, keep raw coordinates, and
 * shift each page by its content bounding-box top-left so all ink sits near (0,0). For IMAGE ELEMENTS the
 * per-element `matrix` IS a real placement transform and is applied. `parseOlfMatrix` / `transformOlfPoint`
 * remain exported as utilities but are NOT used for stroke positioning. When a page carries a pdfImageUrl
 * background its content is kept at raw viewport coordinates (no re-centre) so overlays/strokes stay
 * registered to that full-page backdrop's coordinate space.
 *
 * This module is browser-safe: it has no Node-only imports and never touches `fabric` at runtime — it
 * only emits the plain JSON shape Fabric's `loadFromJSON` consumes, and a hand-rolled base64 encoder so
 * it does not depend on `Buffer`/`btoa`.
 */

/** Default OLF viewport (the `olf.width` / `olf.height` fields default to these). */
export const OLF_VIEWPORT_WIDTH = 1280;
export const OLF_VIEWPORT_HEIGHT = 720;

/** Fabric canvas-JSON schema version stamped on emitted documents (matches installed fabric@7). */
export const OLF_FABRIC_JSON_VERSION = '7.2.0';

/**
 * Fraction of the page viewport an image element must cover to be treated as the page's full-page
 * background raster (→ `pdfImageUrl`) rather than an in-page overlay object. The ViewSonic full-page
 * template covers ~87% of the viewport; content overlays measured well below (≤ ~52%).
 */
export const OLF_PAGE_BACKGROUND_MIN_COVERAGE = 0.55;

const DEFAULT_STROKE_COLOR = '#000000';
const DEFAULT_STROKE_WIDTH = 4;
const DEFAULT_BACKGROUND_COLOR = '#ffffff';
const DEFAULT_COORDINATE_PRECISION = 2;
const DEFAULT_IMPORT_TITLE = 'Imported board';
const DEFAULT_IMAGE_MIME = 'image/png';

/** Per-page affine extracted from the 9-number matrix string. */
export interface OlfAffine {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

/** Full 2D affine (`x' = a·x + c·y + e`, `y' = b·x + d·y + f`) parsed from an image element's matrix. */
export interface OlfFullAffine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Loose shape of a single OLF stroke element (hyphenated keys are intentional — that's the format). */
export interface OlfStroke {
  id?: string;
  points?: string;
  'stylus-points'?: string;
  stroke?: string;
  'pen-width'?: number | string;
  'pen-height'?: number | string;
  opacity?: number | string;
  'is-highlighter'?: boolean;
  'is-auto-smoothing'?: boolean;
  matrix?: string;
  [key: string]: unknown;
}

/** Loose shape of a single OLF image element (a raster pasted onto the page, e.g. a PDF page). */
export interface OlfImage {
  id?: string;
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  'mime-type'?: string;
  source?: string;
  matrix?: string;
  opacity?: number | string;
  [key: string]: unknown;
}

/** The inner payload of a page background entry (`page.backgrounds[].background`), also accepted flat. */
export interface OlfBackgroundValue {
  type?: string;
  fill?: string;
  'image-source'?: string;
  source?: string;
  opacity?: number | string;
  [key: string]: unknown;
}

/** A page background entry — real OLF wraps it as `{ background: {...} }`; a flat shape is also tolerated. */
export interface OlfBackground extends OlfBackgroundValue {
  background?: OlfBackgroundValue;
}

export interface OlfPage {
  matrix?: string;
  elements?: Array<{ stroke?: OlfStroke; image?: OlfImage; [key: string]: unknown }>;
  backgrounds?: OlfBackground[];
  [key: string]: unknown;
}

export interface OlfRoot {
  width?: number;
  height?: number;
  pageset?: Array<{ page?: OlfPage; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Parsed `content.json` — either `{ olf: {...} }` or the root object directly. */
export interface OlfDocumentJson {
  olf?: OlfRoot;
  [key: string]: unknown;
}

/** The bytes of every non-JSON archive entry (the `images/` folder), keyed by ZIP entry name. */
export type OlfImageAssets = Map<string, Uint8Array>;

export interface OlfConvertOptions {
  /** Document id to assign (default: a fresh local UUID). */
  id?: string;
  /** Document title (default: "Imported board"). */
  title?: string;
  /**
   * Source file name (e.g. `lesson.olf`) stamped onto imported PDF/image pages as `pdfSourceName` so the
   * board records where the page came from. Falls back to {@link OlfConvertOptions.title} when omitted.
   */
  sourceName?: string;
  /**
   * Decimal places to round transformed coordinates to. Trims the (often 34MB+) JSON dramatically
   * with no visible difference. Pass `null` to keep full float precision. Default `2`.
   */
  coordinatePrecision?: number | null;
}

export interface OlfConvertStats {
  pageCount: number;
  strokeCount: number;
  pointCount: number;
  /** Full-page background rasters imported (page backgrounds + exact-duplicate background copies folded in). */
  importedBackgrounds: number;
  /** In-page raster overlays imported as Fabric `image` objects. */
  importedImages: number;
  /** Elements that were not convertible (empty strokes, unknown kinds, images with missing/corrupt bytes). */
  skippedElements: number;
}

export interface OlfConvertResult {
  document: WhiteboardDocument;
  stats: OlfConvertStats;
}

type FabricPathCommand = ['M' | 'L', number, number];

interface FabricPathObject {
  type: 'path';
  version: string;
  originX: 'left';
  originY: 'top';
  left: number;
  top: number;
  width: number;
  height: number;
  fill: null;
  stroke: string;
  strokeWidth: number;
  strokeLineCap: 'round';
  strokeLineJoin: 'round';
  strokeUniform: false;
  opacity: number;
  path: FabricPathCommand[];
  globalCompositeOperation?: 'multiply';
}

interface FabricImageObject {
  type: 'image';
  version: string;
  originX: 'left';
  originY: 'top';
  left: number;
  top: number;
  width: number;
  height: number;
  fill: null;
  stroke: null;
  strokeWidth: 0;
  scaleX: number;
  scaleY: number;
  angle: number;
  flipX: boolean;
  flipY: boolean;
  skewX: 0;
  skewY: 0;
  opacity: number;
  cropX: 0;
  cropY: 0;
  src: string;
  crossOrigin: null;
  filters: [];
}

type FabricObject = FabricPathObject | FabricImageObject;

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);

    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function makeRounder(precision: number | null | undefined): (value: number) => number {
  if (precision === null) {
    return (value) => value;
  }

  const places = Number.isInteger(precision) && precision !== undefined ? precision : DEFAULT_COORDINATE_PRECISION;
  const factor = 10 ** places;

  return (value) => Math.round(value * factor) / factor;
}

/**
 * Parse the 9-number, comma-separated page matrix string into the affine pieces we need. Row-major:
 * `[m0,m1,m2, m3,m4,m5, m6,m7,m8]` → `sx=m0, sy=m4, tx=m2, ty=m5`. Falls back to identity (no scale,
 * no translation) for malformed / missing input, and guards against a zero scale (which would make the
 * inverse divide-by-zero).
 */
export function parseOlfMatrix(matrixString: string | null | undefined): OlfAffine {
  const parts = (matrixString ?? '').split(',').map((part) => Number.parseFloat(part.trim()));

  const sx = Number.isFinite(parts[0]) && parts[0] !== 0 ? (parts[0] as number) : 1;
  const sy = Number.isFinite(parts[4]) && parts[4] !== 0 ? (parts[4] as number) : 1;
  const tx = Number.isFinite(parts[2]) ? (parts[2] as number) : 0;
  const ty = Number.isFinite(parts[5]) ? (parts[5] as number) : 0;

  return { sx, sy, tx, ty };
}

/**
 * Parse the full 2D affine from a row-major 9-number matrix string. Unlike {@link parseOlfMatrix} (which
 * only pulls scale+translate for the stroke path), this keeps the shear terms so an image element's
 * rotation/skew is honoured. Row-major `[m0,m1,m2, m3,m4,m5, m6,m7,m8]` maps to the canvas affine
 * `a=m0, b=m3, c=m1, d=m4, e=m2, f=m5`. Falls back to identity for malformed input.
 */
export function parseOlfFullMatrix(matrixString: string | null | undefined): OlfFullAffine {
  const parts = (matrixString ?? '').split(',').map((part) => Number.parseFloat(part.trim()));
  const at = (index: number, fallback: number): number => (Number.isFinite(parts[index]) ? (parts[index] as number) : fallback);

  return {
    a: at(0, 1),
    b: at(3, 0),
    c: at(1, 0),
    d: at(4, 1),
    e: at(2, 0),
    f: at(5, 0),
  };
}

/** Apply the inverse page transform to a single raw point → page-space coordinates. */
export function transformOlfPoint(rawX: number, rawY: number, affine: OlfAffine): { x: number; y: number } {
  return {
    x: (rawX - affine.tx) / affine.sx,
    y: (rawY - affine.ty) / affine.sy,
  };
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode raw bytes to a standard base64 string. Hand-rolled (not `Buffer`/`btoa`) so this module stays
 * browser-safe and dependency-free. Builds the output in bounded chunks to keep peak intermediate-string
 * cost low on large (hundreds-of-KB) rasters.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const length = bytes.length;
  const chunks: string[] = [];
  let chunk = '';
  let index = 0;

  for (; index + 2 < length; index += 3) {
    const triple = ((bytes[index] as number) << 16) | ((bytes[index + 1] as number) << 8) | (bytes[index + 2] as number);

    chunk +=
      BASE64_CHARS[(triple >> 18) & 63]! +
      BASE64_CHARS[(triple >> 12) & 63]! +
      BASE64_CHARS[(triple >> 6) & 63]! +
      BASE64_CHARS[triple & 63]!;

    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = '';
    }
  }

  const remaining = length - index;

  if (remaining === 1) {
    const triple = (bytes[index] as number) << 16;

    chunk += BASE64_CHARS[(triple >> 18) & 63]! + BASE64_CHARS[(triple >> 12) & 63]! + '==';
  } else if (remaining === 2) {
    const triple = ((bytes[index] as number) << 16) | ((bytes[index + 1] as number) << 8);

    chunk += BASE64_CHARS[(triple >> 18) & 63]! + BASE64_CHARS[(triple >> 12) & 63]! + BASE64_CHARS[(triple >> 6) & 63]! + '=';
  }

  chunks.push(chunk);

  return chunks.join('');
}

/** Normalise an OLF asset path for resilient lookup (lower-case, forward slashes, no leading `./`). */
function normalizeAssetPath(source: string): string {
  return source.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/** Infer an image MIME type from an explicit `mime-type` field, else the file extension, else PNG. */
function inferImageMime(source: string, declaredMime: string | undefined): string {
  if (typeof declaredMime === 'string' && declaredMime.trim().toLowerCase().startsWith('image/')) {
    return declaredMime.trim().toLowerCase();
  }

  const extensionMatch = source.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extension = extensionMatch?.[1];

  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return DEFAULT_IMAGE_MIME;
  }
}

/** Resolve an asset path to its bytes, tolerating case / leading-`./` / basename-only mismatches. */
function lookupImageBytes(source: string | undefined, assets: OlfImageAssets): Uint8Array | null {
  if (!source || typeof source !== 'string' || assets.size === 0) {
    return null;
  }

  const direct = assets.get(source);

  if (direct) {
    return direct;
  }

  const wanted = normalizeAssetPath(source);
  const wantedBase = wanted.split('/').pop() ?? wanted;

  let normalizedHit: Uint8Array | null = null;
  let basenameHit: Uint8Array | null = null;

  assets.forEach((bytes, name) => {
    const normalized = normalizeAssetPath(name);

    if (!normalizedHit && normalized === wanted) {
      normalizedHit = bytes;
    }

    if (!basenameHit && (normalized.split('/').pop() ?? normalized) === wantedBase) {
      basenameHit = bytes;
    }
  });

  return normalizedHit ?? basenameHit;
}

/** Build a `data:<mime>;base64,...` URL for an asset path, or `null` when its bytes are missing/empty. */
function imageSourceToDataUrl(
  source: string | undefined,
  assets: OlfImageAssets,
  declaredMime?: string,
): string | null {
  const bytes = lookupImageBytes(source, assets);

  if (!bytes || bytes.length === 0) {
    return null;
  }

  const mime = inferImageMime(source ?? '', declaredMime);

  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/**
 * Build one Fabric `path` object from an OLF stroke, or `null` when the stroke has no usable points.
 *
 * Positioning note (load-bearing): Fabric renders a path around its own bounding-box CENTER, so for the
 * absolute page coordinates to land where they should we MUST emit `originX/originY = 'left'/'top'` and
 * set `left/top` to the bbox top-left. `width/height` are recomputed identically by Fabric on load from
 * the very same (rounded) path commands, so they stay in sync.
 */
export function olfStrokeToFabricPath(stroke: OlfStroke, round: (value: number) => number): FabricPathObject | null {
  const pointsString = typeof stroke.points === 'string' ? stroke.points : '';

  if (pointsString.trim() === '') {
    return null;
  }

  const path: FabricPathCommand[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // Tokens are "x,y" (or "x,y,pressure"); split on any whitespace run and ignore empties.
  const tokens = pointsString.split(/\s+/);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token) {
      continue;
    }

    const firstComma = token.indexOf(',');

    if (firstComma < 0) {
      continue;
    }

    const rawX = Number.parseFloat(token.slice(0, firstComma));
    const rest = token.slice(firstComma + 1);
    const secondComma = rest.indexOf(',');
    const rawY = Number.parseFloat(secondComma >= 0 ? rest.slice(0, secondComma) : rest);

    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      continue;
    }

    // Use the RAW world coordinates as-is (the page is re-centred to the origin later, per page). The
    // OLF page `matrix` is only the SAVED viewport — applying it would throw most ink off-canvas.
    const x = round(rawX);
    const y = round(rawY);

    path.push([path.length === 0 ? 'M' : 'L', x, y]);

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  if (path.length === 0) {
    return null;
  }

  // A single-point stroke (a dot): add a zero-length line so the round cap renders a visible dot.
  if (path.length === 1) {
    const only = path[0] as FabricPathCommand;

    path.push(['L', only[1], only[2]]);
  }

  const isHighlighter = stroke['is-highlighter'] === true;
  const color = typeof stroke.stroke === 'string' && stroke.stroke.trim() !== '' ? stroke.stroke : DEFAULT_STROKE_COLOR;
  const width = Math.max(0.1, toFiniteNumber(stroke['pen-width'], DEFAULT_STROKE_WIDTH));
  const opacity = Math.min(1, Math.max(0, toFiniteNumber(stroke.opacity, 1)));

  const fabricPath: FabricPathObject = {
    type: 'path',
    version: OLF_FABRIC_JSON_VERSION,
    originX: 'left',
    originY: 'top',
    left: minX,
    top: minY,
    width: maxX - minX,
    height: maxY - minY,
    fill: null,
    stroke: color,
    strokeWidth: width,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    strokeUniform: false,
    opacity,
    path,
  };

  if (isHighlighter) {
    // Highlighter ink composites with multiply so overlapping strokes darken like a real marker.
    fabricPath.globalCompositeOperation = 'multiply';
  }

  return fabricPath;
}

/** The placed rectangle (top-left origin) an image element occupies once its matrix is applied. */
function imagePlacement(
  image: OlfImage,
  affine: OlfFullAffine,
): { left: number; top: number; width: number; height: number; scaleX: number; scaleY: number; angle: number } {
  const localX = toFiniteNumber(image.x, 0);
  const localY = toFiniteNumber(image.y, 0);
  const width = Math.max(0, toFiniteNumber(image.width, 0));
  const height = Math.max(0, toFiniteNumber(image.height, 0));

  // Element's local top-left corner mapped into page space by the full affine.
  const left = affine.a * localX + affine.c * localY + affine.e;
  const top = affine.b * localX + affine.d * localY + affine.f;

  // Decompose the linear part into scale + rotation (skew ignored — OLF image matrices are scale+translate,
  // occasionally with rotation). Fabric draws the source into a `width×height` box, then scales/rotates it.
  const scaleX = Math.hypot(affine.a, affine.b) || 1;
  const scaleY = Math.hypot(affine.c, affine.d) || 1;
  const angle = (Math.atan2(affine.b, affine.a) * 180) / Math.PI;

  return { left, top, width, height, scaleX, scaleY, angle };
}

/** Placed area (page px²) of an image element after its matrix — used to spot the full-page raster. */
function imagePlacedArea(image: OlfImage, affine: OlfFullAffine): number {
  const width = Math.max(0, toFiniteNumber(image.width, 0));
  const height = Math.max(0, toFiniteNumber(image.height, 0));
  const determinant = Math.abs(affine.a * affine.d - affine.b * affine.c);

  return determinant * width * height;
}

/** Build a Fabric `image` object for an in-page raster overlay from its OLF element + resolved data URL. */
function olfImageToFabricImage(image: OlfImage, dataUrl: string, round: (value: number) => number): FabricImageObject {
  const affine = parseOlfFullMatrix(image.matrix);
  const placement = imagePlacement(image, affine);
  const opacity = Math.min(1, Math.max(0, toFiniteNumber(image.opacity, 1)));

  return {
    type: 'image',
    version: OLF_FABRIC_JSON_VERSION,
    originX: 'left',
    originY: 'top',
    left: round(placement.left),
    top: round(placement.top),
    width: round(placement.width),
    height: round(placement.height),
    fill: null,
    stroke: null,
    strokeWidth: 0,
    scaleX: round(placement.scaleX),
    scaleY: round(placement.scaleY),
    angle: round(placement.angle),
    flipX: false,
    flipY: false,
    skewX: 0,
    skewY: 0,
    opacity,
    cropX: 0,
    cropY: 0,
    src: dataUrl,
    crossOrigin: null,
    filters: [],
  };
}

/** A full-viewport Fabric `image` object (for a `type:"image"` page background not used as pdfImageUrl). */
function fullViewportFabricImage(dataUrl: string, viewportWidth: number, viewportHeight: number): FabricImageObject {
  return {
    type: 'image',
    version: OLF_FABRIC_JSON_VERSION,
    originX: 'left',
    originY: 'top',
    left: 0,
    top: 0,
    width: viewportWidth,
    height: viewportHeight,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    scaleX: 1,
    scaleY: 1,
    angle: 0,
    flipX: false,
    flipY: false,
    skewX: 0,
    skewY: 0,
    opacity: 1,
    cropX: 0,
    cropY: 0,
    src: dataUrl,
    crossOrigin: null,
    filters: [],
  };
}

/** Unwrap a page background entry — real OLF nests the payload under `background`; a flat entry is tolerated. */
function unwrapBackground(entry: OlfBackground | null | undefined): OlfBackgroundValue | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  if (entry.background && typeof entry.background === 'object') {
    return entry.background;
  }

  return entry;
}

function resolvePageBackgroundColor(page: OlfPage): string {
  const backgrounds = Array.isArray(page.backgrounds) ? page.backgrounds : [];

  for (const entry of backgrounds) {
    const value = unwrapBackground(entry);

    if (value && typeof value.fill === 'string' && value.fill.trim() !== '') {
      return value.fill;
    }
  }

  return DEFAULT_BACKGROUND_COLOR;
}

/** The `image-source`/`source` paths of every `type:"image"` page background, in order. */
function collectImageBackgroundSources(page: OlfPage): string[] {
  const backgrounds = Array.isArray(page.backgrounds) ? page.backgrounds : [];
  const sources: string[] = [];

  for (const entry of backgrounds) {
    const value = unwrapBackground(entry);

    if (!value || value.type !== 'image') {
      continue;
    }

    const source = value['image-source'] ?? value.source;

    if (typeof source === 'string' && source.trim() !== '') {
      sources.push(source);
    }
  }

  return sources;
}

function olfPageToWhiteboardPage(
  page: OlfPage,
  round: (value: number) => number,
  stats: OlfConvertStats,
  assets: OlfImageAssets,
  viewportWidth: number,
  viewportHeight: number,
  sourceName: string | undefined,
): WhiteboardPage {
  const elements = Array.isArray(page.elements) ? page.elements : [];
  const strokes: OlfStroke[] = [];
  const images: OlfImage[] = [];

  for (const element of elements) {
    if (element && typeof element.image === 'object' && element.image) {
      images.push(element.image);
    } else if (element && typeof element.stroke === 'object' && element.stroke) {
      strokes.push(element.stroke);
    } else {
      stats.skippedElements += 1;
    }
  }

  // --- Pick the page background raster (→ pdfImageUrl). Prefer the largest viewport-covering image
  // ELEMENT (the full-page template/raster); fall back to a `type:"image"` page background. ---
  const viewportArea = viewportWidth * viewportHeight;
  let backgroundElementIndex = -1;
  let backgroundElementArea = -1;

  for (let index = 0; index < images.length; index += 1) {
    const affine = parseOlfFullMatrix(images[index]!.matrix);
    const area = imagePlacedArea(images[index]!, affine);

    // Strictly-greater keeps the FIRST element on an area tie (e.g. a duplicated full-page template).
    if (area > backgroundElementArea && lookupImageBytes(images[index]!.source, assets)) {
      backgroundElementArea = area;
      backgroundElementIndex = index;
    }
  }

  let pdfImageUrl: string | undefined;
  let backgroundSourceKey: string | undefined;

  if (backgroundElementIndex >= 0 && backgroundElementArea >= OLF_PAGE_BACKGROUND_MIN_COVERAGE * viewportArea) {
    const backgroundImage = images[backgroundElementIndex]!;
    const url = imageSourceToDataUrl(backgroundImage.source, assets, backgroundImage['mime-type']);

    if (url) {
      pdfImageUrl = url;
      backgroundSourceKey = normalizeAssetPath(backgroundImage.source ?? '');
      stats.importedBackgrounds += 1;
    }
  }

  const imageBackgroundSources = collectImageBackgroundSources(page);

  if (!pdfImageUrl) {
    for (const source of imageBackgroundSources) {
      const url = imageSourceToDataUrl(source, assets);

      if (url) {
        pdfImageUrl = url;
        backgroundSourceKey = normalizeAssetPath(source);
        stats.importedBackgrounds += 1;
        break;
      }
    }
  }

  const objects: FabricObject[] = [];

  // Any `type:"image"` background NOT chosen as the pdfImageUrl still holds content → render it as a
  // full-viewport image object beneath the overlays (rare — e.g. a pasted screenshot background).
  for (const source of imageBackgroundSources) {
    if (backgroundSourceKey && normalizeAssetPath(source) === backgroundSourceKey) {
      continue;
    }

    const url = imageSourceToDataUrl(source, assets);

    if (!url) {
      stats.skippedElements += 1;
      continue;
    }

    objects.push(fullViewportFabricImage(url, viewportWidth, viewportHeight));
    stats.importedImages += 1;
  }

  // In-page raster overlays → Fabric image objects, placed by their per-element matrix.
  for (let index = 0; index < images.length; index += 1) {
    if (index === backgroundElementIndex && pdfImageUrl) {
      continue;
    }

    const image = images[index]!;

    // An exact duplicate of the chosen background (the ViewSonic repeats its full-page template) is
    // folded into the background rather than drawn twice at a different scale.
    if (backgroundSourceKey && normalizeAssetPath(image.source ?? '') === backgroundSourceKey) {
      stats.importedBackgrounds += 1;
      continue;
    }

    const url = imageSourceToDataUrl(image.source, assets, image['mime-type']);

    if (!url) {
      stats.skippedElements += 1;
      continue;
    }

    objects.push(olfImageToFabricImage(image, url, round));
    stats.importedImages += 1;
  }

  // Strokes render on top of the imported rasters (annotations over content).
  for (const stroke of strokes) {
    const fabricPath = olfStrokeToFabricPath(stroke, round);

    if (!fabricPath) {
      stats.skippedElements += 1;
      continue;
    }

    stats.strokeCount += 1;
    stats.pointCount += fabricPath.path.length;
    objects.push(fabricPath);
  }

  // Re-centre the page to the origin ONLY for backdrop-free pages (legacy stroke-only OLF boards). OLF ink
  // lives on a large horizontal-scroll world and the page `matrix` is only the saved viewport — so shift
  // every object by the page's content bounding-box top-left. When a full-page pdfImageUrl backdrop is
  // present we KEEP raw viewport coordinates instead, so overlays/strokes stay registered to that backdrop.
  if (!pdfImageUrl) {
    let pageMinX = Infinity;
    let pageMinY = Infinity;

    for (const object of objects) {
      if (object.left < pageMinX) pageMinX = object.left;
      if (object.top < pageMinY) pageMinY = object.top;
    }

    if (Number.isFinite(pageMinX) && Number.isFinite(pageMinY) && (pageMinX !== 0 || pageMinY !== 0)) {
      for (const object of objects) {
        object.left = round(object.left - pageMinX);
        object.top = round(object.top - pageMinY);

        if (object.type === 'path') {
          for (const command of object.path) {
            command[1] = round(command[1] - pageMinX);
            command[2] = round(command[2] - pageMinY);
          }
        }
      }
    }
  }

  // A page with a pdfImageUrl backdrop must keep the Fabric layer TRANSPARENT: Fabric paints its
  // `background` ABOVE the separate backdrop canvas, so an opaque page color hides the slide entirely
  // (the "preview shows the PDF but the selected page renders blank" bug — previews render pdfImageUrl
  // directly and were never covered). Only backdrop-free pages carry the OLF page color.
  const canvasJSON = JSON.stringify({
    version: OLF_FABRIC_JSON_VERSION,
    objects,
    ...(pdfImageUrl ? {} : { background: resolvePageBackgroundColor(page) }),
  });

  const whiteboardPage: WhiteboardPage = {
    id: createWhiteboardId(),
    canvasJSON,
    thumbnail: '',
    backgroundType: 'blank',
    viewportOffsetX: 0,
    viewportOffsetY: 0,
  };

  if (pdfImageUrl) {
    whiteboardPage.pdfImageUrl = pdfImageUrl;

    if (sourceName && sourceName.trim() !== '') {
      whiteboardPage.pdfSourceName = sourceName.trim();
    }
  }

  return whiteboardPage;
}

/**
 * Convert an already-parsed `content.json` object into a {@link WhiteboardDocument}. Pure and
 * synchronous — no unzip, no I/O — so it's trivially testable and reusable when the JSON is sourced
 * elsewhere. Pass the archive's `images/` bytes as `assets` to embed image content; when omitted, image
 * elements/backgrounds are skipped (no bytes to embed). Use {@link convertOlfToWhiteboardDocument} for the
 * full bytes → document pipeline.
 */
export function convertOlfDataToWhiteboardDocument(
  data: OlfDocumentJson,
  options: OlfConvertOptions = {},
  assets: OlfImageAssets = new Map(),
): OlfConvertResult {
  const root: OlfRoot = (data && typeof data === 'object' && data.olf ? data.olf : (data as OlfRoot)) ?? {};
  const pageEntries = Array.isArray(root.pageset) ? root.pageset : [];
  const round = makeRounder(options.coordinatePrecision);
  const viewportWidth = Math.max(1, toFiniteNumber(root.width, OLF_VIEWPORT_WIDTH));
  const viewportHeight = Math.max(1, toFiniteNumber(root.height, OLF_VIEWPORT_HEIGHT));
  const sourceName = options.sourceName ?? options.title;

  const stats: OlfConvertStats = {
    pageCount: 0,
    strokeCount: 0,
    pointCount: 0,
    importedBackgrounds: 0,
    importedImages: 0,
    skippedElements: 0,
  };

  const pages: WhiteboardPage[] = pageEntries.map((entry) => {
    const page: OlfPage = (entry && typeof entry === 'object' && entry.page ? entry.page : (entry as OlfPage)) ?? {};

    stats.pageCount += 1;

    return olfPageToWhiteboardPage(page, round, stats, assets, viewportWidth, viewportHeight, sourceName);
  });

  // Never produce a zero-page board — fall back to a single blank page.
  const resolvedPages: WhiteboardPage[] =
    pages.length > 0
      ? pages
      : [
          {
            id: createWhiteboardId(),
            canvasJSON: '',
            thumbnail: '',
            backgroundType: 'blank',
            viewportOffsetX: 0,
            viewportOffsetY: 0,
          },
        ];

  const now = Date.now();

  const document: WhiteboardDocument = {
    id: options.id ?? createWhiteboardId(),
    title: options.title?.trim() || DEFAULT_IMPORT_TITLE,
    pages: resolvedPages,
    currentPageIndex: 0,
    createdAt: now,
    updatedAt: now,
    thumbnail: '',
    schemaVersion: WHITEBOARD_SCHEMA_VERSION,
  };

  return { document, stats };
}

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/** Unzip the `.olf` archive (async, non-blocking) and return its file entries. */
function unzipOlfArchive(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, files) => {
      if (error) {
        reject(error);

        return;
      }

      resolve(files);
    });
  });
}

function pickContentJsonEntry(files: Record<string, Uint8Array>): { name: string; bytes: Uint8Array } {
  const names = Object.keys(files);
  const exact = names.find((name) => name.toLowerCase().endsWith('content.json'));
  const target = exact ?? names.find((name) => name.toLowerCase().endsWith('.json'));

  if (!target) {
    throw new Error('OLF archive does not contain a content.json entry.');
  }

  return { name: target, bytes: files[target] as Uint8Array };
}

/**
 * Unzip `.olf` bytes in-browser and return BOTH the parsed `content.json` and the raw bytes of every
 * `images/` asset (keyed by ZIP entry name), so image elements/backgrounds can be embedded as data URLs.
 * Browser-safe (fflate + its `strFromU8`); no Node-only APIs.
 */
export async function parseOlfArchiveWithAssets(
  input: ArrayBuffer | Uint8Array,
): Promise<{ data: OlfDocumentJson; assets: OlfImageAssets }> {
  const files = await unzipOlfArchive(toUint8Array(input));
  const content = pickContentJsonEntry(files);
  const assets: OlfImageAssets = new Map();

  for (const [name, bytes] of Object.entries(files)) {
    if (name === content.name || name.toLowerCase().endsWith('.json')) {
      continue;
    }

    // Skip directory entries and empty payloads; keep everything else (the `images/` rasters).
    if (name.endsWith('/') || !bytes || bytes.length === 0) {
      continue;
    }

    assets.set(name, bytes);
  }

  return { data: JSON.parse(strFromU8(content.bytes)) as OlfDocumentJson, assets };
}

/**
 * Unzip `.olf` bytes in-browser and parse the embedded `content.json`. Browser-safe (fflate + its
 * `strFromU8`); no Node-only APIs. Discards the image assets — use {@link parseOlfArchiveWithAssets} when
 * you need them.
 */
export async function parseOlfArchive(input: ArrayBuffer | Uint8Array): Promise<OlfDocumentJson> {
  const { data } = await parseOlfArchiveWithAssets(input);

  return data;
}

/**
 * Full pipeline: accept raw `.olf` bytes, unzip + parse `content.json`, embed the archive's image assets,
 * convert every page's strokes into Fabric path objects and its rasters into image objects / pdfImageUrl
 * backgrounds, and return a {@link WhiteboardDocument} ready to hand to `saveWhiteboard()`. Handles ~12k
 * strokes / ~370k points comfortably.
 */
export async function convertOlfToWhiteboardDocument(
  input: ArrayBuffer | Uint8Array,
  options: OlfConvertOptions = {},
): Promise<WhiteboardDocument> {
  const { data, assets } = await parseOlfArchiveWithAssets(input);

  return convertOlfDataToWhiteboardDocument(data, options, assets).document;
}

/** Same as {@link convertOlfToWhiteboardDocument} but also returns conversion {@link OlfConvertStats}. */
export async function convertOlfToWhiteboardResult(
  input: ArrayBuffer | Uint8Array,
  options: OlfConvertOptions = {},
): Promise<OlfConvertResult> {
  const { data, assets } = await parseOlfArchiveWithAssets(input);

  return convertOlfDataToWhiteboardDocument(data, options, assets);
}
