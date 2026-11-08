import { Path } from 'fabric';

import type { FabricObject, StaticCanvas } from 'fabric';

import { applyInkCachePolicy } from './inkCachePolicy';
import { perfSpan } from './perfSpan';

/** An eraser mark is identified by how it composites, never by its fill or stroke. */
const isEraserMark = (object: FabricObject): boolean =>
  (object as FabricObject & { globalCompositeOperation?: string }).globalCompositeOperation === 'destination-out';

/**
 * Re-apply the object state that Fabric does not serialize, after ANY `loadFromJSON`.
 *
 * Fabric's `toObject` omits both of these, and they revive at their defaults — so every restore path has
 * to re-assert them or it silently ships a different board than the one that was saved. The page-load
 * path did; undo/redo did not, which is why this lives in one place now instead of being inlined.
 *
 *   - The ink cache policy (`applyInkCachePolicy`) is a per-instance method, and methods do not
 *     serialize. Without it a revived stroke is cached unconditionally, and a large one is drawn from a
 *     cache that `_limitCacheSize` downscaled: the stroke goes soft, and the calligraphy nib — which
 *     clamps its thin direction at 0.35px either side, a 0.7px feature — loses its hairlines outright.
 *     Zoom in, press undo, and the stroke changes character until the page is reloaded. The policy
 *     caches every stroke Fabric can draw 1:1 and renders the rest directly; see the module header there
 *     for why that replaced the older "no cache for any path" rule.
 *   - `selectable` / `evented` default back to TRUE. An eraser mark is a `destination-out` path, so a
 *     restored one becomes a draggable invisible hole: on the select tool the teacher can pick it up and
 *     move it, and the modification is persisted.
 */
export function restoreRenderInvariants(canvas: StaticCanvas): void {
  const objects = canvas.getObjects() as FabricObject[];

  perfSpan(
    'restore-invariants',
    () => {
      for (const object of objects) {
        if (object instanceof Path || object.type === 'path') {
          applyInkCachePolicy(object);
          object.dirty = true;
        }

        if (isEraserMark(object)) {
          object.selectable = false;
          object.evented = false;
        }
      }
    },
    `objects=${objects.length}`,
  );
}
