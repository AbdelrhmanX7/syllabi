/**
 * The brand font gate. Fabric measures a Textbox ONCE, with whatever font the canvas has at that
 * moment, and caches the character widths per family/weight. If IBM Plex Sans Arabic is still downloading
 * (or the host page never declared it — the Android static export, a test page), the first AI
 * insert is laid out in the fallback font's metrics and keeps them: wrong wraps, clipped lines,
 * glyphs drawn past the box. So every builder awaits this gate before it creates a single text
 * object, and the gate only opens when each weight the board uses is really loaded.
 *
 * Pure apart from the injected FontFaceSet / FontFace constructor, so it is tested without a DOM.
 */

export const BOARD_FONT_FAMILY = 'IBM Plex Sans Arabic';

/** Regular (body), Medium (question stems, labels), Semibold (headings, numbers), Bold (remake `bold`). */
export const BOARD_FONT_WEIGHTS = [400, 500, 600, 700] as const;

export type BoardFontWeight = (typeof BOARD_FONT_WEIGHTS)[number];

/** The woff2 file of each weight under the app's `public/font/` (same names as `@repo/ui/fonts`). */
export const BOARD_FONT_FILES: Record<BoardFontWeight, string> = {
  400: 'IBMPlexSansArabic-Regular.woff2',
  500: 'IBMPlexSansArabic-Medium.woff2',
  600: 'IBMPlexSansArabic-SemiBold.woff2',
  700: 'IBMPlexSansArabic-Bold.woff2',
};

/** What the gate reads off a `FontFace`. */
export interface FontFaceInfo {
  family: string;
  weight: string;
  status: string;
}

/**
 * The subset of `FontFaceSet` the gate uses. NOT `check()`: it answers true when the family is not
 * declared at all («nothing to load»), which is exactly the case that needs the face declared here.
 */
export interface FontSetLike {
  load(font: string, text?: string): Promise<unknown[]>;
  forEach(callback: (face: FontFaceInfo) => void): void;
  add?(face: unknown): unknown;
  readonly ready?: Promise<unknown>;
}

export interface FontFaceLike {
  load(): Promise<unknown>;
}

export type FontFaceFactory = (family: string, source: string, descriptors: { weight: string; style: string; display: 'block' | 'swap' }) => FontFaceLike;

export interface FontGateOptions {
  family?: string;
  weights?: readonly number[];
  /** Directory the woff2 files are served from (trailing slash). */
  baseUrl?: string;
  files?: Partial<Record<number, string>>;
  timeoutMs?: number;
  /** `new FontFace(...)` — absent where the API is missing. */
  createFace?: FontFaceFactory;
}

export interface FontGateResult {
  /** Every requested weight is usable now. */
  ready: boolean;
  /** Weights that only loaded because the gate declared them itself (no @font-face in the page). */
  injected: number[];
  /** Weights still missing when the gate gave up. */
  missing: number[];
}

/** A sample of what we draw, so `load` fetches the face that actually covers it. */
const SAMPLE = 'Question 123 abc';

export const fontSpec = (weight: number, family = BOARD_FONT_FAMILY) => `${weight} 24px '${family}'`;

/** `normal` / `bold` / `500` → a number. */
export function faceWeight(weight: string): number {
  const value = weight.trim().toLowerCase();

  if (value === 'normal' || value === '') return 400;
  if (value === 'bold') return 700;

  return Number.parseInt(value, 10) || 400;
}

const timeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

/**
 * Loads every weight of the board font and resolves when they are usable or the time is up.
 *  1. A face of that family + weight is already `loaded` → nothing to do.
 *  2. Declared by the page's @font-face but not loaded yet → `load` it.
 *  3. Not declared in this page (or it failed): declare the face from `baseUrl` ourselves.
 *  4. Wait for `fonts.ready`, so a face still swapping in does not leave stale metrics.
 */
export async function loadBoardFontFaces(fonts: FontSetLike, options: FontGateOptions = {}): Promise<FontGateResult> {
  const family = options.family ?? BOARD_FONT_FAMILY;
  const weights = options.weights ?? BOARD_FONT_WEIGHTS;
  const baseUrl = options.baseUrl ?? '/font/';
  const files = { ...BOARD_FONT_FILES, ...(options.files ?? {}) } as Record<number, string | undefined>;
  const timeoutMs = options.timeoutMs ?? 4000;
  const injected: number[] = [];

  const facesOf = (weight: number): FontFaceInfo[] => {
    const found: FontFaceInfo[] = [];

    try {
      fonts.forEach((face) => {
        if (face.family.replace(/["']/g, '').trim() === family && faceWeight(face.weight) === weight) found.push(face);
      });
    } catch {
      /* no iteration: treat as undeclared */
    }

    return found;
  };

  const loadWeight = async (weight: number): Promise<boolean> => {
    const spec = fontSpec(weight, family);
    const declared = facesOf(weight);

    if (declared.some((face) => face.status === 'loaded')) return true;

    if (declared.length > 0) {
      try {
        await fonts.load(spec, SAMPLE);
      } catch {
        /* fall through to declaring it ourselves */
      }

      if (facesOf(weight).some((face) => face.status === 'loaded')) return true;
    }

    const file = files[weight];

    if (!options.createFace || !file) return false;

    try {
      const face = options.createFace(family, `url(${baseUrl}${file}) format('woff2')`, { weight: String(weight), style: 'normal', display: 'block' });

      await face.load();
      fonts.add?.(face);
      injected.push(weight);

      return true;
    } catch {
      return false;
    }
  };

  const results = await timeout(
    Promise.all(weights.map((weight) => loadWeight(weight))),
    timeoutMs,
    weights.map(() => false),
  );

  if (fonts.ready) await timeout(fonts.ready.then(() => true).catch(() => true), Math.min(timeoutMs, 2000), false);

  const missing = weights.filter((_, index) => !results[index]);

  return { ready: missing.length === 0, injected, missing };
}

/** Is `weight` of the board font loaded in `fonts` right now? */
export function isBoardFontLoaded(fonts: Pick<FontSetLike, 'forEach'>, weight = 400, family = BOARD_FONT_FAMILY): boolean {
  let loaded = false;

  try {
    fonts.forEach((face) => {
      if (face.status === 'loaded' && face.family.replace(/["']/g, '').trim() === family && faceWeight(face.weight) === weight) loaded = true;
    });
  } catch {
    return false;
  }

  return loaded;
}
