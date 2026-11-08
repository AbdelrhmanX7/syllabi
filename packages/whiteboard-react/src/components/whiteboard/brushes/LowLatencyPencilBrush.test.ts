import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Point } from 'fabric';

import type { Canvas } from 'fabric';

import { LowLatencyPencilBrush } from './LowLatencyPencilBrush';
import { StrokeSmoother } from './strokeSmoothing';

/**
 * The live preview of a pen stroke must include every coalesced digitizer sample, not only the one
 * frame-aligned sample Fabric receives per animation frame.
 *
 * Fabric's `PencilBrush.onMouseMove` incremental branch draws exactly ONE segment per call, from
 * `oldEnd` to the midpoint of the last two points. If the samples pushed in through
 * `appendCoalescedSample` are only appended to `_points`, they are skipped by the preview and the next
 * frame stitches a straight chord across them — under any slow frame the live stroke becomes a jagged
 * polyline that only turns smooth at pen-up, when the final path is built from all the points. The
 * ViewSonic (dual-tip IR pen reported as touch, Intel HD 530) showed exactly that.
 */

type Op = { name: string; args: number[] };

class RecordingContext {
  ops: Op[] = [];

  private record(name: string, ...args: number[]) {
    this.ops.push({ name, args });
  }

  save() {
    this.record('save');
  }
  restore() {
    this.record('restore');
  }
  beginPath() {
    this.record('beginPath');
  }
  closePath() {
    this.record('closePath');
  }
  moveTo(x: number, y: number) {
    this.record('moveTo', x, y);
  }
  lineTo(x: number, y: number) {
    this.record('lineTo', x, y);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    this.record('quadraticCurveTo', cx, cy, x, y);
  }
  stroke() {
    this.record('stroke');
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.record('clearRect', x, y, w, h);
  }
  transform(...matrix: number[]) {
    this.record('transform', ...matrix);
  }
  setLineDash() {
    this.record('setLineDash');
  }
}

function makeCanvas() {
  const ctx = new RecordingContext();
  const canvas = {
    contextTop: ctx,
    width: 1920,
    height: 1080,
    viewportTransform: [1, 0, 0, 1, 0, 0] as const,
    clearContext(target: RecordingContext) {
      target.clearRect(0, 0, this.width, this.height);
    },
    _isMainEvent: () => true,
    getScenePoint: (point: Point) => point,
    getZoom: () => 1,
    getRetinaScaling: () => 1,
    requestRenderAll: () => {},
    fire: () => {},
    add: () => {},
  };

  return { canvas: canvas as unknown as Canvas, ctx };
}

const EVENT = { e: {} } as unknown as Parameters<LowLatencyPencilBrush['onMouseDown']>[1];

function segmentsAfter(ops: Op[], startIndex: number) {
  return ops.slice(startIndex).filter((op) => op.name === 'quadraticCurveTo');
}

