// Pure parsers: PerformanceEntry-shaped objects → compact telemetry events. Typed structurally (not
// against lib.dom's PerformanceLongAnimationFrameTiming, which TS 5.6 does not ship) so they are
// unit-testable with plain objects and tolerate the older shapes a Chrome 138 WebView may report.

import type { PerfErrorEvent, PerfInteractionEvent, PerfLoafEvent, PerfLoafScript, PerfLongTaskEvent } from './types';

/** Scripts kept per LoAF (by duration). */
export const LOAF_MAX_SCRIPTS = 5;
/** Scripts shorter than this are noise in a ≥ 50 ms frame. */
export const LOAF_MIN_SCRIPT_MS = 5;

export interface LoafScriptLike {
  sourceURL?: string;
  sourceFunctionName?: string;
  invoker?: string;
  invokerType?: string;
  duration?: number;
  forcedStyleAndLayoutDuration?: number;
}

export interface LoafEntryLike {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: readonly LoafScriptLike[];
}

export interface LongTaskEntryLike {
  startTime: number;
  duration: number;
  attribution?: readonly { containerType?: string; name?: string }[];
}

export interface EventEntryLike {
  name: string;
  startTime: number;
  duration: number;
  interactionId?: number;
  processingStart?: number;
  processingEnd?: number;
  target?: unknown;
}

const round = (value: number) => Math.round(value * 10) / 10;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * `https://host/_next/static/chunks/pages/notebook-abc123.js?v=1` → `/_next/static/chunks/pages/notebook-abc123.js`.
 * Keeps the path (the chunk name IS the attribution), drops origin, query and hash; ≤ 120 chars,
 * keeping the tail when clipping (the file name matters more than the directory).
 */
export function shortenUrl(url: string | undefined): string {
  if (!url) return '';
  let path = url;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);

  if (scheme) path = path.slice(scheme[0].length) || '/';
  path = path.split(/[?#]/)[0];

  return path.length > 120 ? `…${path.slice(path.length - 119)}` : path;
}

/** `epochOrigin` = performance.timeOrigin (entries carry performance.now()-relative times). */
export function parseLoaf(entry: LoafEntryLike, epochOrigin: number): PerfLoafEvent {
  const scripts: PerfLoafScript[] = (entry.scripts ?? [])
    .filter((script) => (script.duration ?? 0) >= LOAF_MIN_SCRIPT_MS)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, LOAF_MAX_SCRIPTS)
    .map((script) => {
      const out: PerfLoafScript = {
        src: shortenUrl(script.sourceURL),
        fn: clip(script.sourceFunctionName ?? '', 80),
        inv: clip(script.invoker ?? '', 80),
        it: script.invokerType ?? '',
        dur: round(script.duration ?? 0),
      };
      const forced = script.forcedStyleAndLayoutDuration ?? 0;

      if (forced >= 1) out.fsl = round(forced);

      return out;
    });
  const end = entry.startTime + entry.duration;
  const renderStart = entry.renderStart && entry.renderStart > 0 ? entry.renderStart : end;
  const styleStart = entry.styleAndLayoutStart && entry.styleAndLayoutStart > 0 ? entry.styleAndLayoutStart : end;

  return {
    k: 'loaf',
    t: Math.round(epochOrigin + entry.startTime),
    dur: round(entry.duration),
    blk: round(entry.blockingDuration ?? 0),
    work: round(Math.max(0, renderStart - entry.startTime)),
    layout: round(Math.max(0, end - styleStart)),
    scripts,
  };
}

export function parseLongTask(entry: LongTaskEntryLike, epochOrigin: number): PerfLongTaskEvent {
  const attribution = entry.attribution?.[0];
  const out: PerfLongTaskEvent = {
    k: 'longtask',
    t: Math.round(epochOrigin + entry.startTime),
    dur: round(entry.duration),
  };
  const attr = attribution?.containerType || attribution?.name;

  if (attr) out.attr = clip(attr, 40);

  return out;
}

interface ElementLike {
  tagName?: string;
  id?: string;
  className?: unknown;
  getAttribute?: (name: string) => string | null;
}

