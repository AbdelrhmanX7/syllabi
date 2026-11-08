// Board-side trace of the NATIVE-driven pen contact (MainActivity's `kind:'contact'` forwarding — a stylus
// that landed with its button held, which the Samsung WebView never reports to the page). The board runs
// on a different page than «Pen buttons», so the board writes here and that page shows the lines live
// (PEN_NATIVE_TRACE_EVENT) and includes them in its export — the proof of what the native stream did on
// the device: how many MOVE frames/samples arrived per second, and WHY each erase stroke ended.
//
// Written only on edges (contact down, a once-a-second rate line, the stroke end), never per move.

export interface PenNativeTraceEntry {
  at: number;
  type: string;
  text: string;
}

export const PEN_NATIVE_TRACE_EVENT = 'wb-pen-native-trace';

const STORAGE_KEY = 'wb-pen-native-trace';
const TRACE_LIMIT = 200;

let entries: PenNativeTraceEntry[] | null = null;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function load(): PenNativeTraceEntry[] {
  if (entries) return entries;

  entries = [];

  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];

    if (Array.isArray(parsed)) {
      entries = parsed.filter(
        (entry): entry is PenNativeTraceEntry =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as PenNativeTraceEntry).at === 'number' &&
          typeof (entry as PenNativeTraceEntry).type === 'string' &&
          typeof (entry as PenNativeTraceEntry).text === 'string',
      );
    }
  } catch {
    // A corrupt or blocked store starts an empty trace.
  }

  return entries;
}

/** Newest last. */
export function readPenNativeTrace(): PenNativeTraceEntry[] {
  return [...load()];
}

export function recordPenNativeTrace(type: string, text: string, at = Date.now()): void {
  const entry = { at, type, text };
  const next = [...load(), entry].slice(-TRACE_LIMIT);

  entries = next;

  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Diagnostics only — a full or blocked store never breaks input.
  }

  try {
    window.dispatchEvent(new window.CustomEvent(PEN_NATIVE_TRACE_EVENT, { detail: entry }));
  } catch {
    // No window / CustomEvent: the stored trace is still there for the export.
  }
}

export function clearPenNativeTrace(): void {
  entries = [];

  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Counts forwarded MOVE frames (one bridge call each) and the samples they carried (historical batch),
 * and yields one summary line per elapsed second — so a stall or a stream that stops shows as a gap
 * or a falling rate, without a log line per move.
 */
export interface NativeMoveRateMeter {
  /** Note one MOVE frame carrying `samples` points; returns a summary line when a second has elapsed. */
  frame: (samples: number, now: number) => string | null;
  /** The partial window at the end of a contact (null when nothing was counted). */
  flush: (now: number) => string | null;
  reset: (now: number) => void;
}

export function createNativeMoveRateMeter(): NativeMoveRateMeter {
  let windowStart = 0;
  let frames = 0;
  let samples = 0;

  const summary = (now: number): string | null => {
    if (frames === 0) return null;

    const span = Math.max(1, now - windowStart);
    const line = `MOVE ${frames} frames / ${samples} samples in ${span} ms (${Math.round((frames * 1000) / span)}/s)`; // i18n-ignore: diagnostic trace

    windowStart = now;
    frames = 0;
    samples = 0;

    return line;
  };

  return {
    frame: (count, now) => {
      if (windowStart === 0) windowStart = now;

      frames += 1;
      samples += Math.max(1, count);

      return now - windowStart >= 1000 ? summary(now) : null;
    },
    flush: (now) => summary(now),
    reset: (now) => {
      windowStart = now;
      frames = 0;
      samples = 0;
    },
  };
}
