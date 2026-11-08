// Which lecture each notebook page is for — on this device until the backend's Page carries
// week / module / lecture fields (the title «Lecture 8 — …» is the cross-device fallback).
import type { LectureNoteMeta } from './lib/lectures';

import { useSyncExternalStore } from 'react';

const KEY = 'study_lecture_notes';

type MetaTable = Record<string, LectureNoteMeta>;

const EMPTY: MetaTable = Object.freeze({}) as MetaTable;
let snapshot: MetaTable | null = null;
const listeners = new Set<() => void>();

function read(): MetaTable {
  if (snapshot) return snapshot;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as unknown;

    snapshot = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as MetaTable) : EMPTY;
  } catch {
    snapshot = EMPTY;
  }

  return snapshot;
}

export function readLectureNoteMetas(): MetaTable {
  return typeof window === 'undefined' ? EMPTY : read();
}

export function readLectureNoteMeta(pageId: string): LectureNoteMeta | undefined {
  return readLectureNoteMetas()[pageId];
}

/** Records (or with null, forgets) the lecture a page is for. */
export function writeLectureNoteMeta(pageId: string, meta: LectureNoteMeta | null): void {
  const next = { ...readLectureNoteMetas() };

  if (meta) next[pageId] = meta;
  else delete next[pageId];
  snapshot = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota: the in-memory copy lasts the session, the title carries the lecture
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    snapshot = null;
    listener();
  };

  listeners.add(listener);
  window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useLectureNoteMetas(): MetaTable {
  return useSyncExternalStore(subscribe, readLectureNoteMetas, () => EMPTY);
}
