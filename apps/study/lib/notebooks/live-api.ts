// Network side of live co-editing (a notebook page several people edit at once). See live.ts.
import type { BoardDoc, LiveOps } from './live-merge';
import type { LiveBase, LivePerson, LiveStreamHandlers } from './live';
import type { OpenNotebookOptions, OpenNotebookSource } from './sync';
import type { WhiteboardDocument } from '@repo/whiteboard-core';

import { normalizeWhiteboardDocument } from '@repo/whiteboard-core';

import { emptyBoard } from './live';
import { diffDocs, ensureDocIds, mergeDocs } from './live-merge';
import { readSyncedVersion, writeSyncedVersion } from './pages-cache';
import { openNotebookDocument } from './sync';

import { getPageContent } from '@/lib/api/endpoints';
import { studyApiError } from '@/lib/api/errors';
import { readSse, studyGet, studyPost } from '@/lib/api/http';
import { fetchJsonFromUrl } from '@/lib/api/upload';
import { readSessionToken } from '@/lib/auth';
import { getBackendSettingsSnapshot } from '@/lib/backend-settings';

const enc = encodeURIComponent;

export const pushLiveOps = (pageId: string, clientId: string, ops: LiveOps) =>
  studyPost<{ prevVersion: number; version: number }>(`/pages/${enc(pageId)}/live`, { clientId, ops });

async function readBoard(url: string): Promise<BoardDoc | null> {
  const doc = normalizeWhiteboardDocument(await fetchJsonFromUrl<WhiteboardDocument>(url));

  return doc ? ensureDocIds(doc as unknown as BoardDoc) : null;
}

/** The page's current board (null = never saved), with ids on every item. */
export async function fetchLatestBoard(pageId: string): Promise<{ version: number; doc: BoardDoc | null }> {
  const ref = await getPageContent(pageId);

  return { version: ref.version, doc: ref.url ? await readBoard(ref.url) : null };
}

/** An earlier version of the page (the base this device last had), or null when it is not stored. */
export async function fetchBoardVersion(pageId: string, version: number): Promise<BoardDoc | null> {
  if (!(version > 0)) return null;

  try {
    const ref = await studyGet<{ url: string | null }>(`/pages/${enc(pageId)}/content?version=${version}`);

    return ref.url ? await readBoard(ref.url) : null;
  } catch {
    return null;
  }
}

/**
 * `GET /pages/:id/live/stream` (SSE). Settles when the server closes it; rejects with a StudyApiError
 * when it refuses (404 = no access, or a server without live pages) or ends it (`ACCESS_REVOKED`).
 */
export async function openLiveStream(pageId: string, clientId: string, handlers: LiveStreamHandlers, signal: AbortSignal): Promise<void> {
  const token = readSessionToken();

  if (!token) throw studyApiError(401, 'Not signed in', 'NO_SESSION');
  const base = `${getBackendSettingsSnapshot().backendUrl}/study`;
  const res = await fetch(`${base}/pages/${enc(pageId)}/live/stream?clientId=${enc(clientId)}`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
    signal,
  });

  if (!res.ok) {
    let message = `${res.status}`;
    let code: string | undefined;

    try {
      const body = (await res.json()) as { message?: string; code?: string };

      message = body.message ?? message;
      code = body.code;
    } catch {
      // not JSON
    }
    throw studyApiError(res.status, message, code);
  }

  await readSse(res, (frame) => {
    const data = frame.data as Record<string, unknown> | null;

    if (!data || typeof data !== 'object') return;
    if (frame.event === 'hello') handlers.onHello(Number(data.version) || 0, (data.people as LivePerson[]) ?? []);
    else if (frame.event === 'presence') handlers.onPeople((data.people as LivePerson[]) ?? []);
    else if (frame.event === 'ops') handlers.onOps(data as never);
  });
}

/**
 * Open a live page: make sure the device holds the board the editor should show, and return the base
 * (the server version it builds on). Edits this device made while away are merged with what the others
 * did meanwhile (three-way, against the version it last had), never a "keep mine / keep theirs" choice.
 * Offline: the device copy opens as is and the session catches up once the server answers.
 */
export async function openLiveNotebook(options: OpenNotebookOptions): Promise<{ source: OpenNotebookSource; base: LiveBase | null }> {
  const { pageId, storage, title } = options;
  let latest: { version: number; doc: BoardDoc | null };

  try {
    latest = await fetchLatestBoard(pageId);
  } catch {
    const opened = await openNotebookDocument(options);
    // Old items get their derived ids now, before the editor would hand them random ones.
    const stored = await storage.loadWhiteboard(pageId).catch(() => null);
    const ensured = stored ? ensureDocIds(stored as unknown as BoardDoc) : null;

    if (stored && ensured !== (stored as unknown)) await storage.saveWhiteboard(ensured as unknown as WhiteboardDocument);

    return { source: opened.source, base: null };
  }

  const stored = await storage.loadWhiteboard(pageId).catch(() => null);
  const synced = readSyncedVersion(pageId);
  let doc: BoardDoc;
  let source: OpenNotebookSource;

  if (stored) {
    const local = ensureDocIds(stored as unknown as BoardDoc);

    source = 'local';
    if (!latest.doc) doc = local;
    else if (synced?.dirty) {
      const before = synced.version === latest.version ? latest.doc : await fetchBoardVersion(pageId, synced.version);

      doc = mergeDocs(before, local, latest.doc);
    } else if ((synced?.version ?? 0) >= latest.version) doc = local;
    else {
      doc = latest.doc;
      source = 'remote';
    }
  } else if (latest.doc) {
    doc = latest.doc;
    source = 'remote';
  } else {
    // Nothing anywhere yet: the normal path builds the first board (a seed, or blank paper).
    const opened = await openNotebookDocument(options);
    const created = await storage.loadWhiteboard(pageId).catch(() => null);

    doc = ensureDocIds((created ?? emptyBoard(pageId)) as unknown as BoardDoc);
    source = opened.source;
  }

  const base: LiveBase = { version: latest.version, doc: latest.doc ?? emptyBoard(pageId) };
  const board = doc as unknown as WhiteboardDocument;

  await storage.saveWhiteboard({ ...board, id: pageId, title: board.title || title });
  writeSyncedVersion(pageId, latest.version, diffDocs(base.doc, doc) !== null);

  return { source, base };
}
