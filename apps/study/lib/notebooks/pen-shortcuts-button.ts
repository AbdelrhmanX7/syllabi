// Settings → Notebook paper → «Pen shortcuts button»: show or hide the board's floating shortcuts
// button. Per device, like the other Settings stores. The S Pen side button still opens the menu.
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'study_hide_pen_shortcuts';

let snapshot: boolean | null = null;
const listeners = new Set<() => void>();

export function readHidePenShortcuts(): boolean {
  if (snapshot !== null) return snapshot;
  if (typeof window === 'undefined') return false;

  try {
    snapshot = window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    snapshot = false;
  }

  return snapshot;
}

export function saveHidePenShortcuts(hide: boolean): void {
  snapshot = hide;

  try {
    window.localStorage.setItem(STORAGE_KEY, hide ? '1' : '0');
  } catch {
    // private mode / quota — the in-memory snapshot still applies for this session
  }

  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useHidePenShortcuts(): boolean {
  return useSyncExternalStore(subscribe, readHidePenShortcuts, () => false);
}
