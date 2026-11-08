import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bakeTranslation,
  DEFAULT_MAX_TAIL,
  DEFAULT_MIN_OBJECTS,
  deviceRectToScene,
  dropBakedObject,
  exposedStrips,
  isBakeValid,
  padSceneRect,
  planBake,
  removalPatchRegion,
  resolveInkBakeOptions,
  sameBackground,
  sceneRectsIntersect,
  snapPanStep,
  type BakeableObject,
  type BackgroundFingerprint,
  type BakeFrameInfo,
  type BakeValidityState,
} from './inkBake';

const EMPTY_BACKGROUND: BackgroundFingerprint = {
  color: 'transparent',
  element: undefined,
  geometry: '',
  image: undefined,
  vpt: true,
};

const makeObjects = (count: number): BakeableObject[] =>
  Array.from({ length: count }, () => ({ dirty: false, opacity: 1, visible: true }));

const makeState = (objects: BakeableObject[], overrides: Partial<BakeValidityState> = {}): BakeValidityState => ({
  background: EMPTY_BACKGROUND,
  height: 1200,
  objects,
  opacity: objects.map((object) => object.opacity ?? 1),
  retina: 2,
  stale: false,
  transform: [1, 0, 0, 1, 0, 0],
  visible: objects.map((object) => object.visible !== false),
  width: 1600,
  ...overrides,
});

const makeFrame = (overrides: Partial<BakeFrameInfo> = {}): BakeFrameInfo => ({
  background: EMPTY_BACKGROUND,
  height: 1200,
  isLowerCanvas: true,
  retina: 2,
  transform: [1, 0, 0, 1, 0, 0],
  width: 1600,
  ...overrides,
});

describe('isBakeValid', () => {
  it('accepts an untouched prefix with a growing tail', () => {
    const baked = makeObjects(200);
    const objects = [...baked, ...makeObjects(5)];

    assert.equal(isBakeValid(makeState(baked), makeFrame(), objects), true);
  });

  it('rejects when there is no bake at all', () => {
    assert.equal(isBakeValid(null, makeFrame(), makeObjects(200)), false);
  });

  it('rejects a bake that was explicitly invalidated', () => {
    const baked = makeObjects(200);

    assert.equal(isBakeValid(makeState(baked, { stale: true }), makeFrame(), baked), false);
  });

  it('rejects an identity mismatch (an object was replaced in place)', () => {
    const baked = makeObjects(10);
    const objects = [...baked];

    objects[4] = { dirty: false, opacity: 1, visible: true };

    assert.equal(isBakeValid(makeState(baked), makeFrame(), objects), false);
  });

  it('rejects a removal — the list is shorter than the baked prefix', () => {
    const baked = makeObjects(10);

    assert.equal(isBakeValid(makeState(baked), makeFrame(), baked.slice(0, 9)), false);
  });

  it('rejects a reorder even when every object is still present', () => {
    const baked = makeObjects(10);
    const objects = [...baked];

    [objects[2], objects[7]] = [objects[7], objects[2]];

    assert.equal(isBakeValid(makeState(baked), makeFrame(), objects), false);
  });

  it('rejects a baked object that went dirty', () => {
    const baked = makeObjects(10);

    baked[3].dirty = true;

    assert.equal(isBakeValid(makeState(baked), makeFrame(), baked), false);
  });

  it('rejects a visibility flip (an image being pinned)', () => {
    const baked = makeObjects(10);
    const state = makeState(baked);

    baked[6].visible = false;

    assert.equal(isBakeValid(state, makeFrame(), baked), false);
  });

  it('rejects an opacity change', () => {
    const baked = makeObjects(10);
    const state = makeState(baked);

    baked[0].opacity = 0.4;

    assert.equal(isBakeValid(state, makeFrame(), baked), false);
  });

  it('treats a missing visible/opacity as visible and fully opaque', () => {
    const baked: BakeableObject[] = [{ dirty: false }, { dirty: false }];

    assert.equal(isBakeValid(makeState(baked), makeFrame(), baked), true);
  });

  it('rejects a viewport change (pan or zoom)', () => {
    const baked = makeObjects(10);

    assert.equal(isBakeValid(makeState(baked), makeFrame({ transform: [1, 0, 0, 1, 0, -40] }), baked), false);
    assert.equal(isBakeValid(makeState(baked), makeFrame({ transform: [2, 0, 0, 2, 0, 0] }), baked), false);
  });

  it('rejects a retina scaling change', () => {
    const baked = makeObjects(10);

    assert.equal(isBakeValid(makeState(baked), makeFrame({ retina: 1 }), baked), false);
  });

  it('rejects a canvas size change', () => {
    const baked = makeObjects(10);

    assert.equal(isBakeValid(makeState(baked), makeFrame({ width: 1601 }), baked), false);
    assert.equal(isBakeValid(makeState(baked), makeFrame({ height: 1199 }), baked), false);
  });

  it('rejects a foreign canvas — this is what keeps exports rendering every object', () => {
    const baked = makeObjects(10);

    assert.equal(isBakeValid(makeState(baked), makeFrame({ isLowerCanvas: false }), baked), false);
  });

  it('rejects a background swap', () => {
    const baked = makeObjects(10);
    const image = {};

    assert.equal(
      isBakeValid(makeState(baked), makeFrame({ background: { ...EMPTY_BACKGROUND, image } }), baked),
      false,
    );
  });

  it('rejects a background image whose source element was swapped under it', () => {
    const image = {};
    const baked = makeObjects(10);
    const before: BackgroundFingerprint = { ...EMPTY_BACKGROUND, element: {}, image };
    const after: BackgroundFingerprint = { ...before, element: {} };

    assert.equal(isBakeValid(makeState(baked, { background: before }), makeFrame({ background: after }), baked), false);
  });

  it('rejects a background image that moved without going dirty', () => {
    const image = {};
    const element = {};
    const baked = makeObjects(10);
    const before: BackgroundFingerprint = { ...EMPTY_BACKGROUND, element, geometry: '0|0', image };
    const after: BackgroundFingerprint = { ...before, geometry: '0|12' };

    assert.equal(isBakeValid(makeState(baked, { background: before }), makeFrame({ background: after }), baked), false);
  });
});

