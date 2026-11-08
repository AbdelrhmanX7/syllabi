/**
 * Smart ink contrast: a stroke colour that would barely show against what is under it is drawn in
 * a darker (or, on a dark background, lighter) shade of the SAME hue, until it reads at WCAG 3:1.
 *
 * The teacher's palette is never touched — only the colour the brush paints with for one stroke.
 * Light yellow or cyan on a white page is the case that prompted this; dark ink over a dark region of
 * an imported PDF is the mirror image, and both come out of the same rule:
 *
 *   1. Take the luminance of the background under the stroke start, ONCE per stroke (a plain page is
 *      its paper colour and needs no pixel read; a painted background is answered from readings taken
 *      OFF the input path — see `backgroundLuminanceCache.ts` — never by a readback at pen-down).
 *   2. Composite the ink's translucency over that luminance and measure the WCAG contrast ratio.
 *   3. Below {@link MIN_INK_CONTRAST}, move the ink's OKLCH lightness — hue and chroma kept as far as
 *      the sRGB gamut allows — towards the side with more headroom, by bisection, until the ratio is
 *      met. A target that cannot be met at all (a deliberately faint wash) leaves the colour alone.
 *
 * Everything in here is pure arithmetic on a handful of numbers; the whole adjustment is well under
 * a millisecond and runs once per pen-down, which is what makes it free on a Galaxy Tab A7.
 */

/** WCAG ratio a stroke must reach against its background before it is left as the teacher picked it. */
export const MIN_INK_CONTRAST = 3;

/** Relative luminance of the board's paper (`BOARD_BASE_COLOR`, white). */
export const PAPER_LUMINANCE = 1;

interface Rgba {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
  /** How the input was written, so the output can be written the same way. */
  format: 'hex' | 'rgb';
}

interface Oklch {
  l: number;
  c: number;
  h: number;
}

/**
 * Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` and `rgba(r, g, b, a)`. Anything else
 * (a named colour, `hsl()`) returns null and the caller leaves the colour as it is — adjusting a
 * colour we cannot read back would risk replacing it with the wrong one.
 */
export function parseInkColor(color: string): Rgba | null {
  const value = color.trim();

  if (value.startsWith('#')) {
    const hex = value.slice(1);

    if (!/^[0-9a-f]+$/i.test(hex)) return null;

    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split('').map((part) => Number.parseInt(part + part, 16));

      return { r, g, b, a: hex.length === 4 ? a / 255 : 1, format: 'hex' };
    }

    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;

      return { r, g, b, a, format: 'hex' };
    }

    return null;
  }

  const match = value.match(/^rgba?\(([^)]+)\)$/i);

  if (!match) return null;

  const parts = match[1].split(/[\s,/]+/).filter(Boolean);

  if (parts.length < 3 || parts.length > 4) return null;

  const channel = (part: string): number | null => {
    const number = part.endsWith('%') ? (Number.parseFloat(part) * 255) / 100 : Number.parseFloat(part);

    return Number.isFinite(number) ? Math.min(255, Math.max(0, number)) : null;
  };
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);

  if (r === null || g === null || b === null) return null;

  let a = 1;

  if (parts.length === 4) {
    const alpha = parts[3].endsWith('%') ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);

    if (!Number.isFinite(alpha)) return null;

    a = Math.min(1, Math.max(0, alpha));
  }

  return { r, g, b, a, format: 'rgb' };
}

