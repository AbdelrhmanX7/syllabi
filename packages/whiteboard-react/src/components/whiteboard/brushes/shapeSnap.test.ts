import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Path, Point } from 'fabric';

import type { Canvas } from 'fabric';

import { CalligraphyBrush } from './CalligraphyBrush';
import { createSnappedBrushObject, createSnappedShapeObject, SNAPPED_SHAPE_PROP } from './shapeSnap';

/**
 * Hold-to-snap with the calligraphy brush: the committed shape must be the brush's own swept outline
 * (a filled Path, like every brush stroke), not a uniform stroked line — and asking the brush for that
 * outline mid-stroke must leave the live stroke exactly as it was.
 */

function makeCanvas() {
  const noop = () => {};

  return {
    contextTop: {
      save: noop,
      restore: noop,
      beginPath: noop,
      moveTo: noop,
      lineTo: noop,
      stroke: noop,
      fill: noop,
      clearRect: noop,
      transform: noop,
      closePath: noop,
      setLineDash: noop,
      getLineDash: () => [],
    },
    width: 1920,
    height: 1080,
    viewportTransform: [1, 0, 0, 1, 0, 0] as const,
    clearContext: noop,
    _isMainEvent: () => true,
    getScenePoint: (point: Point) => point,
    getZoom: () => 1,
    getRetinaScaling: () => 1,
    requestRenderAll: noop,
    fire: noop,
    add: noop,
  } as unknown as Canvas;
}

const EVENT = { e: {} } as unknown as Parameters<CalligraphyBrush['onMouseDown']>[1];

// The live preview paints through Path2D, which node has no notion of; a recorder is enough here.
class StubPath2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
}

(globalThis as unknown as { Path2D: unknown }).Path2D ??= StubPath2D;
const line = { kind: 'line' as const, geometry: { type: 'poly' as const, closed: false, points: [{ x: 10, y: 10 }, { x: 210, y: 60 }] } };
const square = {
  kind: 'rectangle' as const,
  square: true,
  geometry: { type: 'poly' as const, closed: true, points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }] },
};
const circle = { kind: 'circle' as const, geometry: { type: 'ellipse' as const, cx: 100, cy: 100, rx: 50, ry: 50, angle: 0 } };

describe('hold-to-snap with the calligraphy brush', () => {
  it('commits the nib swept along the shape as a filled Path carrying the shape kind, with no vertex handles', () => {
    const brush = new CalligraphyBrush(makeCanvas());

    brush.width = 6;
    brush.color = 'navy';

    for (const shape of [line, square, circle]) {
      const object = createSnappedBrushObject(shape, { color: 'navy', opacity: 0.8 }, brush);

      assert.ok(object instanceof Path, `${shape.kind}: not a Path`);
      assert.equal(object.fill, 'navy');
      assert.equal(object.strokeWidth, 0);
      assert.equal(object.opacity, 0.8);
      assert.equal((object as Path & Record<string, unknown>)[SNAPPED_SHAPE_PROP], shape.kind);
      // A filled outline has no vertices to drag: the default scale box, never poly controls.
      assert.equal('p0' in object.controls, false, `${shape.kind}: vertex controls on a filled outline`);
      assert.ok(object.width > 0 && object.height > 0, `${shape.kind}: empty outline`);
    }

    // The swept line is wider than the nib's own width would be as a stroke: the nib's broad side shows.
    const sweptLine = createSnappedBrushObject(line, { color: '#000', opacity: 1 }, brush) as Path;

    assert.ok(sweptLine.height > 50 + 6, `swept line is as thin as a plain stroke (${sweptLine.height})`);
  });

  it('is what createSnappedShapeObject builds when the style names the nib; plain styles keep the stroked geometry', () => {
    const brush = new CalligraphyBrush(makeCanvas());
    const base = { color: '#000000', width: 4, opacity: 1, blur: 0 };

    assert.ok(createSnappedShapeObject(line, { ...base, nib: brush }) instanceof Path);
    assert.equal(createSnappedShapeObject(line, { ...base, nib: null }) instanceof Path, false);
    assert.equal(createSnappedShapeObject(square, { ...base, nib: null }).type, 'polygon');
  });

  it('asking for another outline mid-stroke leaves the live stroke untouched', () => {
    const brush = new CalligraphyBrush(makeCanvas());

    brush.onMouseDown(new Point(0, 0), EVENT);
    brush.onMouseMove(new Point(20, 5), EVENT);
    brush.onMouseMove(new Point(40, 12), EVENT);

    const livePoints = brush.liveStrokePoints;
    const liveBefore = livePoints.map((point) => ({ x: point.x, y: point.y }));
    const liveOutline = brush.outlinePathDataFor(liveBefore);

    const other = brush.outlinePathDataFor([new Point(100, 100), new Point(150, 100), new Point(200, 100)]);

    assert.ok(other && other.startsWith('M ') && other.endsWith(' Z'), 'no closed outline for the sampled shape');
    assert.equal(brush.liveStrokePoints, livePoints, 'the live _points array was replaced');
    assert.deepEqual(
      brush.liveStrokePoints.map((point) => ({ x: point.x, y: point.y })),
      liveBefore,
      'the live points changed',
    );
    assert.equal(brush.outlinePathDataFor(liveBefore), liveOutline, 'the live outline changed');
    // Too little to sweep: no outline, so the caller falls back to the stroked geometry.
    assert.equal(brush.outlinePathDataFor([]), null);
  });
});
