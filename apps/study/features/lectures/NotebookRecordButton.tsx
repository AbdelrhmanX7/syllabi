import type { Page } from '@/lib/api/types';
import type { LectureAudioRecorder } from './lib/audio';

import { useCallback, useEffect, useRef, useState } from 'react';
import { addToast } from '@repo/ui';
import { Mic, Pause, Play, Square } from 'lucide-react';

import { holdWakeLock, pickAudioMime, startLectureRecorder } from './lib/audio';
import { createLecture } from './lib/api';
import { getLectureQueue } from './lib/queueInstance';
import { formatClock } from './lib/transcript';
import { liveLectureIds } from './LectureRecorder';

import { ActionButton, BOARD_CHIP_OVERRIDE } from '@/components/ui/primitives';
import { Sheet } from '@/features/inbox/components/Sheet';
import { errorReason, track } from '@/lib/analytics';
import { useClasses } from '@/lib/api/hooks';

type Phase = 'idle' | 'picking' | 'starting' | 'live' | 'stopping';

/**
 * «Record» on a notebook's top bar: records the class through the mic while you keep writing in THIS
 * notebook. The audio goes to the same safe upload queue as a lecture (saved every 30 s, survives the
 * app being closed) and becomes a lecture with its words under Lectures; ink written meanwhile is
 * stamped with the recorded time. The notebook itself is never uploaded by the recorder — the board
 * keeps saving it as always.
 */
