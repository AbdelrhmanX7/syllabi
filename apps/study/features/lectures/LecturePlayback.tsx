import type { WhiteboardPage } from '@repo/whiteboard-core';
import type { Lecture } from '@/lib/api/types';
import type { LectureDto } from './lib/api';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ExtractQuestionsButton, FlashcardsButton } from './components/ExtractQuestionsButton';
import { InkPlayer } from './components/InkPlayer';
import { SummaryCard, TranscriptPanel } from './components/TranscriptPanel';
import { getLecture, retranscribeLecture } from './lib/api';
import { loadPageDoc } from './lib/pageContent';
import { formatClock } from './lib/transcript';

import { AskTutorButton } from '@/features/tutor/components/AskTutorButton';
import { useSeekTarget } from '@/features/tutor/lib/seek';
import { resolveMediaUrl } from '@/lib/api/upload';
import { useVoiceAiEnabled } from '@/hooks/useAiEnabled';

export interface LecturePlaybackProps {
  lectureId: string;
  onBack?: () => void;
  /** Start here once the audio is ready — `/lectures/?id=&t=` from a tutor transcript chip. */
  startAtSec?: number;
}

const SPEEDS = [1, 1.25, 1.5, 2];
const PROCESSING_POLL_MS = 5_000;
const UPLOAD_POLL_MS = 15_000;

/** What a failed lecture tells the student — the backend's codes in plain words. */
export const isNoSpeech = (lecture: LectureDto) =>
  lecture.warning?.code === 'NO_SPEECH' || lecture.error?.code === 'NO_SPEECH';

export function lectureFailureText(lecture: LectureDto): string {
  if (lecture.error?.code === 'NO_SPEECH') return 'No speech detected in this recording.';

  return lecture.error?.message
    ? `Processing failed: ${lecture.error.message}. The audio and notes are kept.`
    : 'Processing failed. The audio and notes are kept.';
}

export const LECTURE_STATUS_LABEL: Record<Lecture['status'], string> = {
  recording: 'Recording',
  uploading: 'Uploading',
  processing: 'Transcribing',
  ready: 'Ready',
  failed: 'Failed',
};

