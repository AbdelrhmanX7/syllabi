/**
 * Pen-ink smoothing for the freehand brushes. Free of any `fabric` import so it can be unit-tested in
 * plain Node.
 *
 * WHY THIS EXISTS. The brushes now receive every coalesced digitizer sample (120–240 Hz), and Fabric's
 * midpoint-quadratic path passes through every one of them. The only filter left was `decimate` (0.4
 * screen px, finalize-only), which is below the digitizer's own noise. Wherever the pen slows down —
 * stroke ends, the bottom of a "3" or "u", the corners of an "N", the base of a "2" — the spacing
 * between samples falls under that noise, so every wobble of the sensor was drawn as ink: little hooks
 * at the ends and wiggles on slow curves.
 *
 * {@link StrokeSmoother} is a per-sample One-Euro filter (Casiez et al., CHI 2012): a low-pass whose
 * cutoff rises with speed. Slow, noisy samples are averaged hard; fast, clean ones pass almost
 * untouched, so a quick stroke keeps its shape and its latency (steady-state lag stays around one
 * screen pixel at every speed). It is CAUSAL and APPEND-ONLY — a point, once emitted, is never revised —
 * which is what keeps the live preview and the committed path identical: both are built from the same
 * filtered points, so there is no "snap" on pen-up.
 *
 * {@link findLiftHookTrim} removes the one artefact a causal filter cannot see coming: the short, sharp
 * hook a nib draws as it lifts (the pen rotates as it leaves the glass and the digitizer keeps
 * tracking it for a sample or two). It is bounded to a few screen pixels and only fires on a turn far
 * sharper than handwriting curvature, so a deliberate flick or a tight curve is never cut.
 */

export interface SmoothPoint {
  x: number;
  y: number;
}

export interface StrokeSmootherOptions {
  /** Cutoff (cycles per sample) when the pen is still. Lower = smoother slow ink, more slow-speed lag. */
  minCutoff: number;
  /** Cutoff added per screen px/sample of speed. Higher = less lag on fast strokes, less smoothing. */
  beta: number;
  /** Cutoff of the speed estimate itself. */
  derivativeCutoff: number;
}

export const DEFAULT_STROKE_SMOOTHER_OPTIONS: StrokeSmootherOptions = {
  minCutoff: 0.04,
  beta: 0.12,
  derivativeCutoff: 0.2,
};

function smoothingFactor(cutoff: number): number {
  // Sampling period of one sample: alpha = 1 / (1 + tau / Te), tau = 1 / (2π fc).
  const tau = 1 / (2 * Math.PI * cutoff);

  return 1 / (1 + tau);
}

export class StrokeSmoother {
  private readonly options: StrokeSmootherOptions;
  private x = 0;
  private y = 0;
  /** Filtered speed, in SCREEN px per sample. */
  private speed = 0;
  private started = false;

  constructor(options: Partial<StrokeSmootherOptions> = {}) {
    this.options = { ...DEFAULT_STROKE_SMOOTHER_OPTIONS, ...options };
  }

  reset(): void {
    this.started = false;
    this.speed = 0;
  }

  /**
   * Filter one raw sample.
   *
   * @param x raw sample, scene units
   * @param y raw sample, scene units
   * @param screenPxPerUnit the canvas zoom: tuning is in SCREEN px (that is where digitizer noise lives),
   *   so the same hand gets the same smoothing at every zoom level.
   */
  next(x: number, y: number, screenPxPerUnit = 1): SmoothPoint {
    if (!this.started || !Number.isFinite(this.x) || !Number.isFinite(this.y)) {
      this.started = true;
      this.x = x;
      this.y = y;
      this.speed = 0;

      return { x, y };
    }

    const scale = Number.isFinite(screenPxPerUnit) && screenPxPerUnit > 0 ? screenPxPerUnit : 1;
    const { minCutoff, beta, derivativeCutoff } = this.options;
    const rawSpeed = Math.hypot(x - this.x, y - this.y) * scale;
    const speedAlpha = smoothingFactor(derivativeCutoff);

    this.speed += speedAlpha * (rawSpeed - this.speed);

    const alpha = smoothingFactor(minCutoff + beta * this.speed);

    this.x += alpha * (x - this.x);
    this.y += alpha * (y - this.y);

    return { x: this.x, y: this.y };
  }
}