function formatInkColor({ r, g, b, a, format }: Rgba): string {
  const round = (channel: number) => Math.round(Math.min(255, Math.max(0, channel)));

  if (format === 'hex' && a >= 1) {
    const hex = (channel: number) => round(channel).toString(16).padStart(2, '0');

    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  const alpha = Math.round(a * 1000) / 1000;

  return `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${alpha})`;
}

const srgbToLinear = (channel: number): number => {
  const c = channel / 255;

  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

const linearToSrgb = (linear: number): number => {
  const c = Math.min(1, Math.max(0, linear));

  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

/** WCAG 2 relative luminance of an sRGB colour (0 = black, 1 = white). */
export function relativeLuminance(color: Pick<Rgba, 'r' | 'g' | 'b'>): number {
  return 0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b);
}

/** WCAG 2 contrast ratio between two luminances, ≥ 1. */
export function contrastRatio(luminanceA: number, luminanceB: number): number {
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Luminance the eye sees where translucent ink of luminance `ink` covers a background of luminance
 * `background` at `alpha`. Luminance is linear in linear-light RGB, so compositing is a plain mix.
 */
const compositeLuminance = (ink: number, background: number, alpha: number): number =>
  alpha * ink + (1 - alpha) * background;

// --- OKLab / OKLCH (Björn Ottosson, 2020) ---

function linearRgbToOklch(r: number, g: number, b: number): Oklch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  // An achromatic colour has no hue; 0 is as good as any and keeps the maths finite.
  const h = c < 1e-6 ? 0 : (Math.atan2(bb, a) * 180) / Math.PI;

  return { l: L, c, h: h < 0 ? h + 360 : h };
}

function oklchToLinearRgb({ l: L, c, h }: Oklch): { r: number; g: number; b: number } {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const bb = c * Math.sin(hRad);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * bb, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * bb, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * bb, 3);

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

const GAMUT_EPSILON = 1e-4;

const isInGamut = (rgb: { r: number; g: number; b: number }): boolean =>
  rgb.r >= -GAMUT_EPSILON &&
  rgb.r <= 1 + GAMUT_EPSILON &&
  rgb.g >= -GAMUT_EPSILON &&
  rgb.g <= 1 + GAMUT_EPSILON &&
  rgb.b >= -GAMUT_EPSILON &&
  rgb.b <= 1 + GAMUT_EPSILON;

/**
 * The sRGB colour at lightness `l` with the hue kept and the chroma kept as far as the gamut allows:
 * a darker yellow has to shed some chroma to stay representable, so the chroma is bisected down to
 * the widest value that still lands inside sRGB. Every channel is finally clamped to absorb the
 * epsilon.
 */
function oklchToGamutRgb(target: Oklch): { r: number; g: number; b: number } {
  let rgb = oklchToLinearRgb(target);

  if (!isInGamut(rgb)) {
    let low = 0;
    let high = target.c;

    for (let step = 0; step < 16; step += 1) {
      const mid = (low + high) / 2;
      const candidate = oklchToLinearRgb({ ...target, c: mid });

      if (isInGamut(candidate)) {
        low = mid;
        rgb = candidate;
      } else {
        high = mid;
      }
    }

    if (!isInGamut(rgb)) rgb = oklchToLinearRgb({ ...target, c: 0 });
  }

  return {
    r: Math.min(1, Math.max(0, rgb.r)),
    g: Math.min(1, Math.max(0, rgb.g)),
    b: Math.min(1, Math.max(0, rgb.b)),
  };
}

/** The OKLCH coordinates of a CSS colour, for tests and diagnostics (null when unparseable). */
export function inkColorToOklch(color: string): Oklch | null {
  const rgba = parseInkColor(color);

  if (!rgba) return null;

  return linearRgbToOklch(srgbToLinear(rgba.r), srgbToLinear(rgba.g), srgbToLinear(rgba.b));
}

export interface EnsureInkContrastOptions {
  /** Ratio to reach; {@link MIN_INK_CONTRAST} by default. */
  minRatio?: number;
  /**
   * Object opacity the committed stroke will carry ON TOP of the colour's own alpha (the pen family's
   * opacity slider is applied to the path, not baked into the brush colour). 1 by default.
   */
  opacity?: number;
}

/**
 * The colour to paint `ink` with over a background of luminance `backgroundLuminance` so that the
 * stroke reads at the required contrast. Returns `ink` itself (same string) when it already does, when
 * it cannot be parsed, or when no shade of this hue can reach the ratio at this translucency.
 *
 * The returned string keeps the input's alpha and notation (`#rrggbb` in → `#rrggbb` out; `rgba(…)`
 * in → `rgba(…)` out), so the brush pipelines that read the colour back see what they expect.
 */
export function ensureInkContrast(
  ink: string,
  backgroundLuminance: number,
  { minRatio = MIN_INK_CONTRAST, opacity = 1 }: EnsureInkContrastOptions = {},
): string {
  const rgba = parseInkColor(ink);

  if (!rgba) return ink;

  const background = Math.min(1, Math.max(0, backgroundLuminance));
  const alpha = Math.min(1, Math.max(0, rgba.a * (Number.isFinite(opacity) ? opacity : 1)));

  if (alpha <= 0) return ink;

  const seen = (inkLuminance: number) => contrastRatio(compositeLuminance(inkLuminance, background, alpha), background);
  const linear = { r: srgbToLinear(rgba.r), g: srgbToLinear(rgba.g), b: srgbToLinear(rgba.b) };

  if (seen(relativeLuminance(rgba)) >= minRatio) return ink;

  const original = linearRgbToOklch(linear.r, linear.g, linear.b);
  // Measured on the 8-bit colour that will actually be painted: the rounding to a channel value is
  // worth up to a few hundredths of a ratio, enough to land a stroke at 2.99 instead of 3.
  const achromatic = original.c < 1e-4;
  const rgbAt = (l: number) => {
    const fitted = oklchToGamutRgb({ ...original, l });

    // A grey comes back from the OKLab round trip a channel or so off here and there; keep it a grey.
    if (achromatic) {
      const grey = Math.round(linearToSrgb((fitted.r + fitted.g + fitted.b) / 3));

      return { r: grey, g: grey, b: grey };
    }

    return {
      r: Math.round(linearToSrgb(fitted.r)),
      g: Math.round(linearToSrgb(fitted.g)),
      b: Math.round(linearToSrgb(fitted.b)),
    };
  };
  const luminanceAt = (l: number) => relativeLuminance(rgbAt(l));
  // Which way has more room: against a light background darkening always wins; against a dark one
  // lightening does. The two meet at a mid-grey of luminance ≈0.18, where a tie goes to the darker
  // ink. (Moving the ink towards the background's own side is never considered: it can only lose.)
  const darkenHeadroom = seen(luminanceAt(0));
  const lightenHeadroom = seen(luminanceAt(1));
  const darken = darkenHeadroom >= lightenHeadroom;
  const headroom = darken ? darkenHeadroom : lightenHeadroom;

  // No shade of this hue reaches the ratio at this translucency: a deliberately faint wash. Leave it.
  if (headroom < minRatio) return ink;

  // Bisect the lightness between the original and the reachable extreme: the smallest move that meets
  // the ratio. Contrast is monotonic in lightness along one direction, which is what makes this valid.
  let near = original.l;
  let far = darken ? 0 : 1;

  for (let step = 0; step < 24; step += 1) {
    const mid = (near + far) / 2;

    if (seen(luminanceAt(mid)) >= minRatio) {
      far = mid;
    } else {
      near = mid;
    }
  }

  return formatInkColor({ ...rgbAt(far), a: rgba.a, format: rgba.format });
}

// --- Reading the background ---

/** Half-size of the square read under the stroke start, in device px (7×7 = 49 samples). */
const SAMPLE_RADIUS_PX = 3;

/**
 * Two stroke starts closer together in time than this share one reading — a stream of quick dots
 * costs one copy, not one per dot.
 */
const SAMPLE_REUSE_MS = 50;

interface LuminanceSampleCache {
  at: number;
  luminance: number;
}

const sampleCache = new WeakMap<HTMLCanvasElement, LuminanceSampleCache>();

/**
 * The 7×7 window is copied onto this small canvas and read THERE — never `getImageData` on the live
 * background canvas itself. A readback of a GPU canvas makes Chrome move that canvas to software
 * rendering (the «Multiple readback operations… willReadFrequently» warning), and the background
 * canvas is the one the continuous PDF layout repaints on every scroll frame: after the first few
 * strokes on a PDF page every finger scroll rasterised the page on the main thread (measured: 2.6×
 * the main-thread time of a scroll, CPU-throttled, GPU on). `drawImage` of the source leaves the
 * source accelerated; the scratch is created `willReadFrequently`, so reading it is the cheap path.
 */
let scratch: CanvasRenderingContext2D | null = null;

function readWindow(
  canvas: HTMLCanvasElement | ImageBitmap,
  left: number,
  top: number,
  size: number,
): Uint8ClampedArray | null {
  if (typeof document === 'undefined') {
    // No DOM (the node test runner): the source is read as is.
    return (canvas as HTMLCanvasElement).getContext('2d')?.getImageData(left, top, size, size).data ?? null;
  }

  if (!scratch) {
    const element = document.createElement('canvas');

    element.width = size;
    element.height = size;
    scratch = element.getContext('2d', { willReadFrequently: true });
  }

  if (!scratch) return null;

  if (scratch.canvas.width !== size || scratch.canvas.height !== size) {
    scratch.canvas.width = size;
    scratch.canvas.height = size;
  }

  scratch.clearRect(0, 0, size, size);
  scratch.drawImage(canvas, left, top, size, size, 0, 0, size, size);

  return scratch.getImageData(0, 0, size, size).data;
}

/** Median luminance of RGBA pixels, each composited over paper. See {@link sampleCanvasLuminance}. */
function medianLuminance(data: Uint8ClampedArray): number {
  const luminances: number[] = [];

  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3] / 255;
    const luminance = relativeLuminance({ r: data[offset], g: data[offset + 1], b: data[offset + 2] });

    // The background canvas is painted opaque, but composite over paper anyway so a transparent
    // pixel (a cleared region mid-redraw) reads as the paper it shows.
    luminances.push(compositeLuminance(luminance, PAPER_LUMINANCE, alpha));
  }

  luminances.sort((a, b) => a - b);

  return luminances[Math.floor(luminances.length / 2)];
}