/** `canvas.upper-canvas`, `button#save`, `button[aria-label=Undo]` — never text content. */
export function describeTarget(target: unknown): string | undefined {
  if (!target || typeof target !== 'object') return undefined;
  const element = target as ElementLike;

  if (typeof element.tagName !== 'string') return undefined;
  let out = element.tagName.toLowerCase();

  if (element.id) out += `#${clip(element.id, 30)}`;
  else {
    const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/) : [];
    // Utility classes (Tailwind) say nothing; keep the first non-utility-looking one.
    const named = classes.find((name) => name && !/[:[\]/]/.test(name) && /-/.test(name) && name.length > 4);

    if (named) out += `.${clip(named, 30)}`;
  }
  const label = element.getAttribute?.('aria-label') || element.getAttribute?.('data-wb-chrome');

  if (label) out += `[${clip(label, 40)}]`;

  return out;
}

/**
 * Event types that only echo an interaction already reported by its pointerdown/up/click: the board's
 * nested listeners fire ~15 identical enter/leave entries per touch (device log 2026-10-12), which
 * filled the 2000-event ring on their own.
 */
const NOISE_EVENT_NAMES = new Set([
  'pointerenter',
  'pointerleave',
  'pointerover',
  'pointerout',
  'mouseenter',
  'mouseleave',
  'mouseover',
  'mouseout',
  'gotpointercapture',
  'lostpointercapture',
]);

/**
 * One observer batch → the entries worth recording: noise types dropped, then one entry per
 * interaction (the longest — that is the latency the user felt) and one per identical
 * (name, startTime, duration) for entries outside an interaction.
 */
export function filterEventEntries<T extends EventEntryLike>(entries: readonly T[]): T[] {
  const byInteraction = new Map<number, T>();
  const seen = new Set<string>();
  const out: T[] = [];

  for (const entry of entries) {
    if (NOISE_EVENT_NAMES.has(entry.name)) continue;
    const id = entry.interactionId ?? 0;

    if (id > 0) {
      const kept = byInteraction.get(id);

      if (!kept) {
        byInteraction.set(id, entry);
        out.push(entry);
      } else if (entry.duration > kept.duration) {
        byInteraction.set(id, entry);
        out[out.indexOf(kept)] = entry;
      }
      continue;
    }
    const key = `${entry.name}|${entry.startTime}|${entry.duration}`;

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  return out;
}

export function parseEventTiming(entry: EventEntryLike, epochOrigin: number): PerfInteractionEvent {
  const processingStart = entry.processingStart ?? entry.startTime;
  const processingEnd = entry.processingEnd ?? processingStart;
  const out: PerfInteractionEvent = {
    k: 'event',
    t: Math.round(epochOrigin + entry.startTime),
    name: entry.name,
    dur: round(entry.duration),
    delay: round(Math.max(0, processingStart - entry.startTime)),
    proc: round(Math.max(0, processingEnd - processingStart)),
  };
  const tgt = describeTarget(entry.target);

  if (tgt) out.tgt = tgt;

  return out;
}

/** Top `lines` frames of a stack, without the message line V8 repeats at the top. */
export function topOfStack(stack: string | undefined, lines = 3): string | undefined {
  if (!stack) return undefined;
  const frames = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') || /@/.test(line))
    .slice(0, lines)
    .map((line) => line.replace(/(https?:\/\/[^/\s)]+)/g, ''));

  return frames.length ? clip(frames.join('\n'), 400) : undefined;
}

export function parseError(
  how: PerfErrorEvent['how'],
  value: unknown,
  now: number,
  source?: { filename?: string; lineno?: number; colno?: number },
): PerfErrorEvent {
  let msg: string;
  let stack: string | undefined;

  if (value instanceof Error || (value && typeof value === 'object' && 'message' in value)) {
    const error = value as { name?: string; message?: unknown; stack?: unknown };

    msg = `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${String(error.message)}`;
    stack = topOfStack(typeof error.stack === 'string' ? error.stack : undefined);
  } else {
    msg = String(value);
  }
  const out: PerfErrorEvent = { k: 'error', t: now, how, msg: clip(msg, 300) };

  if (stack) out.stack = stack;
  if (source?.filename) out.src = `${shortenUrl(source.filename)}:${source.lineno ?? 0}:${source.colno ?? 0}`;

  return out;
}

/** The dedupe key for an error: message + its first stack frame. */
export function errorKey(event: PerfErrorEvent): string {
  return `${event.msg}|${event.stack?.split('\n')[0] ?? event.src ?? ''}`;
}

/** Chrome major version from a UA string (`Chrome/138.0.…`), undefined when absent. */
export function chromeMajor(ua: string): number | undefined {
  const match = /Chrom(?:e|ium)\/(\d+)/.exec(ua);

  return match ? Number(match[1]) : undefined;
}
