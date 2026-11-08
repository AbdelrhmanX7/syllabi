import { config } from 'fabric';

import type { FabricObject } from 'fabric';

/**
 * Per-object cache policy for committed ink.
 *
 * ## Why ink was rendered directly, and why that became the lag
 *
 * Fabric draws a cached object from a bitmap. `_limitCacheSize` caps that bitmap at
 * `config.maxCacheSideLimit` per side and `config.perfLimitSizeTotal` in area, and when an object
 * would exceed either it DOWNSCALES the bitmap and stretches it back on the canvas. A big stroke went
 * soft after pen-up; the calligraphy nib's 0.7px hairlines did not soften, they vanished. The fix at the
 * time (v0.1.27-era, then re-asserted on every restore) was `objectCaching: false` on EVERY path.
 *
 * That trades one bug for another: an uncached path is re-tessellated and re-stroked on every render
 * of the lower canvas — `path:created`, eraser marks, selection, any `requestRenderAll` — so the cost
 * of a render grows with the ink on the page. An annotated PDF page carries hundreds of strokes by the
 * end of a lesson; a blank board gets cleared. On the studio's integrated GPUs that is the difference
 * between a board that writes and one that stutters.
 *
 * ## The rule
 *
 * Cache exactly when Fabric would NOT downscale the cache, and decide it on EVERY render: the cache
 * dimensions Fabric computes (`_getCacheCanvasDimensions`) already fold in the object's own scale, the
 * canvas zoom and the retina scaling, so a stroke that fits at zoom 1 and would be capped at zoom 3
 * flips to direct rendering for as long as the teacher stays zoomed in, and flips back afterwards.
 * Fabric re-renders a cache whenever the zoom changes (`_updateCacheCanvas` → `zoomChanged`), so a
 * cached stroke is drawn at device resolution at every zoom level, never from a stale bitmap.
 *
 * The decision is installed as a per-instance `shouldCache` — Fabric calls it at the top of every
 * `render()`, it is the one place both branches (`renderCache` vs `drawObject`) are chosen — rather than
 * as a one-time `objectCaching` flag, precisely so the zoom case above needs no extra bookkeeping.
 */

/** The two Fabric limits the decision reads. `config` satisfies this; tests pass their own. */
export interface CacheLimits {
  maxCacheSideLimit: number;
  perfLimitSizeTotal: number;
}

/** The cache bitmap Fabric is about to allocate, in device pixels. */
export interface CacheDims {
  width: number;
  height: number;
}

/**
 * The smallest cache bitmap side, in device pixels.
 *
 * Fabric's default is 256: every cached object, however tiny, pins a 256×256 RGBA bitmap (256 KB).
 * Handwriting is mostly small strokes — a few hundred of them would pin ~100 MB for nothing. 64 keeps
 * the padding Fabric wants against constant reallocation while a stroke's box moves by a pixel or two,
 * at a sixteenth of the memory.
 */
export const INK_MIN_CACHE_SIDE_PX = 64;

/**
 * Whether a cache of `dims` would be drawn 1:1 — i.e. Fabric would not downscale it.
 *
 * Mirrors the first branch of `FabricObject._limitCacheSize` in fabric 7.2: a cache is left alone when
 * both sides fit `maxCacheSideLimit` and the area fits `perfLimitSizeTotal`; otherwise it is capped
 * and stretched back, which is the blur this policy exists to avoid.
 */
export function cacheStaysCrisp(dims: CacheDims, limits: CacheLimits = config): boolean {
  return (
    dims.width <= limits.maxCacheSideLimit &&
    dims.height <= limits.maxCacheSideLimit &&
    dims.width * dims.height <= limits.perfLimitSizeTotal
  );
}

const INK_CACHE_POLICY = Symbol('inkCachePolicy');

/** `_getCacheCanvasDimensions` is declared in fabric's typings; the marker is ours. */
type PolicyTarget = FabricObject & {
  [INK_CACHE_POLICY]?: true;
  _getCacheCanvasDimensions(): CacheDims;
};

function decide(target: PolicyTarget): boolean {
  const crisp = cacheStaysCrisp(target._getCacheCanvasDimensions());

  target.objectCaching = crisp;

  return crisp;
}

/**
 * Give a committed ink object the cache policy above. Idempotent; call it on every path Fabric
 * creates (`path:created`) and on every path a `loadFromJSON` revives (`restoreRenderInvariants`),
 * since neither the flag nor the instance method survives serialization.
 */
export function applyInkCachePolicy(object: FabricObject): void {
  if (config.minCacheSideLimit !== INK_MIN_CACHE_SIDE_PX) {
    config.minCacheSideLimit = INK_MIN_CACHE_SIDE_PX;
  }

  const target = object as PolicyTarget;

  if (target[INK_CACHE_POLICY]) {
    decide(target);

    return;
  }

  // The class implementation, resolved through the prototype chain once, at install time.
  const inherited = Object.getPrototypeOf(target).shouldCache as (this: FabricObject) => boolean;

  target.shouldCache = function shouldCacheInk(this: PolicyTarget): boolean {
    decide(this);

    return inherited.call(this);
  };
  target[INK_CACHE_POLICY] = true;

  decide(target);
}