/**
 * {@link sampleCanvasLuminance} for the background cache (`backgroundLuminanceCache.ts`), which reads
 * OFF the input path: where `createImageBitmap` exists the 7×7 window is snapshotted asynchronously
 * and only then copied to the scratch and read — the intent being that the scratch read finds the GPU
 * work already flushed (unverified on device; the `ink-contrast-read` perf entry is end-to-end latency
 * including the await, NOT main-thread blocking time). Without it, this is the synchronous read. Null
 * when the canvas cannot be read; never rejects.
 */
export async function readCanvasLuminance(canvas: HTMLCanvasElement, x: number, y: number): Promise<number | null> {
  const size = SAMPLE_RADIUS_PX * 2 + 1;

  if (canvas.width < size || canvas.height < size) return null;

  const left = Math.min(canvas.width - size, Math.max(0, Math.round(x) - SAMPLE_RADIUS_PX));
  const top = Math.min(canvas.height - size, Math.max(0, Math.round(y) - SAMPLE_RADIUS_PX));

  let bitmap: ImageBitmap | null = null;

  try {
    const data =
      typeof document === 'undefined' || typeof createImageBitmap !== 'function'
        ? readWindow(canvas, left, top, size)
        : readWindow((bitmap = await createImageBitmap(canvas, left, top, size, size)), 0, 0, size);

    return data ? medianLuminance(data) : null;
  } catch {
    scratch = null;

    return null;
  } finally {
    bitmap?.close();
  }
}

