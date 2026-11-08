// Notebook page ⇄ backend. A page IS a whiteboard document: the editor keeps it in the device's
// whiteboard IndexedDB under `whiteboardId = page.id` (its autosave path), and the backend keeps the
// same JSON on B2 behind the contract's versioned pages API. This module moves JSON between the two.
import type { WhiteboardDocument, WhiteboardStorage } from '@repo/whiteboard-core';
import type { PageContentRef } from '@/lib/api/types';

import { createBlankWhiteboardDocument, normalizeWhiteboardDocument } from '@repo/whiteboard-core';

import { readSyncedVersion, writeSyncedVersion } from './pages-cache';
import { pdfAssetIdsOf, queuePdfAssetUpload } from './pdf-assets-sync';
import { readPaperSpacingDefaults, withPaperSpacingDefaults } from './paper-settings';

import { beginPageContentUpload, commitPageContent, getPageContent, putPageContentBlob } from '@/lib/api/endpoints';
import { isStudyApiError } from '@/lib/api/errors';
import { studyGet } from '@/lib/api/http';
import { fetchJsonFromUrl, putToUrl } from '@/lib/api/upload';

export interface OpenNotebookOptions {
  pageId: string;
  title: string;
  storage: WhiteboardStorage;
  /** Builds the first document when neither the device nor the backend has one (e.g. a PDF import). */
  seed?: () => Promise<WhiteboardDocument | null>;
}

export type OpenNotebookSource = 'local' | 'remote' | 'seed' | 'blank';

/** `GET content` of a page that was never committed answers `{ url: null, version: 0 }` — an empty page. */
async function readRemoteContent(pageId: string): Promise<PageContentRef | null> {
  try {
    const ref = await getPageContent(pageId);

    return ref && typeof ref.version === 'number' ? ref : null;
  } catch (error) {
    // 404 = never uploaded (older backend); anything else (offline, 401) = work from the device copy.
    if (isStudyApiError(error, 404)) return null;

    return null;
  }
}

/**
 * Make sure the local IndexedDB holds the document the editor should open, and say where it came
 * from. The device copy wins unless the backend has a STRICTLY newer version than this device last
 * synced (edited elsewhere); then the remote replaces it.
 */
export async function openNotebookDocument({ pageId, title, storage, seed }: OpenNotebookOptions): Promise<{
  source: OpenNotebookSource;
  remoteVersion: number | null;
}> {
  const local = await storage.loadWhiteboard(pageId).catch(() => null);
  const remote = await readRemoteContent(pageId);
  let synced = readSyncedVersion(pageId);

  // The unsent mark is set the moment the board saves on the device (leaving the page saves it too), so
  // it can stand on a board that is exactly what this device last synced. Same ink = nothing to send:
  // clear it, and a newer copy from another device then opens as usual instead of a conflict.
  if (local && synced?.dirty && synced.version > 0 && remote && remote.version >= synced.version) {
    if (await syncedCopyMatches(pageId, synced.version, remote, local)) {
      writeSyncedVersion(pageId, synced.version, false);
      synced = readSyncedVersion(pageId);
    }
  }
  const remoteHasContent = remote !== null && remote.url !== null && remote.version > 0;
  const remoteIsNewer = remoteHasContent && remote.version > (synced?.version ?? 0);

  if (local && !(remoteIsNewer && !synced?.dirty)) {
    return { source: 'local', remoteVersion: remote?.version ?? null };
  }

  if (remoteHasContent && remote.url) {
    try {
      const doc = normalizeWhiteboardDocument(await fetchJsonFromUrl<WhiteboardDocument>(remote.url));

      if (doc) {
        await storage.saveWhiteboard({ ...doc, id: pageId, title: doc.title || title });
        writeSyncedVersion(pageId, remote.version);

        return { source: 'remote', remoteVersion: remote.version };
      }
    } catch {
      // fall through to the device copy / a fresh document
    }
  }

  if (local) {
    return { source: 'local', remoteVersion: remote?.version ?? null };
  }

  const seeded = seed ? await seed().catch(() => null) : null;
  // A new page starts on the paper spacing set in Settings → Notebook paper.
  const doc = withPaperSpacingDefaults(
    seeded ?? createBlankWhiteboardDocument({ id: pageId, title, backgroundType: 'blank' }),
    readPaperSpacingDefaults(),
  );

  await storage.saveWhiteboard({ ...doc, id: pageId, title: doc.title || title });

  // An empty remote page (version 0) is the base this device's first upload builds on.
  if (remote && !remoteHasContent && !synced) writeSyncedVersion(pageId, remote.version, true);

  return { source: seeded ? 'seed' : 'blank', remoteVersion: remote?.version ?? null };
}

export type UploadOutcome =
  | { ok: true; version: number }
  | { ok: false; reason: 'conflict' | 'offline' | 'error'; message: string; currentVersion?: number };

/**
 * Push the board JSON as the raw body of `PUT content/blob?baseVersion=` (upload + commit in one
 * call). A 404 means the backend predates that route: use the presigned flow instead.
 */
