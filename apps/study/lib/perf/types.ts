// Event + payload shapes of the Study perf telemetry (`study-perf/v1`). The full backend contract is
// at the top of `./api.ts`. Keys are short on purpose: a 2000-event ring must fit in ~2 MB, and a
// 60-second batch from a janky session should stay a few KB gzipped.

export const PERF_SCHEMA = 'study-perf/v1';

/** Board context attached to gesture (and LoAF/event) entries — no content, no coordinates. */
export interface PerfBoard {
  tool: string;
  pages: number;
  page: number;
  zoom: number;
  layout: 'paged' | 'continuous' | 'notebook';
  objects?: number;
}

/** One script that ran inside a long animation frame (LoAF `scripts[]`, top N by duration). */
export interface PerfLoafScript {
  /** sourceURL without origin/query, ≤ 120 chars. */
  src: string;
  /** sourceFunctionName (may be empty for anonymous). */
  fn: string;
  /** invoker, e.g. `DIV.onclick`, `Window.requestAnimationFrame`, `Response.json.then`. */
  inv: string;
  /** invokerType: `user-callback` | `event-listener` | `resolve-promise` | `classic-script` | … */
  it: string;
  dur: number;
  /** forcedStyleAndLayoutDuration — layout thrash inside this script. */
  fsl?: number;
}

interface PerfBase {
  /** Epoch ms. */
  t: number;
  /** Route (pathname) at the time. */
  r?: string;
}

/** Long Animation Frame (Chrome 123+). */
export interface PerfLoafEvent extends PerfBase {
  k: 'loaf';
  dur: number;
  /** blockingDuration. */
  blk: number;
  /** renderStart − startTime (time spent before rendering: scripts/tasks). */
  work: number;
  /** styleAndLayoutStart → end of frame (style + layout + paint share). */
  layout: number;
  scripts: PerfLoafScript[];
  tool?: string;
}

/** `longtask` fallback where LoAF is unsupported. */
export interface PerfLongTaskEvent extends PerfBase {
  k: 'longtask';
  dur: number;
  /** attribution container (`iframe`, `window`). */
  attr?: string;
  tool?: string;
}

/** Event Timing entry (interaction latency ≥ 40 ms). */
export interface PerfInteractionEvent extends PerfBase {
  k: 'event';
  /** Event type: `pointerdown`, `click`, `keydown`, … */
  name: string;
  dur: number;
  /** Input delay: processingStart − startTime. */
  delay: number;
  /** Handler time: processingEnd − processingStart. */
  proc: number;
  /** Short target description: `canvas.upper-canvas`, `button[aria-label=…]`. */
  tgt?: string;
  tool?: string;
}

/** One board gesture with jank (smooth gestures are summarised in `gsum`). */
export interface PerfGestureEvent extends PerfBase {
  k: 'gesture';
  kind: 'pen' | 'touch' | 'pinch' | 'mouse' | 'wheel';
  dur: number;
  /** Frames painted (rAF callbacks) during the gesture. */
  frames: number;
  /** Frames missed at 60 Hz. */
  dropped: number;
  /** dropped / (frames + dropped), 0–100. */
  pct: number;
  /** Worst frame interval ms. */
  worst: number;
  /** Frame intervals > 50 ms. */
  slow: number;
  board?: PerfBoard;
}

/**
 * Per-minute rollup: smooth gestures (so every stroke does not cost an event) and the entries the
 * per-kind rate limits skipped. Emitted only for a minute that had either.
 */
export interface PerfGestureSummaryEvent extends PerfBase {
  k: 'gsum';
  /** Smooth gestures per kind. */
  n: Record<string, number>;
  frames: number;
  dropped: number;
  /** Entries skipped by the rate limits, per kind (`loaf`, `event`, `span:autosave:write`, …). */
  sk?: Record<string, number>;
}

export interface PerfErrorEvent extends PerfBase {
  k: 'error';
  msg: string;
  /** Top stack frames (≤ 3 lines, ≤ 400 chars). */
  stack?: string;
  src?: string;
  /** `rejection` for unhandledrejection. */
  how: 'error' | 'rejection';
  /** Repeats of the same message+frame folded into this one since it was recorded. */
  n?: number;
}

/** A line of the board's native pen trace (pen buttons: menu toggles, MOVE rates, stroke ends). */
export interface PerfPenEvent extends PerfBase {
  k: 'pen';
  type: string;
  text: string;
}

/** A renderer span from whiteboard-react's `perfSpan` seam (`autosave:write`, `bg-paint:high`, …). */
export interface PerfSpanEvent extends PerfBase {
  k: 'span';
  label: string;
  dur: number;
  d?: string;
}

/** Route change. */
export interface PerfNavEvent extends PerfBase {
  k: 'nav';
}

/** Heap + DOM size sample (once a minute while visible; heap is Chrome-only). */
export interface PerfMemEvent extends PerfBase {
  k: 'mem';
  /** usedJSHeapSize MB. */
  heap?: number;
  /** jsHeapSizeLimit MB. */
  limit?: number;
  nodes: number;
}

export type PerfEvent =
  | PerfLoafEvent
  | PerfLongTaskEvent
  | PerfInteractionEvent
  | PerfGestureEvent
  | PerfGestureSummaryEvent
  | PerfErrorEvent
  | PerfPenEvent
  | PerfSpanEvent
  | PerfNavEvent
  | PerfMemEvent;

export type PerfEventKind = PerfEvent['k'];

export interface PerfDevice {
  /** Random id persisted per install (localStorage) — the admin read filters by it. */
  id: string;
  ua: string;
  /** navigator.hardwareConcurrency. */
  cores?: number;
  /** navigator.deviceMemory (GB, coarse). */
  mem?: number;
  /** screen.width × height in CSS px. */
  screen: [number, number];
  dpr: number;
  /** `android` (Tauri APK) | `web`. */
  platform: 'android' | 'web';
  /** Chrome major parsed from the UA, when present. */
  chrome?: number;
}

export interface PerfApp {
  /** Study app version (from NEXT_PUBLIC_BUILD_STAMP; '' in dev). */
  version: string;
  sha: string;
  versionCode: number | null;
}

/** What `POST /study/telemetry/perf` receives (JSON, gzip `Content-Encoding` when supported). */
export interface PerfBatch {
  schema: typeof PERF_SCHEMA;
  /** Random per batch — the server dedupes retries by it. */
  batchId: string;
  /** Random per app launch. */
  session: string;
  /** Epoch ms when sent. */
  sentAt: number;
  device: PerfDevice;
  app: PerfApp;
  /** Events evicted from the local ring (cap reached) since the last successful upload. */
  dropped: number;
  events: PerfEvent[];
}
