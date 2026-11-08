// `/concept-maps…` — thin wrappers over the shared study transport. Paths follow the backend
// contract in the lead's handoff; the SSE streams hand raw frames to the reducers in `lib/frames`.
import type { ConceptMapRecord, GradeRequest, MapAttempt, ReferenceRequest } from './types';
import type { SseFrame } from '@/lib/api/http';
import type { Question } from '@/lib/api/types';

import { parseReading, parseVerdict } from './lib/frames';
import { REFERENCE_READS_IMAGES, referenceWireBody } from './lib/pageImages';
import { parseProvenance } from './lib/provenance';

import { isMockRoute } from '@/lib/api/client';
import { studyGet, studyPatch, studyPost, studySse } from '@/lib/api/http';

const enc = encodeURIComponent;

/** Imported maps arrive with `score: null` until she scores them; arrays are never missing. */
export function normalizeMap(raw: ConceptMapRecord): ConceptMapRecord {
  return {
    ...raw,
    number: raw.number ?? null,
    week: raw.week ?? null,
    lecture: raw.lecture ?? null,
    promptTerms: Array.isArray(raw.promptTerms) ? raw.promptTerms : [],
    score: raw.score ?? null,
    maxScore: raw.maxScore || 10,
    scoreSource: raw.scoreSource ?? null,
    canvasScore: raw.canvasScore ?? null,
    manualScore: raw.manualScore ?? null,
    scoreNote: raw.scoreNote ?? null,
    canvasItemId: raw.canvasItemId ?? null,
  };
}

/** Attempts are stored as the grader's raw frames — run them through the same parsers as the live stream. */
export function normalizeAttempt(raw: MapAttempt): MapAttempt {
  return {
    ...raw,
    createdAt: raw.createdAt ?? null,
    imageUrl: raw.imageUrl ?? null,
    verdict: parseVerdict(raw.verdict),
    reading: raw.reading ? parseReading(raw.reading) : undefined,
    provenance: parseProvenance(raw),
  };
}

export const listConceptMaps = async (classId: string) =>
  (await studyGet<ConceptMapRecord[]>(`/concept-maps?classId=${enc(classId)}`)).map(normalizeMap);

/**
 * His entry of her score: 0–10 in steps of 0.5 (400 otherwise); null drops the manual score and falls
 * back to the Canvas grade. A later Canvas change replaces it (the map's `scoreNote` then says so).
 */
export const setMapScore = async (mapId: string, score: number | null) =>
  normalizeMap(await studyPatch<ConceptMapRecord>(`/concept-maps/${enc(mapId)}`, { score }));

/**
 * SSE: `reading {nodes, edges}` → `criterion {name, score, max, note}` ×5 → `verdict {…}` → `done`.
 * With `mapId` the backend records the attempt under that map.
 */
export const gradeConceptMap = (body: GradeRequest, onFrame: (frame: SseFrame) => void, signal?: AbortSignal) =>
  studySse('/concept-maps/grade', body, onFrame, signal);

/** A practice map: from an assigned map's terms (`mapId`) or a custom / predicted term list. */
export const createPracticeMap = (body: {
  classId: string;
  mapId?: string;
  promptTerms?: string[];
  lecture?: string;
  week?: number;
}) => studyPost<ConceptMapRecord>('/concept-maps/practice', body).then(normalizeMap);

export const listAttempts = async (mapId: string) =>
  (await studyGet<MapAttempt[]>(`/concept-maps/${enc(mapId)}/attempts`)).map(normalizeAttempt);

/**
 * SSE (~25 s): `status` → `prediction {lecture, terms, prompt, modelAnswer, why, alternatives, source,
 * postedIn}` + legacy `prompt {terms, lecture, week, why}` frames → `done {usageId, model, sources}`.
 * No `lecture` (1..200): the next lecture.
 */
export const predictPrompts = (
  body: { classId: string; lecture?: number },
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
) => studySse('/concept-maps/predict', body, onFrame, signal);

/**
 * SSE: `status "…"` ×2 → `result {graph}` (laid out: rect boxes with `bbox`, labelled end-arrows) →
 * `done`. With `mapId` her model answer grounds it and `promptTerms` may be left out. `pageId` /
 * `lecture` scope the grounding to that notebook page's lecture (its notes); `images` are pictures to
 * read the terms from (see {@link referenceWireBody}).
 */
export const referenceMap = (body: ReferenceRequest, onFrame: (frame: SseFrame) => void, signal?: AbortSignal) =>
  studySse('/concept-maps/reference', referenceWireBody(body, !isMockRoute('/concept-maps/reference', 'POST')), onFrame, signal);

/** Whether `/concept-maps/reference` reads the pictures itself (else the client reads their terms first). */
export const referenceReadsImages = () => REFERENCE_READS_IMAGES || isMockRoute('/concept-maps/reference', 'POST');

/** Short-answer questions from this map's relationships, saved to the bank. */
export const makeShortAnswers = (mapId: string) => studyPost<Question[]>(`/concept-maps/${enc(mapId)}/short-answers`);