describe('sameBackground', () => {
  it('matches two readings of an unchanged background', () => {
    assert.equal(sameBackground(EMPTY_BACKGROUND, { ...EMPTY_BACKGROUND }), true);
  });

  it('separates backgrounds that differ only in the vpt flag', () => {
    assert.equal(sameBackground(EMPTY_BACKGROUND, { ...EMPTY_BACKGROUND, vpt: false }), false);
  });
});

describe('planBake', () => {
  const options = resolveInkBakeOptions();

  it('never bakes below the object floor', () => {
    assert.deepEqual(planBake(null, options.minObjects - 1, options), { mode: 'none' });
  });

  it('bakes everything when there is no valid bake', () => {
    assert.deepEqual(planBake(null, 400, options), { from: 0, mode: 'full', to: 400 });
  });

  it('extends incrementally once the tail reaches the threshold', () => {
    assert.deepEqual(planBake(400, 400 + options.maxTail, options), {
      from: 400,
      mode: 'tail',
      to: 400 + options.maxTail,
    });
  });

  it('does nothing while the tail is still short', () => {
    assert.deepEqual(planBake(400, 400 + options.maxTail - 1, options), { mode: 'none' });
  });

  it('honours custom thresholds', () => {
    const custom = resolveInkBakeOptions({ maxTail: 2, minObjects: 10 });

    assert.deepEqual(planBake(null, 9, custom), { mode: 'none' });
    assert.deepEqual(planBake(null, 10, custom), { from: 0, mode: 'full', to: 10 });
    assert.deepEqual(planBake(10, 12, custom), { from: 10, mode: 'tail', to: 12 });
    assert.deepEqual(planBake(10, 11, custom), { mode: 'none' });
  });

  it('clamps nonsense options rather than disabling itself', () => {
    const clamped = resolveInkBakeOptions({ maxTail: 0, minObjects: 0 });

    assert.equal(clamped.maxTail, 1);
    assert.equal(clamped.minObjects, 1);
  });

  it('ships the documented defaults', () => {
    assert.equal(options.minObjects, DEFAULT_MIN_OBJECTS);
    assert.equal(options.maxTail, DEFAULT_MAX_TAIL);
  });
});