async function pushContent(pageId: string, baseVersion: number, json: string): Promise<number> {
  try {
    const { version } = await putPageContentBlob(pageId, baseVersion, json);

    return version;
  } catch (error) {
    if (!isStudyApiError(error, 404)) throw error;
  }

  const begin = await beginPageContentUpload(pageId, baseVersion);

  await putToUrl(begin.uploadUrl, json, 'application/json');
  await commitPageContent(pageId, begin.version);

  return begin.version;
}

/** Whether the stored `version` (the one this device last synced) holds the same ink as the device copy. */
async function syncedCopyMatches(
  pageId: string,
  version: number,
  remote: PageContentRef,
  doc: WhiteboardDocument,
): Promise<boolean> {
  try {
    const url =
      remote.version === version
        ? remote.url
        : (await studyGet<{ url: string | null }>(`/pages/${encodeURIComponent(pageId)}/content?version=${version}`)).url;

    if (!url) return false;

    return sameDocument(await fetchJsonFromUrl<WhiteboardDocument>(url), doc);
  } catch {
    // An older server without earlier versions, or offline: keep the mark (the upload sorts it out).
    return false;
  }
}

/** Whether the server's `version` of the page holds the same document as the device copy. */
async function remoteMatches(pageId: string, version: number, doc: WhiteboardDocument): Promise<boolean> {
  try {
    const remote = await getPageContent(pageId);

    if (remote.version !== version || !remote.url) return false;
    const theirs = await fetchJsonFromUrl<WhiteboardDocument>(remote.url);

    return sameDocument(theirs, doc);
  } catch {
    return false;
  }
}

/** Content equality, ignoring save timestamps (they differ between two saves of the same ink). */
export function sameDocument(a: unknown, b: unknown): boolean {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== 'updatedAt' && key !== 'savedAt' && key !== 'lastModified')
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([key, inner]) => [key, strip(inner)]),
      );
    }

    return value;
  };

  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * Upload the device's copy of a page. `baseVersion` is what this device last synced; a 409
 * (`STALE_VERSION`, with the server's `currentVersion`) means someone else wrote in between.
 */
export async function uploadNotebookDocument(pageId: string, storage: WhiteboardStorage): Promise<UploadOutcome> {
  const doc = await storage.loadWhiteboard(pageId).catch(() => null);

  if (!doc) return { ok: false, reason: 'error', message: 'Nothing to upload' };
  const baseVersion = readSyncedVersion(pageId)?.version ?? 0;

  try {
    const version = await pushContent(pageId, baseVersion, JSON.stringify(doc));

    writeSyncedVersion(pageId, version, false);
    // The PDFs under the pages follow in the background (the board JSON only points at them).
    void queuePdfAssetUpload(pageId, pdfAssetIdsOf(doc), storage);

    return { ok: true, version };
  } catch (error) {
    writeSyncedVersion(pageId, baseVersion, true);

    if (isStudyApiError(error, 409)) {
      // UPLOAD_MISSING (presigned flow: the PUT never landed) is retryable; STALE_VERSION is a conflict.
      if (error.code === 'UPLOAD_MISSING') {
        return { ok: false, reason: 'error', message: 'Upload did not land — retrying' };
      }

      const currentVersion = (error as { currentVersion?: number }).currentVersion;

      // A save whose answer never arrived (tab closed or reloaded mid-upload) leaves the server one
      // version ahead with exactly this content. Same content = no conflict: adopt its version.
      if (typeof currentVersion === 'number' && (await remoteMatches(pageId, currentVersion, doc))) {
        writeSyncedVersion(pageId, currentVersion, false);

        return { ok: true, version: currentVersion };
      }

      return { ok: false, reason: 'conflict', message: error.message, currentVersion };
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { ok: false, reason: 'offline', message: 'Offline — will retry' };
    }

    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Conflict resolution «keep theirs»: drop the device copy for the backend's current version. */
export async function replaceWithRemote(pageId: string, storage: WhiteboardStorage): Promise<boolean> {
  const remote = await getPageContent(pageId);

  if (!remote.url) {
    // The server's page is empty: an empty board IS its content.
    await storage.saveWhiteboard(
      createBlankWhiteboardDocument({ id: pageId, title: 'Notebook', backgroundType: 'blank' }),
    );
    writeSyncedVersion(pageId, remote.version, false);

    return true;
  }

  const doc = normalizeWhiteboardDocument(await fetchJsonFromUrl<WhiteboardDocument>(remote.url));

  if (!doc) return false;
  await storage.saveWhiteboard({ ...doc, id: pageId });
  writeSyncedVersion(pageId, remote.version, false);

  return true;
}

/** Conflict resolution «keep mine»: re-base on the server's version and push the device copy. */
export async function forceUploadOverRemote(pageId: string, storage: WhiteboardStorage): Promise<UploadOutcome> {
  const remote = await getPageContent(pageId).catch(() => null);

  writeSyncedVersion(pageId, remote?.version ?? 0, true);

  return uploadNotebookDocument(pageId, storage);
}
