import type { QueueStatus } from './chunkQueue';

import { useEffect, useState } from 'react';

import { finishLecture, putLectureChunk } from './api';
import { ChunkUploadQueue, createMemoryChunkStore } from './chunkQueue';
import { createIdbChunkStore } from './idbChunkStore';
import { uploadPageDoc } from './pageContent';

import { errorReason, track } from '@/lib/analytics';

let queue: ChunkUploadQueue | null = null;

/** The app-wide lecture upload queue. Pumps on creation (leftovers from a crash) and on `online`. */
export function getLectureQueue(): ChunkUploadQueue {
  if (queue) return queue;
  const store = typeof indexedDB !== 'undefined' ? createIdbChunkStore() : createMemoryChunkStore();

  queue = new ChunkUploadQueue(store, {
    putChunk: async (lectureId, index, blob, mime) => {
      await putLectureChunk(lectureId, index, blob, mime);
    },
    uploadPage: (session) => uploadPageDoc(session.pageId as string, session.pageVersion),
    finish: async (lectureId, chunks, durationSec) => {
      try {
        await finishLecture(lectureId, chunks, durationSec);
        track('lecture_uploaded', { chunks, duration_s: durationSec });
      } catch (error) {
        track('lecture_upload_failed', { reason: errorReason(error) });
        throw error;
      }
    },
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void queue?.pump());
    void queue.pump();
  }

  return queue;
}

export function useLectureQueueStatus(): QueueStatus | null {
  const [status, setStatus] = useState<QueueStatus | null>(null);

  useEffect(() => getLectureQueue().subscribe(setStatus), []);

  return status;
}