export interface LiftHookTrimOptions {
  /** Longest hook that may be trimmed, in screen px. */
  maxHookPx: number;
  /** Length of stroke before the hook used as the reference direction, in screen px. */
  referencePx: number;
  /** Minimum turn (degrees) between the reference direction and the hook to call it a hook. */
  minTurnDeg: number;
}

export const DEFAULT_LIFT_HOOK_TRIM_OPTIONS: LiftHookTrimOptions = {
  // Only a short near-reversal is a lift hook. A turn of 80–110° within 5 px used to be cut too, and
  // that is the flick at the end of a «2» or a «z» — real ink, which then vanished on lift.
  maxHookPx: 4,
  referencePx: 8,
  minTurnDeg: 110,
};

/**
 * Index of the last point to KEEP at the end of `points` (inclusive), or `points.length - 1` when the
 * end has no lift hook.
 */
function hookCutFromEnd(
  points: readonly SmoothPoint[],
  scale: number,
  options: LiftHookTrimOptions,
): number {
  const last = points.length - 1;
  const { maxHookPx, referencePx, minTurnDeg } = options;
  const cosLimit = Math.cos((minTurnDeg * Math.PI) / 180);

  // Walk back from the tip: every candidate vertex `v` whose tail (v → tip) is no longer than maxHookPx.
  // The hook's vertex is the candidate with the SHARPEST turn — not merely the furthest one past the
  // threshold, which would also cut a little of the good stroke before the turn.
  let tailLength = 0;
  let best = last;
  let bestCos = cosLimit;

  for (let v = last - 1; v >= 1; v -= 1) {
    tailLength += Math.hypot(points[v + 1].x - points[v].x, points[v + 1].y - points[v].y) * scale;

    if (tailLength > maxHookPx) break;

    // Reference direction: the stroke over the `referencePx` leading INTO v.
    let referenceLength = 0;
    let r = v;

    while (r > 0 && referenceLength < referencePx) {
      referenceLength += Math.hypot(points[r].x - points[r - 1].x, points[r].y - points[r - 1].y) * scale;
      r -= 1;
    }

    // Not enough stroke before the hook to know which way it was going: never trim.
    if (referenceLength < referencePx) break;

    const refX = points[v].x - points[r].x;
    const refY = points[v].y - points[r].y;
    const hookX = points[last].x - points[v].x;
    const hookY = points[last].y - points[v].y;
    const refNorm = Math.hypot(refX, refY);
    const hookNorm = Math.hypot(hookX, hookY);

    if (refNorm * scale < referencePx / 2 || hookNorm === 0) continue;

    const cos = (refX * hookX + refY * hookY) / (refNorm * hookNorm);

    if (cos <= bestCos) {
      best = v;
      bestCos = cos;
    }
  }

  return best;
}

/**
 * The range of `points` to keep once a lift-off hook is cut, as `[start, end]` inclusive
 * indices. Returns the full range when nothing is trimmed (including every stroke too short to judge,
 * so a dot, the dot of an "i" or a short dash is never touched).
 *
 * @param screenPxPerUnit the canvas zoom, so the bounds are in screen px.
 */
export function findLiftHookTrim(
  points: readonly SmoothPoint[],
  screenPxPerUnit = 1,
  options: Partial<LiftHookTrimOptions> = {},
): [number, number] {
  const resolved = { ...DEFAULT_LIFT_HOOK_TRIM_OPTIONS, ...options };
  const scale = Number.isFinite(screenPxPerUnit) && screenPxPerUnit > 0 ? screenPxPerUnit : 1;
  const full: [number, number] = [0, points.length - 1];

  if (points.length < 5) return full;

  let length = 0;

  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) * scale;
  }

  // The stroke must be clearly longer than both possible hooks plus their reference runs.
  if (length < 2 * (resolved.maxHookPx + resolved.referencePx)) return full;

  // END only. A landing hook is rarer, and the start of a stroke is where real short lead-ins live (the
  // first leg of a ✓, the flag of a "1") — and cutting it would visibly move ink the teacher has been
  // looking at for the whole stroke. `start` stays in the signature so a start pass can be added later.
  const end = hookCutFromEnd(points, scale, resolved);

  if (end < 1) return full;

  return [0, end];
}
