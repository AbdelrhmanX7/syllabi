// One typed function per contract endpoint (docs/study-app/CONTRACT.md). Features import these
// instead of spelling paths themselves, so a contract change is one edit here.
import type { SseFrame } from './http';
import type {
  AttemptInput,
  AttemptVerdict,
  CanvasStatus,
  ClassGuide,
  Exam,
  ClassExamResult,
  ClassMeetingTimes,
  ClassExamResultInput,
  ExamRow,
  ExamScheduleEntry,
  Item,
  ItemType,
  Lecture,
  LibraryDoc,
  LibraryDocDetail,
  LibraryHit,
  LibraryKind,
  MasteryTopic,
  McpConnection,
  McpKey,
  ModuleNode,
  Page,
  PageLectureLink,
  PageContentRef,
  PageKind,
  Question,
  SearchResult,
  StudyClass,
  Today,
  VideoTranscript,
  VideoTranscriptUpload,
} from './types';

import type { RulerPreset } from '@/lib/ruler/preset';

import { studyDelete, studyGet, studyPatch, studyPost, studyPut, studyPutRaw, studySse } from './http';

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');

  if (entries.length === 0) return '';

  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&')}`;
}

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ canvas */

export const getCanvasConnection = () => studyGet<CanvasStatus>('/canvas/connection');
export const putCanvasConnection = (body: { baseUrl: string; token: string; expiresAt?: string | null }) =>
  studyPut<CanvasStatus>('/canvas/connection', body);
export const deleteCanvasConnection = () => studyDelete('/canvas/connection');
export const startCanvasSync = () => studyPost<{ started: boolean }>('/canvas/sync');

/* ------------------------------------------------------------------ classes & items */

export const listClasses = (term?: 'all' | string) => studyGet<StudyClass[]>(`/classes${qs({ term })}`);
/** Hide a class from the lists, or recolour it. */
export const patchClass = (
  classId: string,
  patch: { hidden?: boolean; color?: string; meetings?: ClassMeetingTimes | null; name?: string; code?: string },
) => studyPatch<StudyClass>(`/classes/${enc(classId)}`, patch);
/** A class of his own (LeetCode, a side project…) — not from Canvas. `name`/`code` are editable only on these. */
export const createClass = (body: { name: string; code?: string; color?: string }) =>
  studyPost<StudyClass>('/classes', body);
/** Manual classes only. */
export const deleteClass = (classId: string) => studyDelete(`/classes/${enc(classId)}`);
export const getClassModules = (classId: string) => studyGet<ModuleNode[]>(`/classes/${enc(classId)}/modules`);
export const listClassItems = (classId: string, filter: { type?: ItemType; q?: string } = {}) =>
  studyGet<Item[]>(`/classes/${enc(classId)}/items${qs(filter)}`);
export const getItem = (itemId: string) => studyGet<Item>(`/items/${enc(itemId)}`);
export const markItemSeen = (itemId: string) => studyPost<void>(`/items/${enc(itemId)}/seen`);
export const getVideoTranscript = (itemId: string) => studyGet<VideoTranscript>(`/videos/${enc(itemId)}/transcript`);
/** Ask the backend to (re)build the transcript (captions → ASR). Answers 202; the body may be empty. */
export const requeueVideoTranscript = (itemId: string) =>
  studyPost<Partial<VideoTranscript> | undefined>(`/videos/${enc(itemId)}/transcript`);
/** @deprecated use `requeueVideoTranscript`. */
export const requestVideoTranscript = requeueVideoTranscript;
/**
 * Hand the backend captions the tablet fetched from YouTube (`lib/youtube/captions.ts`): YouTube
 * blocks the server's IP, so the device is the only place they can come from. 404 until the
 * backend ships the route — callers then leave it to ASR.
 */
export const uploadVideoTranscript = (itemId: string, body: VideoTranscriptUpload) =>
  studyPut<VideoTranscript>(`/videos/${enc(itemId)}/transcript`, body);

/* ------------------------------------------------------------------ today */

export const getToday = () => studyGet<Today>('/today');

/* ------------------------------------------------------------------ notebook pages */

/** Ruler presets of a notebook page, keyed by board page number (1-based). One place for the paths. */
export const getRulerPresets = (pageId: string) =>
  studyGet<{ rulers: Record<string, RulerPreset> }>(`/pages/${enc(pageId)}/ruler`);
