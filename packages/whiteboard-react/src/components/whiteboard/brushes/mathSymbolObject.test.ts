import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Point, Polyline } from 'fabric';

import type { FabricObject, TPointerEvent, Transform } from 'fabric';

import { compactCanvasJson } from '../utils/canvasJson';
import type { MathSymbolParams } from '../utils/mathSymbols';
import { adjustSnappedShape, mathSymbolShape, recognizeShape } from '../utils/shapeRecognition';
import { isMathSymbolObject, MATH_SYMBOL_PROP, setMathSymbolParams } from './mathSymbolObject';
import type { LowLatencyPencilBrush } from './LowLatencyPencilBrush';
import { applySnappedShapeControls, createSnappedShapeObject, registerSnappedShapePersistence, ShapeSnapController, SNAPPED_SHAPE_PROP } from './shapeSnap';

const STYLE = { color: '#2563eb', width: 3, opacity: 0.8, blur: 0, nib: null };

const BRACKET: MathSymbolParams = { kind: 'bracket', side: 'left', height: 100, arm: 20 };
const ARROW: MathSymbolParams = { kind: 'arrow', length: 150, angle: 0, head: 30 };

function make(params: MathSymbolParams, anchor = { x: 200, y: 100 }) {
  return createSnappedShapeObject(mathSymbolShape({ anchor, params }), STYLE) as Polyline;
}

function scenePoint(object: Polyline, index: number): Point {
  return new Point(object.points[index]).subtract(object.pathOffset).transform(object.calcTransformMatrix());
}

