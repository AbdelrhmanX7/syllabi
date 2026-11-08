// State hooks for the notes + map workspace: the map's linked notes (backend field when it exists,
// this device until then) and the notes digest (hidden while the backend has no route).
import type { MapWithNotes } from './api';
import type { DigestState } from './digest-frames';
import type { NoteLink } from './links';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { conceptMapKeys } from '../hooks';

import { DigestUnavailable, normalizeDigest, NotesPageRejected, saveNotesPageIds, streamNotesDigest } from './api';
import { digestErrorMessage, digestProgress, INITIAL_DIGEST, reduceDigestFrame } from './digest-frames';
import { addLink, browserStore, linkKey, pageIdsOf, readLinks, removeLink, resolveLinks, writeLinks } from './links';

import { describeError } from '@/lib/api/errors';

export interface NoteLinksState {
  links: NoteLink[];
  /** `server` once the map record carries `notesPageIds`; `device` until the backend ships it. */
  source: 'server' | 'device';
  add: (link: NoteLink) => void;
  remove: (key: string) => void;
}

/**
 * Linked notes for one map (or a not-yet-saved in-class draft: `mapKey` = its draft id, no `map`).
 * Every change is written to this device first, then PATCHed; a backend that keeps the field flips
 * the hook to server mode by itself, and device-only links are pushed up once on that first load.
 */
export function useNoteLinks(
  mapKey: string,
  map: MapWithNotes | null,
  classId: string,
  onError?: (message: string) => void,
): NoteLinksState {
  const queryClient = useQueryClient();
  const [local, setLocal] = useState<NoteLink[]>(() => readLinks(browserStore(), mapKey));
  const [serverIds, setServerIds] = useState<string[] | null>(() =>
    Array.isArray(map?.notesPageIds) ? map.notesPageIds : null,
  );
  const migratedRef = useRef(false);

  useEffect(() => {
    setLocal(readLinks(browserStore(), mapKey));
    migratedRef.current = false;
  }, [mapKey]);

  useEffect(() => {
    if (Array.isArray(map?.notesPageIds)) setServerIds(map.notesPageIds);
  }, [map?.notesPageIds]);

  const resolved = useMemo(
    () => resolveLinks(serverIds === null ? {} : { notesPageIds: serverIds }, local),
    [local, serverIds],
  );

  const push = useCallback(
    async (pageIds: string[], onRejected?: () => void) => {
      if (!map) return;
      try {
        const saved = await saveNotesPageIds(map.id, pageIds);

        if (saved?.notesPageIds) {
          setServerIds(saved.notesPageIds);
          void queryClient.invalidateQueries({ queryKey: conceptMapKeys.list(classId) });
        }
      } catch (error) {
        // A page the backend refused (not his, or deleted) comes off again; network / 5xx: the device
        // copy holds the link and the next change retries.
        if (error instanceof NotesPageRejected) {
          onRejected?.();
          onError?.(`Could not link that page: ${error.message}`);
        }
      }
    },
    [classId, map, onError, queryClient],
  );

  // The switch-over: the first time the backend shows the field, links made on this device go up once.
  useEffect(() => {
    if (resolved.source !== 'server' || resolved.toMigrate.length === 0 || migratedRef.current) return;
    migratedRef.current = true;
    const stray = new Set(resolved.toMigrate.map((id) => `page:${id}`));

    void push(pageIdsOf(resolved.links), () =>
      setLocal((current) => {
        const kept = current.filter((row) => !stray.has(linkKey(row)));

        writeLinks(browserStore(), mapKey, kept);

        return kept;
      }),
    );
  }, [mapKey, push, resolved]);

  const commit = useCallback(
    (next: NoteLink[]) => {
      setLocal(next);
      writeLinks(browserStore(), mapKey, next);
    },
    [mapKey],
  );

  const add = useCallback(
    (link: NoteLink) => {
      const next = addLink(local, link);

      commit(next);
      const ids = pageIdsOf(addLink(resolved.links, link));

      if (link.kind === 'page') void push(ids, () => commit(removeLink(next, linkKey(link))));
    },
    [commit, local, push, resolved.links],
  );

  const remove = useCallback(
    (key: string) => {
      commit(removeLink(local, key));
      const ids = pageIdsOf(removeLink(resolved.links, key));

      if (key.startsWith('page:')) {
        if (serverIds !== null) setServerIds(serverIds.filter((id) => `page:${id}` !== key));
        void push(ids);
      }
    },
    [commit, local, push, resolved.links, serverIds],
  );

  return { links: resolved.links, source: resolved.source, add, remove };
}

