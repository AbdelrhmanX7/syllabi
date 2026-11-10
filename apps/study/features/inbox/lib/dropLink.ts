// The phone drop link this device made, remembered so Settings and the board's «From phone» sheet
// show the same QR without minting a new permanent token each time (the backend caps them at 20 and
// returns the secret only once, from the create call). Scoped to the server it was made on: a mock
// token never shows against a live server. Pure (storage injected) so it is testable.
import type { DropTokenCreated } from '../types';

export const DROP_LINK_KEY = 'study_phone_drop_link';

export interface SavedDropLink {
  /** `mock`, or the backend URL + account the token belongs to. */
  scope: string;
  id: string;
  label: string;
  token: string;
  /** When it was saved (ms): a token list fetched before that cannot know it yet. */
  savedAt: number;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseSaved(raw: string | null): SavedDropLink | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SavedDropLink> | null;

    if (
      value &&
      typeof value.scope === 'string' &&
      typeof value.id === 'string' &&
      typeof value.token === 'string' &&
      value.token
    )
      return {
        scope: value.scope,
        id: value.id,
        label: typeof value.label === 'string' ? value.label : '',
        token: value.token,
        savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
      };
  } catch {
    // corrupt — treat as none
  }

  return null;
}

let cache: SavedDropLink | null | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeDropLink(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/** Stable reference between changes (useSyncExternalStore). */
export function getDropLinkSnapshot(): SavedDropLink | null {
  if (cache === undefined) {
    let raw: string | null = null;

    try {
      raw = storage()?.getItem(DROP_LINK_KEY) ?? null;
    } catch {
      raw = null;
    }
    cache = parseSaved(raw);
  }

  return cache;
}

export function rememberDropLink(scope: string, created: DropTokenCreated): void {
  cache = { scope, id: created.id, label: created.label, token: created.token, savedAt: Date.now() };
  try {
    storage()?.setItem(DROP_LINK_KEY, JSON.stringify(cache));
  } catch {
    // private window — this session keeps it in memory
  }
  emit();
}

/** Forget it (revoked, or gone from the server's list). `id` limits it to that token. */
export function forgetDropLink(id?: string): void {
  const current = getDropLinkSnapshot();

  if (!current || (id && current.id !== id)) return;
  cache = null;
  try {
    storage()?.removeItem(DROP_LINK_KEY);
  } catch {
    // nothing stored
  }
  emit();
}

/** Test hook. */
export function resetDropLinkCache(): void {
  cache = undefined;
}

/** True when a token list fetched at `listedAt` should contain the saved token and does not (revoked). */
export function dropLinkRevoked(saved: SavedDropLink, listedIds: string[] | null, listedAt: number): boolean {
  return !!listedIds && listedAt > saved.savedAt && !listedIds.includes(saved.id);
}

/** The saved link when it belongs to this server and is not known to be revoked there. */
export function usableDropLink(
  saved: SavedDropLink | null,
  scope: string,
  listedIds: string[] | null,
  listedAt = Number.POSITIVE_INFINITY,
): SavedDropLink | null {
  if (!saved || saved.scope !== scope) return null;
  if (dropLinkRevoked(saved, listedIds, listedAt)) return null;

  return saved;
}
