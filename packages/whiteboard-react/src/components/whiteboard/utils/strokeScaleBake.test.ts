import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActiveSelection, Path } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import {
  bakeLinearIntoPath,
  bakePathScale,
  bakeTransformedInk,
  dimensionMatrix,
  enableStrokeScaleBake,
  installStrokeScaleBake,
  isIdentityDimensions,
  makeStrokeUniform,
} from './strokeScaleBake';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** A 100 px horizontal line from (100,100) to (200,100), width 4. */
const line = () => new Path('M 100 100 L 200 100', { fill: null, stroke: 'navy', strokeWidth: 4 });

/** Scene end points of a single-segment path. */
function sceneEnds(path: Path) {
  const m = path.calcTransformMatrix();
  const cmds = path.path as unknown as (string | number)[][];

  return cmds.map((c) => {
    const x = Number(c[1]) - path.pathOffset.x;
    const y = Number(c[2]) - path.pathOffset.y;

    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  });
}

/** Just what `bakeTransformedInk` touches on a Fabric canvas. */
function fakeCanvas(active: FabricObject | null) {
  let current = active;
  const fired: FabricObject[] = [];
  const canvas = {
    getActiveObject: () => current,
    discardActiveObject: () => {
      if (current instanceof ActiveSelection) current.removeAll();
      current = null;

      return true;
    },
    setActiveObject: (o: FabricObject) => {
      current = o;
    },
    fire: (name: string, e: { target: FabricObject }) => {
      if (name === 'object:modified') fired.push(e.target);
    },
  };

  return { canvas: canvas as unknown as Canvas, fired, active: () => current };
}

describe('stroke scale bake — pure math', () => {
  it('identity transforms are recognised', () => {
    assert.ok(isIdentityDimensions({}));
    assert.ok(isIdentityDimensions({ scaleX: 1, scaleY: 1 }));
    assert.ok(!isIdentityDimensions({ scaleX: 2 }));
    assert.ok(!isIdentityDimensions({ flipX: true }));
    assert.ok(!isIdentityDimensions({ skewX: 10 }));
  });

  it('bakes scale and flip into every coordinate pair, relative to the offset', () => {
    const out = bakeLinearIntoPath(
      [
        ['M', 10, 20],
        ['Q', 12, 22, 14, 20],
        ['Z'],
      ],
      { x: 10, y: 20 },
      dimensionMatrix({ scaleX: 2, scaleY: 3, flipY: true }),
    );

    const plain = out.map((c) => c.map((v) => (typeof v === 'number' ? v + 0 : v)));

    assert.deepEqual(plain, [['M', 0, 0], ['Q', 4, -6, 8, 0], ['Z']]);
  });
});

describe('stroke scale bake — on a Path', () => {
  it('a horizontal line stretched ×2 becomes 200 px long; its width and centre stay', () => {
    const path = line();
    const center = path.getCenterPoint();

    path.set({ scaleX: 2, strokeUniform: true });
    assert.ok(bakePathScale(path));

    assert.equal(path.scaleX, 1);
    assert.equal(path.scaleY, 1);
    assert.equal(path.strokeWidth, 4);
    near(path.width, 200);
    near(path.getCenterPoint().x, center.x);
    near(path.getCenterPoint().y, center.y);
    const [a, b] = sceneEnds(path);

    near(a!.x, 50);
    near(b!.x, 250);
  });

  it('keeps the scene geometry exactly under non-uniform scale, flip and rotation', () => {
    const path = new Path('M 0 0 L 30 10 L 10 40', { fill: null, stroke: 'red', strokeWidth: 2, strokeUniform: true, left: 50, top: 60 });

    path.set({ scaleX: 1.5, scaleY: 0.5, flipX: true, angle: 30 });
    const before = sceneEnds(path);

    bakePathScale(path);
    const after = sceneEnds(path);

    assert.equal(path.angle, 30, 'the angle is kept');
    assert.equal(path.flipX, false);
    before.forEach((p, i) => {
      near(after[i]!.x, p.x, 1e-6);
      near(after[i]!.y, p.y, 1e-6);
    });
  });

  it('a stroke that scaled its width (old board) keeps the width it showed', () => {
    const path = line();

    path.set({ scaleX: 2, scaleY: 2 });
    bakePathScale(path);
    assert.equal(path.strokeWidth, 8);
  });

  it('an unscaled path is left alone', () => {
    const path = line();
    const commands = path.path;

    assert.equal(bakePathScale(path), false);
    assert.equal(path.path, commands);
  });

  it('survives a save / load round trip as a plain, unscaled stroke', async () => {
    const path = line();

    path.set({ scaleX: 3, strokeUniform: true });
    bakePathScale(path);
    const revived = await Path.fromObject(path.toObject() as never);

    assert.equal(revived.scaleX, 1);
    assert.equal(revived.strokeWidth, 4);
    near(revived.width, 300);
  });
});

