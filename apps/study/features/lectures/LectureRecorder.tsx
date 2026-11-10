import type { Lecture, Page } from '@/lib/api/types';
import type { LectureAudioRecorder } from './lib/audio';

import { useCallback, useEffect, useRef, useState } from 'react';

import { NotebookPage } from './components/NotebookPage';
import { holdWakeLock, pickAudioMime, startLectureRecorder } from './lib/audio';
import { createLecture, createPage } from './lib/api';
import { getLectureQueue, useLectureQueueStatus } from './lib/queueInstance';
import { formatClock } from './lib/transcript';

import { useStudyBoardAi } from '@/features/tutor';
import { errorReason, track } from '@/lib/analytics';

export interface LectureRecorderProps {
  classId: string;
  title: string;
  /** Recording stopped and handed to the upload queue. */
  onDone?: (lectureId: string) => void;
  onCancel?: () => void;
  /** The synced notebook page exists (e.g. to file it under a lecture). */
  onPageCreated?: (page: Page) => void;
}

type Phase =
  | { kind: 'starting' }
  | { kind: 'error'; message: string }
  | { kind: 'live'; lecture: Lecture; page: Page }
  | { kind: 'stopping'; lecture: Lecture; page: Page };

/** Lecture ids recording in THIS app session — anything else left `recording` on disk was interrupted. */
export const liveLectureIds = new Set<string>();

/**
 * In-class recording: a lecture notebook page with a recorder bar on top. Audio goes to the durable
 * chunk queue every 30 s; ink is stamped with the recorded time (see `lib/strokeClock.ts`).
 */
