// Physical scale of the on-screen ruler: CSS px per real millimetre on THIS device.
//
// Order of trust: the owner's manual calibration (a credit card held to the screen) → a known device
// matched by its physical pixel size → the CSS reference 96 px/inch. The browser cannot report the
// panel's real density, which is why the table and the manual setting exist. Per device, like the
// other Settings stores.
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'study_ruler';

/** ISO/IEC 7810 ID-1 card width — the calibration reference. */
export const CARD_WIDTH_MM = 85.6;
export const MM_PER_INCH = 25.4;
/** CSS reference density (the board's own mm scale: `BOARD_PX_PER_MM` in whiteboard-react). */
export const FALLBACK_CSS_PX_PER_MM = 96 / MM_PER_INCH;
/** Manual calibration bounds (CSS px per mm), so a bad drag cannot store nonsense. */
export const MIN_PX_PER_MM = 1.5;
export const MAX_PX_PER_MM = 12;

interface KnownDevice {
  name: string;
  /** Physical panel pixels, long edge × short edge. */
  longPx: number;
  shortPx: number;
  /** Physical pixels per inch of the panel. */
  ppi: number;
}

/**
 * Samsung Galaxy Tab S9 Ultra: 14.6" 16:10 panel, 2960×1848 → √(2960²+1848²) / 14.6 ≈ 239.0 ppi
 * → 9.41 physical px/mm (= 4.70 CSS px/mm at the usual devicePixelRatio of 2).
 */
export const KNOWN_DEVICES: readonly KnownDevice[] = [
  { name: 'Galaxy Tab S9 Ultra', longPx: 2960, shortPx: 1848, ppi: Math.hypot(2960, 1848) / 14.6 },
];

export interface RulerPrefs {
  /** Manual calibration, CSS px per mm; absent = automatic. */
  pxPerMm?: number;
  /** Show inch ticks on the lower edge instead of centimetres only. */
  inch?: boolean;
  /** Ticks follow the glass (physical mm) instead of the page (paper mm at the board zoom). */
  real?: boolean;
  /** Page mode: tick spacing stretched to fit a map's own scale bar (1 = the page as printed). */
  pageFactor?: number;
}

export const MIN_PAGE_FACTOR = 0.2;
export const MAX_PAGE_FACTOR = 10;

export interface RulerScale {
  cssPxPerMm: number;
  source: 'manual' | 'device' | 'fallback';
  deviceName?: string;
}

/** The known device whose physical pixel size matches this screen (orientation-independent), if any. */
export function matchKnownDevice(widthPx: number, heightPx: number): KnownDevice | null {
  const long = Math.max(widthPx, heightPx);
  const short = Math.min(widthPx, heightPx);

  return KNOWN_DEVICES.find((d) => Math.abs(d.longPx - long) <= 2 && Math.abs(d.shortPx - short) <= 2) ?? null;
}

/** Pure: the scale for a screen of `cssW × cssH` CSS px at `dpr`, given the stored prefs. */
export function resolveScale(prefs: RulerPrefs, cssW: number, cssH: number, dpr: number): RulerScale {
  if (prefs.pxPerMm && prefs.pxPerMm >= MIN_PX_PER_MM && prefs.pxPerMm <= MAX_PX_PER_MM) {
    return { cssPxPerMm: prefs.pxPerMm, source: 'manual' };
  }

  const device = matchKnownDevice(cssW * dpr, cssH * dpr);

  if (device) {
    return { cssPxPerMm: device.ppi / MM_PER_INCH / dpr, source: 'device', deviceName: device.name };
  }

  return { cssPxPerMm: FALLBACK_CSS_PX_PER_MM, source: 'fallback' };
}

/** Board units (1 unit = 1 CSS px at zoom 1; printed at 96 dpi) per mm of PAPER — not of screen. */
export const PAGE_UNITS_PER_PAPER_MM = FALLBACK_CSS_PX_PER_MM;

/** Board units that span `mm` real millimetres ON SCREEN at the viewport `zoom`. */
export const pageUnitsForScreenMm = (mm: number, scale: RulerScale, zoom: number): number =>
  (mm * scale.cssPxPerMm) / (zoom || 1);

/** CSS px per mm of PAPER at the board viewport `zoom`: what a printed page shows on screen. */
export const pageCssPxPerMm = (zoom: number): number => PAGE_UNITS_PER_PAPER_MM * (zoom || 1);

// --- persisted prefs ----------------------------------------------------------------------------

const EMPTY: RulerPrefs = Object.freeze({});
let snapshot: RulerPrefs | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): RulerPrefs {
  if (!raw) return EMPTY;

  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const px = Number(value?.pxPerMm);

    return Object.freeze({
      ...(Number.isFinite(px) && px >= MIN_PX_PER_MM && px <= MAX_PX_PER_MM ? { pxPerMm: px } : {}),
      ...(value?.inch === true ? { inch: true } : {}),
      ...(value?.real === true ? { real: true } : {}),
      ...(Number.isFinite(Number(value?.pageFactor)) &&
      Number(value.pageFactor) >= MIN_PAGE_FACTOR &&
      Number(value.pageFactor) <= MAX_PAGE_FACTOR
        ? { pageFactor: Number(value.pageFactor) }
        : {}),
    });
  } catch {
    return EMPTY;
  }
}

export function readRulerPrefs(): RulerPrefs {
  if (snapshot) return snapshot;
  if (typeof window === 'undefined') return EMPTY;

  try {
    snapshot = parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    snapshot = EMPTY;
  }

  return snapshot;
}

/** Merge into the stored prefs; `pxPerMm: null` goes back to automatic. */
export function saveRulerPrefs(patch: {
  pxPerMm?: number | null;
  inch?: boolean;
  real?: boolean;
  pageFactor?: number | null;
}): void {
  const next: RulerPrefs = { ...readRulerPrefs() };

  if (patch.pageFactor === null || patch.pageFactor === 1) delete next.pageFactor;
  else if (patch.pageFactor !== undefined) {
    next.pageFactor = Math.min(MAX_PAGE_FACTOR, Math.max(MIN_PAGE_FACTOR, patch.pageFactor));
  }

  if (patch.pxPerMm === null) delete next.pxPerMm;
  else if (patch.pxPerMm !== undefined) next.pxPerMm = Math.min(MAX_PX_PER_MM, Math.max(MIN_PX_PER_MM, patch.pxPerMm));

  if (patch.inch !== undefined) {
    if (patch.inch) next.inch = true;
    else delete next.inch;
  }

  if (patch.real !== undefined) {
    if (patch.real) next.real = true;
    else delete next.real;
  }

  snapshot = Object.freeze(next);

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // private mode / quota — the in-memory snapshot still applies for this session
  }

  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export const useRulerPrefs = (): RulerPrefs => useSyncExternalStore(subscribe, readRulerPrefs, () => EMPTY);

/** Live scale for this screen (re-resolves on prefs change; call again on resize if you need it). */
export function currentScale(prefs: RulerPrefs): RulerScale {
  if (typeof window === 'undefined') return { cssPxPerMm: FALLBACK_CSS_PX_PER_MM, source: 'fallback' };

  return resolveScale(prefs, window.screen.width, window.screen.height, window.devicePixelRatio || 1);
}
