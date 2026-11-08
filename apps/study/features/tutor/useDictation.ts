import { useCallback, useEffect, useRef, useState } from 'react';

import { canRecordAudio, speechCtor, transcribeAudio } from './lib/transcribe';

import { pickAudioMime } from '@/features/lectures/lib/audio';
import { isStudyApiError } from '@/lib/api/errors';

export type DictationState = 'idle' | 'recording' | 'transcribing';

const MAX_MS = 120_000;

/** The backend route answered 404/501 once: use the browser engine for the rest of the session. */
let backendMissing = false;

/** Press-to-talk: `start()` records, `stop()` transcribes and hands the text to `onText` (never sends). */
export function useDictation(onText: (text: string) => void, onError: (message: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const [seconds, setSeconds] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);
  const cbRef = useRef({ onText, onError });

  cbRef.current = { onText, onError };

  useEffect(() => {
    if (state !== 'recording') return;
    setSeconds(0);
    const id = window.setInterval(() => setSeconds((value) => value + 1), 1000);

    return () => window.clearInterval(id);
  }, [state]);

  useEffect(() => () => stopRef.current?.(), []);

  const startBrowserEngine = () => {
    const Ctor = speechCtor();

    if (!Ctor) return false;
    const rec = new Ctor();
    let text = '';

    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (event) => {
      text = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join(' ');
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        cbRef.current.onError('Microphone blocked — allow it in Settings.');
      }
    };
    rec.onend = () => {
      stopRef.current = null;
      setState('idle');
      if (text.trim()) cbRef.current.onText(text.trim());
    };
    stopRef.current = () => rec.stop();
    rec.start();
    setState('recording');

    return true;
  };

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    if ((backendMissing || !canRecordAudio()) && startBrowserEngine()) return;

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } });
    } catch {
      cbRef.current.onError('Microphone blocked — allow it in Settings.');

      return;
    }
    const mime = pickAudioMime((m) => MediaRecorder.isTypeSupported(m));
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const timer = window.setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), MAX_MS);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      window.clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
      stopRef.current = null;
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });

      if (blob.size < 800) {
        setState('idle');

        return;
      }
      setState('transcribing');
      try {
        const text = await transcribeAudio(blob);

        if (text) cbRef.current.onText(text);
        else cbRef.current.onError("Couldn't hear anything — try again.");
      } catch (error) {
        if (isStudyApiError(error, 404) || isStudyApiError(error, 501)) backendMissing = true;
        cbRef.current.onError(
          error instanceof Error && error.message
            ? `Transcription failed: ${error.message}`
            : 'Transcription failed — try again.',
        );
      } finally {
        setState('idle');
      }
    };
    stopRef.current = () => recorder.state !== 'inactive' && recorder.stop();
    recorder.start();
    setState('recording');
  }, [state]);

  const stop = useCallback(() => stopRef.current?.(), []);

  return { state, seconds, start, stop };
}
