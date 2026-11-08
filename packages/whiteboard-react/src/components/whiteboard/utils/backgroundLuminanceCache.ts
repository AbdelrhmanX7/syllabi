/**
 * Smart ink contrast without a pixel read at pen-down.
 *
 * ## Why
 *
 * Smart ink contrast needs the luminance of what is under a stroke's first point. It used to be read
 * AT pen-down: a 7×7 `drawImage` from the live (GPU) background canvas into a scratch, then a
 * synchronous `getImageData`. On a Galaxy Tab S9 Ultra that readback stalls the main thread until the
 * GPU has drained — the owner's device log measured 19–34 ms of `touchstart` processing on every pen
 * down on a PDF page, right where the first segment of ink is supposed to appear.
 *
 * ## How
 *
 * Readings are cached by SCENE cell (what is under a scene point does not change when the board
 * scrolls; a PDF page sits at a fixed place in the scene) and filled OFF the input path:
 *
 *  - while the pen hovers (an S Pen reports hover long before it touches), the cell under it is read
 *    in an idle callback;
 *  - a stroke start that finds no reading asks for one the same way;
 *  - an entry older than {@link BACKGROUND_LUMINANCE_REFRESH_MS} is still used, and re-read in the
 *    background so the next stroke sees the fresh value.
 *
 * {@link BackgroundLuminanceCache.lookup} never reads a pixel. A miss falls back to the nearest
 * reading on the same background (handwriting moves along a line; the cell next door is almost always
 * the same paper), and to `null` beyond that — the host then decides (the board treats it as paper).
 * The result of a read requested by a stroke applies to the NEXT stroke, never retroactively to the
 * one already on the glass: its first segments are drawn already, and a colour change at commit
 * would read as a flash.
 *
 * Everything here is injectable (clock, scheduler, reader), so the rules are unit-tested without a DOM.
 */

/** Edge of one cache cell, in scene units. ~A word of handwriting at the default zoom. */
export const BACKGROUND_LUMINANCE_CELL = 32;

/** A reading older than this is still served, but re-read in the background. */
export const BACKGROUND_LUMINANCE_REFRESH_MS = 1_500;

/** How far (in cells, Chebyshev) a miss looks for a neighbouring reading before giving up. */
export const BACKGROUND_LUMINANCE_NEIGHBOUR_CELLS = 3;

/** Readings kept per background before the oldest are dropped. */
const MAX_ENTRIES = 512;

interface Entry {
  luminance: number;
  at: number;
}

export interface BackgroundLuminanceCacheOptions {
  /**
   * Read the luminance under scene point (`x`, `y`) NOW. May be async. `undefined` = cannot be read
   * right now (the point is off screen, the background is mid-repaint) — nothing is stored and the
   * cell stays a miss; `null` = unreadable (tainted) — nothing is stored either.
   */
  read: (x: number, y: number) => number | null | undefined | Promise<number | null | undefined>;
  /** Run `task` when the main thread is idle. `requestIdleCallback` in the browser. */
  schedule: (task: () => void) => void;
  /** Whether a read must wait (a contact is on the glass). Checked when the idle task runs. */
  isBusy?: () => boolean;
  now?: () => number;
  cellSize?: number;
  refreshAfterMs?: number;
}

export interface BackgroundLuminanceCache {
  /**
   * The luminance under scene (`x`, `y`) as far as is known, without reading a pixel. Queues a read
   * when the cell is unknown or stale. Null when nothing near has been read yet.
   */
  lookup(x: number, y: number): number | null;
  /** The pen is hovering at scene (`x`, `y`): read the cell under it if it is unknown or stale. */
  prefetch(x: number, y: number): void;
  /**
   * Identity of what the background paints (page, PDF, pinned images). A different key drops every
   * reading — they describe a background that is gone.
   */
  setBackgroundKey(key: string): void;
  /** Drop every reading (and any read in flight). */
  clear(): void;
  /** Number of readings held (tests, perf HUD). */
  size(): number;
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

export function createBackgroundLuminanceCache(options: BackgroundLuminanceCacheOptions): BackgroundLuminanceCache {
  const cellSize = options.cellSize ?? BACKGROUND_LUMINANCE_CELL;
  const refreshAfterMs = options.refreshAfterMs ?? BACKGROUND_LUMINANCE_REFRESH_MS;
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

  let entries = new Map<string, Entry>();
  let backgroundKey: string | null = null;
  /** Bumped whenever readings are dropped, so a read in flight for the old background is discarded. */
  let epoch = 0;
  /** The most recent point that wants a read. Only the latest matters: the pen has moved on. */
  let wanted: { x: number; y: number } | null = null;
  let scheduled = false;
  let reading = false;

  const cellOf = (value: number): number => Math.floor(value / cellSize);

  const isFresh = (entry: Entry | undefined): boolean => entry !== undefined && now() - entry.at < refreshAfterMs;

  const store = (key: string, luminance: number): void => {
    entries.delete(key);
    entries.set(key, { at: now(), luminance });

    if (entries.size > MAX_ENTRIES) {
      // Map keeps insertion order and a re-store re-inserts: the first key is the least recently read.
      const oldest = entries.keys().next().value;

      if (oldest !== undefined) entries.delete(oldest);
    }
  };

  const finish = (): void => {
    reading = false;

    if (wanted) schedule();
  };

  const run = (): void => {
    scheduled = false;

    if (reading || !wanted) return;

    if (options.isBusy?.()) {
      // A contact is on the glass: a readback now would land in the middle of its stroke. Try again.
      schedule();

      return;
    }

    const { x, y } = wanted;

    wanted = null;

    const key = cellKey(cellOf(x), cellOf(y));

    if (isFresh(entries.get(key))) {
      if (wanted) schedule();

      return;
    }

    const startedEpoch = epoch;
    const accept = (value: number | null | undefined): void => {
      if (startedEpoch === epoch && typeof value === 'number' && Number.isFinite(value)) {
        store(key, Math.min(1, Math.max(0, value)));
      }
    };

    reading = true;

    let result: ReturnType<BackgroundLuminanceCacheOptions['read']>;

    try {
      result = options.read(x, y);
    } catch {
      finish();

      return;
    }

    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<number | null | undefined>).then(accept, () => undefined).finally(finish);

      return;
    }

    accept(result as number | null | undefined);
    finish();
  };

  function schedule(): void {
    if (scheduled) return;

    scheduled = true;
    options.schedule(run);
  }

  const want = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    wanted = { x, y };
    schedule();
  };

  const nearest = (cx: number, cy: number): number | null => {
    for (let radius = 1; radius <= BACKGROUND_LUMINANCE_NEIGHBOUR_CELLS; radius += 1) {
      let best: Entry | null = null;

      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;

          const entry = entries.get(cellKey(cx + dx, cy + dy));

          if (entry && (best === null || entry.at > best.at)) best = entry;
        }
      }

      if (best) return best.luminance;
    }

    return null;
  };

  const clear = (): void => {
    entries = new Map();
    epoch += 1;
    wanted = null;
  };

  return {
    lookup(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

      const cx = cellOf(x);
      const cy = cellOf(y);
      const entry = entries.get(cellKey(cx, cy));

      if (!isFresh(entry)) want(x, y);

      return entry ? entry.luminance : nearest(cx, cy);
    },
    prefetch(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      if (isFresh(entries.get(cellKey(cellOf(x), cellOf(y))))) return;

      want(x, y);
    },
    setBackgroundKey(key) {
      if (key === backgroundKey) return;

      backgroundKey = key;
      clear();
    },
    clear,
    size: () => entries.size,
  };
}
