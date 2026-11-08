/**
 * Overscan backdrop — which ink is actually ON the backdrop's ink layer, so a removal can be wiped
 * from it the moment it happens.
 *
 * The backdrop (see ./overscanBackdrop) is rebuilt lazily, at quiet moments. Being BEHIND on additions
 * is harmless (new ink is missing from the blurred preview for a moment), but being behind on
 * removals is not: erased text reappearing, blurred, in the area a pan reveals is showing content that
 * no longer exists. So every object drawn into the ink layer is recorded with the scene rect it was
 * drawn at, and any change that can make drawn pixels wrong yields the rect(s) to clear right away:
 *
 *  - removal (object eraser, delete, cut, undo of an add, AI replace, …) → the rect it was drawn at;
 *  - modification (move / scale / rotate / restyle) → the rect it was drawn at, i.e. its OLD position;
 *    it is forgotten, and the next rebuild draws it where it is now;
 *  - a pixel-eraser stroke (a `destination-out` path) being added → its own rect, since it punches
 *    whatever was drawn under it.
 *
 * Clearing a rect may also wipe neighbouring ink that overlaps it — missing ink for a moment, never
 * wrong ink. Pure (no DOM / Fabric) so the bookkeeping is unit-tested.
 */

export interface SceneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InkLedger<T extends object> {
  /** Replace the ledger with what the freshly composed ink layer holds. */
  reset(entries: Iterable<readonly [T, SceneRect]>): void;
  /** Forget everything (the layer was hidden / emptied). */
  clear(): void;
  /** An object was removed from the canvas: the rect to wipe, or null when it was never drawn. */
  onRemoved(object: T): SceneRect | null;
  /** An object (or each member of a multi-selection) was modified: the OLD rects to wipe. */
  onModified(objects: readonly T[]): SceneRect[];
  /** An object was added. Only an erasing stroke has anything to wipe: its own current rect. */
  onAdded(object: T, isEraser: boolean, currentRect: SceneRect | null): SceneRect | null;
  /** How many drawn objects are tracked (tests / diagnostics). */
  size(): number;
}

export function createInkLedger<T extends object>(): InkLedger<T> {
  let drawn = new Map<T, SceneRect>();

  const take = (object: T): SceneRect | null => {
    const rect = drawn.get(object);

    if (!rect) return null;

    drawn.delete(object);

    return rect;
  };

  return {
    clear: () => {
      drawn = new Map();
    },
    onAdded: (_object, isEraser, currentRect) => (isEraser && currentRect ? currentRect : null),
    onModified: (objects) => {
      const rects: SceneRect[] = [];

      for (const object of objects) {
        const rect = take(object);

        if (rect) rects.push(rect);
      }

      return rects;
    },
    onRemoved: (object) => take(object),
    reset: (entries) => {
      drawn = new Map(entries);
    },
    size: () => drawn.size,
  };
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A scene rect → the backdrop-pixel rect to `clearRect`, given the backdrop's scene→pixel mapping
 * (`scale` = zoom × ratio, `originX/Y` = the backdrop's scene top-left). Grown by `marginPx` on every
 * side to take the blur's spill (and anti-aliasing) with it, snapped outward to whole pixels, and
 * clamped to the canvas. Null when it misses the canvas entirely.
 */
export function sceneRectToBackdropPixels(
  rect: SceneRect,
  mapping: { scale: number; originX: number; originY: number; pixelWidth: number; pixelHeight: number },
  marginPx = 3,
): PixelRect | null {
  const x0 = Math.floor((rect.left - mapping.originX) * mapping.scale - marginPx);
  const y0 = Math.floor((rect.top - mapping.originY) * mapping.scale - marginPx);
  const x1 = Math.ceil((rect.left + rect.width - mapping.originX) * mapping.scale + marginPx);
  const y1 = Math.ceil((rect.top + rect.height - mapping.originY) * mapping.scale + marginPx);
  const left = Math.max(0, x0);
  const top = Math.max(0, y0);
  const right = Math.min(mapping.pixelWidth, x1);
  const bottom = Math.min(mapping.pixelHeight, y1);

  if (!Number.isFinite(left + top + right + bottom) || right <= left || bottom <= top) return null;

  return { height: bottom - top, width: right - left, x: left, y: top };
}
