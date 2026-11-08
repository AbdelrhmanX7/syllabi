// `POST /concept-maps/:id/notes-digest` SSE → state. Frames: `page {pageId, version, cached}` per linked
// page as the backend reads it, then `digest {…}`, then `done {usageId}` — or `error {message}`.
import type { NotesDigest } from './api';
import type { SseFrame } from '@/lib/api/http';

import { parseProvenance } from '../lib/provenance';

import { normalizeDigest } from './api';

export interface DigestPageRead {
  pageId: string;
  version: number | null;
  /** Read from the backend's per-revision cache (no vision call). */
  cached: boolean;
  /** Backend skipped this page and carried on: TIMEOUT, READ_FAILED or EMPTY_PAGE. */
  error: string | null;
}

export interface DigestState {
  phase: 'idle' | 'reading' | 'done' | 'error';
  pages: DigestPageRead[];
  digest: NotesDigest | null;
  error: string | null;
  sample: boolean;
}

export const INITIAL_DIGEST: DigestState = { phase: 'idle', pages: [], digest: null, error: null, sample: false };

/** The digest's error codes (`error {message, code}`) in plain words. */
const DIGEST_ERRORS: Record<string, string> = {
  NO_NOTES: 'Link a notes page to this map first.',
  NOTHING_READ: 'Could not read anything on the linked pages — check they have writing on them.',
  AI_EMPTY: 'Could not digest the notes this time — try again.',
};

export const digestErrorMessage = (code: unknown): string | null =>
  typeof code === 'string' ? (DIGEST_ERRORS[code] ?? null) : null;

/** «Page 2 couldn't be read» for each page the backend skipped (empty pages are not failures). */
export function skippedPages(pages: DigestPageRead[]): string[] {
  return pages.flatMap((page, index) =>
    page.error === 'TIMEOUT' || page.error === 'READ_FAILED' ? [`Page ${index + 1} couldn’t be read`] : [],
  );
}

const record = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

export function reduceDigestFrame(state: DigestState, frame: SseFrame): DigestState {
  const data = record(frame.data);
  const sample = state.sample || data.__sample === true;

  switch (frame.event) {
    case 'page': {
      const pageId = typeof data.pageId === 'string' ? data.pageId : '';

      if (!pageId) return state;
      const row: DigestPageRead = {
        pageId,
        version: typeof data.version === 'number' ? data.version : null,
        cached: data.cached === true,
        error: typeof data.error === 'string' && data.error ? data.error : null,
      };
      const pages = state.pages.some((page) => page.pageId === pageId)
        ? state.pages.map((page) => (page.pageId === pageId ? row : page))
        : [...state.pages, row];

      return { ...state, phase: 'reading', pages, sample };
    }
    case 'digest':
      return { ...state, phase: 'reading', digest: normalizeDigest(frame.data), sample };
    case 'done': {
      if (!state.digest) return { ...state, phase: 'error', error: 'The notes could not be read.', sample };
      // `done {usageId, model, sources}`: what the digest was built from.
      const provenance = parseProvenance(frame.data);
      const digest = provenance.model || provenance.sources.length > 0 ? { ...state.digest, provenance } : state.digest;

      return { ...state, phase: 'done', digest, sample };
    }
    case 'error':
      return {
        ...state,
        phase: 'error',
        error:
          digestErrorMessage(data.code) ??
          (typeof data.message === 'string' && data.message ? data.message : 'The notes could not be read.'),
      };
    default:
      return state;
  }
}

/** «Reading page 2 of 3» while it streams; null when idle or finished. */
export function digestProgress(state: DigestState, linkedPages: number): string | null {
  if (state.phase !== 'reading') return null;
  // Every linked page read: the backend is setting them against her list.
  if (state.pages.length > 0 && state.pages.length >= linkedPages) return 'Comparing with the term list…';
  const total = Math.max(linkedPages, state.pages.length);

  return state.pages.length === 0 ? 'Reading your notes…' : `Read page ${state.pages.length} of ${total}`;
}