// A removal is patched into the bake in place (the object eraser removes strokes under a moving pen;
// a stale bake there meant a full render every frame of the drag). These are the pure halves of it.
describe('dropBakedObject', () => {
  it('takes a baked object out of the prefix and keeps the per-object arrays aligned', () => {
    const baked = makeObjects(5);

    baked[2].opacity = 0.5;
    baked[3].visible = false;

    const state = makeState(baked);
    const next = dropBakedObject(state, baked[2]);

    assert.ok(next);
    assert.deepEqual(next.objects, [baked[0], baked[1], baked[3], baked[4]]);
    assert.deepEqual(next.opacity, [1, 1, 1, 1]);
    assert.deepEqual(next.visible, [true, true, false, true]);
    // …and the live list without that object validates against the patched record.
    assert.equal(isBakeValid(next, makeFrame(), [baked[0], baked[1], baked[3], baked[4], ...makeObjects(2)]), true);
    // The original record is untouched.
    assert.equal(state.objects.length, 5);
  });

  it('is null for a tail object (never baked), a stale bake, and no bake', () => {
    const baked = makeObjects(3);
    const tail = makeObjects(1)[0];

    assert.equal(dropBakedObject(makeState(baked), tail), null);
    assert.equal(dropBakedObject(makeState(baked, { stale: true }), baked[0]), null);
    assert.equal(dropBakedObject(null, baked[0]), null);
  });
});

describe('removalPatchRegion', () => {
  const bake = { height: 1200, retina: 2, transform: [1, 0, 0, 1, 0, 0] as const, width: 1600 };

  it('maps a scene box to whole device pixels, snapped outward', () => {
    assert.deepEqual(removalPatchRegion({ left: 10.3, top: 20.6, width: 30.2, height: 10.1 }, bake), {
      left: 20,
      top: 41,
      width: 61,
      height: 21,
    });
  });

  it('follows the viewport (zoom + pan) and the retina scale', () => {
    const zoomed = { ...bake, transform: [2, 0, 0, 2, 100, 50] as const };

    assert.deepEqual(removalPatchRegion({ left: 10, top: 20, width: 30, height: 10 }, zoomed), {
      left: (2 * 10 + 100) * 2,
      top: (2 * 20 + 50) * 2,
      width: 30 * 2 * 2,
      height: 10 * 2 * 2,
    });
  });

  it('clips to the bitmap and is null for a box entirely off it', () => {
    assert.deepEqual(removalPatchRegion({ left: -20, top: -20, width: 30, height: 30 }, bake), {
      left: 0,
      top: 0,
      width: 20,
      height: 20,
    });
    assert.equal(removalPatchRegion({ left: 2000, top: 10, width: 30, height: 30 }, bake), null);
    assert.equal(removalPatchRegion({ left: Number.NaN, top: 10, width: 30, height: 30 }, bake), null);
  });

  it('pads a box on every side; boxes that merely touch do not intersect', () => {
    assert.deepEqual(padSceneRect({ left: 10, top: 10, width: 5, height: 5 }, 3), { left: 7, top: 7, width: 11, height: 11 });
    assert.equal(sceneRectsIntersect({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 5, height: 5 }), false);
    assert.equal(sceneRectsIntersect({ left: 0, top: 0, width: 10, height: 10 }, { left: 9, top: 9, width: 5, height: 5 }), true);
  });
});

describe('bakeTranslation', () => {
  const bake = { height: 1200, retina: 1.75, transform: [1, 0, 0, 1, 10, -400], width: 1600 };

  it('is the whole-device-pixel shift between the bake and the frame', () => {
    // 8 device px at DPR 1.75 = 8 / 1.75 CSS px of viewport translation.
    assert.deepEqual(bakeTranslation(bake, { ...bake, transform: [1, 0, 0, 1, 10, -400 - 8 / 1.75] }), { dx: 0, dy: -8 });
    assert.deepEqual(bakeTranslation(bake, { ...bake, transform: [1, 0, 0, 1, 10 + 4 / 1.75, -400 + 12 / 1.75] }), {
      dx: 4,
      dy: 12,
    });
  });

  it('refuses a fractional shift — it would resample, and repeated resampling blurs the ink', () => {
    assert.equal(bakeTranslation(bake, { ...bake, transform: [1, 0, 0, 1, 10, -400.5] }), null);
  });

  it('refuses anything that is not a pure translation, and no move at all', () => {
    assert.equal(bakeTranslation(bake, { ...bake, transform: [1.5, 0, 0, 1.5, 10, -400] }), null);
    assert.equal(bakeTranslation(bake, { ...bake, retina: 2 }), null);
    assert.equal(bakeTranslation(bake, { ...bake, width: 800 }), null);
    assert.equal(bakeTranslation(bake, bake), null);
  });

  it('refuses a shift that leaves nothing of the bitmap on screen', () => {
    assert.equal(bakeTranslation(bake, { ...bake, transform: [1, 0, 0, 1, 10, -400 + 1200 / 1.75] }), null);
  });
});

