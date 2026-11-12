// The app's offline work: which jobs the outbox knows, how each is sent, and the offline-aware calls
// the screens use instead of the plain endpoints (grade a flashcard, mark an item seen, create a note).
// Installed once from `_app.tsx` (`installOfflineJobs`).
import type { SendResult } from './outbox';
import type { Page } from '@/lib/api/types';
import type { QueryClient } from '@tanstack/react-query';

import { classifySendError } from './classify';
import { isPageOpen, localPageRecord, LOCAL_PAGE_PREFIX, type NewPageBody, PAGE_ID_SWAPPED_EVENT, rememberPageRedirect } from './local-pages';
import { isOnline, reportNetworkFailure, reportNetworkSuccess, subscribeOnline } from './network';
import { newClientId, Outbox, type OutboxJob } from './outbox';
import { offlineOwner } from './owner';

import { attemptQuestion, createPage, deletePage, markItemSeen, patchPage } from '@/lib/api/endpoints';
import { isNetworkError, StudyApiError } from '@/lib/api/errors';
import { getBackendSettingsSnapshot } from '@/lib/backend-settings';
import { forgetPage, readCachedPage, rememberPages } from '@/lib/notebooks/pages-cache';

/** Account + server + mode: queued work only ever goes to where it was made. */
export function currentScope(): string {
  const { backendUrl, mockMode } = getBackendSettingsSnapshot();

  return `${offlineOwner() ?? 'anon'}|${mockMode === 'mock' ? 'mock' : backendUrl}`;
}

export const outbox = new Outbox();

let client: QueryClient | null = null;

/** Calls `send`; a network failure flips the app offline and says so (the caller queues instead). */
async function trySend<T>(send: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const value = await send();

    reportNetworkSuccess();

    return { ok: true, value };
  } catch (error) {
    if (!isNetworkError(error)) throw error;
    reportNetworkFailure();

    return { ok: false };
  }
}

/* ------------------------------------------------------------------ flashcard / review grades */

export interface GradePayload {
  questionId: string;
  selfRating: 1 | 2 | 3 | 4;
  timeMs: number;
}

// The attempt body stays exactly what the server validates today (no client id field: a strict server
// would refuse it, and the grade would be lost). Delivery is therefore at-least-once.
const sendGrade = (payload: GradePayload) =>
  attemptQuestion(payload.questionId, { timeMs: payload.timeMs, selfRating: payload.selfRating }, () => undefined);

/**
 * A self-grade (no grader runs): sent now when online, else queued and sent on reconnect.
 * Resolves `'sent'` or `'queued'`; throws only when the server refused it.
 */
export async function recordSelfGrade(payload: GradePayload): Promise<'sent' | 'queued'> {
  const id = newClientId('g');

  if (isOnline()) {
    const result = await trySend(() => sendGrade(payload));

    if (result.ok) return 'sent';
  }
  await outbox.enqueue({ kind: 'grade', payload, scope: currentScope(), id });

  return 'queued';
}

/* ------------------------------------------------------------------ mark seen */

export async function markSeenOfflineAware(itemId: string): Promise<'sent' | 'queued'> {
  if (isOnline()) {
    const result = await trySend(() => markItemSeen(itemId));

    if (result.ok) return 'sent';
  }
  await outbox.enqueue({ kind: 'seen', payload: { itemId }, scope: currentScope(), dedupeKey: `seen:${itemId}` });

  return 'queued';
}

/* ------------------------------------------------------------------ note pages */

interface CreatePagePayload {
  localId: string;
  body: NewPageBody;
  /** Set once the server created it (so a retry never creates a second page). */
  serverPage?: Page;
}

function pageListMatches(key: readonly unknown[], page: Pick<Page, 'classId' | 'itemId'>): boolean {
  // studyKeys.pages(classId, itemId) = ['study', 'pages', classId ?? '', itemId ?? '']
  const classId = key[2] ?? '';
  const itemId = key[3] ?? '';

  return (classId === '' || classId === (page.classId ?? '')) && (itemId === '' || itemId === (page.itemId ?? ''));
}