/** Replays a lecture: audio drives the notebook ink and the transcript; both seek the audio back. */
export function LecturePlayback({ lectureId, onBack, startAtSec }: LecturePlaybackProps) {
  const voiceOn = useVoiceAiEnabled();
  const [lecture, setLecture] = useState<LectureDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<WhiteboardPage[] | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [follow, setFollow] = useState(true);
  const [tab, setTab] = useState<'transcript' | 'summary'>('transcript');
  const [retranscribing, setRetranscribing] = useState(false);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const resumeAtMsRef = useRef(startAtSec && startAtSec > 0 ? startAtSec * 1000 : 0);

  const refresh = useCallback(async () => {
    try {
      setLecture(await getLecture(lectureId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the lecture');
    }
  }, [lectureId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Uploading / transcribing: keep checking until it settles.
  useEffect(() => {
    if (!lecture || lecture.status === 'ready' || lecture.status === 'failed') return;
    const timer = window.setTimeout(refresh, lecture.status === 'processing' ? PROCESSING_POLL_MS : UPLOAD_POLL_MS);

    return () => window.clearTimeout(timer);
  }, [lecture, refresh]);

  // Signed URLs change on every fetch; swap the source only when there is none or it expired.
  useEffect(() => {
    if (lecture?.audio?.url && !audioSrc) setAudioSrc(resolveMediaUrl(lecture.audio.url));
  }, [lecture, audioSrc]);

  const onAudioError = () => {
    resumeAtMsRef.current = currentMs;
    setAudioSrc(null);
    void refresh();
  };

  const pageKey = lecture?.pageIds.join(',') ?? '';

  useEffect(() => {
    if (!pageKey) {
      setPages(lecture ? [] : null);

      return;
    }
    let cancelled = false;

    void Promise.all(pageKey.split(',').map(loadPageDoc)).then((docs) => {
      if (!cancelled) setPages(docs.flatMap((doc) => doc?.pages ?? []));
    });

    return () => {
      cancelled = true;
    };
  }, [pageKey]);

  // Smooth playhead while playing (timeupdate is only ~4 Hz).
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;

      if (audio) setCurrentMs(audio.currentTime * 1000);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  const seekMs = useCallback((ms: number) => {
    const audio = audioRef.current;

    setCurrentMs(ms);
    if (!audio) return;
    audio.currentTime = ms / 1000;
    if (audio.paused) void audio.play().catch(() => undefined);
  }, []);

  // A tutor transcript chip for THIS lecture, clicked in the Ask sheet on top of it.
  useSeekTarget(lectureId, (sec) => seekMs(sec * 1000));

  const togglePlay = () => {
    const audio = audioRef.current;

    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  };

  if (error && !lecture) {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 p-6 text-center'>
        <p className='text-sm text-st-danger'>{error}</p>
        <button
          className='h-10 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-sm shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
          type='button'
          onClick={refresh}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!lecture)
    return <div className='flex h-full items-center justify-center text-sm text-st-muted'>Loading lecture…</div>;

  const audio = lecture.audio;
  const totalMs = durationMs || lecture.durationSec * 1000;
  const segments = lecture.transcript?.segments ?? [];
  const hasTranscript = segments.length > 0;
  const notReady = lecture.status === 'ready' && hasTranscript ? null : 'Available once the transcript is ready';
  const canRetranscribe = voiceOn && (lecture.status === 'failed' || (lecture.status === 'ready' && !hasTranscript));
  const retranscribe = async () => {
    setRetranscribing(true);
    try {
      await retranscribeLecture(lecture.id);
      setLecture({ ...lecture, status: 'processing', error: null, warning: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start transcription');
    } finally {
      setRetranscribing(false);
    }
  };

  return (
    <div className='flex h-full min-h-0 flex-col bg-st-bg text-st-fg'>
      <header className='flex flex-wrap items-center gap-3 border-b border-st-line px-4 py-3'>
        {onBack && (
          <button
            className='h-10 rounded-md px-3 text-sm hover:bg-st-raised'
            type='button'
            onClick={onBack}
          >
            Back
          </button>
        )}
        <div className='min-w-[12rem] flex-1'>
          <h1 className='text-base font-semibold [overflow-wrap:anywhere]'>{lecture.title}</h1>
          <p className='text-xs text-st-muted'>
            {new Date(lecture.startedAt).toLocaleString()} · {formatClock(lecture.durationSec)} ·{' '}
            {LECTURE_STATUS_LABEL[lecture.status]}
            {lecture.questionCount ? ` · ${lecture.questionCount} questions in bank` : ''}
            {isNoSpeech(lecture) ? ' · No speech detected' : ''}
          </p>
          {error && <p className='text-xs text-st-danger'>{error}</p>}
        </div>
        <label className='flex items-center gap-2 text-sm text-st-muted'>
          <input checked={follow} type='checkbox' onChange={(event) => setFollow(event.target.checked)} />
          Follow pages
        </label>
        {canRetranscribe && (
          <button
            className='h-10 rounded-st border-2 border-st-clay-edge bg-st-surface px-4 text-sm font-medium hover:bg-st-accent-soft disabled:opacity-60 shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
            disabled={retranscribing}
            type='button'
            onClick={retranscribe}
          >
            {retranscribing ? 'Starting…' : 'Transcribe again'}
          </button>
        )}
        <AskTutorButton
          classId={lecture.classId}
          context={{ lectureId: lecture.id }}
          contextLabel={lecture.title}
          label='Ask about this lecture'
        />
        <FlashcardsButton classId={lecture.classId} disabledReason={notReady} source={{ lectureId: lecture.id }} />
        <ExtractQuestionsButton classId={lecture.classId} disabledReason={notReady} lectureId={lecture.id} />
      </header>

      <div className='flex min-h-0 flex-1 flex-col md:flex-row'>
        <div className='min-h-0 min-w-0 flex-1'>
          {pages === null ? (
            <div className='flex h-full items-center justify-center text-sm text-st-muted'>Loading notes…</div>
          ) : pages.length === 0 ? (
            <div className='flex h-full items-center justify-center text-sm text-st-muted'>
              No notes were written in this lecture.
            </div>
          ) : (
            <InkPlayer
              currentMs={audio ? currentMs : null}
              follow={follow && playing}
              pages={pages}
              onSeekMs={seekMs}
            />
          )}
        </div>
        <aside className='flex max-h-[45vh] w-full shrink-0 flex-col border-t border-st-line bg-st-surface md:max-h-none md:w-[400px] md:border-l md:border-t-0'>
          <div className='flex gap-1 border-b border-st-line px-3 pt-2'>
            {(['transcript', 'summary'] as const).map((key) => (
              <button
                key={key}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize ${
                  tab === key
                    ? 'border-st-clay-edge text-st-fg'
                    : 'border-transparent text-st-muted hover:text-st-fg'
                }`}
                type='button'
                onClick={() => setTab(key)}
              >
                {key}
              </button>
            ))}
          </div>
          <div className='min-h-0 flex-1 overflow-y-auto'>
            {lecture.status !== 'ready' ? (
              <p className='p-4 text-sm text-st-muted'>
                {lecture.status === 'failed'
                  ? lectureFailureText(lecture)
                  : 'The transcript and summary appear here once the lecture is processed.'}
              </p>
            ) : !hasTranscript ? (
              <p className='p-4 text-sm text-st-muted'>
                {isNoSpeech(lecture) ? 'No speech detected in this recording.' : 'This lecture has no transcript.'}
              </p>
            ) : tab === 'transcript' ? (
              <TranscriptPanel currentSec={currentMs / 1000} segments={segments} onSeek={(sec) => seekMs(sec * 1000)} />
            ) : (
              <SummaryCard keyPoints={lecture.keyPoints} summary={lecture.summary} />
            )}
          </div>
        </aside>
      </div>

      <footer className='flex items-center gap-3 border-t border-st-line bg-st-surface px-4 py-3'>
        {audio ? (
          <>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the transcript panel is the caption track */}
            <audio
              ref={audioRef}
              preload='metadata'
              src={audioSrc ?? undefined}
              onEnded={() => setPlaying(false)}
              onError={onAudioError}
              onLoadedMetadata={(event) => {
                const d = event.currentTarget.duration;

                if (Number.isFinite(d)) setDurationMs(d * 1000);
                event.currentTarget.playbackRate = speed;
                if (resumeAtMsRef.current > 0) {
                  event.currentTarget.currentTime = resumeAtMsRef.current / 1000;
                  resumeAtMsRef.current = 0;
                }
              }}
              onPause={() => setPlaying(false)}
              onPlay={() => setPlaying(true)}
              onTimeUpdate={(event) => !playing && setCurrentMs(event.currentTarget.currentTime * 1000)}
            />
            <button
              className='h-10 w-20 rounded-st border-2 border-st-accent-lip bg-st-accent text-sm font-medium text-st-accent-fg shadow-clay-accent transition-transform active:translate-y-[3px] active:shadow-none'
              type='button'
              onClick={togglePlay}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              className='h-10 rounded-md px-2 text-sm tabular-nums hover:bg-st-raised'
              type='button'
              onClick={() => seekMs(Math.max(0, currentMs - 10_000))}
            >
              −10s
            </button>
            <button
              className='h-10 rounded-md px-2 text-sm tabular-nums hover:bg-st-raised'
              type='button'
              onClick={() => seekMs(currentMs + 10_000)}
            >
              +10s
            </button>
            <span className='w-14 text-right text-xs tabular-nums text-st-muted'>{formatClock(currentMs / 1000)}</span>
            <input
              aria-label='Seek'
              className='min-w-0 flex-1 accent-st-ink'
              max={Math.max(totalMs, 1)}
              min={0}
              step={250}
              type='range'
              value={Math.min(currentMs, totalMs)}
              onChange={(event) => seekMs(Number(event.target.value))}
            />
            <span className='w-14 text-xs tabular-nums text-st-muted'>{formatClock(totalMs / 1000)}</span>
            <button
              className='h-10 w-14 rounded-st border-2 border-st-clay-edge bg-st-surface text-sm tabular-nums shadow-clay transition-transform active:translate-y-[3px] active:shadow-none'
              type='button'
              onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
            >
              {speed}×
            </button>
          </>
        ) : (
          <p className='text-sm text-st-muted'>Audio becomes playable once the upload is processed.</p>
        )}
      </footer>
    </div>
  );
}

export default LecturePlayback;
