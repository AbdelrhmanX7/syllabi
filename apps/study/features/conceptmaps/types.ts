// Concept Map Studio — this feature's own types. Mirrors the backend contract for `/concept-maps…`
// (lead's handoff, 2026-10-05); `Question` comes from the shared contract types.
import type { Provenance, SourceRef } from './lib/provenance';

export type ConceptMapSource = 'import' | 'canvas' | 'practice';

/** Where `score` comes from: her Canvas grade, or a score he entered by hand (`PATCH /concept-maps/:id`). */
export type ConceptMapScoreSource = 'canvas' | 'manual';

export interface ConceptMapSubmission {
  imageUrl: string | null;
  /** The map as text (node → arrow label → node), for reading it without the picture. */
  transcription: string | null;
}

export interface ConceptMapInstructor {
  comment: string | null;
  modelAnswer: string | null;
}

/**
 * One assigned (or practice) concept map. `score` is null until graded (and for imported maps she
 * has not scored). `number` / `week` / `lecture` are null on a custom practice map or a Canvas
 * assignment the import does not know yet.
 */
export interface ConceptMapRecord {
  id: string;
  classId: string;
  number: number | null;
  week: number | null;
  lecture: string | null;
  dueAt: string | null;
  promptTerms: string[];
  submission: ConceptMapSubmission | null;
  instructor: ConceptMapInstructor | null;
  score: number | null;
  maxScore: number;
  scoreSource: ConceptMapScoreSource | null;
  /** The last grade Canvas reported (kept when he overrides it). */
  canvasScore: number | null;
  manualScore: number | null;
  /** Why the score changed under him, e.g. «Canvas changed the score to 9 — it replaced your manual 8.5.» */
  scoreNote: string | null;
  /** The synced Canvas assignment («Concept Map N») — its item page. */
  canvasItemId: string | null;
  source: ConceptMapSource;
  /** The instructor named this map as exam material (beyond the contract; absent = false). */
  examReview?: boolean;
}

/* ------------------------------------------------------------------ grading (SSE) */

/** `concept` = a term or idea; `note` = a definition / example sentence hanging off a concept. */
export type ReadNodeKind = 'concept' | 'note';

export interface ReadNode {
  id: string;
  label: string;
  /** Absent = concept (older attempts). */
  kind?: ReadNodeKind;
}

export interface ReadEdge {
  from: string;
  to: string;
  /** Null / empty = an unlabeled arrow. */
  label: string | null;
}

/** `reading` frame: what the model read off the picture. */
export interface MapReading {
  nodes: ReadNode[];
  edges: ReadEdge[];
}

/** `criterion` frame — one of the rubric's five rows. */
export interface Criterion {
  name: string;
  score: number;
  max: number;
  note: string;
}

export interface WrongLink {
  from: string;
  to: string;
  label: string | null;
  why: string;
}

/** `verdict` frame. */
export interface GradeVerdict {
  /** Calibrated to her scale — the predicted grade. */
  score: number;
  /** The plain criteria sum before calibration (absent on older attempts). */
  rawScore: number | null;
  max: number;
  missingTerms: string[];
  unlabeledArrows: number;
  wrongLinks: WrongLink[];
  suggestions: string[];
}

/** With `mapId` the attempt (and its picture) is saved and `promptTerms` may be left out. */
export interface GradeRequest {
  classId: string;
  promptTerms?: string[];
  imagePngB64: string;
  mapId?: string;
}

/** `GET /concept-maps/:id/attempts`, newest first. */
export interface MapAttempt {
  id: string;
  mapId?: string;
  promptTerms?: string[];
  createdAt: string | null;
  imageUrl: string | null;
  verdict: GradeVerdict;
  score?: number | null;
  reading?: MapReading;
  criteria?: Criterion[];
  /** Raw DTO fields — absent on attempts saved before the backend recorded them. */
  model?: string | null;
  sources?: unknown;
  /** `model` + `sources` parsed by `normalizeAttempt`. */
  provenance?: Provenance;
}

/* ------------------------------------------------------------------ predict / reference */

export interface PredictionLecture {
  number: number | null;
  title: string;
  date: string | null;
  week: number | null;
}

export interface PredictedTerm {
  term: string;
  /** 0..1 */
  p: number;
}

export interface PredictionAlternative {
  prompt: string[];
  why: string;
}

/** `prediction` frame of `POST /concept-maps/predict`. */
export interface Prediction {
  lecture: PredictionLecture;
  /** Ranked, most likely first. */
  terms: PredictedTerm[];
  /** The most likely prompt (term list). */
  prompt: string[];
  modelAnswer: string | null;
  why: string;
  alternatives: PredictionAlternative[];
  /** `posted` = she already put the terms up (`postedIn` says where). */
  source: 'predicted' | 'posted';
  postedIn: SourceRef[];
}

/** Legacy `prompt` frame of `/concept-maps/predict` (still sent alongside `prediction`). */
export interface PredictedPrompt {
  terms: string[];
  lecture: string;
  week: number;
  why: string;
}

export interface ReferenceNode {
  id: string;
  text: string;
  level?: number;
  /** `[x, y, w, h]` from the backend's layout (the whiteboard generate payload); drawn as-is when every node has one. */
  bbox?: [number, number, number, number];
  color?: string;
}

export interface ReferenceEdge {
  from: string;
  to: string;
  label?: string;
}

/** A picture the terms are read from: base64 JPEG (no `data:` prefix), long edge ≤ 1600 px. */
export interface ReferenceImage {
  jpegB64: string;
  width: number;
  height: number;
  /** `phone` = sent from the phone inbox; `page` = any other picture on the notebook page. */
  origin: 'phone' | 'page';
  /** The phone-inbox item it came from (the backend may fetch the original instead). */
  inboxItemId?: string;
}

/** `POST /concept-maps/reference`. Live today: `classId`, `promptTerms`, `mapId`; the rest is the spec'd extension. */
export interface ReferenceRequest {
  classId: string;
  promptTerms?: string[];
  mapId?: string;
  /** The notebook page the map is for — its lecture (and its own ink) grounds the explanations. */
  pageId?: string;
  /** That page's lecture, when the device knows it and the backend may not. */
  lecture?: { number: number | null; key: string | null; date: string | null; week: number | null };
  /** Pictures to read the concept terms from (1..4); with them `promptTerms` may be left out. */
  images?: ReferenceImage[];
}

/** The whiteboard's concept-map graph (`result {graph}` frame), reduced to what we draw. */
export interface ReferenceMap {
  title?: string;
  nodes: ReferenceNode[];
  edges: ReferenceEdge[];
  /** What the `result` frame says it was drawn from (absent on older backends). */
  provenance?: Provenance;
}
