/**
 * Cooperative yielding for the PDF import rasterization loop.
 *
 * pdf.js parses on its web worker, but `page.render()` rasterizes into a canvas
 * and `canvas.toBlob()` + JPEG encoding run on the MAIN thread. When importing a
 * large PDF (hundreds of pages) these bursts freeze the UI unless we deliberately
 * hand control back to the browser between pages so it can paint and process input.
 *
 * The primitives below pick the best-available yield strategy at runtime:
 *   1. `scheduler.yield()`  — modern, lets pending input/paint run before resuming.
 *   2. `MessageChannel`     — a true macrotask, so the event loop drains input/paint.
 *   3. `setTimeout(0)`      — universal fallback (incl. SSR / tests).
 *
 * `requestAnimationFrame` is intentionally NOT used as the primary strategy: its
 * callback fires *before* paint, so it does not reliably let the browser paint or
 * flush queued input during a long import.
 */

export interface YieldSchedulerEnvironment {
  hasMessageChannel: boolean;
  schedulerYield?: (options?: { priority?: 'background' | 'user-blocking' | 'user-visible' }) => Promise<void>;
  setTimeoutFn: (callback: () => void, delayMs: number) => unknown;
}

export type YieldFn = () => Promise<void>;

interface SchedulerGlobal {
  scheduler?: {
    yield?: (options?: { priority?: 'background' | 'user-blocking' | 'user-visible' }) => Promise<void>;
  };
}

/**
 * Inspect the current runtime and describe which yield primitives are available.
 * Kept pure (no side effects) so it is trivially testable with injected globals.
 */
export function resolveYieldSchedulerEnvironment(
  scope: unknown = typeof globalThis === 'undefined' ? undefined : globalThis,
): YieldSchedulerEnvironment {
  const globalScope = (scope ?? {}) as SchedulerGlobal & {
    MessageChannel?: unknown;
    setTimeout?: (callback: () => void, delayMs: number) => unknown;
  };

  const schedulerYield =
    typeof globalScope.scheduler?.yield === 'function'
      ? globalScope.scheduler.yield.bind(globalScope.scheduler)
      : undefined;

  const setTimeoutFn =
    typeof globalScope.setTimeout === 'function'
      ? globalScope.setTimeout.bind(globalScope)
      : (callback: () => void) => {
          callback();

          return 0;
        };

  return {
    hasMessageChannel: typeof globalScope.MessageChannel === 'function',
    schedulerYield,
    setTimeoutFn,
  };
}

/**
 * Build a `yield` function that hands the main thread back to the browser using
 * the best primitive available in the given environment. Pure factory: the same
 * environment always produces the same strategy, which makes it unit-testable.
 */
export function createYieldFn(env: YieldSchedulerEnvironment): YieldFn {
  if (env.schedulerYield) {
    const { schedulerYield } = env;

    return () => schedulerYield({ priority: 'user-visible' });
  }

  if (env.hasMessageChannel && typeof MessageChannel === 'function') {
    return () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();

        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(undefined);
      });
  }

  const { setTimeoutFn } = env;

  return () =>
    new Promise<void>((resolve) => {
      setTimeoutFn(() => resolve(), 0);
    });
}

let cachedYieldFn: YieldFn | null = null;

/**
 * Hand control back to the browser so it can paint and process queued input
 * before the import loop renders the next page. Strategy is resolved once and
 * cached for the lifetime of the page.
 */
export async function yieldToBrowserDuringImport(): Promise<void> {
  if (!cachedYieldFn) {
    cachedYieldFn = createYieldFn(resolveYieldSchedulerEnvironment());
  }

  await cachedYieldFn();
}

/** Test-only: reset the cached strategy so a fresh environment can be resolved. */
export function resetYieldSchedulerForTests(): void {
  cachedYieldFn = null;
}
