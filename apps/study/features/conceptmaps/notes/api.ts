// Notes ↔ map endpoints (backend #583): `notesPageIds` + the cached `notesDigest` + `promptTermsSource`
// on the map DTO, PATCH {notesPageIds?, promptTerms?}, and the digest SSE.
import type { Provenance } from '../lib/provenance';
import type { ConceptMapRecord } from '../types';
import type { SseFrame } from '@/lib/api/http';

import { normalizeMap } from '../api';
import { parseProvenance } from '../lib/provenance';

import { SLIDE_TERMS_QUESTION } from './slide-terms';

import { askTutor } from '@/features/tutor/api';
import { studyPatch, studySse } from '@/lib/api/http';

const enc = encodeURIComponent;

/** Backend cap on linked pages per map. */
export const NOTES_PAGES_MAX = 20;

/** Both transports' errors carry `status` (the mock's feature handlers throw plain Errors with one). */
const statusOf = (error: unknown) =>
  error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : null;

/** The map with the notes fields (absent only from the mock transport and old cached data). */
export type MapWithNotes = ConceptMapRecord & {
  notesPageIds?: string[];
  notesDigest?: unknown;
  promptTermsSource?: 'canvas' | 'manual' | null;
};

export interface DigestConcept {
  term: string;
  definitionFromNotes: string | null;
  matchesProfessor: boolean;
  professorWording?: string | null;
}

export interface DigestQuestion {
  q: string;
  answerFromNotes?: string | null;
}

export interface DigestConflict {
  term: string;
  notes: string;
  professor: string;
}

/** `POST /concept-maps/:id/notes-digest` — what his notes say, set against the professor's list. */
export interface NotesDigest {
  concepts: DigestConcept[];
  questions: DigestQuestion[];
  missingFromNotes: string[];
  conflicts: DigestConflict[];
  /** ISO time the backend built it (cached digests only). */
  generatedAt?: string | null;
  /** `model` + `sources` (cached digest, or the stream's `done`); empty on old digests. */
  provenance?: Provenance;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

/** Tolerant of a half-filled reply: missing arrays become [], questions may arrive as bare strings. */
export function normalizeDigest(raw: unknown): NotesDigest {
  const body = obj(raw);

  return {
    concepts: arr(body.concepts)
      .map(obj)
      .filter((row) => str(row.term))
      .map((row) => ({
        term: str(row.term),
        definitionFromNotes: str(row.definitionFromNotes) || null,
        matchesProfessor: row.matchesProfessor === true,
        professorWording: str(row.professorWording) || null,
      })),
    questions: arr(body.questions)
      .map((row) => (typeof row === 'string' ? { q: row } : obj(row)))
      .filter((row) => str(row.q))
      .map((row) => ({
        q: str(row.q),
        answerFromNotes: str((row as Record<string, unknown>).answerFromNotes) || null,
      })),
    missingFromNotes: arr(body.missingFromNotes).map(str).filter(Boolean),
    conflicts: arr(body.conflicts)
      .map(obj)
      .filter((row) => str(row.term))
      .map((row) => ({ term: str(row.term), notes: str(row.notes), professor: str(row.professor) })),
    generatedAt: str(body.generatedAt) || null,
    provenance: parseProvenance(body),
  };
}

/** The backend refused one of the pages (404: not his, or deleted) — nothing was written. */
export class NotesPageRejected extends Error {}

/**
 * Saves the linked page ids on the map (deduped, at most {@link NOTES_PAGES_MAX}; `[]` unlinks).
 * Resolves to the updated map. A 404 is a refused page ({@link NotesPageRejected}); a reply without
 * `notesPageIds` (the mock transport) resolves to null and the caller keeps the device copy.
 */
export async function saveNotesPageIds(mapId: string, notesPageIds: string[]): Promise<MapWithNotes | null> {
  try {
    const raw = await studyPatch<MapWithNotes>(`/concept-maps/${enc(mapId)}`, {
      notesPageIds: [...new Set(notesPageIds)].slice(0, NOTES_PAGES_MAX),
    });

    return Array.isArray(raw?.notesPageIds) ? { ...normalizeMap(raw), notesPageIds: raw.notesPageIds } : null;
  } catch (error) {
    if (statusOf(error) === 404) {
      throw new NotesPageRejected(error instanceof Error ? error.message : 'That notes page could not be linked');
    }
    throw error;
  }
}

/** Thrown when the backend has no digest route — the panel hides. */
export class DigestUnavailable extends Error {}

/**
 * SSE: `page {pageId, version, cached, error?}` per linked page → `digest {…}` → `done {usageId}`; an
 * `error {message, code}` frame rejects (NO_NOTES, NOTHING_READ, AI_EMPTY — see `digestErrorMessage`).
 * Feed the frames to `reduceDigestFrame`. A 404 before the stream = the mock has no route.
 */
export async function streamNotesDigest(
  mapId: string,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await studySse(`/concept-maps/${enc(mapId)}/notes-digest`, {}, onFrame, signal);
  } catch (error) {
    if ([404, 405].includes(statusOf(error) ?? 0)) throw new DigestUnavailable('No digest route');
    throw error;
  }
}

/**
 * The professor's concept list for a map that came without one: 1–15 terms, saved on the map as
 * `promptTermsSource:'manual'` (Canvas never replaces it). Resolves to the updated map; a 400 (bad
 * list) or 404 (map gone) rejects with the backend's error.
 */
export async function savePromptTerms(mapId: string, promptTerms: string[]): Promise<MapWithNotes> {
  return normalizeMap(await studyPatch<MapWithNotes>(`/concept-maps/${enc(mapId)}`, { promptTerms }));
}

/**
 * Asked of the class tutor (`/ai/ask`, vision) with a photo of the concept-list slide. No dedicated
 * endpoint exists; the reply is free text, parsed with `termsFromReply`. The force-mock answers this
 * exact question from notes/mock.ts.
 */

export async function readSlideTerms(
  classId: string,
  imagePngB64: string,
  signal?: AbortSignal,
  question: string = SLIDE_TERMS_QUESTION,
): Promise<string> {
  let text = '';
  let failure: string | null = null;

  await askTutor(
    { classId, mode: 'explain', context: { imagePngB64 }, question },
    (frame) => {
      const data = obj(frame.data);

      if (frame.event === 'delta') text += str(data.text);
      if (frame.event === 'error') failure = str(data.message) || 'Could not read the slide';
    },
    signal,
  );
  if (failure) throw new Error(failure);

  return text;
}