export function NotebookRecordButton({ page }: { page: Page }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [controlsOpen, setControlsOpen] = useState(false);
  const recorderRef = useRef<LectureAudioRecorder | null>(null);
  const lectureIdRef = useRef<string | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const pendingWritesRef = useRef(new Set<Promise<unknown>>());
  const aliveRef = useRef(true);
  const classes = useClasses();

  const teardown = useCallback(async () => {
    const recorder = recorderRef.current;
    const lectureId = lectureIdRef.current;

    recorderRef.current = null;
    lectureIdRef.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
    const { setStrokeClock } = await import('./lib/strokeClock');

    if (recorder) {
      track('lecture_recorded', { duration_ms: Math.round(recorder.clock.elapsedMs()), where: 'notebook' });
      await recorder.stop();
      await Promise.allSettled(Array.from(pendingWritesRef.current));
    }
    setStrokeClock(null);
    if (lectureId) {
      liveLectureIds.delete(lectureId);
      await getLectureQueue().stop(lectureId, recorder?.clock.elapsedMs());
    }

    return lectureId;
  }, []);

  const start = useCallback(
    async (classId: string) => {
      setPhase('starting');
      let stream: MediaStream | null = null;

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
        });
        const startedAt = new Date().toISOString();
        const title = `${page.title || 'Notebook'} · recording`;
        const { lecture } = await createLecture({ classId, title, startedAt });
        const queue = getLectureQueue();
        const { installStrokeClock, setStrokeClock } = await import('./lib/strokeClock');

        // No pageId: this notebook saves itself; the recorder must never push its own copy over it.
        await queue.startSession({
          lectureId: lecture.id,
          classId,
          title,
          pageId: null,
          pageVersion: 0,
          pageUploaded: true,
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
        setPaused(false);
        setElapsedMs(0);
        setPhase('live');
        track('lecture_recording_started', { where: 'notebook' });
      } catch (error) {
        stream?.getTracks().forEach((t) => t.stop());
        const denied = error instanceof DOMException && error.name === 'NotAllowedError';

        track('lecture_recording_failed', { reason: denied ? 'mic_denied' : errorReason(error), where: 'notebook' });
        setPhase('idle');
        addToast({
          title: 'Could not start recording',
          description: denied
            ? 'The app is not allowed to use the microphone. Allow it in the tablet settings and try again.'
            : 'Check your internet and try again.',
          color: 'danger',
          timeout: 8000,
        });
      }
    },
    [page.title, teardown],
  );

  // Leaving the notebook mid-class: wrap up so the audio still uploads.
  useEffect(() => {
    aliveRef.current = true;

    return () => {
      aliveRef.current = false;
      void teardown();
    };
  }, [teardown]);

  // Hand the in-progress piece to disk whenever the app may be closed.
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

  useEffect(() => {
    if (phase !== 'live') return;
    const timer = window.setInterval(() => setElapsedMs(recorderRef.current?.clock.elapsedMs() ?? 0), 500);

    return () => window.clearInterval(timer);
  }, [phase]);

  const begin = () => {
    if (page.classId) {
      void start(page.classId);
    } else {
      setPhase('picking');
    }
  };

  const togglePause = () => {
    const recorder = recorderRef.current;

    if (!recorder) return;
    if (paused) recorder.resume();
    else recorder.pause();
    setPaused(!paused);
  };

  const stop = async () => {
    setPhase('stopping');
    await teardown();
    setPhase('idle');
    addToast({
      title: 'Recording saved',
      description: 'The words will be ready under Lectures in a few minutes.',
      color: 'success',
      timeout: 6000,
    });
  };

  if (phase === 'live' || phase === 'stopping') {
    const clock = (
      <>
        <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${paused ? 'bg-st-muted' : 'bg-st-danger animate-pulse'}`} />
        <span className='font-mono tabular-nums'>{formatClock(elapsedMs / 1000)}</span>
      </>
    );

    return (
      <div className='pointer-events-auto flex items-center gap-1' data-testid='notebook-recording'>
        {/* Narrow (a portrait tablet): one timer chip; tap it for Pause and Stop — the bar has no room for three. */}
        <ActionButton
          aria-label={paused ? 'Recording paused: open controls' : 'Recording: open controls'}
          className={`${BOARD_CHIP_OVERRIDE} min-[1000px]:hidden`}
          onClick={() => setControlsOpen(true)}
        >
          {clock}
        </ActionButton>
        <span
          aria-label={paused ? 'Recording paused' : 'Recording'}
          className={`${BOARD_CHIP_OVERRIDE} border-st-line bg-st-surface text-st-fg hidden items-center border-2 min-[1000px]:inline-flex`}
        >
          {clock}
        </span>
        {controlsOpen && (
          <Sheet title={paused ? 'Recording paused' : 'Recording'} onClose={() => setControlsOpen(false)}>
            <div className='flex flex-wrap items-center gap-3'>
              <span className='inline-flex items-center gap-2 text-sm'>{clock}</span>
              <ActionButton disabled={phase !== 'live'} variant='secondary' onClick={togglePause}>
                {paused ? <Play className='h-4 w-4' /> : <Pause className='h-4 w-4' />}
                {paused ? 'Resume' : 'Pause'}
              </ActionButton>
              <ActionButton
                disabled={phase !== 'live'}
                variant='primary'
                onClick={() => {
                  setControlsOpen(false);
                  void stop();
                }}
              >
                <Square className='h-4 w-4' />
                Stop and save
              </ActionButton>
            </div>
          </Sheet>
        )}
        <ActionButton
          aria-label={paused ? 'Resume recording' : 'Pause recording'}
          className={`${BOARD_CHIP_OVERRIDE} hidden min-[1000px]:inline-flex`}
          disabled={phase !== 'live'}
          title={paused ? 'Resume' : 'Pause'}
          onClick={togglePause}
        >
          {paused ? <Play className='h-4 w-4' /> : <Pause className='h-4 w-4' />}
        </ActionButton>
        <ActionButton
          aria-label='Stop recording'
          className={`${BOARD_CHIP_OVERRIDE} hidden min-[1000px]:inline-flex`}
          disabled={phase !== 'live'}
          title='Stop and save'
          onClick={() => void stop()}
        >
          <Square className='text-st-danger h-4 w-4' />
          {phase === 'stopping' ? 'Saving…' : 'Stop'}
        </ActionButton>
      </div>
    );
  }

  const classList = classes.data ?? [];

  return (
    <>
      <ActionButton
        aria-label='Record the class'
        className={BOARD_CHIP_OVERRIDE}
        disabled={phase === 'starting'}
        title='Record the class while you write'
        onClick={begin}
      >
        <Mic className='h-4 w-4' />
        <span className='hidden min-[1000px]:inline'>{phase === 'starting' ? 'Starting…' : 'Record'}</span>
      </ActionButton>
      {phase === 'picking' && (
        <Sheet title='Which class is this?' onClose={() => setPhase('idle')}>
          <div className='flex flex-col'>
            {classList.length === 0 ? (
              <p className='text-st-muted text-sm'>Add a class first, then record.</p>
            ) : (
              classList.map((cls) => (
                <button
                  key={cls.id}
                  className='hover:bg-st-accent-soft flex min-h-11 items-center gap-2 rounded-st px-2 text-left text-sm'
                  type='button'
                  onClick={() => void start(cls.id)}
                >
                  <span aria-hidden className='h-2.5 w-2.5 shrink-0 rounded-sm' style={{ backgroundColor: cls.color }} />
                  <span className='min-w-0 truncate'>{cls.name}</span>
                </button>
              ))
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}

export default NotebookRecordButton;
