// Notebook PDF backgrounds on the server. A board's JSON only points at its PDFs (`pdfAssetId`); the
// file itself sits in this device's board storage. After a save, every PDF the board points at that
// the server lacks goes up (one at a time, in the background, the stored Blob as the body — never
// base64); a board that opens without one of its PDFs fetches it from the server first.
//
// The server keeps PDFs per account by asset id; the page routes reach the page OWNER's copy, so
// editors save into, and viewers read from, the owner's account.
import type { WhiteboardDocument, WhiteboardStorage } from '@repo/whiteboard-core';

import { isMockRoute } from '@/lib/api/client';
import { isStudyApiError } from '@/lib/api/errors';
import { studyGet, studyPutRaw } from '@/lib/api/http';
import { parseJwt, readSessionToken } from '@/lib/auth';
import { getBackendSettingsSnapshot } from '@/lib/backend-settings';
import { LOCAL_PAGE_PREFIX } from '@/lib/offline/local-pages';

const enc = encodeURIComponent;
const LIST_CHUNK = 100;
const CACHE_PREFIX = 'study_pdf_up';

/** The distinct PDF asset ids a board's pages point at. */
export function pdfAssetIdsOf(doc: Pick<WhiteboardDocument, 'pages'> | null | undefined): string[] {
  const ids = new Set<string>();

  for (const page of doc?.pages ?? []) {
    const id = page.pdfAssetId?.trim();

    if (id) ids.add(id);
  }

  return Array.from(ids);
}

// --- "the server has it" memory: per server + account, so a new server or account starts over.

interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PdfAssetSyncEnv {
  store: KeyValue | null;
  scope: () => string | null;
  /** The server page routes (swapped in tests). */
  listPresent: (pageId: string, ids: string[]) => Promise<string[]>;
  put: (pageId: string, assetId: string, blob: Blob) => Promise<void>;
  /** Whether this page's calls would go to the demo mock (nothing to sync with). */
  isDemo: (pageId: string) => boolean;
}

function browserStore(): KeyValue | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function defaultScope(): string | null {
  const token = readSessionToken();
  const user = token ? parseJwt(token)?._id : null;

  if (!user) return null;

  return `${getBackendSettingsSnapshot().backendUrl}|${user}`;
}

const pagePath = (pageId: string) => `/pages/${enc(pageId)}/pdf-assets`;

const defaultEnv: PdfAssetSyncEnv = {
  store: null,
  scope: defaultScope,
  listPresent: async (pageId, ids) => {
    const out = await studyGet<{ present?: string[] }>(`${pagePath(pageId)}?ids=${ids.map(enc).join(',')}`);

    return Array.isArray(out?.present) ? out.present : [];
  },
  put: async (pageId, assetId, blob) => {
    await studyPutRaw(`${pagePath(pageId)}/${enc(assetId)}`, blob, 'application/pdf');
  },
  isDemo: (pageId) => isMockRoute(pagePath(pageId)),
};

let env: PdfAssetSyncEnv = defaultEnv;

/** Tests swap the server + memory; `null` restores the real ones. */
export function setPdfAssetSyncEnv(next: Partial<PdfAssetSyncEnv> | null): void {
  env = next ? { ...defaultEnv, ...next } : defaultEnv;
  pending.clear();
  disabled = false;
}

const store = () => env.store ?? browserStore();
const cacheKey = (scope: string, assetId: string) => `${CACHE_PREFIX}|${scope}|${assetId}`;

/** '1' = the server has it; 'skip' = the server refused it for good (too big, not a PDF): never resend. */
function settled(scope: string, assetId: string): boolean {
  try {
    const v = store()?.getItem(cacheKey(scope, assetId));

    return v === '1' || v === 'skip';
  } catch {
    return false;
  }
}

function remember(scope: string | null, assetId: string, value: '1' | 'skip' = '1'): void {
  if (!scope) return;
  try {
    store()?.setItem(cacheKey(scope, assetId), value);
  } catch {
    // storage full / blocked: it is checked with the server again next time
  }
}

const rememberOnServer = (scope: string | null, assetId: string) => remember(scope, assetId);

/** The server will never take this file (too big, not a PDF, bad id): retrying would resend tens of MB per save. */
const refusedForGood = (error: unknown) =>
  isStudyApiError(error) && (error.status === 413 || error.status === 415 || error.status === 400);

/** A 404 with no error code is Express's own: this server has no PDF routes yet. */
const routeMissing = (error: unknown) => isStudyApiError(error, 404) && !error.code;

// --- the upload queue: one page at a time, one PDF at a time.

const pending = new Map<string, { ids: Set<string>; storage: WhiteboardStorage }>();
let running: Promise<void> | null = null;
/** Set when the server has no PDF routes: stop asking until the app restarts. */
let disabled = false;