function addToPageLists(page: Page): void {
  if (!client) return;
  const queryClient = client;
  const keys = queryClient
    .getQueryCache()
    .findAll({ queryKey: ['study', 'pages'] })
    .map((query) => query.queryKey)
    .filter((key) => pageListMatches(key, page));

  // The lists that screen opens even if they were never loaded on this device: all pages, and its own.
  for (const key of [
    ['study', 'pages', '', ''],
    ['study', 'pages', page.classId ?? '', page.itemId ?? ''],
    ...(page.itemId ? [['study', 'pages', '', page.itemId]] : []),
  ]) {
    if (!keys.some((known) => JSON.stringify(known) === JSON.stringify(key))) keys.push(key);
  }
  keys.forEach((key) =>
    queryClient.setQueryData<Page[]>(key, (current) => [page, ...(current ?? []).filter((other) => other.id !== page.id)]),
  );
}

/** A page's fresh record (e.g. after AI described it) into every loaded page list. */
export function updatePageInLists(page: Page): void {
  replaceInPageLists(page.id, page);
}

/** Reload the page lists (e.g. once a cover picture had time to be made). */
export function refreshPageLists(): void {
  void client?.invalidateQueries({ queryKey: ['study', 'pages'] });
}

function replaceInPageLists(localId: string, page: Page): void {
  client?.setQueriesData<Page[]>({ queryKey: ['study', 'pages'] }, (current) =>
    Array.isArray(current) ? current.map((other) => (other.id === localId ? page : other)) : current,
  );
}

/**
 * Create a note page. Online: the server's page. Offline (or the network drops): a temporary page
 * that opens at once and becomes the server's page on reconnect. Server refusals still throw.
 */
export async function createNotePage(body: NewPageBody): Promise<Page> {
  if (isOnline()) {
    try {
      const result = await trySend(() => createPage(body));

      if (result.ok) return result.value;
    } catch (error) {
      // Signed out: the note lives on this device (as the signed-out banner promises), not an error.
      if (!(error instanceof StudyApiError && error.code === 'NO_SESSION')) throw error;
    }
  }
  const localId = newClientId(LOCAL_PAGE_PREFIX);
  const page = localPageRecord(localId, body);

  rememberPages([page]);
  addToPageLists(page);
  await outbox.enqueue<CreatePagePayload>({ kind: 'create-page', payload: { localId, body }, scope: currentScope(), id: localId });

  return page;
}

/**
 * Delete a notebook everywhere: on the server (a page never sent there is just dropped from the
 * outbox), then its board on this device and every cached list entry.
 */
export async function deleteNotePage(pageId: string): Promise<void> {
  if (pageId.startsWith(LOCAL_PAGE_PREFIX)) {
    await outbox.remove(pageId);
  } else {
    await deletePage(pageId);
  }
  client?.setQueriesData<Page[]>({ queryKey: ['study', 'pages'] }, (current) =>
    Array.isArray(current) ? current.filter((other) => other.id !== pageId) : current,
  );
  forgetPage(pageId);
  const { createIndexedDbWhiteboardStorage } = await import('@repo/whiteboard-core');
  const storage = createIndexedDbWhiteboardStorage();

  try {
    await storage.ready();
    await storage.deleteWhiteboard(pageId);
  } catch {
    // The board may never have been saved on this device.
  } finally {
    storage.close();
  }
}

/** Move the board from the temporary id to the server's, then upload it. */
async function adoptServerPage(localId: string, serverPage: Page): Promise<void> {
  const [{ createIndexedDbWhiteboardStorage }, { readSyncedVersion, writeSyncedVersion }, { uploadNotebookDocument }] = await Promise.all([
    import('@repo/whiteboard-core'),
    import('@/lib/notebooks/pages-cache'),
    import('@/lib/notebooks/sync'),
  ]);
  const storage = createIndexedDbWhiteboardStorage();

  await storage.ready();
  const board = await storage.loadWhiteboard(localId).catch(() => null);
  const hadBoard = board !== null;

  if (board) {
    // The server page may already have a (blank) board here — opened from a list before this ran.
    // `rekeyWhiteboard` would keep that one and DROP the ink, so the device's ink is written over it.
    const existing = await storage.loadWhiteboard(serverPage.id).catch(() => null);

    if (existing) {
      await storage.saveWhiteboard({ ...board, id: serverPage.id });
      await storage.deleteWhiteboard(localId);
    } else {
      // One atomic move (doc row + its pages); a failure leaves the temporary board whole and this retries.
      await storage.rekeyWhiteboard(localId, serverPage.id);
    }
  }
  // A title renamed on the device while offline wins over the one sent at creation.
  const local = readCachedPage(localId);
  const record: Page = { ...serverPage, title: local?.title || serverPage.title };

  rememberPages([record]);
  if (record.title !== serverPage.title) void patchPage(serverPage.id, { title: record.title }).catch(() => undefined);
  rememberPageRedirect(localId, serverPage.id);
  forgetPage(localId);
  replaceInPageLists(localId, record);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PAGE_ID_SWAPPED_EVENT, { detail: { from: localId, to: serverPage.id } }));
  }
  if (!hadBoard) return;
  // Unsent, based on the server's empty page (or whatever version a blank open of it already synced):
  // the next open uploads it even if this upload fails.
  writeSyncedVersion(serverPage.id, readSyncedVersion(serverPage.id)?.version ?? 0, true);
  await uploadNotebookDocument(serverPage.id, storage).catch(() => undefined);
}

