import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Path } from 'fabric';

import type { StaticCanvas } from 'fabric';

import { restoreRenderInvariants } from './restoreRenderInvariants';

const canvasOf = (objects: Path[]) => ({ getObjects: () => objects }) as unknown as StaticCanvas;

/** What `loadFromJSON` hands back: Fabric defaults, i.e. caching on and everything selectable. */
const revived = (data: string, options: ConstructorParameters<typeof Path>[1] = {}) =>
  new Path(data, { stroke: '#000', strokeWidth: 3, ...options });

describe('restoreRenderInvariants', () => {
  it('keeps an ordinary restored stroke on a crisp cache instead of re-stroking it every render', () => {
    const stroke = revived('M 0 0 L 120 40 L 200 90');

    restoreRenderInvariants(canvasOf([stroke]));

    assert.equal(stroke.shouldCache(), true);
    assert.equal(stroke.dirty, true, 'the cache is rebuilt, never reused from before the load');
  });

  it('still renders directly a restored stroke Fabric would downscale', () => {
    const huge = revived('M 0 0 L 3000 3000');

    restoreRenderInvariants(canvasOf([huge]));

    assert.equal(huge.shouldCache(), false);
  });

  it('keeps an eraser mark out of reach of the select tool', () => {
    const eraser = revived('M 0 0 L 40 40', { globalCompositeOperation: 'destination-out' });

    restoreRenderInvariants(canvasOf([eraser]));

    assert.equal(eraser.selectable, false);
    assert.equal(eraser.evented, false);
    assert.equal(eraser.shouldCache(), true, 'an eraser mark is ink too');
  });
});
