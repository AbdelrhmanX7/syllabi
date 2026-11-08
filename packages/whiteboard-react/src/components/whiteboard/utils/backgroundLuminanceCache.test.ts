import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKGROUND_LUMINANCE_CELL,
  BACKGROUND_LUMINANCE_REFRESH_MS,
  createBackgroundLuminanceCache,
  type BackgroundLuminanceCacheOptions,
} from './backgroundLuminanceCache';
import { readCanvasLuminance } from './inkContrast';

function harness(overrides: Partial<BackgroundLuminanceCacheOptions> = {}, luminanceAt = (_x: number, _y: number) => 0.2) {
  let clock = 0;
  const queue: Array<() => void> = [];
  const reads: Array<[number, number]> = [];
  const cache = createBackgroundLuminanceCache({
    now: () => clock,
    read: (x, y) => {
      reads.push([x, y]);

      return luminanceAt(x, y);
    },
    schedule: (task) => queue.push(task),
    ...overrides,
  });
  const flush = async () => {
    while (queue.length > 0) {
      queue.shift()?.();
      // Let an async read settle before the next task.
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  return {
    advance: (ms: number) => {
      clock += ms;
    },
    cache,
    flush,
    queue,
    reads,
  };
}

describe('createBackgroundLuminanceCache', () => {
  it('lookup never reads a pixel: a miss is null and queues the read for later', async () => {
    const { cache, flush, queue, reads } = harness();

    assert.equal(cache.lookup(10, 10), null);
    assert.equal(reads.length, 0, 'no synchronous read on the stroke-start path');
    assert.equal(queue.length, 1);

    await flush();

    assert.equal(reads.length, 1);
    assert.equal(cache.lookup(12, 14), 0.2, 'same cell → the reading');
    assert.equal(reads.length, 1);
  });

  it('a hover prefetch makes the following stroke start a hit', async () => {
    const { cache, flush, reads } = harness();

    cache.prefetch(100, 100);
    await flush();

    assert.equal(cache.lookup(101, 99), 0.2);
    assert.equal(reads.length, 1);
  });

  it('accepts an async reader and drops a result that arrives after the background changed', async () => {
    let resolve: ((value: number) => void) | null = null;
    const { cache, queue } = harness({
      read: () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    });

    cache.setBackgroundKey('page-a');
    cache.prefetch(5, 5);
    queue.shift()?.();
    cache.setBackgroundKey('page-b');
    (resolve as unknown as (value: number) => void)(0.9);
    await new Promise((done) => setImmediate(done));

    assert.equal(cache.size(), 0);
  });

  it('only the latest wanted point is read — the pen has moved on', async () => {
    const { cache, flush, reads } = harness();

    cache.prefetch(0, 0);
    cache.prefetch(BACKGROUND_LUMINANCE_CELL * 5, 0);
    cache.prefetch(BACKGROUND_LUMINANCE_CELL * 10, 0);
    await flush();

    assert.deepEqual(reads, [[BACKGROUND_LUMINANCE_CELL * 10, 0]]);
  });

  it('serves the nearest neighbouring reading on a miss, and nothing from far away', async () => {
    const { cache, flush } = harness({}, (x) => (x < 1000 ? 0.05 : 0.9));

    cache.prefetch(0, 0);
    await flush();

    assert.equal(cache.lookup(BACKGROUND_LUMINANCE_CELL * 2, BACKGROUND_LUMINANCE_CELL), 0.05);
    assert.equal(cache.lookup(BACKGROUND_LUMINANCE_CELL * 20, 0), null);
  });

  it('a stale reading is still served, and re-read in the background', async () => {
    const { advance, cache, flush, reads } = harness();

    cache.prefetch(0, 0);
    await flush();
    advance(BACKGROUND_LUMINANCE_REFRESH_MS + 1);

    assert.equal(cache.lookup(0, 0), 0.2);
    await flush();
    assert.equal(reads.length, 2);

    // Fresh again: neither lookup nor prefetch asks for another read.
    cache.lookup(0, 0);
    cache.prefetch(0, 0);
    await flush();
    assert.equal(reads.length, 2);
  });

  it('a new background key drops every reading', async () => {
    const { cache, flush } = harness();

    cache.setBackgroundKey('a');
    cache.prefetch(0, 0);
    await flush();
    assert.equal(cache.size(), 1);

    cache.setBackgroundKey('a');
    assert.equal(cache.size(), 1, 'same key keeps them');

    cache.setBackgroundKey('b');
    assert.equal(cache.size(), 0);
    assert.equal(cache.lookup(0, 0), null);
  });

  it('waits while a contact is on the glass', async () => {
    let busy = true;
    const { cache, queue, reads } = harness({ isBusy: () => busy });

    cache.prefetch(0, 0);
    queue.shift()?.();
    assert.equal(reads.length, 0);
    assert.equal(queue.length, 1, 'rescheduled');

    busy = false;
    queue.shift()?.();
    assert.equal(reads.length, 1);
  });

  it('stores nothing for a point that cannot be read right now', async () => {
    const { cache, flush } = harness({ read: () => undefined });

    cache.prefetch(0, 0);
    await flush();
    assert.equal(cache.size(), 0);
  });
});

describe('readCanvasLuminance', () => {
  it('reads the median of the window, without a DOM', async () => {
    const canvas = {
      height: 300,
      width: 400,
      getContext: () => ({
        getImageData: (_l: number, _t: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(Array.from({ length: w * h }, () => [0, 0, 0, 255]).flat()),
        }),
      }),
    } as unknown as HTMLCanvasElement;

    assert.equal(await readCanvasLuminance(canvas, 200, 150), 0);
  });

  it('resolves null rather than rejecting on a canvas that refuses to be read', async () => {
    const tainted = {
      height: 300,
      width: 400,
      getContext: () => ({
        getImageData() {
          throw new DOMException('tainted', 'SecurityError');
        },
      }),
    } as unknown as HTMLCanvasElement;

    assert.equal(await readCanvasLuminance(tainted, 10, 10), null);
  });
});