/* ------------------------------------------------------------------ handlers + triggers */

async function handleGrade(job: OutboxJob): Promise<SendResult> {
  try {
    await sendGrade(job.payload as GradePayload);

    return 'done';
  } catch (error) {
    return classifySendError(error);
  }
}

async function handleSeen(job: OutboxJob): Promise<SendResult> {
  try {
    await markItemSeen((job.payload as { itemId: string }).itemId);

    return 'done';
  } catch (error) {
    return classifySendError(error);
  }
}

async function handleCreatePage(job: OutboxJob): Promise<SendResult> {
  const payload = job.payload as CreatePagePayload;
  let serverPage = payload.serverPage;

  if (!serverPage) {
    try {
      serverPage = await createPage(payload.body);
    } catch (error) {
      return classifySendError(error);
    }
    await outbox.patch(job.id, { ...payload, serverPage });
  }
  // Never move a board that is open (either id): wait until the student leaves it.
  if (isPageOpen(payload.localId) || isPageOpen(serverPage.id)) return 'later';
  try {
    await adoptServerPage(payload.localId, serverPage);
  } catch {
    return 'retry';
  }

  return 'done';
}

outbox.register('grade', handleGrade);
outbox.register('seen', handleSeen);
outbox.register('create-page', handleCreatePage);

/** Send what is queued for this session; refresh the screens it touched. */
export async function flushOutbox(force = false): Promise<number> {
  if (!isOnline()) return 0;
  const sent = await outbox.flush(currentScope(), { force });

  if (sent > 0 && client) {
    void client.invalidateQueries({ queryKey: ['study', 'questions'] });
    void client.invalidateQueries({ queryKey: ['study', 'mastery'] });
    void client.invalidateQueries({ queryKey: ['study', 'knowledge'] });
    void client.invalidateQueries({ queryKey: ['study', 'today'] });
    void client.invalidateQueries({ queryKey: ['study', 'items'] });
    void client.invalidateQueries({ queryKey: ['study', 'classes'] });
    void client.invalidateQueries({ queryKey: ['study', 'pages'] });
    // useLoad screens: only the shared lists the jobs change — never a per-component load (a review
    // queue stepping by index would swap the question under the student).
    void client.invalidateQueries({ queryKey: ['study', 'load', 'questions'] });
    void client.invalidateQueries({ queryKey: ['study', 'load', 'mastery'] });
  }

  return sent;
}

let installed = false;

/** Idempotent. Flushes on reconnect, on start, when the app comes to the front and every 30 s. */
export function installOfflineJobs(queryClient: QueryClient): () => void {
  client = queryClient;
  if (installed || typeof window === 'undefined') return () => undefined;
  installed = true;
  const kick = () => void flushOutbox().catch(() => undefined);
  const unsubscribe = subscribeOnline((online) => {
    if (online) void flushOutbox(true).catch(() => undefined);
  });
  const onVisible = () => {
    if (document.visibilityState === 'visible') kick();
  };
  const start = window.setTimeout(kick, 2_000);
  const timer = window.setInterval(kick, 30_000);

  document.addEventListener('visibilitychange', onVisible);

  return () => {
    installed = false;
    unsubscribe();
    window.clearTimeout(start);
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

