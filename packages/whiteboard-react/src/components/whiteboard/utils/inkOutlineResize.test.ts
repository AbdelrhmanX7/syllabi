import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Path, Point } from 'fabric';

import type { Canvas } from 'fabric';

import { CalligraphyBrush } from '../brushes/CalligraphyBrush';
import { ScriptBrush } from '../brushes/ScriptBrush';
import { inkPenOf } from '../brushes/inkPenMark';
import { estimateOutlineWidth, fitOutline, outlineLoopPoints, resizeOutlinePath } from './inkOutlineResize';

/**
 * The brush and script pens save strokes as filled outlines, so «Size» on the selection bar has to
 * rebuild the outline. These pin that a resized stroke matches the same stroke drawn at the new size.
 */

class FakePath2D {
  moveTo() {}
  lineTo() {}
  closePath() {}
}

(globalThis as unknown as { Path2D: unknown }).Path2D ??= FakePath2D;

function makeCanvas(added: unknown[]) {
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
    add: (object: unknown) => added.push(object),
  } as unknown as Canvas;
}

const EVENT = { e: {} } as never;

/** A wavy handwriting-like stroke. */
const WAVE = Array.from({ length: 70 }, (_, i) => new Point(100 + i * 3, 300 + 30 * Math.sin(i / 7)));

function drawPath(Brush: typeof CalligraphyBrush | typeof ScriptBrush, width: number, points = WAVE): Path {
  const added: unknown[] = [];
  const brush = new Brush(makeCanvas(added));

  brush.color = '#1f2937';
  brush.width = width;
  brush.decimate = 0;
  brush.onMouseDown(points[0]!, EVENT);
  for (const point of points.slice(1)) brush.onMouseMove(point, EVENT);
  brush.onMouseUp(EVENT);

  const path = added[0] as Path;

  assert.ok(path instanceof Path, 'the brush committed a path');

  return path;
}

const draw = (Brush: typeof CalligraphyBrush | typeof ScriptBrush, width: number, points = WAVE) =>
  drawPath(Brush, width, points).path as unknown as Array<Array<string | number>>;

function area(commands: ReadonlyArray<ReadonlyArray<string | number>>): number {
  const points = outlineLoopPoints(commands)!;
  let twice = 0;

  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length]!;

    twice += p.x * q.y - q.x * p.y;
  });

  return Math.abs(twice) / 2;
}

const width = (commands: ReadonlyArray<ReadonlyArray<string | number>>) => {
  const points = outlineLoopPoints(commands)!;

  return estimateOutlineWidth(points, fitOutline(points));
};

describe('outlineLoopPoints', () => {
  it('reads one closed polygon and drops repeated points', () => {
    const points = outlineLoopPoints([
      ['M', 0, 0],
      ['L', 10, 0],
      ['L', 10, 0],
      ['L', 20, 0],
      ['L', 20, 2],
      ['L', 10, 2],
      ['L', 0, 2],
      ['L', 0, 0],
      ['Z'],
    ]);

    assert.deepEqual(points, [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 2 },
      { x: 10, y: 2 },
      { x: 0, y: 2 },
    ]);
  });

  it('refuses curves and second sub-paths', () => {
    assert.equal(outlineLoopPoints([['M', 0, 0], ['Q', 1, 1, 2, 2], ['L', 3, 3], ['L', 4, 4], ['L', 5, 5], ['L', 6, 6]]), null);
    assert.equal(outlineLoopPoints([['M', 0, 0], ['L', 1, 1], ['L', 2, 2], ['M', 3, 3], ['L', 4, 4], ['L', 5, 5]]), null);
  });
});

describe('resizeOutlinePath', () => {
  it('pairs a band with its other side and scales across it', () => {
    // A 2-wide horizontal band, traced up the top and back along the bottom.
    const band = [
      ['M', 0, 0],
      ['L', 10, 0],
      ['L', 20, 0],
      ['L', 30, 0],
      ['L', 30, 2],
      ['L', 20, 2],
      ['L', 10, 2],
      ['L', 0, 2],
      ['Z'],
    ];
    const resized = outlineLoopPoints(resizeOutlinePath(band, 6)!)!;

    assert.deepEqual(
      resized.map((p) => [p.x, p.y]),
      [
        [0, -2],
        [10, -2],
        [20, -2],
        [30, -2],
        [30, 4],
        [20, 4],
        [10, 4],
        [0, 4],
      ],
    );
  });

  for (const [name, Brush] of [
    ['calligraphy brush', CalligraphyBrush],
    ['script pen', ScriptBrush],
  ] as const) {
    it(`${name}: a stroke reads back as about the size it was drawn at`, () => {
      for (const size of [2, 4, 8, 16]) {
        const measured = width(draw(Brush, size));

        assert.ok(Math.abs(measured / size - 1) < 0.2, `drawn at ${size}, measured ${measured.toFixed(2)}`);
      }
    });

    it(`${name}: marks its strokes, so a straight line in any direction reads back as its size`, () => {
      const pen = Brush === ScriptBrush ? 'script' : 'brush';

      for (let step = 0; step < 12; step += 1) {
        const angle = (Math.PI * 2 * step) / 12;
        const line = Array.from({ length: 40 }, (_, i) => new Point(300 + i * 3 * Math.cos(angle), 300 + i * 3 * Math.sin(angle)));
        const path = drawPath(Brush, 4, line);
        const points = outlineLoopPoints(path.path as never)!;

        assert.equal(inkPenOf(path), pen);
        assert.equal(fitOutline(points, inkPenOf(path)).calibration, pen === 'script' ? 1 : 2.25, `angle ${step * 30}°`);
        // (the brush nib is thinner along its own slant, so allow its direction-dependent width)
        const measured = estimateOutlineWidth(points, fitOutline(points, inkPenOf(path)));

        assert.ok(measured > 4 * 0.5 && measured < 4 * 1.3, `angle ${step * 30}°: ${measured.toFixed(2)}`);
      }
    });

    it(`${name}: an unmarked (older) handwriting stroke is still read as this pen`, () => {
      const points = outlineLoopPoints(draw(Brush, 4))!;

      assert.equal(fitOutline(points).calibration, Brush === ScriptBrush ? 1 : 2.25);
    });

    it(`${name}: resizing 4 → 8 looks like drawing at 8, and 8 → 4 comes back`, () => {
      const at4 = draw(Brush, 4);
      const at8 = draw(Brush, 8);
      const resized = resizeOutlinePath(at4, 8 * (width(at4) / 4))!;
      // (scaled by how far the size-4 stroke reads from exactly 4, so the comparison is size for size)

      assert.ok(resized, 'resized');
      // Same ink area as the real size-8 stroke, within 15 %.
      assert.ok(Math.abs(area(resized) / area(at8) - 1) < 0.15, `area ${area(resized).toFixed(0)} vs ${area(at8).toFixed(0)}`);

      const back = outlineLoopPoints(resizeOutlinePath(resized, width(at4))!)!;
      const original = outlineLoopPoints(at4)!;

      assert.equal(back.length, original.length);
      back.forEach((p, i) => {
        assert.ok(Math.hypot(p.x - original[i]!.x, p.y - original[i]!.y) < 0.05, `point ${i} drifted`);
      });
    });
  }

  it('leaves a stroke that already has the size alone', () => {
    const at4 = draw(ScriptBrush, 4);

    assert.equal(resizeOutlinePath(at4, width(at4)), null);
  });
});
