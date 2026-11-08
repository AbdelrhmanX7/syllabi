// The glyph bank on this device, for the signed-in user: one `GlyphBankStore` per user id (the
// package's IndexedDB adapter under `study-glyph-bank`), with the remote taken off the Study board
// AI service — the same object the notebook board gets, so My handwriting goes wherever the board AI goes
// (mock in Force-mock / Auto until the route ships, the backend after).
import type { GlyphBankState, GlyphBankStore as GlyphBankStoreType } from '@repo/whiteboard-react';

import { useEffect, useSyncExternalStore } from 'react';
import {
  createIndexedDbGlyphBankLocal,
  EMPTY_GLYPH_BANK,
  glyphBankRemoteFrom,
  GlyphBankStore,
} from '@repo/whiteboard-react';

import { createStudyBoardAi } from '@/features/tutor/boardAi';
import { readSessionUserId } from '@/lib/auth';

/** Signed out (or the mock's token-less session): one shared local bank. */
const LOCAL_USER = 'local';

const stores = new Map<string, GlyphBankStoreType>();
let local: ReturnType<typeof createIndexedDbGlyphBankLocal> | null = null;

export function currentHandwritingUserId(): string {
  return readSessionUserId() ?? LOCAL_USER;
}

export function getHandwritingStore(userId = currentHandwritingUserId()): GlyphBankStoreType {
  let store = stores.get(userId);

  if (!store) {
    local ??= createIndexedDbGlyphBankLocal();
    store = new GlyphBankStore({ userId, local, remote: glyphBankRemoteFrom(createStudyBoardAi()) });
    stores.set(userId, store);
    void store.load();
  }

  return store;
}

const SERVER_STATE: GlyphBankState = { status: 'loading', bank: EMPTY_GLYPH_BANK, remote: 'idle', error: null };
const serverStore = {
  subscribe: () => () => {},
  getState: () => SERVER_STATE,
};

/** The bank + its sync state, live. The store is created on first use and loads itself. */
export function useGlyphBank(): GlyphBankState & { store: GlyphBankStoreType | null } {
  // The session lives in a cookie the server cannot read: resolve the store only on the client.
  const store = useSyncExternalStore(
    serverStore.subscribe,
    () => getHandwritingStore(),
    () => null,
  );
  const state = useSyncExternalStore(
    store ? store.subscribe.bind(store) : serverStore.subscribe,
    store ? store.getState.bind(store) : serverStore.getState,
    serverStore.getState,
  );

  // Leaving the page pushes whatever the debounce still holds.
  useEffect(() => {
    if (!store) return;

    const flush = () => void store.flush();

    window.addEventListener('pagehide', flush);

    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [store]);

  return { ...state, store };
}