export const putRulerPreset = (pageId: string, page: number, preset: RulerPreset) =>
  studyPut<RulerPreset>(`/pages/${enc(pageId)}/ruler/${page}`, preset);
export const deleteRulerPreset = (pageId: string, page: number) =>
  studyDelete(`/pages/${enc(pageId)}/ruler/${page}`);

export const listPages = (
  filter: { classId?: string | null; itemId?: string | null; week?: number | null; lectureKey?: string | null } = {},
) => studyGet<Page[]>(`/pages${qs(filter)}`);
/** One page record (incl. `markdown`/`text` for typed pages). 404 on an older backend → list and find. */
export const getPage = (pageId: string) => studyGet<Page>(`/pages/${enc(pageId)}`);
export const createPage = (body: {
  classId: string | null;
  itemId?: string | null;
  title: string;
  kind: PageKind;
  week?: number | null;
  moduleId?: string | null;
  lecture?: PageLectureLink | null;
}) => studyPost<Page>('/pages', body);
/** Rename / file a page under a lecture. Leaves the content version alone. */
export const patchPage = (
  pageId: string,
  patch: { title?: string; week?: number | null; moduleId?: string | null; lecture?: PageLectureLink | null },
) => studyPatch<Page>(`/pages/${enc(pageId)}`, patch);
export const getPageContent = (pageId: string) => studyGet<PageContentRef>(`/pages/${enc(pageId)}/content`);
/**
 * One-call save: the board JSON as the raw body, upload + commit server-side → `{ version, expiresAt }`.
 * 409 `{ code: 'STALE_VERSION', currentVersion }` when `baseVersion` is not the server's. 404 while the
 * backend has not shipped the route — callers fall back to the presigned flow below.
 */
export const putPageContentBlob = (pageId: string, baseVersion: number, json: string) =>
  studyPutRaw<{ version: number; expiresAt?: string | null }>(
    `/pages/${enc(pageId)}/content/blob${qs({ baseVersion })}`,
    json,
    'application/json',
  );
/** Presigned flow (B2 CORS blocks it from the browser; kept for the mock and as the 404 fallback). */
export const beginPageContentUpload = (pageId: string, baseVersion: number) =>
  studyPut<{ uploadUrl: string; version: number }>(`/pages/${enc(pageId)}/content`, { baseVersion });
export const commitPageContent = (pageId: string, version: number) =>
  studyPost<Page>(`/pages/${enc(pageId)}/content/commit`, { version });
export const deletePage = (pageId: string) => studyDelete(`/pages/${enc(pageId)}`);
export const putPageOcr = (pageId: string, text: string) => studyPut<void>(`/pages/${enc(pageId)}/ocr`, { text });

/** One board page's uploaded image (what the Study MCP shows Claude). `index` is 0-based. */
export interface PageRender {
  index: number;
  boardPageId?: string | null;
  hash: string;
  version: number;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  renderedAt: string;
  url?: string;
  expiresAt?: string;
}
export interface PageRenders {
  version: number;
  pageCount: number | null;
  renders: PageRender[];
}
export const getPageRenders = (pageId: string) => studyGet<PageRenders>(`/pages/${enc(pageId)}/renders`);
/** Raw image body (webp/png/jpeg ≤ 8 MB); `version` = the content version just committed. */
export const putPageRender = (
  pageId: string,
  index: number,
  image: Blob,
  params: { hash: string; version: number; boardPageId?: string },
) =>
  studyPutRaw<PageRender>(`/pages/${enc(pageId)}/renders/${index}${qs(params)}`, image, image.type || 'image/webp');
/** After every sync: drops renders of deleted pages; `hashes` re-stamps unchanged pages to `version`. */
export const commitPageRenders = (pageId: string, body: { pageCount: number; version?: number; hashes?: string[] }) =>
  studyPost<PageRenders>(`/pages/${enc(pageId)}/renders/commit`, body);

/** Feedback Claude left on a board page through the MCP (`page` is 1-based). */
export interface PageAnnotation {
  id: string;
  page: number;
  markdown: string;
  author: string;
  createdAt: string;
}
export const listPageAnnotations = (pageId: string) => studyGet<PageAnnotation[]>(`/pages/${enc(pageId)}/annotations`);
export const deletePageAnnotation = (pageId: string, annotationId: string) =>
  studyDelete(`/pages/${enc(pageId)}/annotations/${enc(annotationId)}`);

/* ------------------------------------------------------------------ search */

