/**
 * Uniform-grid spatial hit-index (broad-phase only).
 *
 * A standalone, fabric-free spatial index used to make eraser/selection
 * hit-testing scale on large boards. Instead of scanning every object on every
 * pointer move (O(n)), object ids are bucketed into a uniform grid hashed by
 * integer cell coordinates ("cx,cy"). Queries gather candidate ids only from
 * the cells a query touches.
 *
 * GUARANTEE — NO FALSE NEGATIVES: a query returns *every* indexed object whose
 * bounding box could contain/intersect the query, even at the cost of returning
 * a few extra candidates. (Cells are coarse, so the grid step alone can yield
 * candidates that don't truly intersect; we filter those out with an exact bbox
 * intersection test to suppress false positives, but we never drop a real hit.)
 *
 * BROAD-PHASE ONLY: returned ids are *candidates*. The caller is expected to run
 * its own exact hit-test (e.g. fabric pixel/path containment) on each candidate.
 *
 * Non-finite coordinates are treated as not-insertable so a malformed bbox can
 * never corrupt or crash the grid.
 */

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SpatialHitIndex {
  insert(id: string, bbox: BBox): void;
  update(id: string, bbox: BBox): void;
  remove(id: string): void;
  clear(): void;
  queryPoint(x: number, y: number, radius?: number): string[];
  queryBBox(bbox: BBox): string[];
  size(): number;
}

const isFiniteBBox = (bbox: BBox): boolean =>
  !!bbox &&
  Number.isFinite(bbox.minX) &&
  Number.isFinite(bbox.minY) &&
  Number.isFinite(bbox.maxX) &&
  Number.isFinite(bbox.maxY);

const bboxesIntersect = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

export function createSpatialHitIndex(cellSize = 256): SpatialHitIndex {
  // Source of truth: id -> bbox.
  const boxes = new Map<string, BBox>();
  // Grid buckets: "cx,cy" -> set of ids covering that cell.
  const cells = new Map<string, Set<string>>();

  const size = cellSize > 0 ? cellSize : 256;

  const forEachCell = (bbox: BBox, fn: (key: string) => void): void => {
    const minCx = Math.floor(bbox.minX / size);
    const minCy = Math.floor(bbox.minY / size);
    const maxCx = Math.floor(bbox.maxX / size);
    const maxCy = Math.floor(bbox.maxY / size);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        fn(cellKey(cx, cy));
      }
    }
  };

  const removeFromCells = (id: string, bbox: BBox): void => {
    forEachCell(bbox, (key) => {
      const bucket = cells.get(key);

      if (bucket) {
        bucket.delete(id);

        if (bucket.size === 0) cells.delete(key);
      }
    });
  };

  const addToCells = (id: string, bbox: BBox): void => {
    forEachCell(bbox, (key) => {
      let bucket = cells.get(key);

      if (!bucket) {
        bucket = new Set<string>();
        cells.set(key, bucket);
      }

      bucket.add(id);
    });
  };

  const upsert = (id: string, bbox: BBox): void => {
    const existing = boxes.get(id);

    if (existing) removeFromCells(id, existing);

    // A non-finite bbox is treated as "not inserted": drop any prior entry and stop.
    if (!isFiniteBBox(bbox)) {
      boxes.delete(id);

      return;
    }

    const stored: BBox = {
      minX: bbox.minX,
      minY: bbox.minY,
      maxX: bbox.maxX,
      maxY: bbox.maxY,
    };

    boxes.set(id, stored);
    addToCells(id, stored);
  };

  const queryBBox = (bbox: BBox): string[] => {
    if (!isFiniteBBox(bbox)) return [];

    const seen = new Set<string>();
    const result: string[] = [];

    forEachCell(bbox, (key) => {
      const bucket = cells.get(key);

      if (!bucket) return;

      bucket.forEach((id) => {
        if (seen.has(id)) return;

        seen.add(id);

        const stored = boxes.get(id);

        // Exact intersection filter: suppress coarse-grid false positives while
        // never dropping a true hit.
        if (stored && bboxesIntersect(stored, bbox)) result.push(id);
      });
    });

    return result;
  };

  return {
    insert(id, bbox) {
      upsert(id, bbox);
    },
    update(id, bbox) {
      upsert(id, bbox);
    },
    remove(id) {
      const existing = boxes.get(id);

      if (!existing) return;

      removeFromCells(id, existing);
      boxes.delete(id);
    },
    clear() {
      boxes.clear();
      cells.clear();
    },
    queryPoint(x, y, radius = 0) {
      return queryBBox({
        minX: x - radius,
        minY: y - radius,
        maxX: x + radius,
        maxY: y + radius,
      });
    },
    queryBBox,
    size() {
      return boxes.size;
    },
  };
}