describe('LowLatencyPencilBrush live preview of coalesced samples', () => {
  it('draws one segment per appended sample, continuous with the frame-aligned segment', () => {
    const { canvas, ctx } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.onMouseDown(new Point(10, 10), EVENT);

    const afterDown = ctx.ops.length;

    brush.appendCoalescedSample(new Point(20, 12));
    brush.appendCoalescedSample(new Point(30, 15));
    brush.appendCoalescedSample(new Point(40, 19));
    brush.onMouseMove(new Point(50, 24), EVENT);

    const segments = segmentsAfter(ctx.ops, afterDown);

    // 3 coalesced samples + the frame's own sample = 4 segments, never 1.
    assert.equal(segments.length, 4);

    // Every segment after the first starts where the previous one ended (the midpoint drawSegment
    // returned), so the preview is one continuous curve rather than disjoint chords.
    const moveTos = ctx.ops.slice(afterDown).filter((op) => op.name === 'moveTo');

    assert.equal(moveTos.length, 4);

    for (let index = 1; index < segments.length; index += 1) {
      const previousEnd = segments[index - 1].args.slice(2);

      assert.deepEqual(moveTos[index].args, previousEnd);
    }
  });

  it('strokes each appended segment inside its own save/transform/restore', () => {
    const { canvas, ctx } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.onMouseDown(new Point(0, 0), EVENT);

    const afterDown = ctx.ops.length;

    brush.appendCoalescedSample(new Point(5, 5));

    const names = ctx.ops.slice(afterDown).map((op) => op.name);

    assert.deepEqual(names, ['save', 'transform', 'beginPath', 'moveTo', 'quadraticCurveTo', 'stroke', 'restore']);
  });

  it('leaves full-render brushes to repaint everything on the next move', () => {
    const { canvas, ctx } = makeCanvas();

    class FullRenderBrush extends LowLatencyPencilBrush {
      override needsFullRender(): boolean {
        return true;
      }
    }

    const brush = new FullRenderBrush(canvas);

    brush.onMouseDown(new Point(0, 0), EVENT);

    const afterDown = ctx.ops.length;

    brush.appendCoalescedSample(new Point(5, 5));
    brush.appendCoalescedSample(new Point(10, 10));

    // Nothing is painted per sample for a brush that repaints its whole stroke each frame …
    assert.equal(segmentsAfter(ctx.ops, afterDown).length, 0);

    const beforeMove = ctx.ops.length;

    brush.onMouseMove(new Point(15, 15), EVENT);

    // … and the frame's full render then covers every point. Fabric's onMouseDown records the first
    // point twice (prepare + "capture immediately"), so 5 points → 4 segments.
    assert.equal(segmentsAfter(ctx.ops, beforeMove).length, 4);
  });

  it('ignores a sample identical to the last point', () => {
    const { canvas, ctx } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.onMouseDown(new Point(0, 0), EVENT);
    brush.appendCoalescedSample(new Point(5, 5));

    const before = ctx.ops.length;

    brush.appendCoalescedSample(new Point(5, 5));

    assert.equal(ctx.ops.length, before);
  });
});

describe('LowLatencyPencilBrush ink smoothing', () => {
  it('stores the filtered samples — the same points the live preview draws and the commit builds from', () => {
    const { canvas } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);
    const raw = [
      [10, 10],
      [11, 10.6],
      [12.2, 9.7],
      [13.1, 10.5],
      [14.3, 9.8],
    ] as const;
    const expected = new StrokeSmoother();

    brush.onMouseDown(new Point(raw[0][0], raw[0][1]), EVENT);
    brush.appendCoalescedSample(new Point(raw[1][0], raw[1][1]));
    brush.appendCoalescedSample(new Point(raw[2][0], raw[2][1]));
    brush.appendCoalescedSample(new Point(raw[3][0], raw[3][1]));
    brush.onMouseMove(new Point(raw[4][0], raw[4][1]), EVENT);

    // Pen-down records the first contact twice (Fabric's dot rule), so the filter sees it twice too.
    // Those two are skipped in the comparison: Fabric's pen-down `_render` nudges them apart in place
    // (its dot trick), which is unrelated to the filter.
    const filtered = [raw[0], ...raw].map(([x, y]) => expected.next(x, y));

    assert.deepEqual(
      brush.liveStrokePoints.slice(2).map((point) => ({ x: point.x, y: point.y })),
      filtered.slice(2),
    );
  });

  it('applies no filter when smoothing is off (the eraser)', () => {
    const { canvas } = makeCanvas();
    const brush = new LowLatencyPencilBrush(canvas);

    brush.smoothing = false;
    brush.onMouseDown(new Point(0, 0), EVENT);
    brush.appendCoalescedSample(new Point(5, 3));

    assert.deepEqual(
      brush.liveStrokePoints.map((point) => [point.x, point.y]),
      [
        [0, 0],
        [0, 0],
        [5, 3],
      ],
    );
  });
});