export const search = (q: string) => studyGet<SearchResult>(`/search${qs({ q })}`);

/* ------------------------------------------------------------------ question bank */

export interface QuestionListFilter {
  classId?: string;
  topic?: string;
  due?: boolean;
  source?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export const listQuestions = (filter: QuestionListFilter = {}) =>
  studyGet<{ items: Question[]; next: string | null }>(
    `/questions${qs({ ...filter, due: filter.due ? 1 : undefined })}`,
  );
export const createQuestions = (questions: Partial<Question>[]) => studyPost<Question[]>('/questions', { questions });
export const patchQuestion = (questionId: string, patch: Partial<Question>) =>
  studyPatch<Question>(`/questions/${enc(questionId)}`, patch);
export const deleteQuestion = (questionId: string) => studyDelete(`/questions/${enc(questionId)}`);
export const getReviewNext = (filter: { classId?: string; limit?: number } = {}) =>
  studyGet<Question[]>(`/review/next${qs(filter)}`);
export const getMastery = (classId?: string) => studyGet<{ topics: MasteryTopic[] }>(`/mastery${qs({ classId })}`);

export interface ExtractSource {
  itemId?: string;
  pageId?: string;
  lectureId?: string;
  imagePngB64?: string;
  /** P-CM: a class library doc (stored PDF/image → vision; note or text-only PDF → its text). */
  libraryId?: string;
  pageRange?: string;
}

/** SSE: `question {Question}` per saved question, then `done {count}`. */
export const extractQuestions = (
  body: { classId: string; from: ExtractSource },
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
) => studySse('/questions/extract', body, onFrame, signal);

/** SSE: `reading {text}` → `verdict {AttemptVerdict}` → `done {stats, srs}`. */
export const attemptQuestion = (
  questionId: string,
  body: AttemptInput,
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
) => studySse(`/questions/${enc(questionId)}/attempt`, body, onFrame, signal);

/** SSE: `question {Question}` … `done`. */
export const similarQuestion = (questionId: string, onFrame: (frame: SseFrame) => void, signal?: AbortSignal) =>
  studySse(`/questions/${enc(questionId)}/similar`, {}, onFrame, signal);

/* ------------------------------------------------------------------ mock exams */

export const createExam = (body: {
  classId: string;
  topics?: string[];
  scopeItemIds?: string[];
  count: number;
  minutes: number;
}) => studyPost<Exam>('/exams', body);
export const listExams = (classId?: string) => studyGet<ExamRow[]>(`/exams${qs({ classId })}`);
export const getExam = (examId: string) => studyGet<Exam>(`/exams/${enc(examId)}`);

export interface ExamAnswer {
  questionId: string;
  inkPngB64?: string;
  typed?: string;
  choice?: number;
  code?: string;
}

/** SSE: `graded {questionId, result, steps…}` … `done {score, byTopic}`. */
export const submitExam = (
  examId: string,
  answers: ExamAnswer[],
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
) => studySse(`/exams/${enc(examId)}/submit`, { answers }, onFrame, signal);

/* ------------------------------------------------------------------ lectures */

export const createLecture = (body: { classId: string; title: string; startedAt: string }) =>
  studyPost<{ lecture: Lecture; upload: { uploadId: string } }>('/lectures', body);
export const requestLectureChunkUpload = (lectureId: string, body: { index: number; size: number }) =>
  studyPost<{ uploadUrl: string }>(`/lectures/${enc(lectureId)}/chunks`, body);
/** Raw-body twin of the presigned chunk upload (same CORS reason as `putPageContentBlob`). */
export const putLectureChunkBlob = (lectureId: string, index: number, chunk: Blob) =>
  studyPutRaw<{ index: number; size: number }>(
    `/lectures/${enc(lectureId)}/chunks/${index}`,
    chunk,
    chunk.type || 'application/octet-stream',
  );
export const finishLecture = (lectureId: string, body: { chunks: number; durationSec: number }) =>
  studyPost<Lecture>(`/lectures/${enc(lectureId)}/finish`, body);
export const listLectures = (classId?: string) => studyGet<Lecture[]>(`/lectures${qs({ classId })}`);
export const getLecture = (lectureId: string) => studyGet<Lecture>(`/lectures/${enc(lectureId)}`);

/* ------------------------------------------------------------------ AI helpers */

export interface AiAskBody {
  classId?: string;
  context: { imagePngB64?: string; text?: string; itemId?: string; pageId?: string };
  question: string;
}

/** SSE: `delta {text}` … `done`. */
export const aiAsk = (body: AiAskBody, onFrame: (frame: SseFrame) => void, signal?: AbortSignal) =>
  studySse('/ai/ask', body, onFrame, signal);
/** SSE: `question {Question}` (type 'free') … `done`. */
export const aiFlashcards = (
  body: {
    itemId?: string;
    lectureId?: string;
    pageId?: string;
    libraryId?: string;
    classId?: string;
    count?: number;
    /** The source's title — names the demo mock's deck; the server ignores it. */
    topic?: string;
  },
  onFrame: (frame: SseFrame) => void,
  signal?: AbortSignal,
) => studySse('/ai/flashcards', body, onFrame, signal);

/* ------------------------------------------------------------------ P-CM: library, guide, exams, lab kit */

export const listClassLibrary = (classId: string, filter: { kind?: LibraryKind; week?: number | null } = {}) =>
  studyGet<LibraryDoc[]>(`/classes/${enc(classId)}/library${qs(filter)}`);
/** Keyword search over the class library; needs `q` or `week`. */
export const searchClassLibrary = (classId: string, query: { q?: string; week?: number | null; limit?: number }) =>
  studyGet<LibraryHit[]>(`/classes/${enc(classId)}/library/search${qs(query)}`);
/** One doc: markdown for a note, a signed `url` for a stored PDF/image (`fileStored: false` = text only). */
export const getLibraryDoc = (libraryId: string) => studyGet<LibraryDocDetail>(`/library/${enc(libraryId)}`);

export const getClassGuide = (classId: string) => studyGet<ClassGuide>(`/classes/${enc(classId)}/guide`);
/** Max 20 000 chars. */
export const putClassGuide = (classId: string, markdown: string) =>
  studyPut<ClassGuide>(`/classes/${enc(classId)}/guide`, { markdown });
export const getExamsSchedule = (classId: string) =>
  studyGet<ExamScheduleEntry[]>(`/classes/${enc(classId)}/exams-schedule`);
/** Replaces the whole schedule (max 20 entries). */
export const putExamsSchedule = (classId: string, schedule: ExamScheduleEntry[]) =>
  studyPut<ExamScheduleEntry[]>(`/classes/${enc(classId)}/exams-schedule`, schedule);
export const listExamResults = (classId: string) =>
  studyGet<ClassExamResult[]>(`/classes/${enc(classId)}/exam-results`);
export const createExamResult = (classId: string, body: ClassExamResultInput) =>
  studyPost<ClassExamResult>(`/classes/${enc(classId)}/exam-results`, body);
export const patchExamResult = (classId: string, resultId: string, patch: Partial<ClassExamResultInput>) =>
  studyPatch<ClassExamResult>(`/classes/${enc(classId)}/exam-results/${enc(resultId)}`, patch);

/* ------------------------------------------------------------------ MCP keys */

export const listMcpKeys = () => studyGet<McpKey[]>('/mcp/keys');
/** The BE returns the one-time secret as `key` (the mock as `secret`) — normalised to `secret`. */
export const createMcpKey = async (name: string): Promise<McpKey> => {
  const { key, ...rest } = await studyPost<McpKey & { key?: string }>('/mcp/keys', { name });

  return { ...rest, secret: rest.secret ?? key };
};
export const revokeMcpKey = (keyId: string) => studyDelete(`/mcp/keys/${enc(keyId)}`);
export const listMcpConnections = () => studyGet<McpConnection[]>('/mcp/connections');
export const disconnectMcpConnection = (id: string) => studyDelete(`/mcp/connections/${enc(id)}`);

/** Collects `delta {text}` frames of a streaming endpoint into `onText`; resolves when `done` arrives. */
export function collectDeltas(onText: (text: string) => void): (frame: SseFrame) => void {
  return (frame) => {
    if (frame.event !== 'delta') return;
    const data = frame.data as { text?: string } | string | null;
    const text = typeof data === 'string' ? data : data?.text;

    if (text) onText(text);
  };
}

/** Re-exported so features can type the verdict frames without importing two modules. */
export type { AttemptVerdict };

/** Notebook paper ruling (mm, null = the board's own default) → the drawing profile Claude reads. */
export const patchPaperRuling = (paper: { linedMm: number | null; gridMm: number | null }) =>
  studyPatch<unknown>('/drawing-profile', { paper });
