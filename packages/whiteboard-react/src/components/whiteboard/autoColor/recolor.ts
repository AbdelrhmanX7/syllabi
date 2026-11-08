/**
 * Recolour decisions — pure, no Fabric.
 *
 * Rules:
 * - Only ink that was written in the DEFAULT colour is ever changed. A colour the student picked by hand
 *   always wins, and so does a manual recolour of a word auto-colour already coloured.
 * - An auto-coloured stroke carries a marker ({@link InkAutoMarker}, persisted with the page) saying which
 *   class and colour auto-colour gave it and what the ink was before. Its current colour still equal to
 *   the marker's = still ours (it may be re-classified); different = the student recoloured it: that is a
 *   CORRECTION, reported once, and the stroke is left alone from then on.
 */
import type { InkPalette } from './model';
import type { InkClass } from './types';

/** Fabric custom property holding the marker. */
export const INK_AUTO_PROP = 'inkAuto';

export interface InkAutoMarker {
  /** Class auto-colour gave the word. */
  c: InkClass;
  /** Colour it applied. */
  k: string;
  /** The ink's colour before. */
  o: string;
  /** Word group id (session-local; groups a correction). */
  g: string;
  /** Epoch ms of the auto-colour. */
  at: number;
  /** 1 = the student picked this class (the class menu): auto-colour never recolours it again. */
  m?: 1;
}

/**
 * Suggested palette on white paper — each colour ≥ 4.5:1 against #FFFFFF so it reads as clearly as the
 * black ink (Tailwind 700/800 shades): heading indigo-800 9.9:1, term teal-700 5.5:1, formula
 * purple-700 7.0:1, example green-700 5.0:1, key-point orange-700 5.2:1. Definition and plain stay in the
 * student's ink so the coloured term pops against its definition.
 */
export const DEFAULT_INK_PALETTE: Readonly<Record<InkClass, string | null>> = Object.freeze({
  heading: '#3730a3',
  term: '#0f766e',
  definition: null,
  formula: '#7e22ce',
  example: '#15803d',
  keypoint: '#c2410c',
  plain: null,
});

export function resolvePalette(palette: InkPalette | undefined): Record<InkClass, string | null> {
  return { ...DEFAULT_INK_PALETTE, ...(palette ?? {}) };
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);

  if (hex) {
    let h = hex[1];

    if (h.length === 3 || h.length === 4) h = Array.from(h).map((ch) => ch + ch).join('');
    if (h.length !== 6 && h.length !== 8) return null;

    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);

  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);

    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha };
  }

  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };

  return null;
}

/** Same colour, whatever the notation (`#000`, `#000000`, `rgb(0,0,0)`), within 2/255 per channel. */
export function sameColor(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true;
  const x = parseColor(a);
  const y = parseColor(b);

  if (!x || !y) return false;

  return Math.abs(x.r - y.r) <= 2 && Math.abs(x.g - y.g) <= 2 && Math.abs(x.b - y.b) <= 2 && Math.abs(x.a - y.a) <= 0.02;
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** Linear mix `from → to` at `t` (0–1), as `#rrggbb` (or rgba when translucent). For the cross-fade. */
export function mixColor(from: string, to: string, t: number): string {
  const a = parseColor(from);
  const b = parseColor(to);

  if (!a || !b) return t < 0.5 ? from : to;
  const k = Math.min(1, Math.max(0, t));
  const r = a.r + (b.r - a.r) * k;
  const g = a.g + (b.g - a.g) * k;
  const bl = a.b + (b.b - a.b) * k;
  const al = a.a + (b.a - a.a) * k;

  return al >= 0.999 ? `#${hex2(r)}${hex2(g)}${hex2(bl)}` : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(bl)},${Math.round(al * 1000) / 1000})`;
}

/** What the recolour engine knows about one stroke of a classified word. */
export interface RecolorTarget {
  id: string;
  /** The stroke's colour now. */
  color: string;
  marker: InkAutoMarker | null;
  /** Written with the default ink (tagged when the stroke was committed). */
  defaultInk: boolean;
  /** Its colour when committed (null = not tracked this session). */
  createdColor: string | null;
}

export interface RecolorChange {
  id: string;
  from: string;
  to: string;
  /** Marker to store (null = remove: the word went back to the ink it was written in). */
  marker: InkAutoMarker | null;
}

/** May auto-colour touch this stroke? */
export function isRecolorable(target: RecolorTarget): boolean {
  if (target.marker) return !target.marker.m && sameColor(target.color, target.marker.k);

  return target.defaultInk && target.createdColor !== null && sameColor(target.color, target.createdColor);
}

/**
 * The changes that give `targets` (one word's strokes, decorations included) the colour of `cls`.
 * Strokes the student coloured are skipped; a word re-classified to an uncoloured class goes back to
 * its original ink.
 */
export function planRecolor(
  targets: readonly RecolorTarget[],
  cls: InkClass,
  palette: Readonly<Record<InkClass, string | null>>,
  groupId: string,
  now: number,
): RecolorChange[] {
  const want = palette[cls] ?? null;
  const changes: RecolorChange[] = [];

  for (const target of targets) {
    if (!isRecolorable(target)) continue;
    const original = target.marker?.o ?? target.color;

    if (want === null) {
      if (target.marker) changes.push({ id: target.id, from: target.color, to: original, marker: null });

      continue;
    }

    if (target.marker && target.marker.c === cls && sameColor(target.color, want)) continue;
    changes.push({ id: target.id, from: target.color, to: want, marker: { c: cls, k: want, o: original, g: groupId, at: now } });
  }

  return changes;
}

export interface InkCorrection {
  from: InkClass;
  /** The class whose palette colour the student picked; 'plain' = back to the original ink; else 'manual'. */
  to: InkClass | 'manual';
  /** ms since the auto-colour. */
  afterMs: number;
}

/** The stroke's colour changed: a correction when it is no longer the colour auto-colour applied. */
export function detectCorrection(
  marker: InkAutoMarker | null | undefined,
  color: string,
  palette: Readonly<Record<InkClass, string | null>>,
  now: number,
): InkCorrection | null {
  if (!marker || sameColor(color, marker.k)) return null;
  let to: InkCorrection['to'] = 'manual';

  if (sameColor(color, marker.o)) {
    to = 'plain';
  } else {
    const hit = (Object.keys(palette) as InkClass[]).find((cls) => palette[cls] && sameColor(palette[cls], color));

    if (hit) to = hit;
  }

  return { from: marker.c, to, afterMs: Math.max(0, now - marker.at) };
}

export function isInkAutoMarker(value: unknown): value is InkAutoMarker {
  const v = value as InkAutoMarker | null;

  return Boolean(v && typeof v === 'object' && typeof v.c === 'string' && typeof v.k === 'string' && typeof v.o === 'string');
}