describe('exposedStrips', () => {
  const area = (rects: { width: number; height: number }[]) => rects.reduce((sum, r) => sum + r.width * r.height, 0);

  for (const [dx, dy] of [
    [0, 7],
    [0, -7],
    [5, 0],
    [-5, 0],
    [3, -4],
    [-3, 4],
  ]) {
    it(`covers exactly what a shift by (${dx}, ${dy}) uncovers`, () => {
      const width = 40;
      const height = 30;
      const strips = exposedStrips(width, height, dx, dy);

      assert.equal(area(strips), width * height - (width - Math.abs(dx)) * (height - Math.abs(dy)));

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          // The pixel shows old content when its source (x - dx, y - dy) was inside the old bitmap.
          const covered = x - dx >= 0 && x - dx < width && y - dy >= 0 && y - dy < height;
          const hits = strips.filter((r) => x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height);

          assert.equal(hits.length, covered ? 0 : 1, `pixel ${x},${y}`);
        }
      }
    });
  }
});

describe('deviceRectToScene', () => {
  it('inverts removalPatchRegion', () => {
    const bake = { height: 1200, retina: 1.75, transform: [2, 0, 0, 2, 30, -500], width: 1600 };
    const scene = deviceRectToScene({ height: 70, left: 35, top: 140, width: 350 }, bake.retina, bake.transform);

    assert.deepEqual(removalPatchRegion(scene, bake), { height: 70, left: 35, top: 140, width: 350 });
  });
});

describe('scrolling a bake (pixel model)', () => {
  // A "render" paints each device pixel with the scene cell under it, so a shifted bake plus its
  // repainted strips must equal a fresh render under the new transform, pixel for pixel.
  const W = 48;
  const H = 36;
  const retina = 1.75;
  const paint = (transform: number[]) => {
    const pixels: number[] = [];

    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const sceneX = ((x + 0.5) / retina - transform[4]) / transform[0];
        const sceneY = ((y + 0.5) / retina - transform[5]) / transform[3];

        pixels.push(Math.floor(sceneX * 7) * 1009 + Math.floor(sceneY * 3));
      }
    }

    return pixels;
  };

  it('shift + exposed strips equals a full render', () => {
    const before = [1.3, 0, 0, 1.3, 2, -11];
    const after = [1.3, 0, 0, 1.3, 2 - 5 / retina, -11 + 9 / retina];
    const shift = bakeTranslation({ height: H, retina, transform: before, width: W }, { height: H, retina, transform: after, width: W });

    assert.ok(shift);

    const old = paint(before);
    const fresh = paint(after);
    const shifted = new Array<number>(W * H).fill(-1);

    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const sx = x - shift.dx;
        const sy = y - shift.dy;

        if (sx >= 0 && sx < W && sy >= 0 && sy < H) shifted[y * W + x] = old[sy * W + sx];
      }
    }

    for (const strip of exposedStrips(W, H, shift.dx, shift.dy)) {
      for (let y = strip.top; y < strip.top + strip.height; y += 1) {
        for (let x = strip.left; x < strip.left + strip.width; x += 1) shifted[y * W + x] = fresh[y * W + x];
      }
    }

    assert.deepEqual(shifted, fresh);
  });
});

describe('snapPanStep', () => {
  it('pans by whole device pixels and carries the remainder, losing no distance', () => {
    const retina = 1.75;
    let carry = { x: 0, y: 0 };
    let totalY = 0;

    for (let frame = 0; frame < 50; frame += 1) {
      const step = snapPanStep(0, -3.3, retina, carry);

      assert.ok(Math.abs(step.y * retina - Math.round(step.y * retina)) < 1e-9, 'whole device px');
      assert.ok(Math.abs(step.carry.y) <= 0.5);
      carry = step.carry;
      totalY += step.y;
    }

    assert.ok(Math.abs(totalY + carry.y / retina - -3.3 * 50) < 1e-9);
  });
});
