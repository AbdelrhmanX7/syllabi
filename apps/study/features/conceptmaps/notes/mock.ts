// Mock for the `POST /concept-maps/:id/notes-digest` SSE (force-mock / unshipped). Made-up note readings
// built from the map's own terms — nothing here is the owner's. The transport marks it `__sample`.
import type { ConceptMapRecord } from '../types';
import type { NotesDigest } from './api';
import type { SseFrame } from '@/lib/api/http';

import { buildMockMaps, subjectFor } from '../mock';

import { PHOTO_TERMS_QUESTION, SLIDE_TERMS_QUESTION } from './slide-terms';
import { browserStore, pageIdsOf, readLinks } from './links';

import { StudyApiError } from '@/lib/api/errors';
import { streamFrames } from '@/lib/api/mock/sse';

const MOCK_STATE_KEY = 'study_mock_conceptmaps';

function findMockMap(mapId: string): ConceptMapRecord | undefined {
  const classId = /^cm_(.+)_\d+$/.exec(mapId)?.[1];

  if (classId) return buildMockMaps(classId).find((map) => map.id === mapId);
  try {
    const state = JSON.parse(window.localStorage.getItem(MOCK_STATE_KEY) ?? '{}') as {
      practice?: ConceptMapRecord[];
    };

    return state.practice?.find((map) => map.id === mapId);
  } catch {
    return undefined;
  }
}

/** Every 3rd term is "missing from the notes", every 4th is worded differently. Deterministic. */
export function mockNotesDigest(terms: string[]): NotesDigest {
  const missing = terms.filter((_, index) => index % 3 === 2);
  const present = terms.filter((_, index) => index % 3 !== 2);

  return {
    concepts: present.map((term, index) => {
      const matches = index % 4 !== 1;

      return {
        term,
        definitionFromNotes: matches
          ? `${term}: the idea as written under the lecture heading in the notes (sample text).`
          : `${term} — roughly, "the part that moves" (sample note wording).`,
        matchesProfessor: matches,
        professorWording: matches
          ? null
          : `${term} is defined in the term list with a more exact wording (sample).`,
      };
    }),
    questions: [
      { q: `What is ${terms[0] ?? 'the main idea'}?`, answerFromNotes: 'Answered on page 1 of the notes (sample).' },
      { q: `How does ${terms[1] ?? 'it'} relate to ${terms[0] ?? 'the rest'}?`, answerFromNotes: null },
    ],
    missingFromNotes: missing,
    conflicts: present
      .filter((_, index) => index % 4 === 1)
      .map((term) => ({
        term,
        notes: `"the part that moves" (sample)`,
        professor: `the reference definition of ${term} (sample)`,
      })),
  };
}

/** Pages the mock has "read" this session — read again, they come from the cache. */
const readPages = new Set<string>();

/**
 * SSE like the backend: one `page` frame per linked page (the links live on this device in mock mode),
 * the second time a page is read it comes from the "cache", then `digest`, then `done`. Undefined = not
 * this route.
 */
export function notesDigestMockSse(
  path: string,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> | undefined {
  const match = /^\/concept-maps\/([^/?]+)\/notes-digest(?:\?|$)/.exec(path);

  if (!match) return undefined;
  const mapId = decodeURIComponent(match[1]!);
  const map = findMockMap(mapId);

  if (!map) return Promise.reject(new StudyApiError(404, 'Concept map not found', 'NOT_FOUND'));
  const pageIds = pageIdsOf(readLinks(browserStore(), mapId));
  const frames: SseFrame[] = [
    ...pageIds.map((pageId) => {
      const cached = readPages.has(pageId);

      readPages.add(pageId);

      return { event: 'page', data: { pageId, version: 1, cached } };
    }),
    { event: 'digest', data: mockNotesDigest(map.promptTerms) },
    { event: 'done', data: { usageId: 'mock_usage' } },
  ];

  return streamFrames(frames, onFrame, { gapMs: 600, signal });
}

/** «Snap the slide» in force-mock: the tutor's vision reply for the concept-list question (made up). */
export function slideTermsMockSse(
  path: string,
  body: Record<string, unknown> | undefined,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
): Promise<void> | undefined {
  if (path.split('?')[0] !== '/ai/ask') return undefined;
  if (body?.question !== SLIDE_TERMS_QUESTION && body?.question !== PHOTO_TERMS_QUESTION) return undefined;

  const terms = subjectFor(typeof body?.classId === 'string' ? body.classId : '').photoTerms;
  const half = Math.ceil(terms.length / 2);

  return streamFrames(
    [
      { event: 'meta', data: { conversationId: 'cv_mock_slide' } },
      { event: 'delta', data: { text: `${terms.slice(0, half).join(', ')}, ` } },
      { event: 'delta', data: { text: terms.slice(half).join(', ') } },
      { event: 'done', data: {} },
    ],
    onFrame,
    { gapMs: 400, signal },
  );
}
