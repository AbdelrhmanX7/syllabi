// Settings → Notebook paper → «Fill the screen»: a notebook page opens as wide as the screen instead of
// stopping at the board's 1150 px sheet with grey margins (no more zooming to ~147% on every page).
// Per device, like the other Settings stores. On by default.
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'study_notebook_fill_screen';

let snapshot: boolean | null = null;
const listeners = new Set<() => void>();

export function readNotebookFillScreen(): boolean {
  if (snapshot !== null) return snapshot;
  if (typeof window === 'undefined') return true;

  try {
    snapshot = window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    snapshot = true;
  }

  return snapshot;
}

export function saveNotebookFillScreen(fill: boolean): void {
  snapshot = fill;

  try {
    window.localStorage.setItem(STORAGE_KEY, fill ? '1' : '0');
  } catch {
    // private mode / quota — the in-memory snapshot still applies for this session
  }

  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useNotebookFillScreen(): boolean {
  return useSyncExternalStore(subscribe, readNotebookFillScreen, () => true);
}
