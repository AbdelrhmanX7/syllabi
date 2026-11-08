/**
 * Pan inertia ("sliding"): the pure physics behind the whiteboard's fling after a pan gesture lifts.
 *
 * Two halves, both free of DOM and Fabric so they are unit-testable in plain Node:
 *   1. RELEASE VELOCITY — from the raw pan samples of the last ~100ms before the lift. A finger that
 *      PAUSED before lifting (no sample within `pauseMs` of the release) gets no fling: the teacher
 *      stopped the board where they wanted it.
 *   2. DECAY — time-based exponential decay, iOS-like: v(t) = v0 · e^(−t/τ). Each frame advances by the
 *      exact integral of that curve over the frame's dt (not Euler), so a dropped frame moves the board
 *      exactly as far as two normal ones would have. Stops once the speed falls under `minSpeed`.
 *
 * Units: px (CSS, viewport) and ms (DOMHighResTimeStamp or performance.now — the caller keeps one clock
 * per use: samples + release on the event clock, decay on the frame clock).
 */

export interface PanSample {
  x: number;
  y: number;
  /** ms, monotonic — PointerEvent.timeStamp. */
  t: number;
}

export interface Velocity {
  /** px/ms */
  vx: number;
  /** px/ms */
  vy: number;
}

export interface ReleaseVelocityOptions {
  /** How far back (ms) from the release the samples count. */
  windowMs: number;
  /** A gap (ms) between the last sample and the release longer than this is a pause → no fling. */
  pauseMs: number;
  /** Speed cap (px/ms); the direction is kept. */
  maxSpeed: number;
  /** Below this speed (px/ms) a release is a stop, not a fling. */
  minSpeed: number;
}

export const FLING_RELEASE_DEFAULTS: ReleaseVelocityOptions = {
  windowMs: 100,
  pauseMs: 60,
  maxSpeed: 4,
  minSpeed: 0.02,
};

/** Append a sample, dropping everything older than `windowMs` before it (plus one for the slope). */
export function pushPanSample(samples: PanSample[], sample: PanSample, windowMs: number): PanSample[] {
  const next = samples.concat(sample);
  const cutoff = sample.t - windowMs;
  let firstKept = 0;

  // Keep the newest sample that is at or before the cutoff too: it is the far end of the slope.
  for (let i = 0; i < next.length; i += 1) {
    if (next[i].t < cutoff) {
      firstKept = i;
    } else {
      break;
    }
  }

  return firstKept > 0 ? next.slice(firstKept) : next;
}

/**
 * The velocity the pan had when it lifted, or null when the release is a stop: no samples, a pause
 * before the lift, a window too short to measure, or a speed under `minSpeed`. The speed is capped.
 */
export function estimateReleaseVelocity(
  samples: readonly PanSample[],
  releaseT: number,
  options: ReleaseVelocityOptions = FLING_RELEASE_DEFAULTS,
): Velocity | null {
  if (samples.length < 2) {
    return null;
  }

  const last = samples[samples.length - 1];

  if (releaseT - last.t > options.pauseMs) {
    return null;
  }

  // The far end of the slope: the oldest sample still inside the window, or the one just before it.
  const cutoff = last.t - options.windowMs;
  let first = samples[0];

  for (let i = samples.length - 2; i >= 0; i -= 1) {
    first = samples[i];

    if (first.t <= cutoff) {
      break;
    }
  }

  const dt = last.t - first.t;

  // Two samples inside a single frame are noise, not a measurement.
  if (dt < 8) {
    return null;
  }

  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);

  if (!Number.isFinite(speed) || speed < options.minSpeed) {
    return null;
  }

  if (speed > options.maxSpeed) {
    const scale = options.maxSpeed / speed;

    vx *= scale;
    vy *= scale;
  }

  return { vx, vy };
}

export interface FlingStep {
  /** Displacement (px) to apply for this frame. */
  dx: number;
  dy: number;
  /** The velocity after this frame. */
  velocity: Velocity;
  /** True once the fling has decayed under `minSpeed` — `dx`/`dy` are this last frame's remainder. */
  done: boolean;
}

/**
 * Advance an exponential-decay fling by `dtMs`. Displacement is the exact integral of v0·e^(−t/τ) over
 * the frame, v0·τ·(1 − e^(−dt/τ)), so it is independent of the frame rate.
 */
export function stepFling(velocity: Velocity, dtMs: number, tauMs: number, minSpeed: number): FlingStep {
  const dt = Math.max(0, dtMs);
  const decay = Math.exp(-dt / tauMs);
  const travel = tauMs * (1 - decay);
  const next = { vx: velocity.vx * decay, vy: velocity.vy * decay };

  return {
    dx: velocity.vx * travel,
    dy: velocity.vy * travel,
    velocity: next,
    done: Math.hypot(next.vx, next.vy) < minSpeed,
  };
}

/** τ for the decay (ms). 325ms ≈ the "normal" deceleration rate of UIScrollView. */
export const FLING_TAU_MS = 325;
