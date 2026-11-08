// Realistic streaming for the mock: frames arrive with small delays, like the backend's SSE.
import type { SseFrame } from '../http';

export const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));

      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/** Emit a list of frames in order with a pause between them; `done` is appended if missing. */
export async function streamFrames(
  frames: SseFrame[],
  onFrame: (frame: SseFrame) => void,
  { gapMs = 180, signal }: { gapMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  for (const frame of frames) {
    await delay(gapMs, signal);
    onFrame(frame);
    if (frame.event === 'done') return;
  }

  onFrame({ event: 'done', data: null });
}

/** Stream a text as `delta {text}` word-chunks, then `done`. */
export async function streamText(
  text: string,
  onFrame: (frame: SseFrame) => void,
  {
    wordsPerChunk = 3,
    gapMs = 40,
    signal,
    done = null as unknown,
  }: { wordsPerChunk?: number; gapMs?: number; signal?: AbortSignal; done?: unknown } = {},
): Promise<void> {
  const words = text.split(/(\s+)/);
  let chunk = '';
  let count = 0;

  for (const word of words) {
    chunk += word;
    if (/\S/.test(word)) count += 1;

    if (count >= wordsPerChunk) {
      await delay(gapMs, signal);
      onFrame({ event: 'delta', data: { text: chunk } });
      chunk = '';
      count = 0;
    }
  }

  if (chunk) {
    await delay(gapMs, signal);
    onFrame({ event: 'delta', data: { text: chunk } });
  }

  onFrame({ event: 'done', data: done });
}
