import type { Item, Lecture, Page, Question, StudyClass, Transcript } from '@/lib/api/types';

import { tagAsFlashcard } from '@/features/flashcards/lib/tag';
import { putLectureChunkBlob } from '@/lib/api/endpoints';
import { studyGet, studyPost, studyPut, studySse } from '@/lib/api/http';
import { MOCK_URL_PREFIX, putToUrl as putToMockUrl } from '@/lib/api/upload';

export const listClasses = () => studyGet<StudyClass[]>('/classes');

/** The live DTO carries more than the v1 type: a failure reason and how many questions it produced. */
export type LectureDto = Lecture & {
  questionCount?: number;
  error?: { code: string; message: string } | null;
  /** A soft problem on a `ready` lecture, e.g. `NO_SPEECH`. */
  warning?: { code: string; message: string } | null;
  createdAt?: string;
  updatedAt?: string;
};

export const listLectures = (classId?: string) =>
  studyGet<LectureDto[]>(classId ? `/lectures?classId=${encodeURIComponent(classId)}` : '/lectures');

export const getLecture = (id: string) => studyGet<LectureDto>(`/lectures/${id}`);

export const createLecture = (body: { classId: string; title: string; startedAt: string }) =>
  studyPost<{ lecture: Lecture; upload: { uploadId: string } }>('/lectures', body);

/** Raw PUT, typed with the lecture's pinned mime (a stored blob may have lost or varied its type). */
export const putLectureChunk = (lectureId: string, index: number, blob: Blob, mime: string) =>
  putLectureChunkBlob(lectureId, index, blob.type === mime ? blob : new Blob([blob], { type: mime }));

/** `202`: the backend runs ASR + summary again; the lecture goes back to `processing`. */
export const retranscribeLecture = (lectureId: string) => studyPost<unknown>(`/lectures/${lectureId}/retranscribe`);

export const finishLecture = (lectureId: string, chunks: number, durationSec: number) =>
  studyPost<unknown>(`/lectures/${lectureId}/finish`, { chunks, durationSec });

export const getItem = (id: string) => studyGet<Item>(`/items/${id}`);

/** `lectureId` is beyond the v1 contract body — sent so the BE can link the page to `Lecture.pageIds`. */
export const createPage = (body: {
  classId: string | null;
  itemId?: string;
  lectureId?: string;
  title: string;
  kind: Page['kind'];
}) => studyPost<Page>('/pages', body);

export const listPages = (query: { classId?: string; itemId?: string }) => {
  const params = new URLSearchParams();

  if (query.classId) params.set('classId', query.classId);
  if (query.itemId) params.set('itemId', query.itemId);

  return studyGet<Page[]>(`/pages?${params.toString()}`);
};

export const getPageContent = (id: string) => studyGet<{ url: string; version: number }>(`/pages/${id}/content`);

export const beginPageContentUpload = (id: string, baseVersion: number) =>
  studyPut<{ uploadUrl: string; version: number }>(`/pages/${id}/content`, { baseVersion });

export const commitPageContent = (id: string, version: number) =>
  studyPost<unknown>(`/pages/${id}/content/commit`, { version });

export type TranscriptStatus = 'none' | 'pending' | 'ready' | 'failed';

export type VideoTranscriptDto = Transcript & {
  itemId?: string;
  transcriptStatus?: TranscriptStatus;
  source?: 'captions' | 'asr' | 'device';
  lang?: string | null;
  durationSec?: number | null;
  error?: { code: string; message: string } | null;
  updatedAt?: string;
};

export const getVideoTranscript = (itemId: string) => studyGet<VideoTranscriptDto>(`/videos/${itemId}/transcript`);

export const queueVideoTranscript = (itemId: string) =>
  studyPost<{ transcriptStatus: TranscriptStatus; alreadyRunning?: boolean }>(`/videos/${itemId}/transcript`);

/** Streams questions extracted from a lecture into the bank; resolves with how many were saved. */
export async function extractLectureQuestions(
  classId: string,
  lectureId: string,
  onQuestion: (question: Question) => void,
  signal?: AbortSignal,
): Promise<number> {
  let count = 0;

  await studySse(
    '/questions/extract',
    { classId, from: { lectureId } },
    (frame) => {
      if (frame.event === 'question') {
        count += 1;
        onQuestion(frame.data as Question);
      } else if (frame.event === 'done') {
        const total = (frame.data as { count?: number } | null)?.count;

        if (typeof total === 'number') count = total;
      }
    },
    signal,
  );

  return count;
}

/** Presigned PUT. Throws on non-2xx so the queue retries. */
export async function putToUrl(url: string, body: Blob | string, contentType: string): Promise<void> {
  // The mock transport hands out `mock://` upload URLs that resolve against its blob store; a real
  // fetch of that scheme throws ("URL scheme 'mock' is not supported") and the chunk never lands.
  if (url.startsWith(MOCK_URL_PREFIX)) return putToMockUrl(url, body, contentType);

  // A stalled PUT on flaky Wi-Fi would otherwise hold the whole queue; give up and let it retry.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(url, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': contentType },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  } finally {
    clearTimeout(timer);
  }
}

export type FlashcardSource = { itemId: string } | { lectureId: string } | { pageId: string };

/** `POST /ai/flashcards` (SSE): cards are saved server-side as bank questions. Resolves with the count. */
export async function generateFlashcards(
  source: FlashcardSource,
  options: { classId?: string; count?: number; onCard?: (question: Question) => void; signal?: AbortSignal } = {},
): Promise<number> {
  let count = 0;

  await studySse(
    '/ai/flashcards',
    { ...source, classId: options.classId, count: options.count ?? 12 },
    (frame) => {
      if (frame.event === 'question') {
        count += 1;
        options.onCard?.(tagAsFlashcard(frame.data as Question));
      } else if (frame.event === 'done') {
        const total = (frame.data as { count?: number } | null)?.count;

        if (typeof total === 'number') count = total;
      }
    },
    options.signal,
  );

  return count;
}
