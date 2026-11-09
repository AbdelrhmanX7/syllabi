import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Point, Polyline } from 'fabric';

import type { FabricObject, TPointerEvent, Transform } from 'fabric';

import { compactCanvasJson } from '../utils/canvasJson';
import { radicalVertices } from '../utils/radicalSign';
import type { RadicalParams } from '../utils/radicalSign';
import { adjustSnappedShape, radicalShape, recognizeShape } from '../utils/shapeRecognition';
import { applyRadicalControls, isRadicalObject, RADICAL_PARAMS_PROP, setRadicalParams } from './radicalObject';
import { applySnappedShapeControls, createSnappedShapeObject, registerSnappedShapePersistence, SNAPPED_SHAPE_PROP } from './shapeSnap';

const STYLE = { color: '#2563eb', width: 3, opacity: 1, blur: 0, nib: null };
const PARAMS: RadicalParams = { height: 100, bar: 150, tick: 40 };

function makeRadical(anchor = { x: 200, y: 100 }, params = PARAMS) {
  return createSnappedShapeObject(radicalShape({ anchor, params }), STYLE) as Polyline;
}

/** Where a radical's own point `index` is in the scene. */
function scenePoint(object: Polyline, index: number): Point {
  return new Point(object.points[index]).subtract(object.pathOffset).transform(object.calcTransformMatrix());
}

