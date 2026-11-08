/// <reference path="./katex-css.d.ts" />
import { cache } from 'fabric';

import { BOARD_FONT_FAMILY, BOARD_FONT_FILES, isBoardFontLoaded, loadBoardFontFaces } from './fontGate';
import { stripInlineMarkdown } from './markdownBlocks';
import { inlineMathToText } from './latexText';

import type { FontFaceLike, FontSetLike } from './fontGate';

/**
 * Browser-only rendering for the board AI: KaTeX (lazy), formula → PNG, table → PNG, and the font
 * plumbing both need. Nothing here runs until the teacher actually uses an AI feature — KaTeX and its
 * stylesheet are separate chunks bundled with the app (no CDN, so the Android static export and an
 * offline desktop work the same).
 */

export const BOARD_TEXT_FONT = "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, sans-serif";

type KatexModule = typeof import('katex');

let katexPromise: Promise<KatexModule | null> | null = null;

const LTR_STYLE_ID = 'wb-ai-ltr-style';

/**
 * KaTeX lays formulas out with inline boxes that assume LTR, so every KaTeX host carries
 * `.wb-ai-ltr` and keeps that direction whatever the page around it says.
 */
export function ensureLtrStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(LTR_STYLE_ID)) return;

  const style = document.createElement('style');

  style.id = LTR_STYLE_ID;
  style.textContent =
    '.wb-ai-ltr, .wb-ai-ltr *, .katex, .katex * { direction: ltr !important; unicode-bidi: isolate; }' +
    // \text{…} is written in the brand font, not whatever system font has the glyphs.
    `.katex .text { font-family: KaTeX_Main, '${BOARD_FONT_FAMILY}', serif; }` +
    '.wb-ai-math-block { overflow-x: auto; overflow-y: hidden; text-align: center; }';
  document.head.appendChild(style);
}

export function loadKatex(): Promise<KatexModule | null> {
  ensureLtrStyle();

  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      // The stylesheet is a separate chunk; a failure (no CSS loader in a test runner) leaves the
      // formulas unstyled rather than missing.
      import('katex/dist/katex.min.css').catch(() => null),
    ])
      .then(([module]) => ((module as unknown as { default?: KatexModule }).default ?? module) as KatexModule)
      .catch(() => {
        katexPromise = null;

        return null;
      });
  }

  return katexPromise;
}

/** KaTeX HTML for one formula, or null when KaTeX is not loaded / the TeX is unusable. */
export function renderKatexHtml(katex: KatexModule | null, tex: string, displayMode: boolean): string | null {
  if (!katex) return null;

  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: 'html', strict: 'ignore', trust: false });
  } catch {
    return null;
  }
}

let boardFontBaseUrl = '/font/';
let boardFontsPromise: Promise<boolean> | null = null;
let boardFontsReady = false;
const lateFontListeners = new Set<() => void>();

/** Host apps that serve `public/font` somewhere else point the board at it before the first insert. */
export function setBoardFontBaseUrl(url: string): void {
  boardFontBaseUrl = url.endsWith('/') ? url : `${url}/`;
  boardFontsPromise = null;
}

/** True once every Plex weight the board uses is loaded (and Fabric's metric cache was reset). */
export const boardFontsLoaded = () => boardFontsReady;

/**
 * Called when the board font finishes loading AFTER the gate gave up — text built in the fallback
 * font's metrics should be re-measured (`initDimensions`). Returns the unsubscribe.
 */
export function onBoardFontsLate(listener: () => void): () => void {
  lateFontListeners.add(listener);

  return () => lateFontListeners.delete(listener);
}

let listeningLate = false;

function listenForLateFonts(): void {
  if (listeningLate || typeof document === 'undefined' || !document.fonts?.addEventListener) return;

  listeningLate = true;

  const onDone = () => {
    if (boardFontsReady || !isBoardFontLoaded(document.fonts as unknown as FontSetLike)) return;

    document.fonts.removeEventListener('loadingdone', onDone);
    listeningLate = false;
    markFontsReady();
  };

  document.fonts.addEventListener('loadingdone', onDone);
}

