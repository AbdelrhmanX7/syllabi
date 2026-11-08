// What the collector folds instead of recording one by one: smooth gestures, rate-limited skips and
// repeated errors. Pure; `drain(now)` turns a minute's worth into at most a few events.

import type { FrameStats } from './frames';
import type { PerfErrorEvent, PerfEvent, PerfGestureSummaryEvent } from './types';

import { errorKey } from './parse';

/** Distinct error keys remembered per session (later new ones are still recorded, just not deduped). */
export const MAX_ERROR_KEYS = 100;

export class PerfRollup {
  private gestures: Record<string, number> = {};
  private frames = 0;
  private dropped = 0;
  private skipped: Record<string, number> = {};
  private errors = new Map<string, { event: PerfErrorEvent; repeats: number }>();

  smoothGesture(kind: string, stats: FrameStats): void {
    this.gestures[kind] = (this.gestures[kind] ?? 0) + 1;
    this.frames += stats.frames;
    this.dropped += stats.dropped;
  }

  skip(kind: string): void {
    this.skipped[kind] = (this.skipped[kind] ?? 0) + 1;
  }

  /** Returns the event to record now, or null when it is a repeat folded into the next drain. */
  error(event: PerfErrorEvent): PerfErrorEvent | null {
    const key = errorKey(event);
    const seen = this.errors.get(key);

    if (seen) {
      seen.repeats += 1;

      return null;
    }
    if (this.errors.size < MAX_ERROR_KEYS) this.errors.set(key, { event, repeats: 0 });

    return event;
  }

  drain(now: number): PerfEvent[] {
    const out: PerfEvent[] = [];
    const hasGestures = Object.keys(this.gestures).length > 0;
    const hasSkips = Object.keys(this.skipped).length > 0;

    if (hasGestures || hasSkips) {
      const summary: PerfGestureSummaryEvent = {
        k: 'gsum',
        t: now,
        n: this.gestures,
        frames: this.frames,
        dropped: this.dropped,
      };

      if (hasSkips) summary.sk = this.skipped;
      out.push(summary);
    }
    this.errors.forEach((entry) => {
      if (entry.repeats === 0) return;
      out.push({ ...entry.event, t: now, n: entry.repeats });
      entry.repeats = 0;
    });
    this.gestures = {};
    this.frames = 0;
    this.dropped = 0;
    this.skipped = {};

    return out;
  }
}
