import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config, Path } from 'fabric';

import type { Canvas } from 'fabric';

import { applyInkCachePolicy, cacheStaysCrisp, INK_MIN_CACHE_SIDE_PX } from './inkCachePolicy';

/**
 * Fabric caps a cache bitmap at `maxCacheSideLimit` per side and `perfLimitSizeTotal` in area, and
 * when a cache would exceed either it DOWNSCALES the bitmap and stretches it back — the blur that made
 * the app switch every stroke to direct rendering. The policy here is the narrow version of that fix:
 * direct rendering only for the strokes Fabric would have downscaled, a crisp cache for the rest.
 */
const limits = { maxCacheSideLimit: 4096, perfLimitSizeTotal: 2_097_152 };

/** A fake Fabric canvas: the only two things the cache-dimension math reads. */
const fakeCanvas = (zoom: number, retina = 1) =>
  ({ getRetinaScaling: () => retina, getZoom: () => zoom }) as unknown as Canvas;

describe('cacheStaysCrisp', () => {
  it('accepts a cache within both the side and the area limits', () => {
    assert.equal(cacheStaysCrisp({ height: 600, width: 800 }, limits), true);
  });

  it('refuses a cache whose area would be downscaled', () => {
    assert.equal(cacheStaysCrisp({ height: 1500, width: 1500 }, limits), false);
  });

  it('refuses a cache with one side over the side limit even when the area fits', () => {
    assert.equal(cacheStaysCrisp({ height: 10, width: 5000 }, limits), false);
  });
});

describe('applyInkCachePolicy', () => {
  it('caches an ordinary stroke', () => {
    const path = new Path('M 0 0 L 120 40 L 200 90', { stroke: '#000', strokeWidth: 4 });

    applyInkCachePolicy(path);

    assert.equal(path.shouldCache(), true);
    assert.equal(path.objectCaching, true);
  });

  it('renders directly a stroke whose cache Fabric would downscale', () => {
    const path = new Path('M 0 0 L 3000 3000', { stroke: '#000', strokeWidth: 8 });

    applyInkCachePolicy(path);

    assert.equal(path.shouldCache(), false);
    assert.equal(path.objectCaching, false);
  });

  it('re-decides on every render, so zooming in past the cap falls back to direct rendering', () => {
    const path = new Path('M 0 0 L 600 600', { stroke: '#000', strokeWidth: 2 });

    applyInkCachePolicy(path);
    path.canvas = fakeCanvas(1);

    assert.equal(path.shouldCache(), true, 'fits at zoom 1');

    path.canvas = fakeCanvas(3);

    assert.equal(path.shouldCache(), false, '1800×1800 exceeds the area cap at zoom 3');

    path.canvas = fakeCanvas(1);

    assert.equal(path.shouldCache(), true, 'and comes back once the zoom drops');
  });

  it('counts retina scaling like Fabric does', () => {
    const path = new Path('M 0 0 L 1000 1000', { stroke: '#000', strokeWidth: 2 });

    applyInkCachePolicy(path);
    path.canvas = fakeCanvas(1, 1);

    assert.equal(path.shouldCache(), true, '1000×1000 fits at DPR 1');

    path.canvas = fakeCanvas(1, 2);

    assert.equal(path.shouldCache(), false, '2000×2000 does not at DPR 2');
  });

  it('is idempotent — applying twice installs one policy, not a chain', () => {
    const path = new Path('M 0 0 L 50 50', { stroke: '#000', strokeWidth: 2 });

    applyInkCachePolicy(path);

    const installed = path.shouldCache;

    applyInkCachePolicy(path);

    assert.equal(path.shouldCache, installed);
    assert.equal(path.shouldCache(), true);
  });

  it('keeps the calligraphy nib (a filled outline) on the same rule as a stroked path', () => {
    const nib = new Path('M 0 0 L 80 20 L 82 22 L 2 2 Z', { fill: '#000', stroke: '', strokeWidth: 0 });

    applyInkCachePolicy(nib);

    assert.equal(nib.shouldCache(), true);
  });

  it('lowers the minimum cache side so hundreds of small strokes do not each pin a 256px bitmap', () => {
    const path = new Path('M 0 0 L 10 10', { stroke: '#000', strokeWidth: 2 });

    applyInkCachePolicy(path);

    assert.equal(config.minCacheSideLimit, INK_MIN_CACHE_SIDE_PX);
    assert.ok(INK_MIN_CACHE_SIDE_PX < 256);
  });
});
