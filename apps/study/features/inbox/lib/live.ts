// Keeps the inbox current: `GET /inbox/stream` (SSE `item` frames) when the backend has it, polling
// `GET /inbox?since=` every 10 s when it does not. A stream that worked and then dropped is caught up
// with one poll and reopened with backoff; a stream the backend does not serve (404/405/501), or one
// that never opens three times running, hands over to polling for the rest of the session.
import type { InboxItem } from '../types';

export type InboxLiveMode = 'connecting' | 'sse' | 'poll' | 'stopped';

export interface InboxLiveDeps {
  /** Opens the stream; calls `onOpen` once connected and `onItem` per frame; settles when it closes. */
  stream: (handlers: { onOpen: () => void; onItem: (item: InboxItem) => void }, signal: AbortSignal) => Promise<void>;
  poll: (since: string | null) => Promise<InboxItem[]>;
  /** Newest createdAt held — the poll cursor. */
  getSince: () => string | null;
  onItems: (items: InboxItem[]) => void;
  onMode?: (mode: InboxLiveMode) => void;
  /** Injected for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}

export const POLL_MS = 10_000;
const MAX_UNOPENED_FAILURES = 3;
const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Status codes that mean «this backend has no stream route» — no point retrying. */
export function streamUnsupported(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  const code = (error as { code?: string } | null)?.code;

  return status === 404 || status === 405 || status === 501 || code === 'MOCK_NO_ROUTE';
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Starts the loop; returns `stop`. */
export function startInboxLive(deps: InboxLiveDeps): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? POLL_MS;
  const setMode = (mode: InboxLiveMode) => {
    if (!signal.aborted) deps.onMode?.(mode);
  };

  const pollOnce = async () => {
    try {
      const items = await deps.poll(deps.getSince());

      if (!signal.aborted && items.length) deps.onItems(items);
    } catch {
      // offline / server blip — the next tick tries again
    }
  };

  const pollForever = async () => {
    setMode('poll');
    while (!signal.aborted) {
      await sleep(pollMs, signal);
      if (signal.aborted) return;
      await pollOnce();
    }
  };

  const run = async () => {
    let unopened = 0;
    let attempt = 0;

    while (!signal.aborted) {
      let opened = false;

      setMode('connecting');
      try {
        await deps.stream(
          {
            onOpen: () => {
              opened = true;
              attempt = 0;
              unopened = 0;
              setMode('sse');
            },
            onItem: (item) => {
              if (!signal.aborted) deps.onItems([item]);
            },
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) return;
        if (streamUnsupported(error)) {
          await pollForever();

          return;
        }
      }
      if (signal.aborted) return;
      if (!opened) unopened += 1;
      if (unopened >= MAX_UNOPENED_FAILURES) {
        await pollForever();

        return;
      }
      // Whatever landed while the stream was down.
      await pollOnce();
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], signal);
      attempt += 1;
    }
  };

  void run();

  return () => {
    controller.abort();
    deps.onMode?.('stopped');
  };
}