/** Moves a draft's links onto the real map once the in-class map is created. */
export function adoptDraftLinks(draftKey: string, mapId: string): NoteLink[] {
  const store = browserStore();
  const links = readLinks(store, draftKey);

  if (links.length > 0) {
    writeLinks(store, mapId, links.reduce(addLink, readLinks(store, mapId)));
    writeLinks(store, draftKey, []);
  }

  return links;
}

export { linkKey };

/** Digests read this session, per map + linked pages — reopening the workspace does not re-read. */
const sessionDigests = new Map<string, DigestState>();
/** Set once a digest call 404s: this backend has no route, so nothing asks again this session. */
let digestRouteMissing = false;

export interface NotesDigestState extends DigestState {
  /** False while the backend has no digest route — the panel stays hidden. */
  available: boolean;
  /** Per-page progress text while it reads (null otherwise). */
  progress: string | null;
  run: () => void;
}

/**
 * The digest for a map with linked pages. Starts from the map's cached `notesDigest` when the backend
 * sends one; otherwise reads the notes once (SSE, page by page) when the workspace opens. `run()`
 * reads again (after he writes more notes).
 */
export function useNotesDigest(map: MapWithNotes | null, pageIds: string[]): NotesDigestState {
  const mapId = map?.id ?? null;
  const key = `${mapId ?? ''}|${pageIds.join(',')}`;
  const cached = useMemo<DigestState | null>(() => {
    const session = sessionDigests.get(key);

    if (session) return session;
    if (map?.notesDigest && typeof map.notesDigest === 'object') {
      return { ...INITIAL_DIGEST, phase: 'done', digest: normalizeDigest(map.notesDigest) };
    }

    return null;
  }, [key, map?.notesDigest]);
  const [state, setState] = useState<DigestState>(cached ?? INITIAL_DIGEST);
  const [available, setAvailable] = useState(!digestRouteMissing);
  const abortRef = useRef<AbortController | null>(null);
  const lastDigestRef = useRef(state.digest);

  lastDigestRef.current = state.digest;

  const run = useCallback(() => {
    if (!mapId || pageIds.length === 0 || digestRouteMissing) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    // A re-read keeps the last digest on screen (chips keep their flags) until the new one lands.
    let latest: DigestState = { ...INITIAL_DIGEST, phase: 'reading', digest: lastDigestRef.current };

    abortRef.current = controller;
    setState(latest);
    streamNotesDigest(
      mapId,
      (frame) => {
        latest = reduceDigestFrame(latest, frame);
        setState(latest);
      },
      controller.signal,
    )
      .then(() => {
        if (controller.signal.aborted) return;
        if (latest.phase === 'reading') latest = reduceDigestFrame(latest, { event: 'done', data: null });
        setState(latest);
        if (latest.phase === 'done') sessionDigests.set(key, latest);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DigestUnavailable) {
          digestRouteMissing = true;
          setAvailable(false);
          setState(INITIAL_DIGEST);

          return;
        }
        const code = (error as { code?: unknown } | null)?.code;

        setState({
          ...latest,
          phase: 'error',
          error: digestErrorMessage(code) ?? describeError(error, 'Could not read the notes'),
        });
      });
  }, [key, mapId, pageIds.length]);

  // New map or page set: show what is cached, else read once.
  useEffect(() => {
    if (cached) {
      abortRef.current?.abort();
      setState(cached);
    } else run();
  }, [key]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { ...state, available, progress: digestProgress(state, pageIds.length), run };
}
