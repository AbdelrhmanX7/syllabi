import type { LectureAudioRecorder } from './audio';

import { useSyncExternalStore } from 'react';

import { holdWakeLock, pickAudioMime, startLectureRecorder } from './audio';
import { createLecture } from './api';
import { getLectureQueue } from './queueInstance';
import { liveLectureIds } from '../LectureRecorder';

import { errorReason, track } from '@/lib/analytics';

/**
 * The class recording started from a notebook's «Record» button, kept OUTSIDE React: the button sits
 * in the board's top bar, which can re-mount (fullscreen, hiding the bar, a resize), and a recording
 * owned by the button would silently end there. Only leaving the notebook (or Stop) ends it.
 *
 * The audio goes to the same safe upload queue as a lecture (a piece every 30 s, survives the app
 * closing) and becomes a lecture with its words under Lectures. It never touches the board.
 */
export interface NotebookRecordingState {
  phase: 'idle' | 'starting' | 'live' | 'stopping';
  paused: boolean;
  /** The notebook it records for. */
  pageId: string | null;
}

let state: NotebookRecordingState = { phase: 'idle', paused: false, pageId: null };
const listeners = new Set<() => void>();
let recorder: LectureAudioRecorder | null = null;
let lectureId: string | null = null;
let releaseWakeLock: (() => void) | null = null;
const pendingWrites = new Set<Promise<unknown>>();
let listening = false;

function set(next: Partial<NotebookRecordingState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useNotebookRecording(): NotebookRecordingState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function notebookRecordingElapsedMs(): number {
  return recorder?.clock.elapsedMs() ?? 0;
}

// Hand the in-progress piece to disk whenever the app may be closed.
function listenForHide() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  const flush = () => recorder?.flush();

  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  window.addEventListener('pagehide', flush);
}

export type StartResult = 'ok' | 'mic-denied' | 'failed';

export async function startNotebookRecording(opts: { classId: string; pageId: string; title: string }): Promise<StartResult> {
  if (state.phase !== 'idle') return 'failed';
  set({ phase: 'starting', paused: false, pageId: opts.pageId });
  let stream: MediaStream | null = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const startedAt = new Date().toISOString();
    const { lecture } = await createLecture({ classId: opts.classId, title: opts.title, startedAt });
    const queue = getLectureQueue();

    // No pageId: the notebook saves itself; the recorder must never push its own copy over it.
    await queue.startSession({
      lectureId: lecture.id,
      classId: opts.classId,
      title: opts.title,
      pageId: null,
      pageVersion: 0,
      pageUploaded: true,
      mime: pickAudioMime((mime) => MediaRecorder.isTypeSupported(mime)) ?? 'audio/webm',
      startedAt,
      nextIndex: 0,
      durationMs: 0,
      state: 'recording',
    });
    lectureId = lecture.id;
    liveLectureIds.add(lecture.id);
    const live = startLectureRecorder(stream, (blob, mime) => {
      const write = queue.enqueue(lecture.id, blob, mime, live.clock.elapsedMs()).catch(() => undefined);

      pendingWrites.add(write);
      void write.finally(() => pendingWrites.delete(write));
    });

    recorder = live;
    releaseWakeLock = holdWakeLock();
    listenForHide();
    set({ phase: 'live' });
    track('lecture_recording_started', { where: 'notebook' });

    return 'ok';
  } catch (error) {
    stream?.getTracks().forEach((t) => t.stop());
    const denied = error instanceof DOMException && error.name === 'NotAllowedError';

    track('lecture_recording_failed', { reason: denied ? 'mic_denied' : errorReason(error), where: 'notebook' });
    set({ phase: 'idle', pageId: null });

    return denied ? 'mic-denied' : 'failed';
  }
}

export function toggleNotebookRecordingPause() {
  if (!recorder || state.phase !== 'live') return;
  if (state.paused) recorder.resume();
  else recorder.pause();
  set({ paused: !state.paused });
}

/** Stop and hand the audio to the upload queue. Resolves true when a recording was saved. */
export async function stopNotebookRecording(): Promise<boolean> {
  if (state.phase !== 'live' && state.phase !== 'starting') return false;
  const live = recorder;
  const id = lectureId;

  set({ phase: 'stopping' });
  recorder = null;
  lectureId = null;
  releaseWakeLock?.();
  releaseWakeLock = null;
  try {
    if (live) {
      track('lecture_recorded', { duration_ms: Math.round(live.clock.elapsedMs()), where: 'notebook' });
      await live.stop();
      await Promise.allSettled(Array.from(pendingWrites));
    }
    if (id) {
      liveLectureIds.delete(id);
      await getLectureQueue().stop(id, live?.clock.elapsedMs());
    }
  } finally {
    set({ phase: 'idle', paused: false, pageId: null });
  }

  return Boolean(id);
}