async function uploadPage(pageId: string, ids: string[], storage: WhiteboardStorage): Promise<void> {
  const scope = env.scope();

  if (!scope || disabled || env.isDemo(pageId)) return;
  const unknown = ids.filter((id) => !settled(scope, id));

  if (!unknown.length) return;
  const present = new Set<string>();

  for (let i = 0; i < unknown.length; i += LIST_CHUNK) {
    for (const id of await env.listPresent(pageId, unknown.slice(i, i + LIST_CHUNK))) present.add(id);
  }

  for (const id of unknown) {
    if (present.has(id)) {
      rememberOnServer(scope, id);
      continue;
    }
    const asset = await storage.loadPdfAsset(id).catch(() => null);

    // Not on this device either (imported elsewhere and never uploaded): nothing to send from here.
    if (!asset?.blob) continue;
    try {
      await env.put(pageId, id, asset.blob);
      rememberOnServer(scope, id);
    } catch (error) {
      if (!refusedForGood(error)) throw error;
      remember(scope, id, 'skip');
    }
  }
}

async function drain(): Promise<void> {
  while (pending.size) {
    const [pageId, job] = pending.entries().next().value as [string, { ids: Set<string>; storage: WhiteboardStorage }];

    pending.delete(pageId);
    try {
      await uploadPage(pageId, Array.from(job.ids), job.storage);
    } catch (error) {
      if (routeMissing(error)) disabled = true;
      // Offline / server error: left out of the memory, so the next save or open tries again.
    }
  }
}

/**
 * Queue the PDFs `ids` of page `pageId` for upload (those the server already has cost one small list
 * call, or nothing once remembered). Never throws, never blocks the caller; resolves when the queue
 * is empty (tests await it).
 */
export function queuePdfAssetUpload(pageId: string, ids: readonly string[], storage: WhiteboardStorage): Promise<void> {
  // A note made offline has no server page yet; its PDFs go up once it is opened under the server id.
  if (!ids.length || disabled || pageId.startsWith(LOCAL_PAGE_PREFIX)) return running ?? Promise.resolve();
  const job = pending.get(pageId);

  if (job) {
    ids.forEach((id) => job.ids.add(id));
    job.storage = storage;
  } else {
    pending.set(pageId, { ids: new Set(ids), storage });
  }
  if (!running) {
    running = drain().finally(() => {
      running = null;
    });
  }

  return running;
}

// --- download

/**
 * Fetch the server's copy of one PDF into this device's board storage, under the id the board points
 * at. `fetchUrl` gets a short-lived signed link (fetched without the session header), `restore` stores
 * it (re-imported, so page count and fingerprint are this device's own). false when the server has no
 * copy, is unreachable, or this is demo mode — the caller then tries the other sources.
 */
export async function restorePdfAssetFromServer(
  fetchUrl: () => Promise<{ url?: string | null }>,
  restore: (url: string) => Promise<void>,
  demo: boolean,
): Promise<boolean> {
  if (demo) return false;
  try {
    const { url } = await fetchUrl();

    if (!url) return false;
    await restore(url);

    return true;
  } catch (error) {
    if (routeMissing(error)) disabled = true;

    return false;
  }
}

/** A page's PDF from the server (owner, editor, named viewer). */
export async function restorePagePdfAsset(
  storage: WhiteboardStorage,
  pageId: string,
  assetId: string,
  fileName: string | undefined,
): Promise<boolean> {
  if (disabled) return false;
  const ok = await restorePdfAssetFromServer(
    () => studyGet<{ url?: string }>(`${pagePath(pageId)}/${enc(assetId)}`),
    (url) => restoreFrom(storage, assetId, url, fileName),
    env.isDemo(pageId),
  );

  if (ok) rememberOnServer(env.scope(), assetId);

  return ok;
}

/** A shared notebook's PDF through the share (view-only and link viewers never get the page id). */
export function restoreSharedPdfAsset(
  storage: WhiteboardStorage,
  idOrToken: string,
  assetId: string,
  fileName: string | undefined,
): Promise<boolean> {
  const path = `/share/view/${enc(idOrToken)}/pdf-assets/${enc(assetId)}`;

  return restorePdfAssetFromServer(
    () => studyGet<{ url?: string }>(path),
    (url) => restoreFrom(storage, assetId, url, fileName),
    isMockRoute(path),
  );
}

async function restoreFrom(storage: WhiteboardStorage, assetId: string, url: string, fileName: string | undefined) {
  // Lazy: the PDF importer is heavy and most opens restore nothing.
  const { restorePdfAsset } = await import('./pdf-import');

  await restorePdfAsset({ assetId, fileUrl: url, fileName: fileName || 'document.pdf', storage });
}
