// Settings → Auto-colour (auto-colour handwriting). Per device, like the other Settings stores; off by
// default. A notebook page can override the device switch from the board (`pageOverrides`).
import type { InkClass, InkPalette } from '@repo/whiteboard-react/auto-color';

import { useSyncExternalStore } from 'react';
import { INK_CLASSES } from '@repo/whiteboard-react/auto-color';

const STORAGE_KEY = 'study_ink_autocolor';
/** Page overrides kept at most (oldest dropped). */
const MAX_PAGE_OVERRIDES = 300;

export type InkEngineMode = 'device' | 'device+cloud';

export interface InkAutoColorSettings {
  enabled: boolean;
  engine: InkEngineMode;
  /** Colour per class; absent = the board's default, null = leave that class in the ink. */
  palette: InkPalette;
  /** Debug list on the board + recognised text in the perf log. */
  debug: boolean;
  /** `live`: colour each line after a pause. `manual`: only when "Colour the page" is tapped. */
  when: 'live' | 'manual';
  /** pageId → on/off, beating `enabled` for that page. */
  pageOverrides: Record<string, boolean>;
}

export const DEFAULT_INK_SETTINGS: InkAutoColorSettings = Object.freeze({
  enabled: false,
  engine: 'device',
  palette: Object.freeze({}),
  debug: false,
  when: 'live',
  pageOverrides: Object.freeze({}),
}) as InkAutoColorSettings;

const HEX = /^#[0-9a-f]{6}$/i;

/** Stored JSON → settings; anything malformed falls back field by field. */
export function parseInkSettings(raw: string | null): InkAutoColorSettings {
  if (!raw) return DEFAULT_INK_SETTINGS;

  try {
    const value = JSON.parse(raw) as Partial<Record<keyof InkAutoColorSettings, unknown>>;
    const palette: InkPalette = {};
    const rawPalette = (value.palette && typeof value.palette === 'object' ? value.palette : {}) as Record<
      string,
      unknown
    >;

    for (const cls of INK_CLASSES) {
      const colour = rawPalette[cls];

      if (colour === null) palette[cls] = null;
      else if (typeof colour === 'string' && HEX.test(colour)) palette[cls] = colour.toLowerCase();
    }

    const pageOverrides: Record<string, boolean> = {};
    const rawPages = (
      value.pageOverrides && typeof value.pageOverrides === 'object' ? value.pageOverrides : {}
    ) as Record<string, unknown>;

    for (const [page, on] of Object.entries(rawPages)) {
      if (typeof on === 'boolean') pageOverrides[page] = on;
    }

    return {
      enabled: value.enabled === true,
      engine: value.engine === 'device+cloud' ? 'device+cloud' : 'device',
      palette,
      debug: value.debug === true,
      when: value.when === 'manual' ? 'manual' : 'live',
      pageOverrides,
    };
  } catch {
    return DEFAULT_INK_SETTINGS;
  }
}

let snapshot: InkAutoColorSettings | null = null;
const listeners = new Set<() => void>();

export function readInkSettings(): InkAutoColorSettings {
  if (snapshot) return snapshot;
  if (typeof window === 'undefined') return DEFAULT_INK_SETTINGS;

  try {
    snapshot = parseInkSettings(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    snapshot = DEFAULT_INK_SETTINGS;
  }

  return snapshot;
}

export function saveInkSettings(patch: Partial<InkAutoColorSettings>): void {
  snapshot = { ...readInkSettings(), ...patch };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // private mode / quota — the in-memory snapshot still applies for this session
  }

  listeners.forEach((listener) => listener());
}

/** One class's colour: a hex, null (leave the ink), or undefined (back to the board default). */
export function saveInkClassColor(cls: InkClass, colour: string | null | undefined): void {
  const palette = { ...readInkSettings().palette };

  if (colour === undefined) delete palette[cls];
  else palette[cls] = colour;
  saveInkSettings({ palette });
}

/** The page's own switch (undefined = follow the device setting). */
export function savePageInkOverride(pageId: string, on: boolean | undefined): void {
  const pageOverrides = { ...readInkSettings().pageOverrides };

  delete pageOverrides[pageId];

  if (on !== undefined) pageOverrides[pageId] = on;
  const keys = Object.keys(pageOverrides);

  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PAGE_OVERRIDES))) delete pageOverrides[key];
  saveInkSettings({ pageOverrides });
}

/** Is auto-colour on for this page? */
export function inkEnabledForPage(settings: InkAutoColorSettings, pageId: string | null | undefined): boolean {
  const override = pageId ? settings.pageOverrides[pageId] : undefined;

  return override ?? settings.enabled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useInkSettings(): InkAutoColorSettings {
  return useSyncExternalStore(subscribe, readInkSettings, () => DEFAULT_INK_SETTINGS);
}

/** Test seam: forget the cached snapshot. */
export function resetInkSettingsCache(): void {
  snapshot = null;
}
