/**
 * Developer input trace — a capped, in-memory ring buffer of pen/touch/mouse decisions from the
 * whiteboard input pipeline, so a teacher can reproduce an input bug and export the exact timeline
 * (which pointer, what size/buttons, and WHY it was drawn / suppressed / ignored) for us to analyze.
 *
 * Off by default; enabled via a Settings toggle (persisted in localStorage) so it costs nothing in
 * normal use. The buffer is MODULE-level so it survives SPA route changes (reproduce on the board →
 * open the diagnostics page → export). No PII: only pointer geometry + input-gate booleans.
 */

const STORAGE_KEY = 'whiteboard-input-trace';
// The on-device console-debug flags (`wb-debug-pen` for the pen guards, `whiteboard-debug-input` /
// `wb-debug-input` for the input overlay) ALSO arm this trace, so whatever those flags log to a console
// nobody can read on a tablet is exportable from the touch-probe page as the same JSON timeline.
const DEBUG_FLAG_KEYS = ['wb-debug-pen', 'wb-debug-input', 'whiteboard-debug-input'];
const MAX_ENTRIES = 5000;

export interface InputTraceEntry {
  /** ms since the first recorded entry. */
  t: number;
  kind: 'mouse' | 'pen' | 'touch';
  phase: 'cancel' | 'down' | 'move' | 'up';
  /** What the pipeline decided to do with this event (e.g. 'draw', 'suppressed', 'ignored:pen-active'). */
  decision: string;
  pointerId: number;
  pointerType: string;
  width: number;
  height: number;
  buttons: number;
  hasSeenRealPen: boolean;
  activePen: number;
  activeTouch: number;
}

let enabled = readEnabledFromStorage();
let buffer: InputTraceEntry[] = [];
let startedAt = 0;

function readEnabledFromStorage(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    if (window.localStorage.getItem(STORAGE_KEY) === '1') {
      return true;
    }

    return DEBUG_FLAG_KEYS.some((key) => !!window.localStorage.getItem(key));
  } catch {
    return false;
  }
}

/** Cheap check called on every pointer event — reads a cached module flag, never localStorage. */
export function isInputTraceEnabled(): boolean {
  return enabled;
}

export function setInputTraceEnabled(next: boolean): void {
  enabled = next;

  if (typeof window !== 'undefined') {
    try {
      if (next) {
        window.localStorage.setItem(STORAGE_KEY, '1');
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Best-effort persistence; the in-memory flag still governs this session.
    }
  }
}

/** Re-sync the cached flag from storage (call on mount so a fresh page load reflects the setting). */
export function refreshInputTraceEnabled(): boolean {
  enabled = readEnabledFromStorage();

  return enabled;
}

/** Record one decision. No-op (and allocation-free at the call site is the caller's job) when disabled. */
export function traceInput(entry: Omit<InputTraceEntry, 't'>): void {
  if (!enabled) {
    return;
  }

  const now = typeof performance !== 'undefined' ? performance.now() : 0;

  if (startedAt === 0) {
    startedAt = now;
  }

  buffer.push({ ...entry, t: Math.round(now - startedAt) });

  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

export function getInputTrace(): InputTraceEntry[] {
  return buffer.slice();
}

export function clearInputTrace(): void {
  buffer = [];
  startedAt = 0;
}
