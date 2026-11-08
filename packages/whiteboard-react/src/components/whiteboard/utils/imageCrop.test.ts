import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FabricImage, Point, util } from 'fabric';

import {
  clampCropRect,
  cropRectOf,
  cropResult,
  dragCropRect,
  elementToScreenMatrix,
  isSameCrop,
  matrixAxisScales,
  minCropSize,
  screenDeltaToElement,
} from './imageCrop';
import { historyFingerprint } from './boardHistoryCanvas';
import { drawLockedImages } from './lockedImages';

const SOURCE = { width: 400, height: 300 };
const MIN = { width: 20, height: 20 };

const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} ${actual} ≈ ${expected}`);

function picture() {
  const element = { width: 400, height: 300, naturalWidth: 400, naturalHeight: 300 } as unknown as HTMLImageElement;

  return new FabricImage(element, { left: 100, top: 50, originX: 'left', originY: 'top' });
}

/** Where element pixel (ex, ey) of `image` lands in the scene. */
function sceneOf(image: FabricImage, ex: number, ey: number) {
  return util.transformPoint(new Point(ex - image.cropX - image.width / 2, ey - image.cropY - image.height / 2), image.calcTransformMatrix());
}

/** Applies a crop the way the editor does. */
function applyCrop(image: FabricImage, rect: { x: number; y: number; width: number; height: number }) {
  const result = cropResult(image.calcTransformMatrix(), image, rect);

  image.set({ cropX: result.cropX, cropY: result.cropY, width: result.width, height: result.height });
  image.setPositionByOrigin(new Point(result.center.x, result.center.y), 'center', 'center');
  image.setCoords();
}

describe('dragCropRect — grips resize, the body moves', () => {
  const start = { x: 100, y: 50, width: 200, height: 150 };

  it('an edge grip moves only its own edge', () => {
    assert.deepEqual(dragCropRect(start, 'e', 30, 99, SOURCE, MIN), { x: 100, y: 50, width: 230, height: 150 });
    assert.deepEqual(dragCropRect(start, 'w', 30, 99, SOURCE, MIN), { x: 130, y: 50, width: 170, height: 150 });
    assert.deepEqual(dragCropRect(start, 'n', 99, -20, SOURCE, MIN), { x: 100, y: 30, width: 200, height: 170 });
    assert.deepEqual(dragCropRect(start, 's', 99, 20, SOURCE, MIN), { x: 100, y: 50, width: 200, height: 170 });
  });

  it('a corner grip moves its two edges', () => {
    assert.deepEqual(dragCropRect(start, 'nw', -10, -10, SOURCE, MIN), { x: 90, y: 40, width: 210, height: 160 });
    assert.deepEqual(dragCropRect(start, 'se', 10, 10, SOURCE, MIN), { x: 100, y: 50, width: 210, height: 160 });
  });

  it('stops at the picture border', () => {
    assert.deepEqual(dragCropRect(start, 'nw', -500, -500, SOURCE, MIN), { x: 0, y: 0, width: 300, height: 200 });
    assert.deepEqual(dragCropRect(start, 'se', 500, 500, SOURCE, MIN), { x: 100, y: 50, width: 300, height: 250 });
  });

  it('never shrinks below the minimum, and the opposite edge stays put', () => {
    assert.deepEqual(dragCropRect(start, 'e', -500, 0, SOURCE, MIN), { x: 100, y: 50, width: 20, height: 150 });
    assert.deepEqual(dragCropRect(start, 'w', 500, 0, SOURCE, MIN), { x: 280, y: 50, width: 20, height: 150 });
  });

  it('moving keeps the size and stops at the border', () => {
    assert.deepEqual(dragCropRect(start, 'move', 15, -5, SOURCE, MIN), { x: 115, y: 45, width: 200, height: 150 });
    assert.deepEqual(dragCropRect(start, 'move', 999, 999, SOURCE, MIN), { x: 200, y: 150, width: 200, height: 150 });
    assert.deepEqual(dragCropRect(start, 'move', -999, -999, SOURCE, MIN), { x: 0, y: 0, width: 200, height: 150 });
  });
});

describe('clampCropRect / minCropSize', () => {
  it('pulls a frame back inside the picture', () => {
    assert.deepEqual(clampCropRect({ x: -10, y: 280, width: 50, height: 50 }, SOURCE, MIN), { x: 0, y: 250, width: 50, height: 50 });
    assert.deepEqual(clampCropRect({ x: 0, y: 0, width: 900, height: 5 }, SOURCE, MIN), { x: 0, y: 0, width: 400, height: 20 });
  });

  it('the minimum is a screen size: a zoomed-out picture needs more element px', () => {
    assert.deepEqual(minCropSize(1, SOURCE, 40), { width: 40, height: 40 });
    assert.deepEqual(minCropSize(0.5, SOURCE, 40), { width: 80, height: 80 });
    assert.deepEqual(minCropSize(0.05, SOURCE, 40), { width: 400, height: 300 }, 'never more than the picture');
  });
});

describe('cropResult — the kept region does not move on the board', () => {
  it('a plain picture: the kept pixels stay where they were', () => {
    const image = picture();
    const before = sceneOf(image, 150, 120);

    applyCrop(image, { x: 100, y: 80, width: 120, height: 90 });

    assert.equal(image.cropX, 100);
    assert.equal(image.cropY, 80);
    assert.equal(image.width, 120);
    assert.equal(image.height, 90);

    const after = sceneOf(image, 150, 120);

    near(after.x, before.x, 'x');
    near(after.y, before.y, 'y');
    near(image.left, 100 + 100, 'the frame starts where the kept region did');
    near(image.top, 50 + 80);
  });

  it('a rotated, scaled, flipped picture: the kept pixels stay where they were', () => {
    const image = picture();

    image.set({ angle: 33, scaleX: 0.6, scaleY: 0.6, flipX: true });
    image.setCoords();

    const probes = [
      [150, 120],
      [100, 80],
      [219, 169],
    ] as const;
    const before = probes.map(([x, y]) => sceneOf(image, x, y));

    applyCrop(image, { x: 100, y: 80, width: 120, height: 90 });
    probes.forEach(([x, y], index) => {
      const after = sceneOf(image, x, y);

      near(after.x, before[index]!.x, `x of ${x},${y}`);
      near(after.y, before[index]!.y, `y of ${x},${y}`);
    });
    assert.equal(image.angle, 33);
    assert.equal(image.scaleX, 0.6);
  });

  it('a re-crop can widen back out to the whole picture, still in place', () => {
    const image = picture();
    const before = sceneOf(image, 0, 0);

    image.set({ angle: -20 });
    applyCrop(image, { x: 100, y: 80, width: 120, height: 90 });

    const rotatedOrigin = sceneOf(image, 0, 0);

    applyCrop(image, { x: 0, y: 0, width: 400, height: 300 });

    const after = sceneOf(image, 0, 0);

    near(after.x, rotatedOrigin.x);
    near(after.y, rotatedOrigin.y);
    assert.equal(image.cropX, 0);
    assert.equal(image.width, 400);
    assert.ok(before);
  });

  it('isSameCrop spots a frame that was not changed', () => {
    const image = picture();

    assert.ok(isSameCrop(image, cropRectOf(image)));
    assert.ok(!isSameCrop(image, { x: 1, y: 0, width: 399, height: 300 }));
  });
});

describe('the overlay matrix — element px on screen', () => {
  it('maps element px to the canvas and screen deltas back to element px', () => {
    const image = picture();

    image.set({ angle: 90, scaleX: 0.5, scaleY: 0.5 });
    image.setCoords();

    const viewport = [2, 0, 0, 2, 10, 20] as const;
    const m = elementToScreenMatrix(viewport, image.calcTransformMatrix(), image);
    const expected = util.transformPoint(sceneOf(image, 40, 30), viewport as unknown as [number, number, number, number, number, number]);

    near(m[0] * 40 + m[2] * 30 + m[4], expected.x);
    near(m[1] * 40 + m[3] * 30 + m[5], expected.y);

    const scales = matrixAxisScales(m);

    near(scales.x, 1);
    near(scales.y, 1);

    // Rotated 90°: a screen drag DOWN is a drag along the picture's +x.
    const delta = screenDeltaToElement(m, 0, 10);

    near(delta.x, 10);
    near(delta.y, 0);
  });
});

describe('a crop is saved, undone and drawn like any other edit', () => {
  it('serializes cropX / cropY / width / height (the page JSON and every history snapshot)', () => {
    const image = picture();

    applyCrop(image, { x: 100, y: 80, width: 120, height: 90 });

    const json = image.toObject() as unknown as Record<string, unknown>;

    assert.equal(json.cropX, 100);
    assert.equal(json.cropY, 80);
    assert.equal(json.width, 120);
    assert.equal(json.height, 90);
  });

  it('the history fingerprint sees a frame slid inside the picture (box unchanged)', () => {
    const image = picture();

    image.set({ width: 200, height: 150 });

    const before = historyFingerprint(image);

    image.set({ cropX: 50 });
    assert.notEqual(historyFingerprint(image), before);
    image.set({ cropX: 0, cropY: 30 });
    assert.notEqual(historyFingerprint(image), before);
  });

  it('a pinned (background-painted) picture draws only its cropped part', () => {
    const image = picture();
    const calls: unknown[][] = [];
    const ctx = {
      save() {},
      restore() {},
      setTransform() {},
      drawImage: (...args: unknown[]) => calls.push(args),
    } as unknown as CanvasRenderingContext2D;

    applyCrop(image, { x: 100, y: 80, width: 120, height: 90 });
    drawLockedImages(ctx, [image], undefined);

    assert.deepEqual(calls[0]!.slice(1), [100, 80, 120, 90, -60, -45, 120, 90]);
  });
});