const near = (a: Point, b: { x: number; y: number }, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
const params = (object: FabricObject) => (object as FabricObject & { [MATH_SYMBOL_PROP]: MathSymbolParams })[MATH_SYMBOL_PROP];

function drag(object: Polyline, x: number, y: number): boolean {
  return object.controls.stretch.actionHandler({} as TPointerEvent, { target: object } as unknown as Transform, x, y);
}

describe('math symbol object', () => {
  it('is a plain Polyline with the marker, its params, the pen style and only the stretch handle', () => {
    for (const p of [BRACKET, ARROW, { kind: 'brace', side: 'right', height: 120, depth: 30 } as MathSymbolParams]) {
      const object = make(p);

      assert.ok(object instanceof Polyline);
      assert.equal((object as unknown as Record<string, unknown>)[SNAPPED_SHAPE_PROP], p.kind);
      assert.ok(isMathSymbolObject(object));
      assert.deepEqual(Object.keys(object.controls), ['stretch']);
      assert.equal(object.lockScalingX, true);
      assert.equal(object.stroke, '#2563eb');
      assert.equal(object.strokeWidth, 3);
      assert.equal(object.opacity, 0.8);
      assert.ok(near(scenePoint(object, 0), { x: 200, y: 100 }), 'the first point is the anchor');
    }
  });

  it('stretching a bracket makes it taller: top fixed, serifs and stroke unchanged, never scaled', () => {
    const object = make(BRACKET);
    const last = object.points.length - 1;

    assert.equal(drag(object, 0, 100 + 180), true);
    assert.equal((params(object) as { height: number }).height, 180);
    assert.equal((params(object) as { arm: number }).arm, 20);
    assert.ok(near(scenePoint(object, 0), { x: 200, y: 100 }));
    assert.ok(Math.abs(scenePoint(object, last).y - 280) < 1e-6);
    assert.equal(object.scaleX, 1);
    assert.equal(object.scaleY, 1);
    assert.equal(object.strokeWidth, 3);
  });

  it('stretching an arrow moves its tip; the head keeps its size', () => {
    const object = make(ARROW);

    assert.equal(drag(object, 200 + 100, 100 + 100), true);

    const p = params(object) as Extract<MathSymbolParams, { kind: 'arrow' }>;

    assert.ok(Math.abs(p.length - Math.hypot(100, 100)) < 1e-6);
    assert.ok(Math.abs(p.angle - Math.PI / 4) < 1e-6);
    assert.equal(p.head, 30);
    assert.ok(near(scenePoint(object, 0), { x: 200, y: 100 }));
    assert.ok(near(scenePoint(object, 1), { x: 300, y: 200 }));
  });

  it('keeps the anchor through a stretch after the object was moved and rotated', () => {
    const object = make(BRACKET);

    object.set({ left: object.left + 333, top: object.top - 50, angle: 30 });
    object.setCoords();

    const anchor = scenePoint(object, 0);
    const bottom = scenePoint(object, object.points.length - 1);
    const target = { x: anchor.x + (bottom.x - anchor.x) * 2, y: anchor.y + (bottom.y - anchor.y) * 2 };

    assert.equal(drag(object, target.x, target.y), true);
    assert.ok(Math.abs((params(object) as { height: number }).height - 200) < 1e-6);
    assert.ok(near(scenePoint(object, 0), anchor, 1e-6));
  });

  it('a no-op change reports no change', () => {
    assert.equal(setMathSymbolParams(make(BRACKET), { ...BRACKET }), false);
  });

  it('round-trips through the save path and comes back stretchable', async () => {
    registerSnappedShapePersistence();

    const object = make({ kind: 'integral', height: 150, hook: 20 });
    const page = JSON.parse(JSON.stringify(compactCanvasJson({ objects: [object.toObject()] }))) as { objects: Array<Record<string, unknown>> };
    const json = page.objects[0];

    assert.equal(json.type, 'Polyline', 'a built-in type: older builds load it as a line');
    assert.equal(json[SNAPPED_SHAPE_PROP], 'integral');
    assert.deepEqual(json[MATH_SYMBOL_PROP], { kind: 'integral', hook: 20, height: 150 });

    const revived = (await Polyline.fromObject(json as never)) as Polyline;

    applySnappedShapeControls(revived);

    assert.ok(isMathSymbolObject(revived));
    assert.deepEqual(Object.keys(revived.controls), ['stretch']);
    assert.equal(drag(revived, 0, 100 + 250), true);
    assert.equal((params(revived) as { height: number }).height, 250);
    assert.ok(near(scenePoint(revived, 0), { x: 200, y: 100 }, 0.01));
  });

  it('a closing brace and a slanted arrow keep their side and tip through a reload', async () => {
    registerSnappedShapePersistence();

    for (const p of [
      { kind: 'brace', side: 'right', height: 120, depth: 30 },
      { kind: 'arrow', length: 150, angle: Math.PI / 4, head: 30 },
    ] as MathSymbolParams[]) {
      const page = JSON.parse(JSON.stringify(compactCanvasJson({ objects: [make(p).toObject()] }))) as { objects: Array<Record<string, unknown>> };
      const revived = (await Polyline.fromObject(page.objects[0] as never)) as Polyline;

      applySnappedShapeControls(revived);

      const index = p.kind === 'arrow' ? 1 : revived.points.length - 1;
      const handle = scenePoint(revived, index);

      assert.equal(drag(revived, handle.x, handle.y + 0.5), true);
      if (p.kind === 'brace') assert.equal((params(revived) as { side: string }).side, 'right');
      assert.ok(near(scenePoint(revived, index), { x: handle.x, y: handle.y + 0.5 }, 0.05), 'the handle point follows, no jump');
    }
  });

  it('an old-style polyline without params keeps the generic controls', () => {
    const plain = new Polyline([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);

    (plain as unknown as Record<string, unknown>)[SNAPPED_SHAPE_PROP] = 'bracket';
    applySnappedShapeControls(plain);

    assert.ok(!isMathSymbolObject(plain));
    assert.ok(!('stretch' in plain.controls));
  });

  it('the hold-drag after a snap regenerates instead of scaling', () => {
    // A drawn «[» held at its bottom serif, then dragged down 50: taller, serifs unchanged.
    const drawn = [
      { x: 125, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 200 },
      { x: 125, y: 200 },
    ];
    const dense: { x: number; y: number }[] = [];

    for (let i = 1; i < drawn.length; i += 1) {
      for (let t = 0; t < 1; t += 0.04) dense.push({ x: drawn[i - 1].x + (drawn[i].x - drawn[i - 1].x) * t, y: drawn[i - 1].y + (drawn[i].y - drawn[i - 1].y) * t });
    }
    dense.push(drawn[3]);

    const snapped = recognizeShape(dense, { minSize: 20, mathSymbols: true });

    assert.equal(snapped.kind, 'bracket');

    const adjusted = adjustSnappedShape(snapped, { x: 125, y: 200 }, { x: 140, y: 250 });

    assert.ok('symbol' in adjusted);

    const p = adjusted.symbol.params as Extract<MathSymbolParams, { kind: 'bracket' }>;

    assert.ok(Math.abs(p.height - 150) < 3, `height ${p.height}`);
    assert.equal(p.arm, (snapped as { symbol: { params: { arm: number } } }).symbol.params.arm);
    assert.ok(Math.abs(adjusted.symbol.anchor.y - 100) < 3);
  });
});

/** Densify a polyline the way a pen's samples would. */
function densify(path: { x: number; y: number }[], step = 0.04): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];

  for (let i = 1; i < path.length; i += 1) {
    for (let t = 0; t < 1; t += step) out.push({ x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t });
  }
  out.push(path[path.length - 1]);

  return out;
}