const near = (a: Point, b: { x: number; y: number }, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
const params = (object: FabricObject) => (object as FabricObject & { [RADICAL_PARAMS_PROP]: RadicalParams })[RADICAL_PARAMS_PROP];

function drag(object: Polyline, control: 'bar' | 'depth', x: number, y: number): boolean {
  const handler = object.controls[control].actionHandler;

  return handler({} as TPointerEvent, { target: object } as unknown as Transform, x, y);
}

describe('radical object', () => {
  it('is a plain Polyline with the radical marker, its params and only the two stretch handles', () => {
    const object = makeRadical();

    assert.ok(object instanceof Polyline);
    assert.equal((object as unknown as Record<string, unknown>)[SNAPPED_SHAPE_PROP], 'radical');
    assert.ok(isRadicalObject(object));
    assert.deepEqual(Object.keys(object.controls).sort(), ['bar', 'depth']);
    assert.equal(object.lockScalingX, true);
    assert.equal(object.lockScalingY, true);
    assert.equal(object.strokeUniform, true);
    assert.ok(near(scenePoint(object, 3), { x: 200, y: 100 }), 'the stem top is the anchor');
  });

  it('the selection box hugs the sign (its points bbox; Fabric adds the stroke on top)', () => {
    const object = makeRadical();
    const v = radicalVertices(PARAMS);
    const xs = [v.serif, v.tickTop, v.bottom, v.top, v.barEnd].map((p) => p.x);

    assert.ok(Math.abs(object.width - (Math.max(...xs) - Math.min(...xs))) < 1e-6);
    assert.ok(Math.abs(object.height - (PARAMS.height + Math.max(0, v.serif.y - v.bottom.y))) < 1e-6);
  });

  it('stretching the bar regenerates the sign: anchor fixed, tick and stroke unchanged, never scaled', () => {
    const object = makeRadical();
    const tickBefore = Math.hypot(object.points[1].x - object.points[2].x, object.points[1].y - object.points[2].y);

    assert.equal(drag(object, 'bar', 200 + 420, 137), true);

    assert.equal(params(object).bar, 420);
    assert.equal(params(object).height, 100);
    assert.ok(near(scenePoint(object, 3), { x: 200, y: 100 }));
    assert.ok(near(scenePoint(object, 4), { x: 620, y: 100 }), 'the bar ends under the pointer, still horizontal');
    assert.equal(object.scaleX, 1);
    assert.equal(object.scaleY, 1);
    assert.equal(object.strokeWidth, 3);

    const tickAfter = Math.hypot(object.points[1].x - object.points[2].x, object.points[1].y - object.points[2].y);

    assert.ok(Math.abs(tickAfter - tickBefore) < 1e-9);
  });

  it('stretching the depth makes it deeper with the bar where it was', () => {
    const object = makeRadical();

    assert.equal(drag(object, 'depth', 0, 100 + 300), true);
    assert.equal(params(object).height, 300);
    assert.equal(params(object).bar, 150);
    assert.ok(near(scenePoint(object, 3), { x: 200, y: 100 }));
    assert.ok(Math.abs(scenePoint(object, 2).y - 400) < 1e-6);
  });

  it('cannot be crushed below the tick: the floors hold', () => {
    const object = makeRadical();

    drag(object, 'bar', -1000, 100);
    drag(object, 'depth', 200, -1000);

    assert.ok(params(object).bar >= PARAMS.tick);
    assert.ok(params(object).height > PARAMS.tick);
    assert.equal(params(object).tick, PARAMS.tick);
  });

  it('keeps the anchor through a stretch after the object was moved and rotated', () => {
    const object = makeRadical();

    object.set({ left: object.left + 333, top: object.top - 50, angle: 30 });
    object.setCoords();

    const anchor = scenePoint(object, 3);
    const barEnd = scenePoint(object, 4);

    // Drag along the (rotated) bar direction to twice the length.
    const target = { x: anchor.x + (barEnd.x - anchor.x) * 2, y: anchor.y + (barEnd.y - anchor.y) * 2 };

    assert.equal(drag(object, 'bar', target.x, target.y), true);
    assert.ok(Math.abs(params(object).bar - 300) < 1e-6);
    assert.ok(near(scenePoint(object, 3), anchor, 1e-6));
    assert.ok(near(scenePoint(object, 4), target, 1e-6));
  });

  it('a no-op drag reports no change', () => {
    const object = makeRadical();

    assert.equal(setRadicalParams(object, { ...PARAMS }), false);
  });

  it('round-trips through toObject / fromObject and comes back stretchable', async () => {
    registerSnappedShapePersistence();

    const object = makeRadical();

    drag(object, 'bar', 200 + 260, 100);

    // The editor's own save path: canvas.toJSON() → the size pass (2-decimal points) → JSON.
    const page = JSON.parse(JSON.stringify(compactCanvasJson({ objects: [object.toObject()] }))) as { objects: Array<Record<string, unknown>> };
    const json = page.objects[0];

    assert.equal(json.type, 'Polyline', 'a built-in type: older builds load it as a line');
    assert.equal(json[SNAPPED_SHAPE_PROP], 'radical');
    assert.deepEqual(json[RADICAL_PARAMS_PROP], { height: 100, bar: 260, tick: 40 });

    const revived = (await Polyline.fromObject(json as never)) as Polyline;

    applySnappedShapeControls(revived);

    assert.ok(isRadicalObject(revived));
    assert.deepEqual(Object.keys(revived.controls).sort(), ['bar', 'depth']);
    // Points are stored with 2 decimals.
    assert.ok(near(scenePoint(revived, 3), { x: 200, y: 100 }, 0.01));
    assert.equal(drag(revived, 'depth', 0, 100 + 180), true);
    assert.equal(params(revived).height, 180);
    assert.ok(near(scenePoint(revived, 3), { x: 200, y: 100 }, 0.01));
  });

  it('its selection outline follows the sign, not its bounding box', () => {
    const object = makeRadical();

    object.set({ angle: 20 });
    object.setCoords();

    const calls: Array<[string, number, number]> = [];
    const ctx = {
      save() {},
      restore() {},
      beginPath() {},
      stroke() {},
      setLineDash() {},
      moveTo: (x: number, y: number) => calls.push(['M', x, y]),
      lineTo: (x: number, y: number) => calls.push(['L', x, y]),
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const center = object.getCenterPoint();

    object.drawBorders(ctx, { translateX: center.x, translateY: center.y } as never, {});

    assert.equal(calls.length, 5, 'one segment per piece of the sign');

    // Back into the scene: rotate by the angle and add the centre — must land on the sign's points.
    const r = (20 * Math.PI) / 180;

    calls.forEach(([, x, y], i) => {
      const scene = { x: center.x + x * Math.cos(r) - y * Math.sin(r), y: center.y + x * Math.sin(r) + y * Math.cos(r) };

      assert.ok(near(scenePoint(object, i), scene, 1e-6), `point ${i}`);
    });
  });

  it('an old-style polyline without params keeps the generic controls', () => {
    const plain = new Polyline([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);

    assert.equal(isRadicalObject(plain), false);
    assert.equal(setRadicalParams(plain, PARAMS), false);
  });
});

describe('radical in the hold-to-snap pipeline', () => {
  it('recognizeShape returns a radical for a drawn √ and a line still for a line', () => {
    const stroke: Array<{ x: number; y: number }> = [];
    const path = [
      { x: 160, y: 160 },
      { x: 180, y: 200 },
      { x: 200, y: 100 },
      { x: 360, y: 100 },
    ];

    for (let i = 1; i < path.length; i += 1) {
      for (let t = 0; t < 1; t += 0.05) {
        stroke.push({ x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t });
      }
    }

    stroke.push(path[path.length - 1]);

    const shape = recognizeShape(stroke, { minSize: 20 });

    assert.equal(shape.kind, 'radical');

    const line = recognizeShape(
      Array.from({ length: 40 }, (_, i) => ({ x: i * 5, y: 0 })),
      { minSize: 20 },
    );

    assert.equal(line.kind, 'line');

    // The post-snap drag stretches the bar only.
    if (shape.kind !== 'radical') return;

    const adjusted = adjustSnappedShape(shape, { x: 360, y: 100 }, { x: 460, y: 140 });

    assert.equal(adjusted.kind, 'radical');

    if (adjusted.kind !== 'radical') return;

    assert.ok(Math.abs(adjusted.radical.params.bar - (shape.radical.params.bar + 100)) < 1e-6);
    assert.equal(adjusted.radical.params.height, shape.radical.params.height);
    assert.equal(adjusted.radical.params.tick, shape.radical.params.tick);
    assert.deepEqual(adjusted.radical.anchor, shape.radical.anchor);
  });

  it('hovering a loaded radical with Select does not crash (handle positions follow the swapped handles)', () => {
    const object = makeRadical();

    // findControl only answers on a canvas; the handle math only needs its viewport.
    object.canvas = { viewportTransform: [1, 0, 0, 1, 0, 0], getActiveObject: () => object } as unknown as FabricObject['canvas'];
    // A board load: the box handles' positions get computed, then the radical handles replace them.
    object.controls = new Polyline([{ x: 0, y: 0 }, { x: 1, y: 1 }]).controls;
    object.setCoords();
    applyRadicalControls(object);
    assert.deepEqual(Object.keys(object.oCoords).sort(), Object.keys(object.controls).sort());
    assert.doesNotThrow(() => object.findControl(new Point(0, 0)));

    // Safety net: controls swapped behind Fabric's back still never throw on hover.
    object.controls = { bar: object.controls.bar };
    assert.doesNotThrow(() => object.findControl(new Point(0, 0)));
  });
});
