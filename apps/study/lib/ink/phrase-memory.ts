// Auto-colour phrase memory: the student's own corrections ("Newton's law" → formula), consulted by the
// board before its rules. On the device only (localStorage); capped, newest kept.
import type { InkClass, InkPhraseMemory } from '@repo/whiteboard-react/auto-color';

import { INK_CLASSES } from '@repo/whiteboard-react/auto-color';

const STORAGE_KEY = 'study_ink_phrases';
export const MAX_PHRASES = 500;

/** Case, whitespace and punctuation do not matter. */
export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s.,:;!?"'()]+/g, ' ')
    .trim();
}

export interface PhraseStorage {
  read(): string | null;
  write(value: string): void;
}

const localStore: PhraseStorage = {
  read: () => {
    try {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  write: (value) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // private mode / quota: the memory lasts this session
    }
  },
};

/** A phrase memory over `storage` (Map order = recency). */
export function createPhraseMemory(
  storage: PhraseStorage = localStore,
): InkPhraseMemory & { size(): number; clear(): void } {
  let entries: Map<string, InkClass> | null = null;
  const load = () => {
    if (entries) return entries;
    entries = new Map();

    try {
      const raw = JSON.parse(storage.read() ?? '[]') as unknown;

      if (Array.isArray(raw)) {
        for (const pair of raw) {
          if (Array.isArray(pair) && typeof pair[0] === 'string' && INK_CLASSES.includes(pair[1] as InkClass)) {
            entries.set(pair[0], pair[1] as InkClass);
          }
        }
      }
    } catch {
      // unreadable: start empty
    }

    return entries;
  };

  return {
    lookup(text) {
      const key = normalizePhrase(text);

      return key ? (load().get(key) ?? null) : null;
    },
    remember(text, cls) {
      const key = normalizePhrase(text);

      if (!key || key.length > 80) return;
      const map = load();

      map.delete(key);
      map.set(key, cls);

      while (map.size > MAX_PHRASES) map.delete(map.keys().next().value as string);
      storage.write(JSON.stringify([...map]));
    },
    size: () => load().size,
    clear() {
      entries = new Map();
      storage.write('[]');
    },
  };
}

let shared: ReturnType<typeof createPhraseMemory> | null = null;

/** The device's memory (one per app session). */
export function devicePhraseMemory(): ReturnType<typeof createPhraseMemory> {
  shared ??= createPhraseMemory();

  return shared;
}