describe('makeStrokeUniform', () => {
  it('turns a plain stroke uniform without changing its width at scale 1', () => {
    const path = line();

    makeStrokeUniform(path);
    assert.equal(path.strokeUniform, true);
    assert.equal(path.strokeWidth, 4);
  });

  it('folds an existing scale into the width so the stroke does not thin out', () => {
    const path = line();

    path.set({ scaleX: 2, scaleY: 2 });
    makeStrokeUniform(path);
    assert.equal(path.strokeWidth, 8);
  });

  it('leaves a filled outline (no stroke) alone', () => {
    const path = new Path('M 0 0 L 10 0 L 10 10 Z', { fill: 'black', stroke: '', strokeWidth: 0 });

    makeStrokeUniform(path);
    assert.equal(path.strokeUniform, false);
  });
});

describe('bakeTransformedInk — a scaled multi-selection', () => {
  it('bakes every member, announces each, and reselects the same objects', () => {
    const a = line();
    const b = new Path('M 100 140 L 200 140', { fill: null, stroke: 'navy', strokeWidth: 4 });
    const selection = new ActiveSelection([a, b]);
    const { canvas, fired, active } = fakeCanvas(selection);

    makeStrokeUniform(selection);
    selection.set({ scaleX: 2 });
    selection.setCoords();

    assert.equal(bakeTransformedInk(canvas, selection), 2);
    assert.deepEqual(fired, [a, b]);
    for (const member of [a, b]) {
      near(member.scaleX, 1);
      assert.equal(member.strokeWidth, 4);
      near(member.width, 200);
    }

    const reselected = active();

    assert.ok(reselected instanceof ActiveSelection);
    assert.deepEqual((reselected as ActiveSelection).getObjects(), [a, b]);
  });

  it('inside the gesture (transform still open): no nested modified, later listeners get the rebuilt selection', () => {
    const a = line();
    const b = new Path('M 100 140 L 200 140', { fill: null, stroke: 'navy', strokeWidth: 4 });
    const selection = new ActiveSelection([a, b]);
    const listeners: ((e: { target?: FabricObject }) => void)[] = [];
    let current: FabricObject | null = selection;
    let modifiedFires = 0;
    const canvas = {
      _currentTransform: { target: selection as FabricObject } as { target: FabricObject } | null,
      on: (name: string, fn: (e: { target?: FabricObject }) => void) => {
        if (name === 'object:modified') listeners.push(fn);
      },
      off: () => undefined,
      fire(name: string, e: { target?: FabricObject }) {
        if (name !== 'object:modified') return;
        modifiedFires += 1;
        listeners.forEach((fn) => fn(e));
      },
      getActiveObject: () => current,
      // Fabric 7: discarding the transform's own target ENDS the transform (another object:modified).
      discardActiveObject() {
        if (current instanceof ActiveSelection) current.removeAll();
        if (this._currentTransform && this._currentTransform.target === selection) this.fire('object:modified', { target: selection });
        current = null;
      },
      setActiveObject: (o: FabricObject) => {
        current = o;
      },
      requestRenderAll: () => undefined,
    };
    const uninstall = installStrokeScaleBake(canvas as unknown as Canvas);
    const unenable = enableStrokeScaleBake(canvas as unknown as Canvas);
    const seen: (FabricObject | undefined)[] = [];

    canvas.on('object:modified', (e) => seen.push(e.target));
    makeStrokeUniform(selection);
    selection.set({ scaleX: 2 });
    canvas.fire('object:modified', { target: selection });

    assert.equal(modifiedFires, 3, 'the gesture + one per baked member, nothing nested');
    assert.ok(seen[seen.length - 1] instanceof ActiveSelection);
    assert.notEqual(seen[seen.length - 1], selection);
    assert.equal(canvas._currentTransform?.target, current, 'the open transform follows the rebuilt selection');
    near(a.width, 200);
    unenable();
    uninstall();
  });

  it('a moved (unscaled) selection is untouched', () => {
    const a = line();
    const selection = new ActiveSelection([a, line()]);
    const { canvas } = fakeCanvas(selection);

    selection.set({ left: selection.left + 30 });
    assert.equal(bakeTransformedInk(canvas, selection), 0);
  });
});