function markFontsReady(): void {
  const wasReady = boardFontsReady;

  boardFontsReady = true;
  // Fabric caches glyph widths per family/weight: anything measured before the font arrived is stale.
  cache.clearFontCache();

  if (!wasReady) lateFontListeners.forEach((listener) => listener());
}

/**
 * The gate every builder awaits before it creates text (see `fontGate.ts`): IBM Plex Sans Arabic Regular,
 * Medium, Semibold and Bold loaded through the page's @font-face — or declared here from
 * `/font/*.woff2` when the page has none — then `document.fonts.ready`. Resolves false after ~4 s
 * without the font (offline + never cached): the fallback font is used, and when Plex does arrive
 * later the late listeners re-measure.
 */
export function ensureBoardFonts(): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve(false);
  if (boardFontsReady) return Promise.resolve(true);

  if (!boardFontsPromise) {
    boardFontsPromise = loadBoardFontFaces(document.fonts as unknown as FontSetLike, {
      baseUrl: boardFontBaseUrl,
      createFace:
        typeof FontFace === 'undefined'
          ? undefined
          : (family, source, descriptors) => new FontFace(family, source, descriptors) as unknown as FontFaceLike,
    })
      .then((result) => {
        if (result.ready) {
          // Cleared only when the font is new to this session — later inserts reuse the cache.
          if (!boardFontsReady) {
            boardFontsReady = true;
            cache.clearFontCache();
          }

          return true;
        }

        // Not now: keep listening, and allow the next insert to try again.
        boardFontsPromise = null;
        listenForLateFonts();

        return false;
      })
      .catch(() => {
        boardFontsPromise = null;

        return false;
      });
  }

  return boardFontsPromise;
}

// ---------------------------------------------------------------------------
// Fonts for SVG <foreignObject>: an SVG drawn as an image cannot fetch anything, so every font the
// formula uses is inlined as a data URL.
// ---------------------------------------------------------------------------

const fontDataCache = new Map<string, Promise<string | null>>();

async function fetchAsDataUrl(url: string): Promise<string | null> {
  let cached = fontDataCache.get(url);

  if (!cached) {
    cached = fetch(url)
      .then((response) => (response.ok ? response.blob() : null))
      .then(
        (blob) =>
          blob &&
          new Promise<string | null>((resolve) => {
            const reader = new FileReader();

            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          }),
      )
      .catch(() => null);
    fontDataCache.set(url, cached);
  }

  return cached;
}

function forEachCssRule(visit: (rule: CSSRule, sheetHref: string) => void): void {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;

    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet
    }

    const href = sheet.href ?? location.href;

    for (const rule of Array.from(rules ?? [])) visit(rule, href);
  }
}

