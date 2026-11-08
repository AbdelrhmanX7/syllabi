// Pure frame-pacing maths for board gestures, plus the small rate limiter the collector uses so a
// janky minute cannot fill the ring with one kind of entry.

/** 60 Hz budget — the Galaxy Tab A6/A7 panels are 60 Hz. */
export const FRAME_BUDGET_MS = 1000 / 60;
/** A frame interval above this is counted as `slow` (≥ 3 frames missed). */
export const SLOW_FRAME_MS = 50;
/** A gesture is janky (recorded on its own) at ≥ this % dropped or any frame ≥ JANK_WORST_MS. */
export const JANK_DROPPED_PCT = 10;
export const JANK_WORST_MS = 50;

export interface FrameStats {
  frames: number;
  dropped: number;
  /** 0–100, one decimal. */
  pct: number;
  worst: number;
  slow: number;
}

/**
 * Running frame-pacing accumulator — one `add` per rAF callback, O(1), no array that grows with a
 * long gesture. An interval of `n` budgets means `n − 1` frames were missed; the half-budget rounding
 * absorbs vsync jitter (a 20 ms interval is not a drop).
 */
export class FrameMeter {
  private frames = 0;
  private dropped = 0;
  private worst = 0;
  private slow = 0;

  constructor(private readonly budget = FRAME_BUDGET_MS) {}

  add(interval: number): void {
    if (!(interval > 0)) return;
    this.frames += 1;
    this.dropped += Math.max(0, Math.round(interval / this.budget) - 1);
    if (interval > this.worst) this.worst = interval;
    if (interval > SLOW_FRAME_MS) this.slow += 1;
  }

  stats(): FrameStats {
    const total = this.frames + this.dropped;

    return {
      frames: this.frames,
      dropped: this.dropped,
      pct: total > 0 ? Math.round((this.dropped / total) * 1000) / 10 : 0,
      worst: Math.round(this.worst * 10) / 10,
      slow: this.slow,
    };
  }
}

/** Stats for a list of rAF intervals (see {@link FrameMeter}). */
export function frameStats(intervals: readonly number[], budget = FRAME_BUDGET_MS): FrameStats {
  const meter = new FrameMeter(budget);

  for (const interval of intervals) meter.add(interval);

  return meter.stats();
}

export function isJanky(stats: FrameStats): boolean {
  return stats.pct >= JANK_DROPPED_PCT || stats.worst >= JANK_WORST_MS;
}

/**
 * Fixed-window rate limiter: at most `limit` hits per `windowMs` per key. Returns false when the hit
 * is over the limit (the caller counts what it skipped).
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now: number): boolean {
    const window = this.windows.get(key);

    if (!window || now - window.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });

      return true;
    }
    if (window.count >= this.limit) return false;
    window.count += 1;

    return true;
  }
}
