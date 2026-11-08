import type { WhiteboardDocument } from '@repo/whiteboard-core';

import { createIndexedDbWhiteboardStorage } from '@repo/whiteboard-core';

import { beginPageContentUpload, commitPageContent, getPageContent, putToUrl } from './api';

import { putPageContentBlob } from '@/lib/api/endpoints';
import { isStudyApiError } from '@/lib/api/errors';
import { fetchJsonFromUrl } from '@/lib/api/upload';

/**
 * A notebook page IS a whiteboard document: the editor keeps it in the device's whiteboard IndexedDB
 * under `whiteboardId = page.id`, and the backend keeps the same JSON on B2.
 */

async function withStorage<T>(fn: (storage: ReturnType<typeof createIndexedDbWhiteboardStorage>) => Promise<T>) {
  const storage = createIndexedDbWhiteboardStorage();

  try {
    await storage.ready();

    return await fn(storage);
  } finally {
    storage.close();
  }
}

export const loadLocalPageDoc = (pageId: string) =>
  withStorage((storage) => storage.loadWhiteboard(pageId)).catch(() => null);

export async function loadRemotePageDoc(pageId: string): Promise<WhiteboardDocument | null> {
  const { url } = await getPageContent(pageId);

  // `url` is null for a page that was never committed; the mock answers with `mock://` blobs.
  if (!url) return null;

  return fetchJsonFromUrl<WhiteboardDocument>(url);
}

/** This device's copy first (it has the freshest ink), the backend's otherwise. */
export async function loadPageDoc(pageId: string): Promise<WhiteboardDocument | null> {
  const local = await loadLocalPageDoc(pageId);

  if (local) return local;

  return loadRemotePageDoc(pageId).catch(() => null);
}

/**
 * Push the board JSON: the raw-body `PUT content/blob` (upload + commit server-side) first — the
 * presigned B2 PUT is blocked by the bucket's CORS from the browser — and the presigned flow only
 * when the backend predates that route (404). Same rule as lib/notebooks/sync.ts.
 */
async function pushPageJson(pageId: string, baseVersion: number, body: string): Promise<number> {
  try {
    const { version } = await putPageContentBlob(pageId, baseVersion, body);

    return version;
  } catch (error) {
    if (!isStudyApiError(error, 404)) throw error;
  }

  const begin = await beginPageContentUpload(pageId, baseVersion);

  await putToUrl(begin.uploadUrl, body, 'application/json');
  await commitPageContent(pageId, begin.version);

  return begin.version;
}

/** Upload the local page JSON. Retries once on a stale base. */
export async function uploadPageDoc(pageId: string, baseVersion: number): Promise<number> {
  const doc = await loadLocalPageDoc(pageId);

  if (!doc) return baseVersion;
  const body = JSON.stringify(doc);

  try {
    return await pushPageJson(pageId, baseVersion, body);
  } catch (error) {
    const stale =
      isStudyApiError(error, 409) || /409|stale|conflict/i.test(error instanceof Error ? error.message : String(error));

    if (!stale) throw error;
    // This device wrote the page; its copy wins over whatever raced it.
    const { version } = await getPageContent(pageId);

    return pushPageJson(pageId, version, body);
  }
}
