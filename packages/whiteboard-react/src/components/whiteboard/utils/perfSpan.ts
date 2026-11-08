/**
 * Injectable span recorder — the package's one seam for renderer performance telemetry.
 *
 * The package must not know where a timing goes (the desktop shell files it into the diagnostics
 * bundle; the web build drops it), so the recorder is installed from outside and defaults to a
 * no-op. Wrapping a suspect costs one function call when nothing is installed, so the spans can stay
 * in production code permanently — the whole point is that the evidence is already being collected
 * on the device when a teacher presses «Send diagnostics», not added after the fact.
 */

export type PerfSpanRecorder = (label: string, ms: number, detail?: string) => void;

/** Spans shorter than this are noise on every machine and are not reported. */
export const PERF_SPAN_MIN_MS = 4;

/** Labels with this prefix are feature events (auto-colour: `ink-recognize`, `ink-classify`, …), not
 *  timings: they bypass the duration floor here and the collector's floor, rate limit and truncation. */
export const PERF_FEATURE_PREFIX = 'ink-';

export function isFeatureLabel(label: string): boolean {
  return label.startsWith(PERF_FEATURE_PREFIX);
}

let recorder: PerfSpanRecorder | null = null;

/** Install (or with `null`, remove) the recorder that receives every span ≥ {@link PERF_SPAN_MIN_MS}. */
export function setPerfSpanRecorder(next: PerfSpanRecorder | null): void {
  recorder = next;
}

/** Whether a recorder is installed — lets a hot path skip building a `detail` string. */
export function isPerfSpanRecorderInstalled(): boolean {
  return recorder !== null;
}

function readNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** Report one already-measured duration. Never throws: a broken recorder must not break the editor. */
export function perfMark(label: string, ms: number, detail?: string): void {
  if (recorder === null || !(ms >= PERF_SPAN_MIN_MS || (ms >= 0 && isFeatureLabel(label)))) {
    return;
  }

  try {
    recorder(label, Math.round(ms * 10) / 10, detail);
  } catch {
    // Telemetry is never allowed to become the incident.
  }
}

/**
 * Time `fn` and report it under `label`. A returned promise is measured until it settles, so the same
 * helper wraps a synchronous handler and an async write alike. The result (or rejection) passes
 * through untouched.
 */
export function perfSpan<T>(label: string, fn: () => T, detail?: string): T {
  if (recorder === null) {
    return fn();
  }

  const startedAt = readNow();
  let result: T;

  try {
    result = fn();
  } catch (error) {
    perfMark(label, readNow() - startedAt, detail);
    throw error;
  }

  if (result instanceof Promise) {
    const finish = () => perfMark(label, readNow() - startedAt, detail);

    return result.then(
      (value) => {
        finish();

        return value;
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    ) as T;
  }

  perfMark(label, readNow() - startedAt, detail);

  return result;
}
