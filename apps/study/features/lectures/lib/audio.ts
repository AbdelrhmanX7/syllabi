/** Preferred first: Opus/WebM (what Android WebView records natively), then AAC/MP4. */
export const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
] as const;

export function pickAudioMime(isTypeSupported: (mime: string) => boolean): string | null {
  for (const mime of AUDIO_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // some WebViews throw for unknown types
    }
  }

  return null;
}

/** Recorded-time clock: wall time while running, frozen while paused. */
export function createElapsedClock(now: () => number = () => performance.now()) {
  let accumulated = 0;
  let runningSince: number | null = null;

  return {
    start() {
      accumulated = 0;
      runningSince = now();
    },
    pause() {
      if (runningSince !== null) {
        accumulated += now() - runningSince;
        runningSince = null;
      }
    },
    resume() {
      if (runningSince === null) runningSince = now();
    },
    get running() {
      return runningSince !== null;
    },
    elapsedMs() {
      return accumulated + (runningSince !== null ? now() - runningSince : 0);
    },
  };
}

export type ElapsedClock = ReturnType<typeof createElapsedClock>;

export const CHUNK_MS = 30_000;

export interface LectureAudioRecorder {
  readonly mime: string;
  readonly clock: ElapsedClock;
  pause(): void;
  resume(): void;
  /** Emits the in-progress chunk now (app going to background) so less audio is at risk. */
  flush(): void;
  /** Resolves after the final chunk has been handed to `onChunk`. */
  stop(): Promise<void>;
  /** 0..1 RMS input level. */
  level(): number;
}

/**
 * Starts recording `stream`, handing a blob to `onChunk` every {@link CHUNK_MS} of audio. One
 * MediaRecorder for the whole lecture: its timeslice blobs concatenate back into one valid file.
 */
export function startLectureRecorder(
  stream: MediaStream,
  onChunk: (blob: Blob, mime: string) => void,
): LectureAudioRecorder {
  const mime = pickAudioMime((m) => MediaRecorder.isTypeSupported(m));
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const actualMime = recorder.mimeType || mime || 'audio/webm';
  const clock = createElapsedClock();
  let stopped: (() => void) | null = null;

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) onChunk(event.data, actualMime);
  };
  recorder.onstop = () => stopped?.();

  let analyser: AnalyserNode | null = null;
  let audioContext: AudioContext | null = null;
  let samples: Float32Array | null = null;

  try {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    samples = new Float32Array(analyser.fftSize);
  } catch {
    analyser = null;
  }

  recorder.start(CHUNK_MS);
  clock.start();

  return {
    mime: actualMime,
    clock,
    pause() {
      if (recorder.state === 'recording') {
        recorder.pause();
        clock.pause();
      }
    },
    resume() {
      if (recorder.state === 'paused') {
        recorder.resume();
        clock.resume();
      }
    },
    flush() {
      if (recorder.state === 'recording') recorder.requestData();
    },
    stop() {
      clock.pause();
      if (recorder.state === 'inactive') return Promise.resolve();

      return new Promise<void>((resolve) => {
        stopped = () => {
          stream.getTracks().forEach((track) => track.stop());
          void audioContext?.close().catch(() => undefined);
          resolve();
        };
        recorder.stop();
      });
    },
    level() {
      if (!analyser || !samples || recorder.state !== 'recording') return 0;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;

      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];

      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },
  };
}

/** Keeps the tablet screen on while recording. Re-acquired when the app returns to the foreground. */
export function holdWakeLock(): () => void {
  type Sentinel = { release(): Promise<void> };
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } };
  let sentinel: Sentinel | null = null;
  let released = false;

  const acquire = async () => {
    try {
      if (!released && nav.wakeLock && document.visibilityState === 'visible') {
        sentinel = await nav.wakeLock.request('screen');
      }
    } catch {
      sentinel = null;
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void acquire();
  };

  void acquire();
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisibility);
    void sentinel?.release().catch(() => undefined);
  };
}
