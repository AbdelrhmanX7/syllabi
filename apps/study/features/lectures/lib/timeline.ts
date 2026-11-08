/**
 * Stroke ↔ audio sync. Every ink object written while a lecture records carries `t` — ms of RECORDED
 * audio (pauses excluded) at the moment the pen went down — as a plain property on the Fabric object,
 * so it lives inside the board JSON (`pages[i].canvasJSON → objects[j].t`) and needs nothing on the
 * backend. Objects without `t` (written outside a recording) are "untimed" and always shown.
 */

export const STROKE_TIME_PROP = 't';

interface SerializedObject {
  t?: unknown;
  objects?: unknown[];
}

/**
 * The time an object appeared. A group (lasso-grouped ink) is stamped when it was GROUPED, which is
 * later than its strokes, so the earliest child time wins when the children carry one.
 */
export function effectiveStrokeTime(object: unknown): number | null {
  if (!object || typeof object !== 'object') return null;
  const record = object as SerializedObject;
  let best: number | null = null;

  if (Array.isArray(record.objects)) {
    for (const child of record.objects) {
      const t = effectiveStrokeTime(child);

      if (t !== null && (best === null || t < best)) best = t;
    }
  }
  if (best !== null) return best;

  const own = record[STROKE_TIME_PROP as 't'];

  return typeof own === 'number' && Number.isFinite(own) ? own : null;
}

/** Per-object times of one page's canvas JSON, in object (z) order. */
export function pageStrokeTimes(canvasJSON: string | null | undefined): (number | null)[] {
  if (!canvasJSON) return [];
  try {
    const parsed = JSON.parse(canvasJSON) as { objects?: unknown[] };

    return Array.isArray(parsed.objects) ? parsed.objects.map(effectiveStrokeTime) : [];
  } catch {
    return [];
  }
}

/** Untimed ink is pre-existing content: always visible. */
export function isRevealed(t: number | null, nowMs: number): boolean {
  return t === null || t <= nowMs;
}

/** Sorted timed values only — feed to {@link revealedCount}. */
export function sortedTimes(times: readonly (number | null)[]): number[] {
  return times.filter((t): t is number => t !== null).sort((a, b) => a - b);
}

/** How many timed strokes have appeared by `nowMs` (upper bound). Changes only when the picture does. */
export function revealedCount(sorted: readonly number[], nowMs: number): number {
  let lo = 0;
  let hi = sorted.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (sorted[mid] <= nowMs) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

/**
 * The page being written on at `nowMs`: the one holding the most recent stroke at or before it.
 * Before any ink, the first page. Lets playback follow the lecturer across pages.
 */
export function pageAtTime(pages: readonly (readonly number[])[], nowMs: number): number {
  let bestPage = 0;
  let bestT = -Infinity;

  pages.forEach((sorted, pageIndex) => {
    const count = revealedCount(sorted, nowMs);

    if (count > 0 && sorted[count - 1] > bestT) {
      bestT = sorted[count - 1];
      bestPage = pageIndex;
    }
  });

  return bestPage;
}

/** Tapping a stroke seeks slightly BEFORE it so the sentence that led to it is heard. */
export function seekTargetMs(t: number, leadMs = 1500): number {
  return Math.max(0, t - leadMs);
}
