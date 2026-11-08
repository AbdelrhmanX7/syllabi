// Phone inbox endpoints. JSON routes go through the shared study transport (live when `/inbox` is in
// `LIVE_ROUTES`, the mock otherwise). The multipart upload and the GET event stream do not fit the
// JSON transport, so they pick live vs mock here with the same rule (`isMockRoute`).
import type { DropToken, DropTokenCreated, InboxItem } from './types';
import type { Page } from '@/lib/api/types';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { INBOX_NOTE_MAX, inboxPdfFileName, inboxUploadErrorMessage } from './lib/links';
import { mockInboxStream, mockInboxUpload } from './mock';

import { isMockRoute } from '@/lib/api/client';
import { StudyApiError, studyApiError } from '@/lib/api/errors';
import { readSse, studyDelete, studyGet, studyPatch, studyPost } from '@/lib/api/http';
import { useStudyQueriesEnabled } from '@/lib/api/hooks';
import { markSample } from '@/lib/api/sample';
import { readSessionToken } from '@/lib/auth';
import { getBackendSettingsSnapshot } from '@/lib/backend-settings';

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ items */

export const listInbox = (since?: string | null) =>
  studyGet<InboxItem[]>(since ? `/inbox?since=${enc(since)}` : '/inbox');
/** `GET /inbox?pageId=` — every unused item queued for that note page, newest first (not capped). */
export const listInboxForPage = (pageId: string) => studyGet<InboxItem[]>(`/inbox?pageId=${enc(pageId)}`);
/** `GET /inbox/:id` — one item with a fresh signed url, even when soft-deleted (404 when gone / older BE). */
export const getInboxItem = (id: string) => studyGet<InboxItem>(`/inbox/${enc(id)}`);
export const deleteInboxItem = (id: string) => studyDelete(`/inbox/${enc(id)}`);
export const markInboxUsed = (id: string, usedAt: string | null = new Date().toISOString()) =>
  studyPatch<InboxItem>(`/inbox/${enc(id)}`, { usedAt });

/** `POST /inbox/:id/to-page` — a PDF item becomes an annotatable notebook page (PDF items only). */
export interface InboxToPageBody {
  classId: string;
  title?: string;
  week?: number;
  lecture?: { number?: number | null; key: string; date: string };
}
export interface InboxToPageResult {
  pageId: string;
  itemId: string;
  page: Page;
}
export const inboxItemToPage = (id: string, body: InboxToPageBody) =>
  studyPost<InboxToPageResult>(`/inbox/${enc(id)}/to-page`, body);

/* ------------------------------------------------------------------ drop tokens */

export const listDropTokens = () => studyGet<DropToken[]>('/inbox/tokens');
export const createDropToken = (label: string) =>
  studyPost<DropTokenCreated>('/inbox/tokens', { label: label.trim() || 'iPhone' });
export const revokeDropToken = (id: string) => studyDelete(`/inbox/tokens/${enc(id)}`);

export const inboxKeys = {
  tokens: ['study', 'inbox', 'tokens'] as const,
};

export const useDropTokens = () =>
  useQuery({ queryKey: inboxKeys.tokens, queryFn: listDropTokens, enabled: useStudyQueriesEnabled() });

export function useDropTokenMutations() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: inboxKeys.tokens });

  return {
    create: useMutation({ mutationFn: createDropToken, onSuccess: () => void refresh() }),
    revoke: useMutation({ mutationFn: revokeDropToken, onSuccess: () => void refresh() }),
  };
}

/* ------------------------------------------------------------------ non-JSON: upload + stream */

function liveBase(): string {
  return `${getBackendSettingsSnapshot().backendUrl}/study`;
}

function liveAuth(): Record<string, string> {
  const token = readSessionToken();

  if (!token) throw new StudyApiError(401, 'Not signed in', 'NO_SESSION');

  return { Authorization: `Bearer ${token}` };
}

async function liveError(res: Response): Promise<StudyApiError> {
  const text = await res.text().catch(() => '');
  let message = text.trim() || `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;

  try {
    const body = JSON.parse(text) as { message?: string; code?: string } | null;

    if (body?.message) message = body.message;
    if (body?.code) code = body.code;
  } catch {
    // plain text
  }

  return studyApiError(res.status, message, code);
}

/** Multipart `POST /inbox` (`file` + optional `note`, `classId`) as the signed-in admin. */
export async function uploadToInbox(file: Blob, fields: { note?: string; classId?: string } = {}): Promise<InboxItem> {
  if (isMockRoute('/inbox', 'POST')) return markSample(await mockInboxUpload(file, fields));
  const form = new FormData();

  form.append('file', file);
  if (fields.note?.trim()) form.append('note', fields.note.trim().slice(0, INBOX_NOTE_MAX));
  if (fields.classId) form.append('classId', fields.classId);
  const res = await fetch(`${liveBase()}/inbox`, { method: 'POST', headers: liveAuth(), body: form });

  if (!res.ok) {
    const error = await liveError(res);

    throw studyApiError(error.status, inboxUploadErrorMessage(error.status, error.code, error.message), error.code);
  }

  return (await res.json()) as InboxItem;
}

/**
 * `GET /inbox/stream` — `item` frames as uploads land. Settles when the server closes the stream;
 * rejects with a StudyApiError when it refuses (404 = not deployed yet → the caller polls).
 */
export async function openInboxStream(
  handlers: { onOpen: () => void; onItem: (item: InboxItem) => void },
  signal: AbortSignal,
): Promise<void> {
  if (isMockRoute('/inbox/stream')) {
    const forced = getBackendSettingsSnapshot().mockMode === 'mock';

    return mockInboxStream({ onOpen: handlers.onOpen, onItem: (item) => handlers.onItem(markSample(item)) }, signal, {
      simulate: forced,
    });
  }

  const res = await fetch(`${liveBase()}/inbox/stream`, {
    headers: { Accept: 'text/event-stream', ...liveAuth() },
    signal,
  });

  if (!res.ok) throw await liveError(res);
  handlers.onOpen();
  await readSse(res, (frame) => {
    if (frame.event === 'item' && frame.data && typeof frame.data === 'object')
      handlers.onItem(frame.data as InboxItem);
  });
}

/** The full-size file as a `File` (for the board's image insert / the bank's photo extract). */
export async function fetchInboxFile(item: InboxItem): Promise<File> {
  const res = await fetch(item.url);

  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();
  const ext =
    item.kind === 'pdf' ? 'pdf' : blob.type.includes('svg') ? 'svg' : blob.type.includes('png') ? 'png' : 'jpg';

  return new File([blob], ext === 'pdf' ? inboxPdfFileName(item.id) : `phone-${item.id}.${ext}`, {
    type: blob.type || (item.kind === 'pdf' ? 'application/pdf' : 'image/jpeg'),
  });
}