/** The KaTeX stylesheet text (minus @font-face), plus inlined @font-face rules for `families`. */
async function katexCssFor(families: Set<string>): Promise<string> {
  const css: string[] = [];
  const fontJobs: Array<Promise<string | null>> = [];
  let brandRuleFound = false;

  forEachCssRule((rule, href) => {
    if (rule instanceof CSSFontFaceRule) {
      const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim();

      if (!families.has(family)) return;

      if (family === BOARD_FONT_FAMILY) {
        // Only the weights a formula's \text uses — the black/thin cuts would bloat every SVG.
        const weight = rule.style.getPropertyValue('font-weight');

        if (!['normal', '400', '500'].includes(weight)) return;
        brandRuleFound = true;
      }

      const src = rule.style.getPropertyValue('src');
      const woff2 = src.match(/url\(\s*["']?([^"')]+?\.woff2[^"')]*)["']?\s*\)/i)?.[1];

      if (!woff2) return;

      const absolute = new URL(woff2, href).toString();

      fontJobs.push(
        fetchAsDataUrl(absolute).then((data) =>
          data
            ? `@font-face{font-family:'${family}';src:url(${data}) format('woff2');font-weight:${
                rule.style.getPropertyValue('font-weight') || 'normal'
              };font-style:${rule.style.getPropertyValue('font-style') || 'normal'};}`
            : null,
        ),
      );

      return;
    }

    if (rule instanceof CSSStyleRule && rule.selectorText.includes('katex')) css.push(rule.cssText);
  });

  // The brand font declared by `ensureBoardFonts` itself (no @font-face rule in this page).
  if (families.has(BOARD_FONT_FAMILY) && !brandRuleFound) {
    for (const [weight, file] of Object.entries(BOARD_FONT_FILES)) {
      if (weight !== '400' && weight !== '500') continue;

      fontJobs.push(
        fetchAsDataUrl(new URL(`${boardFontBaseUrl}${file}`, location.href).toString()).then((data) =>
          data ? `@font-face{font-family:'${BOARD_FONT_FAMILY}';src:url(${data}) format('woff2');font-weight:${weight};font-style:normal;}` : null,
        ),
      );
    }
  }

  const fonts = (await Promise.all(fontJobs)).filter(Boolean) as string[];

  return [...fonts, ...css].join('\n');
}

const waitFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export interface RasterResult {
  dataUrl: string;
  /** CSS-px size at the requested font size (the PNG itself is `pixelRatio` × larger). */
  width: number;
  height: number;
  /** CSS px from the top of the picture down to the formula's baseline (inline formulas sit on it). */
  baseline?: number;
}

/**
 * One display formula → PNG via KaTeX HTML inside an SVG <foreignObject>. Returns null wherever
 * that route is closed (KaTeX failed to load, the WebView taints foreignObject canvases), and the
 * caller falls back to a plain-text Textbox of {@link latexToText}.
 */
export async function renderMathImage(
  tex: string,
  {
    fontPx = 28,
    color = '#18204a',
    pixelRatio = 3,
    display = true,
  }: { fontPx?: number; color?: string; pixelRatio?: number; display?: boolean } = {},
): Promise<RasterResult | null> {
  if (typeof document === 'undefined') return null;

  const katex = await loadKatex();
  const formula = renderKatexHtml(katex, tex, display);

  if (!formula) return null;

  // A zero-size inline-block sits on the line's baseline: its top is where the formula's baseline is.
  const html = display ? formula : `<span class="wb-ai-baseline" style="display:inline-block;width:0;height:0;vertical-align:baseline"></span>${formula}`;

  if (!html) return null;

  const host = document.createElement('div');

  host.className = 'wb-ai-ltr';
  host.setAttribute('dir', 'ltr');
  host.style.cssText = `position:fixed;left:-100000px;top:0;display:inline-block;padding:4px 6px;font-size:${fontPx}px;color:${color};background:transparent;white-space:nowrap;line-height:1.2;`;
  host.innerHTML = html;
  document.body.appendChild(host);

  try {
    // KaTeX fonts load on first use; wait for them so the measurement is the real one.
    await waitFrame();

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }

    // `.katex-display` adds vertical margins we do not want in an image.
    host.querySelectorAll<HTMLElement>('.katex-display').forEach((element) => {
      element.style.margin = '0';
    });

    const rect = host.getBoundingClientRect();
    const width = Math.ceil(rect.width) + 2;
    const height = Math.ceil(rect.height) + 2;
    const probe = host.querySelector<HTMLElement>('.wb-ai-baseline');
    const baseline = probe ? probe.getBoundingClientRect().top - rect.top : undefined;

    if (width < 4 || height < 4) return null;

    const families = new Set<string>();

    host.querySelectorAll('*').forEach((element) => {
      const family = getComputedStyle(element).fontFamily.split(',')[0]?.replace(/["']/g, '').trim();

      if (family) families.add(family);
    });

    const css = await katexCssFor(families);

    host.style.position = 'static';
    host.style.left = '0';

    const xhtml = new XMLSerializer().serializeToString(host);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<style><![CDATA[${css}\n.wb-ai-ltr,.wb-ai-ltr *{direction:ltr;}]]></style>` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
    const image = new Image();

    image.decoding = 'async';
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();

    const canvas = document.createElement('canvas');

    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);

    const ctx = canvas.getContext('2d');

    if (!ctx) return null;

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    // Throws SecurityError where foreignObject taints the canvas (WebKit) → caller falls back.
    return { dataUrl: canvas.toDataURL('image/png'), width, height, baseline };
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

/**
 * A block of self-styled HTML (inline styles only — app classes do not reach the SVG) with KaTeX in
 * it → PNG at a fixed CSS width, through the same <foreignObject> route as {@link renderMathImage}.
 * `<img>` sources must already be data URLs. Null wherever that route is closed (tainted canvas).
 */
export async function renderHtmlImage(
  html: string,
  { widthPx, pixelRatio = 2 }: { widthPx: number; pixelRatio?: number },
): Promise<RasterResult | null> {
  if (typeof document === 'undefined') return null;

  const host = document.createElement('div');

  host.className = 'wb-ai-ltr';
  host.setAttribute('dir', 'ltr');
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${widthPx}px;box-sizing:border-box;background:transparent;`;
  host.innerHTML = html;
  document.body.appendChild(host);

  try {
    await waitFrame();

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }

    const width = widthPx;
    const height = Math.ceil(host.getBoundingClientRect().height) + 2;

    if (height < 4) return null;

    const families = new Set<string>();

    host.querySelectorAll('*').forEach((element) => {
      const family = getComputedStyle(element).fontFamily.split(',')[0]?.replace(/["']/g, '').trim();

      if (family) families.add(family);
    });

    const css = await katexCssFor(families);

    host.style.position = 'static';
    host.style.left = '0';

    const xhtml = new XMLSerializer().serializeToString(host);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<style><![CDATA[${css}\n.wb-ai-ltr .katex,.wb-ai-ltr .katex *{direction:ltr;}]]></style>` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
    const image = new Image();

    image.decoding = 'async';
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();

    const canvas = document.createElement('canvas');

    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);

    const ctx = canvas.getContext('2d');

    if (!ctx) return null;

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    return { dataUrl: canvas.toDataURL('image/png'), width, height };
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

// ---------------------------------------------------------------------------
// Tables: drawn with the 2D API, so they rasterise everywhere and use the board's own font.
// ---------------------------------------------------------------------------

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    // A formula (wrapped LRE … PDF by latexText) is one unbreakable word even though it holds spaces:
    // split across two lines, the second half loses its embedding and `+ O₂)` flips to `(O₂ +`.
    const words = paragraph.match(/(?:[^\s\u202A]|\u202A[^\u202C]*\u202C?)+/g) ?? [];
    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;

      if (ctx.measureText(candidate).width <= maxWidth || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }

    lines.push(line);
  }

  return lines.length ? lines : [''];
}

export function cellText(markdown: string): string {
  return inlineMathToText(stripInlineMarkdown(markdown)).trim();
}

export function renderTableImage(
  table: { header: string[]; rows: string[][] },
  {
    fontPx = 20,
    pixelRatio = 2,
    maxColumnWidth = 300,
    color = '#18204a',
  }: { fontPx?: number; pixelRatio?: number; maxColumnWidth?: number; color?: string } = {},
): RasterResult | null {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) return null;

  const padX = Math.round(fontPx * 0.6);
  const padY = Math.round(fontPx * 0.45);
  const lineHeight = Math.round(fontPx * 1.4);
  const columns = Math.max(table.header.length, ...table.rows.map((row) => row.length));
  const all = [table.header, ...table.rows].map((row) => Array.from({ length: columns }, (_, i) => cellText(row[i] ?? '')));
  // Header Semibold, cells Regular — the board's Plex weights.
  const fontFor = (rowIndex: number) => `${rowIndex === 0 ? 600 : 400} ${fontPx}px ${BOARD_TEXT_FONT}`;
  const widths = Array.from({ length: columns }, (_, column) => {
    let widest = fontPx * 2;

    all.forEach((row, rowIndex) => {
      ctx.font = fontFor(rowIndex);

      for (const part of (row[column] ?? '').split('\n')) widest = Math.max(widest, ctx.measureText(part).width);
    });

    return Math.ceil(Math.min(maxColumnWidth, widest)) + padX * 2;
  });
  const wrapped = all.map((row, rowIndex) => {
    ctx.font = fontFor(rowIndex);

    return row.map((cell, column) => wrapText(ctx, cell, (widths[column] ?? 100) - padX * 2));
  });
  const heights = wrapped.map((row) => Math.max(...row.map((lines) => lines.length)) * lineHeight + padY * 2);
  const width = widths.reduce((sum, w) => sum + w, 0) + 2;
  const height = heights.reduce((sum, h) => sum + h, 0) + 2;

  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  ctx.scale(pixelRatio, pixelRatio);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';

  let y = 1;

  wrapped.forEach((row, rowIndex) => {
    const rowHeight = heights[rowIndex] ?? lineHeight;

    if (rowIndex === 0) {
      ctx.fillStyle = '#f1eee4';
      ctx.fillRect(1, y, width - 2, rowHeight);
    } else if (rowIndex % 2 === 0) {
      ctx.fillStyle = '#fbfaf6';
      ctx.fillRect(1, y, width - 2, rowHeight);
    }

    let left = 1;

    row.forEach((lines, column) => {
      const columnWidth = widths[column] ?? 100;

      ctx.font = fontFor(rowIndex);
      ctx.fillStyle = color;
      lines.forEach((line, lineIndex) => {
        ctx.fillText(line, left + padX, y + padY + lineHeight * (lineIndex + 0.5));
      });
      left += columnWidth;
    });

    y += rowHeight;
  });

  // Grid.
  ctx.strokeStyle = 'rgba(24, 32, 74, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  ctx.beginPath();

  let lineY = 1;

  for (const rowHeight of heights.slice(0, -1)) {
    lineY += rowHeight;
    ctx.moveTo(0, Math.round(lineY) + 0.5);
    ctx.lineTo(width, Math.round(lineY) + 0.5);
  }

  let lineX = 1;

  for (const columnWidth of widths.slice(0, -1)) {
    lineX += columnWidth;
    ctx.moveTo(Math.round(lineX) + 0.5, 0);
    ctx.lineTo(Math.round(lineX) + 0.5, height);
  }

  ctx.stroke();

  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/** Canvas → PNG blob (falls back to a dataURL round-trip where `toBlob` is missing). */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => resolve(blob), 'image/png');

      return;
    }

    try {
      const data = canvas.toDataURL('image/png');
      const bytes = atob(data.split(',')[1] ?? '');
      const buffer = new Uint8Array(bytes.length);

      for (let index = 0; index < bytes.length; index += 1) buffer[index] = bytes.charCodeAt(index);
      resolve(new Blob([buffer], { type: 'image/png' }));
    } catch {
      resolve(null);
    }
  });
}

/** Canvas → JPEG blob on white (a page picture for a vision model: a fraction of the PNG's bytes). */
export function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.86): Promise<Blob | null> {
  return new Promise((resolve) => {
    const flat = document.createElement('canvas');

    flat.width = canvas.width;
    flat.height = canvas.height;

    const ctx = flat.getContext('2d');

    if (!ctx) {
      resolve(null);

      return;
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);

    if (typeof flat.toBlob === 'function') {
      flat.toBlob((blob) => resolve(blob), 'image/jpeg', quality);

      return;
    }

    try {
      const data = flat.toDataURL('image/jpeg', quality);
      const bytes = atob(data.split(',')[1] ?? '');
      const buffer = new Uint8Array(bytes.length);

      for (let index = 0; index < bytes.length; index += 1) buffer[index] = bytes.charCodeAt(index);
      resolve(new Blob([buffer], { type: 'image/jpeg' }));
    } catch {
      resolve(null);
    }
  });
}

/** Whitens everything outside `polygon` (pixel coords) — the lasso crop, as one even-odd fill. */
export function maskCanvasOutside(canvas: HTMLCanvasElement, polygon: Array<{ x: number; y: number }>): void {
  const ctx = canvas.getContext('2d');

  if (!ctx || polygon.length < 3) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.moveTo(polygon[0]!.x, polygon[0]!.y);

  for (const point of polygon.slice(1)) ctx.lineTo(point.x, point.y);

  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill('evenodd');
  ctx.restore();
}

/** A picture's RGBA pixels, downscaled so the long edge is at most `maxEdge` (colour sampling). */
export async function blobPixels(blob: Blob, maxEdge = 480): Promise<Uint8ClampedArray | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');

    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));

    const ctx = canvas.getContext('2d');

    if (!ctx) return null;

    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;
  }
}

/** Crops a canvas to `box` (pixels) into a new canvas. */
export function cropCanvas(source: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }): HTMLCanvasElement {
  const canvas = document.createElement('canvas');

  canvas.width = Math.max(1, Math.round(box.width));
  canvas.height = Math.max(1, Math.round(box.height));
  canvas.getContext('2d')?.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);

  return canvas;
}

export interface VisionPrepInfo {
  inverted: boolean;
  scale: number;
  lineHeight: number;
  strokeWidth: number;
  thickened: number;
}

/**
 * A rendered lasso/selection crop → the picture a vision model reads best (see `visionPrep.ts`):
 * white paper, dark ink with its hue, a dark board inverted, outside-the-lasso whitened, trimmed to
 * the ink + 24 px, scaled so a line of writing is ≥ 40 px (long edge 512–1600), hairlines thickened.
 */
export async function prepareForVision(
  source: HTMLCanvasElement,
  { polygon }: { polygon?: Array<{ x: number; y: number }> } = {},
): Promise<{ canvas: HTMLCanvasElement; info: VisionPrepInfo }> {
  const { normalizeInk, strokeWidthEstimate, thickenInk, visionScale } = await import('./visionPrep');
  const { contentPixelBounds, detectInkLines } = await import('./lassoGeometry');
  const ctx = source.getContext('2d', { willReadFrequently: true });

  if (!ctx) return { canvas: source, info: { inverted: false, scale: 1, lineHeight: 0, strokeWidth: 0, thickened: 0 } };

  const image = ctx.getImageData(0, 0, source.width, source.height);
  // Before the mask: the mask paints white, which would hide a dark board from the border test.
  const { inverted } = normalizeInk(image.data, source.width, source.height);

  ctx.putImageData(image, 0, 0);

  if (polygon && polygon.length >= 3) maskCanvasOutside(source, polygon);

  const masked = ctx.getImageData(0, 0, source.width, source.height).data;
  const box = contentPixelBounds(masked, source.width, source.height, { threshold: 235, padding: 24, stride: 1 });
  const cropped = box ? cropCanvas(source, box) : source;
  const croppedData = cropped.getContext('2d')?.getImageData(0, 0, cropped.width, cropped.height).data;
  const bands = croppedData ? detectInkLines(croppedData, cropped.width, cropped.height, { mergeGap: Math.max(2, Math.round(cropped.height * 0.01)) }) : [];
  const heights = bands.map((band) => band.h * cropped.height).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  const scale = visionScale({ width: cropped.width, height: cropped.height }, lineHeight);
  const output = document.createElement('canvas');

  output.width = Math.max(1, Math.round(cropped.width * scale));
  output.height = Math.max(1, Math.round(cropped.height * scale));

  const out = output.getContext('2d', { willReadFrequently: true });

  if (!out) return { canvas: cropped, info: { inverted, scale: 1, lineHeight, strokeWidth: 0, thickened: 0 } };

  out.fillStyle = '#ffffff';
  out.fillRect(0, 0, output.width, output.height);
  out.imageSmoothingEnabled = true;
  out.imageSmoothingQuality = 'high';
  out.drawImage(cropped, 0, 0, output.width, output.height);

  let pixels = out.getImageData(0, 0, output.width, output.height);
  const strokeWidth = strokeWidthEstimate(pixels.data, output.width, output.height);
  let thickened = 0;

  // Hairlines (a fine pen at low zoom) read as noise; two px of weight makes them letters.
  while (strokeWidth > 0 && strokeWidth + thickened * 2 < 4 && thickened < 2) {
    pixels = new ImageData(thickenInk(pixels.data, output.width, output.height), output.width, output.height);
    thickened += 1;
  }

  if (thickened) out.putImageData(pixels, 0, 0);

  return { canvas: output, info: { inverted, scale, lineHeight, strokeWidth, thickened } };
}
