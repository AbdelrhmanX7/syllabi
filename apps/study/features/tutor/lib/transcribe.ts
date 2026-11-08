// Dictation for the Ask-AI box. Engine order: the backend (`POST /ai/transcribe`, raw audio in, JSON out —
// a self-hosted transcriber) → the browser's SpeechRecognition where it exists. The Android WebView has no
// SpeechRecognition, so on the tablet the backend route is the only engine.
import { pickAudioMime } from '@/features/lectures/lib/audio';
import { studyPostRawBlob } from '@/lib/api/http';

/**
 * BE contract: `POST /ai/transcribe?lang=en`, body = the raw recording (`Content-Type: audio/webm;codecs=opus`
 * or `audio/mp4`, <= 120 s), auth like every study route. Answers `{ text: string }` in English.
 * 404/501 = not shipped yet (the FE then tries the browser engine).
 */
export async function transcribeAudio(blob: Blob): Promise<string> {
  const res = await studyPostRawBlob('/ai/transcribe?lang=en', blob, {
    'Content-Type': blob.type || 'audio/webm',
  });
  const body = (await res.json()) as { text?: unknown };

  return typeof body.text === 'string' ? body.text.trim() : '';
}

type SpeechCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export function speechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };

  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function canRecordAudio(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    pickAudioMime((mime) => MediaRecorder.isTypeSupported(mime)) !== null
  );
}

export const canDictate = () => canRecordAudio() || speechCtor() !== null;
