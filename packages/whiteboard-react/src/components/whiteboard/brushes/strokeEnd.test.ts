import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Point } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { CalligraphyBrush } from './CalligraphyBrush';
import { LowLatencyPencilBrush } from './LowLatencyPencilBrush';
import { SoftMarkerBrush } from './SoftMarkerBrush';
import { ScriptBrush } from './ScriptBrush';

/**
 * The end of a stroke must stay where the pen wrote it. Two things used to cut it on lift: the smoothing
 * filter trailing the pen (when the pen stops, no further sample pulls the line the rest of the way),
 * and the lift-hook trim treating the flick at the end of a «2» as a hook.
 */

(globalThis as unknown as { Path2D: unknown }).Path2D = class {
  moveTo() {}
  lineTo() {}
  closePath() {}
};

function makeCanvas(added: FabricObject[]) {
  const noop = () => {};

  return {
    contextTop: new Proxy({}, { get: (_target, key) => (key === 'getLineDash' ? () => [] : noop) }),
    width: 1920,
    height: 1080,
    viewportTransform: [1, 0, 0, 1, 0, 0],
    clearContext: noop,
    _isMainEvent: () => true,
    getScenePoint: (point: Point) => point,
    getZoom: () => 1,
    getRetinaScaling: () => 1,
    requestRenderAll: noop,
    fire: noop,
    add: (object: FabricObject) => added.push(object),
  } as unknown as Canvas;
}

const EVENT = { e: {} } as unknown as Parameters<LowLatencyPencilBrush['onMouseDown']>[1];

const BRUSHES = {
  pen: (canvas: Canvas) => new LowLatencyPencilBrush(canvas),
  brush: (canvas: Canvas) => new CalligraphyBrush(canvas),
  script: (canvas: Canvas) => new ScriptBrush(canvas),
  marker: (canvas: Canvas) => new SoftMarkerBrush(canvas),
} as const;

/** The base of a «2» written fast, then the given tail; returns the committed object and the raw end. */
function write(make: (canvas: Canvas) => LowLatencyPencilBrush, tail: Array<[number, number]>) {
  const points: Point[] = [];

  for (let i = 0; i <= 20; i += 1) points.push(new Point(100 + i * 8, 200));

  let [x, y] = [260, 200];

  for (const [dx, dy] of tail) {
    x += dx;
    y += dy;
    points.push(new Point(x, y));
  }

  const added: FabricObject[] = [];
  const brush = make(makeCanvas(added)) as LowLatencyPencilBrush & { width: number; decimate: number };

  brush.width = 4;
  brush.decimate = 0.4;
  brush.onMouseDown(points[0]!, EVENT);
  for (const point of points.slice(1)) brush.onMouseMove(point, EVENT);
  brush.onMouseUp(EVENT);

  assert.equal(added.length, 1);

  return { object: added[0]!, end: { x, y } };
}

describe('stroke ends reach the last point the pen touched', () => {
  for (const [name, make] of Object.entries(BRUSHES)) {
    it(`${name}: a fast stroke that stops dead`, () => {
      const { object, end } = write(make, []);
      const box = object.getBoundingRect();

      assert.ok(box.left + box.width >= end.x, `${name} ends at ${(box.left + box.width).toFixed(1)}, the pen at ${end.x}`);
    });

    it(`${name}: the up-flick at the end of a «2» is kept`, () => {
      const { object, end } = write(make, [
        [0.4, -2],
        [0.2, -1.8],
      ]);
      const box = object.getBoundingRect();

      assert.ok(box.top <= end.y, `${name} top at ${box.top.toFixed(1)}, the flick reached ${end.y}`);
    });
  }
});