export function LectureRecorder({ classId, title, onDone, onCancel, onPageCreated }: LectureRecorderProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const recorderRef = useRef<LectureAudioRecorder | null>(null);
  const lectureIdRef = useRef<string | null>(null);
  const pendingWritesRef = useRef(new Set<Promise<unknown>>());
  const flushPageRef = useRef<(() => Promise<void>) | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);
  const aliveRef = useRef(true);
  const status = useLectureQueueStatus();
  const boardAi = useStudyBoardAi(
    phase.kind === 'live' || phase.kind === 'stopping' ? phase.page.id : null,
    classId,
    // The live lecture: its transcript only exists once processed, so this mostly scopes retrieval.
    () => (lectureIdRef.current ? { lectureId: lectureIdRef.current } : {}),
  );

  const teardown = useCallback(async () => {
    const recorder = recorderRef.current;
    const lectureId = lectureIdRef.current;

    recorderRef.current = null;
    lectureIdRef.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
    const { setStrokeClock } = await import('./lib/strokeClock');

    if (recorder) {
      track('lecture_recorded', { duration_ms: Math.round(recorder.clock.elapsedMs()) });
      await recorder.stop();
      await Promise.allSettled(Array.from(pendingWritesRef.current));
    }
    setStrokeClock(null);
    await flushPageRef.current?.().catch(() => undefined);
    if (lectureId) {
      liveLectureIds.delete(lectureId);
      await getLectureQueue().stop(lectureId, recorder?.clock.elapsedMs());
    }

    return lectureId;
  }, []);

  const start = useCallback(async () => {
    setPhase({ kind: 'starting' });
    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      const startedAt = new Date().toISOString();
      const { lecture } = await createLecture({ classId, title, startedAt });
      const page = await createPage({ classId, lectureId: lecture.id, title, kind: 'lecture' });

      onPageCreated?.(page);
      const queue = getLectureQueue();
      const { installStrokeClock, setStrokeClock } = await import('./lib/strokeClock');

      // The session must be on disk before the first chunk can arrive.
      await queue.startSession({
        lectureId: lecture.id,
        classId,
        title,
        pageId: page.id,
        pageVersion: page.version,
        pageUploaded: false,
        mime: pickAudioMime((mime) => MediaRecorder.isTypeSupported(mime)) ?? 'audio/webm',
        startedAt,
        nextIndex: 0,
        durationMs: 0,
        state: 'recording',
      });
      lectureIdRef.current = lecture.id;
      liveLectureIds.add(lecture.id);
      const recorder = startLectureRecorder(stream, (blob, mime) => {
        const write = queue.enqueue(lecture.id, blob, mime, recorder.clock.elapsedMs()).catch(() => undefined);

        pendingWritesRef.current.add(write);
        void write.finally(() => pendingWritesRef.current.delete(write));
      });

      recorderRef.current = recorder;
      installStrokeClock();
      setStrokeClock(() => recorder.clock.elapsedMs());
      releaseRef.current = holdWakeLock();
      if (!aliveRef.current) {
        await teardown();

        return;
      }
      setPhase({ kind: 'live', lecture, page });
      track('lecture_recording_started');
    } catch (error) {
      stream?.getTracks().forEach((t) => t.stop());
      track('lecture_recording_failed', {
        reason: error instanceof DOMException && error.name === 'NotAllowedError' ? 'mic_denied' : errorReason(error),
      });
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone access was denied. Allow it in Android settings and try again.'
          : error instanceof Error
            ? error.message
            : 'Could not start recording';

      setPhase({ kind: 'error', message });
    }
  }, [classId, title, teardown, onPageCreated]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  // Leaving the screen mid-lecture: wrap up so the audio still uploads.
  useEffect(() => {
    aliveRef.current = true;

    return () => {
      aliveRef.current = false;
      void teardown();
    };
  }, [teardown]);

  // Hand the in-progress chunk to disk whenever the app may be killed.
  useEffect(() => {
    const flush = () => recorderRef.current?.flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // Timer (state, 2 Hz) and level meter (direct style write, every frame).
  useEffect(() => {
    if (phase.kind !== 'live') return;
    const timer = window.setInterval(() => setElapsedMs(recorderRef.current?.clock.elapsedMs() ?? 0), 500);
    let frame = 0;
    const draw = () => {
      const level = recorderRef.current?.level() ?? 0;

      if (meterRef.current) meterRef.current.style.transform = `scaleX(${level.toFixed(3)})`;
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    return () => {
      window.clearInterval(timer);
      cancelAnimationFrame(frame);
    };
  }, [phase.kind]);

  useEffect(() => {
    if (!confirmStop) return;
    const timer = window.setTimeout(() => setConfirmStop(false), 3000);

    return () => window.clearTimeout(timer);
  }, [confirmStop]);

  const togglePause = () => {
    const recorder = recorderRef.current;

    if (!recorder) return;
    if (paused) recorder.resume();
    else recorder.pause();
    setPaused(!paused);
  };

  const stop = async () => {
    if (phase.kind !== 'live') return;
    if (!confirmStop) {
      setConfirmStop(true);

      return;
    }
    setPhase({ kind: 'stopping', lecture: phase.lecture, page: phase.page });
    const lectureId = await teardown();

    if (lectureId) onDone?.(lectureId);
  };

  if (phase.kind === 'starting' || phase.kind === 'error') {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-4 bg-st-bg p-6 text-center'>
        {phase.kind === 'starting' ? (
          <p className='text-sm text-st-muted'>Starting the recording…</p>
        ) : (
          <>
            <p className='max-w-md text-sm text-st-danger'>{phase.message}</p>
            <div className='flex gap-2'>
              <button
                className='h-10 rounded-st border-2 border-st-accent-lip bg-st-accent px-4 text-sm font-medium text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
                type='button'
                onClick={start}
              >
                Try again
              </button>
              {onCancel && (
                <button
                  className='h-10 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-sm shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
                  type='button'
                  onClick={onCancel}
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  const queued = status?.sessions.find((session) => session.lectureId === phase.lecture.id);
  const pendingChunks = status?.pendingChunks ?? 0;

  return (
    <div className='flex h-full min-h-0 flex-col bg-st-bg text-st-fg'>
      <header className='flex items-center gap-4 border-b border-st-line bg-st-surface px-4 py-2'>
        <span
          aria-hidden
          className={`h-3 w-3 shrink-0 rounded-full ${paused ? 'bg-st-muted' : 'animate-pulse bg-st-danger'}`}
        />
        <div className='min-w-0 flex-1'>
          <p className='truncate text-sm font-semibold'>{phase.lecture.title}</p>
          <p className='text-xs text-st-muted'>
            {paused ? 'Paused' : 'Recording'}
            {queued ? ` · ${queued.nextIndex} saved` : ''}
            {pendingChunks > 0 ? ` · ${pendingChunks} waiting to upload` : ''}
            {status?.lastError ? ' · offline, will retry' : ''}
          </p>
        </div>
        <div className='h-2 w-28 overflow-hidden rounded-full bg-st-raised' title='Input level'>
          <div
            ref={meterRef}
            className='h-full w-full origin-left bg-st-ok transition-transform duration-75'
            style={{ transform: 'scaleX(0)' }}
          />
        </div>
        <span className='w-20 text-right font-mono text-lg tabular-nums'>{formatClock(elapsedMs / 1000)}</span>
        <button
          className='h-11 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-sm font-medium hover:bg-st-accent-soft disabled:opacity-50 shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
          disabled={phase.kind !== 'live'}
          type='button'
          onClick={togglePause}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          className='h-11 min-w-28 rounded-st border-2 border-st-danger-lip bg-st-danger px-4 text-sm font-semibold text-st-accent-fg hover:bg-st-danger/90 disabled:opacity-60 shadow-clay-danger transition-transform active:translate-y-[3px] active:shadow-none'
          disabled={phase.kind !== 'live'}
          type='button'
          onClick={stop}
        >
          {phase.kind === 'stopping' ? 'Saving…' : confirmStop ? 'Tap to confirm' : 'Stop'}
        </button>
      </header>
      <div className='min-h-0 flex-1'>
        <NotebookPage
          boardAi={boardAi}
          classId={classId}
          flushRef={flushPageRef}
          pageId={phase.page.id}
          pageTitle={phase.page.title}
        />
      </div>
    </div>
  );
}

export default LectureRecorder;