/**
 * The MEDIAN luminance of a 7×7 device-px square of `canvas` centred on (`x`, `y`) — the median, so a
 * thin text glyph under the pen does not turn a white page into a grey one. The 49 pixels are copied
 * to a scratch canvas and read there (see {@link readWindow}); null when the canvas cannot be read (no context, or a tainted raster throws).
 *
 * `now` is injectable for tests; the reuse window is explained on {@link SAMPLE_REUSE_MS}.
 */
export function sampleCanvasLuminance(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  now: number = typeof performance !== 'undefined' ? performance.now() : Date.now(),
): number | null {
  const cached = sampleCache.get(canvas);

  if (cached && now - cached.at < SAMPLE_REUSE_MS) return cached.luminance;

  const size = SAMPLE_RADIUS_PX * 2 + 1;

  if (canvas.width < size || canvas.height < size) return null;

  const left = Math.min(canvas.width - size, Math.max(0, Math.round(x) - SAMPLE_RADIUS_PX));
  const top = Math.min(canvas.height - size, Math.max(0, Math.round(y) - SAMPLE_RADIUS_PX));
  let data: Uint8ClampedArray;

  try {
    const read = readWindow(canvas, left, top, size);

    if (!read) return null;

    data = read;
  } catch {
    // A tainted raster: the scratch it was copied into is tainted now too — start a clean one.
    scratch = null;

    return null;
  }

  const median = medianLuminance(data);

  sampleCache.set(canvas, { at: now, luminance: median });

  return median;
}

