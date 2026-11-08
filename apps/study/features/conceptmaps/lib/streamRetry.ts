// One automatic retry for an SSE stream the network cut before it finished (a proxy timeout, a
// dropped tablet connection): Chromium reports that as `TypeError: network error`. A deploy's
// `error {code:'SERVER_RESTARTING'}` frame counts the same. Anything else —
// a server `error` frame, an abort, a stream that already sent `done` — is not retried. Pure.
import { isRetryableStreamError } from '@/lib/api/errors';

export interface StreamRetryOptions {
  signal?: AbortSignal;
  /** True once the stream sent `done` (or its final frame) — a cut after that is not worth a rerun. */
  finished?: () => boolean;
  delayMs?: number;
  /** Called before the retry (status line: «Connection dropped — retrying…»). */
  onRetry?: (error: unknown) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export async function withStreamRetry(run: () => Promise<void>, options: StreamRetryOptions = {}): Promise<void> {
  const { signal, finished = () => false, delayMs = 2000, onRetry, sleep = wait } = options;

  try {
    await run();
  } catch (error) {
    if (signal?.aborted || finished() || !isRetryableStreamError(error)) throw error;
    onRetry?.(error);
    await sleep(delayMs, signal);
    await run();
  }
}
