// Note settings → paper spacing a NEW notebook page starts with, per paper type (Settings → Notebook
// paper). Per device, like the other Settings stores; a page carries its own `paperSpacingMm` from then
// on (it syncs with the page), so changing this never moves the lines of a page already written on.
import type { BackgroundType, WhiteboardDocument } from '@repo/whiteboard-core';

import { useSyncExternalStore } from 'react';
import { normalizePaperSpacingMm } from '@repo/whiteboard-core';

const STORAGE_KEY = 'study_paper_spacing';

/** mm per paper type; a missing type = the board's original spacing. 'dotted' uses 'grid'. */
export type PaperSpacingDefaults = Partial<Record<'lined' | 'grid', number>>;

const EMPTY: PaperSpacingDefaults = Object.freeze({});
let snapshot: PaperSpacingDefaults | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): PaperSpacingDefaults {
  if (!raw) return EMPTY;

  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const lined = normalizePaperSpacingMm(value?.lined);
    const grid = normalizePaperSpacingMm(value?.grid);

    return Object.freeze({ ...(lined !== undefined ? { lined } : {}), ...(grid !== undefined ? { grid } : {}) });
  } catch {
    return EMPTY;
  }
}

export function readPaperSpacingDefaults(): PaperSpacingDefaults {
  if (snapshot) return snapshot;
  if (typeof window === 'undefined') return EMPTY;

  try {
    snapshot = parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    snapshot = EMPTY;
  }

  return snapshot;
}

/** Set (mm) or clear (null) the default for one paper type. */
export function savePaperSpacingDefault(type: 'lined' | 'grid', mm: number | null): void {
  const current = { ...readPaperSpacingDefaults() };
  const value = mm === null ? undefined : normalizePaperSpacingMm(mm);

  if (value === undefined) delete current[type];
  else current[type] = value;

  snapshot = Object.freeze(current);

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // private mode / quota — the in-memory snapshot still applies for this session
  }

  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function usePaperSpacingDefaults(): PaperSpacingDefaults {
  return useSyncExternalStore(subscribe, readPaperSpacingDefaults, () => EMPTY);
}

/** A brand-new document's pages take the default for their paper; anything already set is kept. */
export function withPaperSpacingDefaults(doc: WhiteboardDocument, defaults: PaperSpacingDefaults): WhiteboardDocument {
  const pick = (type: BackgroundType) => (type === 'lined' ? defaults.lined : type === 'grid' || type === 'dotted' ? defaults.grid : undefined);
  let changed = false;
  const pages = doc.pages.map((page) => {
    const mm = page.paperSpacingMm === undefined ? pick(page.backgroundType) : undefined;

    if (mm === undefined) return page;
    changed = true;

    return { ...page, paperSpacingMm: mm };
  });

  return changed ? { ...doc, pages } : doc;
}
