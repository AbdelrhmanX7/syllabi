// The study transport streams through a callback (`studySse(path, body, onFrame)`); the board's AI
// service is an async iterable. This bridges the two: frames queue up as they arrive, the consumer
// pulls them in order, the stream's rejection surfaces at the next pull, and aborting the signal
// ends the iteration quietly.
import type { SseFrame } from '@/lib/api/http';

type Starter = (onFrame: (frame: SseFrame) => void, signal: AbortSignal) => Promise<void>;

export async function* sseIterable(start: Starter, signal: AbortSignal): AsyncGenerator<SseFrame> {
  const queue: SseFrame[] = [];
  let finished = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    const resume = wake;

    wake = null;
    resume?.();
  };

  const onAbort = () => {
    finished = true;
    notify();
  };

  signal.addEventListener('abort', onAbort, { once: true });

  start((frame) => {
    if (finished) return;
    queue.push(frame);
    notify();
  }, signal)
    .then(() => {
      finished = true;
      notify();
    })
    .catch((error: unknown) => {
      failure = error;
      finished = true;
      notify();
    });

  try {
    for (;;) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (signal.aborted) return;
      if (finished) {
        if (failure) throw failure;

        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