const BRACKET_STROKE = densify([
  { x: 125, y: 100 },
  { x: 100, y: 100 },
  { x: 100, y: 200 },
  { x: 125, y: 200 },
]);
const RADICAL_STROKE = densify(
  [
    { x: 150, y: 160 },
    { x: 165, y: 150 },
    { x: 180, y: 200 },
    { x: 200, y: 100 },
    { x: 360, y: 100 },
  ],
  0.05,
);

/** Lift a whole stroke through the controller (no hold): what lands on the canvas, if anything. */
function liftThroughController(points: { x: number; y: number }[], mathSymbolSnap: boolean | undefined): FabricObject[] {
  const added: FabricObject[] = [];
  const noop = () => {};
  const canvas = { getZoom: () => 1, add: (o: FabricObject) => added.push(o), requestRenderAll: noop, clearContext: noop, contextTop: null };
  const brush = { canvas, color: '#2563eb', width: 3, liveStrokePoints: points.map((p) => new Point(p.x, p.y)) } as unknown as LowLatencyPencilBrush;
  const controller = new ShapeSnapController({
    isEnabled: () => true,
    getOpacity: () => 1,
    ...(mathSymbolSnap === undefined ? {} : { isMathSymbolSnapEnabled: () => mathSymbolSnap }),
  });

  controller.strokeStart(brush, new Point(points[0].x, points[0].y));
  controller.strokeFinalize(brush);
  controller.cancel();

  return added;
}

describe('«Clean up math symbols» setting', () => {
  it('is off by default: a drawn bracket stays ink on a hold and on a lift', () => {
    assert.notEqual(recognizeShape(BRACKET_STROKE, { minSize: 20 }).kind, 'bracket');
    assert.notEqual(recognizeShape(BRACKET_STROKE, { minSize: 20, mathSymbols: false }).kind, 'bracket');
    assert.equal(liftThroughController(BRACKET_STROKE, undefined).length, 0);
    assert.equal(liftThroughController(BRACKET_STROKE, false).length, 0);
  });

  it('when on, the same bracket snaps on a hold and on a lift', () => {
    assert.equal(recognizeShape(BRACKET_STROKE, { minSize: 20, mathSymbols: true }).kind, 'bracket');

    const added = liftThroughController(BRACKET_STROKE, true);

    assert.equal(added.length, 1);
    assert.ok(isMathSymbolObject(added[0]));
  });

  it('the square root snaps whatever the setting', () => {
    for (const on of [undefined, false, true]) {
      assert.equal(recognizeShape(RADICAL_STROKE, { minSize: 20, mathSymbols: on }).kind, 'radical', `hold, setting ${on}`);

      const added = liftThroughController(RADICAL_STROKE, on);

      assert.equal(added.length, 1, `lift, setting ${on}`);
      assert.equal((added[0] as FabricObject & { [SNAPPED_SHAPE_PROP]?: string })[SNAPPED_SHAPE_PROP], 'radical');
    }
  });
});
