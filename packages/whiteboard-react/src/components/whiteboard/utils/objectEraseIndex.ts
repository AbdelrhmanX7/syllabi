import type { BBox, SpatialHitIndex } from './spatialHitIndex';
import { createSpatialHitIndex } from './spatialHitIndex';

/**
 * The object eraser's broad phase, kept up to date INCREMENTALLY.
 *
 * The first version of this index (a grid rebuilt from scratch) was correct but did three O(n) passes
 * per eraser sample, so on a dense page the eraser cost what a full scan costs:
 *
 *  1. every erased stroke fired `object:removed`, which marked the whole index dirty — the very next
 *     sample rebuilt it: `setCoords()` + `getBoundingRect()` on every object on the canvas (all pages
 *     at once in the PDF scroll layout);
 *  2. each query counted the non-eraser objects (its staleness check) and found the thickest stroke;
 *  3. a query that found NO candidate — the ring over blank paper, i.e. most samples — was treated as
 *     "inconsistent" and fell back to the exact hit test on EVERY object.
 *
 * Here an add/modify only queues the object (its box is computed lazily at the next query, so a page
 * load's thousands of `object:added` cost nothing), a removal drops it from the grid in O(its cells),
 * the staleness net is an O(1) count compare, the stroke pad is an upper bound kept since the last
 * rebuild, and an empty answer is trusted. Candidates come back topmost first.
 */
export interface ObjectEraseIndexAdapter<T> {
  /** Whether the eraser may ever remove this object (not an eraser mark, not a pinned image). */
  isIndexable: (obj: T) => boolean;
  /** The object's current scene bounding box (the adapter refreshes coords), or null when it has none. */
  bboxOf: (obj: T) => BBox | null;
  /** Half the object's stroke width — how far its paint can reach past its box. */
  halfStrokeOf: (obj: T) => number;
}

export interface ObjectEraseIndex<T> {
  noteAdded: (obj: T) => void;
  noteRemoved: (obj: T) => void;
  noteModified: (obj: T) => void;
  /** Rebuild from the canvas before the next query (page load, pin flip, a change seen only as a whole). */
  markDirty: () => void;
  /**
   * Bring the index in line with `objects` (the canvas's current list, in z-order): a full rebuild when
   * dirty or when the list length disagrees with what the events said, else just the queued boxes.
   */
  sync: (objects: readonly T[]) => void;
  /** Upper bound of {@link ObjectEraseIndexAdapter.halfStrokeOf} over the indexed objects. */
  maxHalfStroke: () => number;
  /** Indexed objects whose box intersects `bbox`, topmost first. Call {@link sync} first. */
  query: (bbox: BBox) => T[];
  /** Diagnostics/tests: how many full rebuilds have run. */
  rebuildCount: () => number;
  size: () => number;
}

export function createObjectEraseIndex<T extends object>(
  adapter: ObjectEraseIndexAdapter<T>,
  cellSize?: number,
): ObjectEraseIndex<T> {
  const grid: SpatialHitIndex = createSpatialHitIndex(cellSize);
  // Every object the events say is on the canvas (indexable or not) → its z-order key. Keys only grow
  // between rebuilds, so a later-added object always sorts above an earlier one, like the canvas does.
  const keys = new Map<T, number>();
  const byId = new Map<string, T>();
  const pending = new Set<T>();
  let nextKey = 0;
  let dirty = true;
  let halfStrokePad = 0;
  let rebuilds = 0;

  const place = (obj: T): void => {
    const key = keys.get(obj);

    if (key === undefined) return;

    const id = String(key);

    if (!adapter.isIndexable(obj)) {
      grid.remove(id);
      byId.delete(id);

      return;
    }

    const box = adapter.bboxOf(obj);

    if (!box) {
      grid.remove(id);
      byId.delete(id);

      return;
    }

    grid.update(id, box);
    byId.set(id, obj);
    halfStrokePad = Math.max(halfStrokePad, adapter.halfStrokeOf(obj));
  };

  const rebuild = (objects: readonly T[]): void => {
    grid.clear();
    keys.clear();
    byId.clear();
    pending.clear();
    nextKey = 0;
    halfStrokePad = 0;

    for (const obj of objects) {
      keys.set(obj, nextKey);
      nextKey += 1;
      place(obj);
    }

    dirty = false;
    rebuilds += 1;
  };

  return {
    noteAdded(obj) {
      if (dirty) return;

      if (!keys.has(obj)) {
        keys.set(obj, nextKey);
        nextKey += 1;
      }

      pending.add(obj);
    },
    noteRemoved(obj) {
      if (dirty) return;

      const key = keys.get(obj);

      pending.delete(obj);

      if (key === undefined) return;

      const id = String(key);

      keys.delete(obj);
      grid.remove(id);
      byId.delete(id);
    },
    noteModified(obj) {
      if (dirty) return;

      // A change to something the canvas does not hold (a multi-selection) moves members we cannot list.
      if (!keys.has(obj)) {
        dirty = true;

        return;
      }

      pending.add(obj);
    },
    markDirty() {
      dirty = true;
    },
    sync(objects) {
      if (dirty || objects.length !== keys.size) {
        rebuild(objects);

        return;
      }

      if (pending.size === 0) return;

      pending.forEach((obj) => place(obj));
      pending.clear();
    },
    maxHalfStroke: () => halfStrokePad,
    query(bbox) {
      const ids = grid.queryBBox(bbox);
      const hits: Array<{ key: number; obj: T }> = [];

      for (const id of ids) {
        const obj = byId.get(id);

        if (obj) hits.push({ key: Number(id), obj });
      }

      hits.sort((a, b) => b.key - a.key);

      return hits.map((hit) => hit.obj);
    },
    rebuildCount: () => rebuilds,
    size: () => grid.size(),
  };
}