// --- Per-stroke wiring ---

export interface StrokeInkContrastHost<TSurface> {
  /** The setting is on. Read at every pen-down. */
  isEnabled(): boolean;
  /**
   * Luminance (0–1) of the background under scene point (`x`, `y`) of `surface` (the canvas the stroke
   * is on), or null when unknown — the stroke is then left as picked. Called once per stroke, only
   * while enabled.
   */
  sampleBackground(surface: TSurface, x: number, y: number): number | null;
  /** Object opacity the committed stroke will carry (the pen family's opacity slider). */
  getOpacity(): number;
}

/**
 * What a brush consults (see `LowLatencyPencilBrush.inkContrast`): the background is read once at
 * stroke start, and every colour the stroke takes afterwards — the first, a dual-tip head revision,
 * a colour button pressed mid-stroke — is mapped against that same reading.
 */
export interface StrokeInkContrast<TSurface = unknown> {
  /** A stroke is starting at scene (`x`, `y`) of `surface`: read the background under it. */
  strokeStart(surface: TSurface, x: number, y: number): void;
  /** The colour to paint `color` with on the stroke in progress. Identity when nothing needs doing. */
  adjust(color: string): string;
  /** The stroke ended; forget its reading. */
  strokeEnd(): void;
}

export function createStrokeInkContrast<TSurface>(host: StrokeInkContrastHost<TSurface>): StrokeInkContrast<TSurface> {
  let background: number | null = null;

  return {
    strokeStart(surface, x, y) {
      background = host.isEnabled() ? host.sampleBackground(surface, x, y) : null;
    },
    adjust(color) {
      if (background === null) return color;

      return ensureInkContrast(color, background, { opacity: host.getOpacity() });
    },
    strokeEnd() {
      background = null;
    },
  };
}

/**
 * Dark board (utils/darkBoard.ts): the colour a stored ink is PAINTED with on a dark board. Dark ink
 * flips to the light side of the same hue (black → near-white chalk, navy → light blue); ink that is
 * already light (yellow, a pastel highlighter) is left as it is. Pure, so callers memoize by string.
 * Unparseable colours (named, gradients) come back unchanged.
 */
export function darkBoardInkColor(color: string): string {
  const rgba = parseInkColor(color);

  if (!rgba) return color;

  const lch = linearRgbToOklch(srgbToLinear(rgba.r), srgbToLinear(rgba.g), srgbToLinear(rgba.b));

  if (lch.l >= DARK_BOARD_KEEP_L) return color;

  // Linear, continuous at the threshold: L 0 → 0.96, L 0.62 → ~0.62.
  const l = 0.96 - lch.l * ((0.96 - DARK_BOARD_KEEP_L) / DARK_BOARD_KEEP_L);
  const rgb = oklchToGamutRgb({ ...lch, l });

  return formatInkColor({ r: linearToSrgb(rgb.r), g: linearToSrgb(rgb.g), b: linearToSrgb(rgb.b), a: rgba.a, format: rgba.format });
}

/** OKLCH lightness at and above which an ink already reads on a dark board and is painted as stored. */
const DARK_BOARD_KEEP_L = 0.62;
