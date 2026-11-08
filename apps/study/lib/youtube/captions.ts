// YouTube captions, fetched ON THE TABLET. YouTube blocks the production server's IP, so the
// Tauri shell asks YouTube itself (src-tauri/src/youtube_captions.rs) and the app uploads the result
// to the backend (`uploadVideoTranscript`). In a plain browser there is no native command — and the
// innertube endpoints refuse cross-origin calls — so `fetchCaptionsOnDevice` answers null and the
// backend's ASR path takes over.
//
// The json3 parser + segment merge below mirror the Rust implementation line for line, so the TS
// unit tests (`captions.test.ts`) cover the logic that runs on the device.
import type { TranscriptSegment } from '@/lib/api/types';

export type CaptionSegment = TranscriptSegment;

export interface DeviceCaptions {
  segments: CaptionSegment[];
  /** BCP-47 as YouTube reports it (`en`, `en-US`). */
  lang: string;
  durationSec: number | null;
  /** `manual` = uploaded by the channel, `asr` = YouTube's automatic track. */
  kind: 'manual' | 'asr';
}

/* ------------------------------------------------------------------ json3 */

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
  /** 1 on the rolling-caption "append" events of ASR tracks — they repeat text already emitted. */
  aAppend?: number;
}

/** One caption event → one fragment (text with newlines flattened). Blank/append events are dropped. */
export function parseJson3(json: unknown): CaptionSegment[] {
  const events = (json as { events?: Json3Event[] } | null)?.events;

  if (!Array.isArray(events)) return [];
  const fragments: CaptionSegment[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (!event || event.aAppend === 1 || !Array.isArray(event.segs)) continue;
    const text = event.segs
      .map((seg) => seg.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) continue;
    const startMs = typeof event.tStartMs === 'number' ? event.tStartMs : 0;
    let endMs = typeof event.dDurationMs === 'number' ? startMs + event.dDurationMs : NaN;

    if (!Number.isFinite(endMs)) {
      // No duration: run until the next timed event, or two seconds.
      const next = events.slice(index + 1).find((candidate) => typeof candidate?.tStartMs === 'number');

      endMs = next && typeof next.tStartMs === 'number' ? next.tStartMs : startMs + 2_000;
    }

    fragments.push({ start: startMs / 1000, end: Math.max(startMs, endMs) / 1000, text });
  }

  // ASR cues overlap on purpose (each stays on screen while the next rolls in); for a transcript
  // one cue ends where the next begins.
  for (let index = 1; index < fragments.length; index += 1) {
    const previous = fragments[index - 1];
    const nextStart = fragments[index].start;

    if (nextStart > previous.start && previous.end > nextStart) previous.end = nextStart;
  }

  return fragments;
}

export interface MergeOptions {
  /** Close a segment once it runs this long (seconds). */
  maxDurationSec?: number;
  /** …or holds this many characters. */
  maxChars?: number;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

/**
 * Caption events are display cues (a line or a few words each); study wants sentence-sized
 * segments. Fragments are glued together until one ends a sentence, or the glue would exceed the
 * duration/character caps.
 */
export function mergeCaptionSegments(
  fragments: CaptionSegment[],
  { maxDurationSec = 8, maxChars = 160 }: MergeOptions = {},
): CaptionSegment[] {
  const merged: CaptionSegment[] = [];
  let acc: CaptionSegment | null = null;

  for (const fragment of fragments) {
    if (acc === null) {
      acc = { ...fragment };
    } else {
      const glued: string = `${acc.text} ${fragment.text}`;
      const tooLong = fragment.end - acc.start > maxDurationSec || glued.length > maxChars;

      if (tooLong) {
        merged.push(acc);
        acc = { ...fragment };
      } else {
        acc = { start: acc.start, end: Math.max(acc.end, fragment.end), text: glued };
      }
    }

    if (SENTENCE_END.test(acc.text)) {
      merged.push(acc);
      acc = null;
    }
  }

  if (acc !== null) merged.push(acc);

  return merged.map((segment) => ({
    start: Math.round(segment.start * 1000) / 1000,
    end: Math.round(segment.end * 1000) / 1000,
    text: segment.text,
  }));
}

/* ------------------------------------------------------------------ on-device fetch */

interface TauriInvoke {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

function tauriInvoke(): TauriInvoke['invoke'] | null {
  if (typeof window === 'undefined') return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInvoke }).__TAURI_INTERNALS__;

  return internals && typeof internals.invoke === 'function' ? internals.invoke.bind(internals) : null;
}

/** Whether this runtime can fetch captions itself (the Tauri shell). */
export function canFetchCaptionsOnDevice(): boolean {
  return tauriInvoke() !== null;
}

/**
 * Captions for a YouTube video, fetched by the native shell: manual English track first, then the
 * automatic (ASR) English track, then whatever the video has. Null when not in Tauri, when the
 * video has no captions, or when YouTube refused.
 */
export async function fetchCaptionsOnDevice(videoId: string): Promise<DeviceCaptions | null> {
  const invoke = tauriInvoke();

  if (!invoke || !videoId) return null;

  try {
    const result = await invoke<DeviceCaptions | null>('youtube_captions', { videoId });

    if (!result || !Array.isArray(result.segments) || result.segments.length === 0) return null;

    return result;
  } catch {
    return null;
  }
}

/** The body `uploadVideoTranscript` expects, from a device fetch. */
export function toTranscriptUpload(captions: DeviceCaptions): {
  segments: CaptionSegment[];
  source: 'captions';
  lang: string;
  durationSec?: number;
} {
  return {
    segments: captions.segments,
    source: 'captions',
    lang: captions.lang,
    ...(captions.durationSec !== null ? { durationSec: captions.durationSec } : {}),
  };
}
