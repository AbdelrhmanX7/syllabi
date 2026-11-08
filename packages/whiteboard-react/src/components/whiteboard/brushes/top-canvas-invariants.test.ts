import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Point } from 'fabric';

import type { Canvas } from 'fabric';

import { CalligraphyBrush } from './CalligraphyBrush';
import { ScriptBrush } from './ScriptBrush';
import { SoftMarkerBrush, SOFT_MARKER_OPACITY } from './SoftMarkerBrush';

/**
 * The top canvas (`contextTop`) is shared mutable state between every brush, and Fabric hands almost
 * none of it back. `SelectableCanvas.renderAll()` refuses to clear it while `isDrawingMode` is true, and
 * `PencilBrush.onMouseDown` calls `_render()` with no clear at all — so whatever the previous tool left
 * on it survives until something clears it explicitly, which in practice is pen-lift. That is why the
 * reported bug looked the way it did: a stray line and a resurrected erased object, both visible only
 * while the pen was down.
 *
 * These tests pin the two invariants a brush owes the next brush, driven through Fabric's real
 * `onMouseDown` / `onMouseMove` rather than by calling `_render` directly:
 *
 *   1. Clear the top canvas before painting a preview, on EVERY frame (mouse-down included).
 *   2. Reset the context's current path (`beginPath`) before anything strokes or fills, ALWAYS —
 *      including on frames with nothing to draw.
 *
 * Invariant 2 matters because `PencilBrush._prepareForDrawing` writes a raw
 * `contextTop.moveTo(pointer)` in SCENE coordinates outside `_saveAndTransform`. At zoom > 1 that point
 * lands well above and left of the pen, and the next `stroke()` anywhere would draw a line to it from
 * off-screen.
 */

// CalligraphyBrush fills a Path2D. Node has no canvas, so record what is built into it — the brush drives
// it imperatively (moveTo/lineTo) rather than parsing a path string, so the stub must accept those.
class StubPath2D {
  ops: string[] = [];

  constructor(public readonly data?: string) {}

  moveTo(x: number, y: number) {
    this.ops.push(`M${x},${y}`);
  }
  lineTo(x: number, y: number) {
    this.ops.push(`L${x},${y}`);
  }
  closePath() {
    this.ops.push('Z');
  }
}

(globalThis as { Path2D?: unknown }).Path2D ??= StubPath2D;

type Op = { name: string; args: unknown[] };

class RecordingContext {
  ops: Op[] = [];
  depth = 0;
  maxDepth = 0;

  private record(name: string, ...args: unknown[]) {
    this.ops.push({ name, args });
  }

  names(): string[] {
    return this.ops.map((op) => op.name);
  }

  reset() {
    this.ops = [];
  }

  save() {
    this.depth += 1;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    this.record('save');
  }
  restore() {
    this.depth -= 1;
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
  fill(path?: unknown) {
    this.record('fill', path);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.record('clearRect', x, y, w, h);
  }
  transform(...matrix: number[]) {
    this.record('transform', ...matrix);
  }
  setTransform(...matrix: number[]) {
    this.record('setTransform', ...matrix);
  }
  setLineDash(dash: number[]) {
    this.record('setLineDash', dash);
  }
}

const VIEWPORT_ZOOM = 1.8;

function makeCanvas() {
  const ctx = new RecordingContext();
  const canvas = {
    contextTop: ctx,
    width: 1920,
    height: 1080,
    viewportTransform: [VIEWPORT_ZOOM, 0, 0, VIEWPORT_ZOOM, 0, 0] as const,
    // Mirrors StaticCanvas.clearContext, which is a plain clearRect in canvas coordinates.
    clearContext(target: RecordingContext) {
      target.clearRect(0, 0, this.width, this.height);
    },
    _isMainEvent: () => true,
    getScenePoint: (point: Point) => point,
    getZoom: () => VIEWPORT_ZOOM,
    getRetinaScaling: () => 1,
    requestRenderAll: () => {},
    fire: () => {},
    add: () => {},
  };

  return { canvas: canvas as unknown as Canvas, ctx };
}

/** Fabric hands brushes a bare `{ e }`; nothing in these paths reads more than that. */
const EVENT = { e: {} } as unknown as Parameters<CalligraphyBrush['onMouseDown']>[1];

const PAINT_OPS = new Set(['stroke', 'fill']);

/**
 * The one thing that must never happen: a paint while a subpath opened BEFORE the last `beginPath()` is
 * still live. Any `moveTo` that is not separated from the paint by a `beginPath` is still in the path
 * being painted — which is exactly how `_prepareForDrawing`'s off-screen scene-space point became a
 * visible line.
 */
function assertNoPaintOverStalePath(ctx: RecordingContext, label: string) {
  // The latch is deliberate, and it is the whole point of the check.
  //
  // What is being guarded is specifically the ONE stray `moveTo` that `PencilBrush._prepareForDrawing`
  // emits outside any `beginPath`, in scene coordinates, before the brush's own `_render` runs. The FIRST
  // `beginPath` of the frame destroys it permanently — so once that has happened there is nothing left to
  // catch, and every later `moveTo` legitimately belongs to the path currently being built.
  //
  // Resetting on every `beginPath` instead would flag `beginPath -> moveTo -> stroke`, which is simply
  // how anything draws — including `PencilBrush._render` itself. That reading was tried and it failed the
  // marker on a correct frame.
  let strayPathStillLive = false;
  let sawBeginPath = false;

  for (const op of ctx.ops) {
    if (op.name === 'beginPath') {
      sawBeginPath = true;
      strayPathStillLive = false;
      continue;
    }

    if (op.name === 'moveTo' && !sawBeginPath) {
      strayPathStillLive = true;
      continue;
    }

    if (PAINT_OPS.has(op.name)) {
      assert.equal(
        strayPathStillLive,
        false,
        `${label}: ${op.name}() painted while a subpath opened before the last beginPath() was live — ` +
          `this is the off-screen ghost line. Ops: ${ctx.names().join(' → ')}`,
      );
    }
  }
}

function drawStroke(brush: CalligraphyBrush | SoftMarkerBrush | ScriptBrush, points: [number, number][]) {
  const [first, ...rest] = points;

  brush.onMouseDown(new Point(first[0], first[1]), EVENT);

  for (const [x, y] of rest) {
    brush.onMouseMove(new Point(x, y), EVENT);
  }
}

describe('brush top-canvas invariants', () => {
  const cases: { name: string; make: (canvas: Canvas) => CalligraphyBrush | SoftMarkerBrush | ScriptBrush }[] = [
    {
      name: 'ScriptBrush',
      make: (canvas) => {
        const brush = new ScriptBrush(canvas);

        brush.color = '#000000';
        brush.width = 3;

        return brush;
      },
    },
    {
      name: 'CalligraphyBrush',
      make: (canvas) => {
        const brush = new CalligraphyBrush(canvas);

        brush.color = '#000000';
        brush.width = 6;

        return brush;
      },
    },
    {
      name: 'SoftMarkerBrush',
      make: (canvas) => {
        const brush = new SoftMarkerBrush(canvas);

        brush.color = `rgba(0, 0, 0, ${SOFT_MARKER_OPACITY})`;
        brush.width = 13;

        return brush;
      },
    },
  ];

  for (const { name, make } of cases) {
    it(`${name} clears the top canvas on the mouse-DOWN frame, not just on move`, () => {
      const { canvas, ctx } = makeCanvas();
      const brush = make(canvas);

      brush.onMouseDown(new Point(500, 400), EVENT);

      assert.ok(
        ctx.names().includes('clearRect'),
        `${name} painted its first frame without clearing contextTop, so the previous tool's pixels ` +
          `(the eraser's full-board preview blit above all) stay visible for the whole stroke. ` +
          `Ops: ${ctx.names().join(' → ')}`,
      );
    });

    it(`${name} never paints over a subpath left open by _prepareForDrawing`, () => {
      const { canvas, ctx } = makeCanvas();
      const brush = make(canvas);

      drawStroke(brush, [
        [500, 400],
        [520, 430],
        [560, 470],
        [610, 505],
      ]);

      assertNoPaintOverStalePath(ctx, name);
    });

    it(`${name} takes Fabric's full-render branch even when its colour is opaque`, () => {
      const { canvas } = makeCanvas();
      const brush = make(canvas);

      // The incremental branch never clears contextTop for the life of the stroke and skips beginPath()
      // until `oldEnd` exists — both invariants above are lost the moment a brush falls onto it. It must
      // not be reachable by changing a colour.
      brush.color = '#112233';

      assert.equal(brush.needsFullRender(), true, `${name} fell onto Fabric's incremental preview branch`);
    });

    it(`${name} leaves the context balanced and clean when there is nothing to draw`, () => {
      const { canvas, ctx } = makeCanvas();
      const brush = make(canvas);

      // Reachable via SelectableCanvas.renderTopLayer, which calls _render() directly whenever
      // `_isCurrentlyDrawing` is true — including after a reset emptied `_points`.
      assert.doesNotThrow(() => brush._render(), `${name}._render() threw on an empty stroke`);

      // An escaping throw between save() and restore() would strand the viewport transform on
      // contextTop, after which clearContext (a clearRect in canvas coordinates) only ever clears a
      // sub-rectangle of it — permanent residue on the top canvas.
      assert.equal(ctx.depth, 0, `${name} left contextTop's save/restore unbalanced`);
      assert.ok(
        ctx.names().includes('clearRect'),
        `${name} skipped clearing contextTop on an empty frame. Ops: ${ctx.names().join(' → ')}`,
      );
      assert.ok(
        ctx.names().includes('beginPath'),
        `${name} skipped beginPath() on an empty frame, re-arming the ghost line for whichever brush ` +
          `runs next. Ops: ${ctx.names().join(' → ')}`,
      );
    });
  }

  it('CalligraphyBrush leaves contextTop with no live subpath, so the next brush cannot inherit one', () => {
    const { canvas, ctx } = makeCanvas();
    const brush = new CalligraphyBrush(canvas);

    brush.color = '#000000';
    brush.width = 6;

    drawStroke(brush, [
      [400, 60],
      [430, 90],
      [470, 130],
    ]);

    // It paints with fill(Path2D), which never touches the context's current path. That is what makes it
    // safe to follow — but only because beginPath() runs unconditionally.
    const names = ctx.names();
    const lastBeginPath = names.lastIndexOf('beginPath');

    assert.notEqual(lastBeginPath, -1, 'CalligraphyBrush never called beginPath()');
    assert.equal(
      names.slice(lastBeginPath).includes('moveTo'),
      false,
      `CalligraphyBrush left a subpath live on contextTop. Ops: ${names.join(' → ')}`,
    );
  });
});

describe('coalesced sub-frame samples', () => {
  it('appendCoalescedSample adds to the stroke without painting', () => {
    const { canvas, ctx } = makeCanvas();
    const brush = new CalligraphyBrush(canvas);

    brush.color = '#000000';
    brush.width = 6;

    brush.onMouseDown(new Point(100, 100), EVENT);
    ctx.reset();

    brush.appendCoalescedSample(new Point(110, 104));
    brush.appendCoalescedSample(new Point(120, 110));

    // Fabric's own move for this frame arrives right after and repaints once. Painting per sample would
    // cost a full repaint per sub-frame sample, which is what made an earlier design skip coalescing for
    // every full-render brush.
    assert.equal(
      ctx.names().some((name) => PAINT_OPS.has(name)),
      false,
      `accumulating a buffered sample repainted the canvas. Ops: ${ctx.names().join(' → ')}`,
    );
  });

  it('the accumulated samples follow the real curve, not the chord across it', () => {
    // A quarter arc the digitizer reported between two animation frames. Keeping only the dispatched
    // sample collapses it to the straight chord from start to end — which is the faceting the teacher
    // sees on fast strokes next to a device that replays every sample.
    const arcPoint = (fraction: number) => {
      const angle = (Math.PI / 2) * fraction;

      return new Point(100 + 60 * Math.sin(angle), 100 + 60 * (1 - Math.cos(angle)));
    };
    const drawArc = (replaySamples: boolean) => {
      const { canvas, ctx } = makeCanvas();
      const brush = new CalligraphyBrush(canvas);

      brush.color = '#000000';
      brush.width = 6;
      brush.onMouseDown(arcPoint(0), EVENT);

      if (replaySamples) {
        // INTERMEDIATE samples only. The final coalesced entry is the event Fabric itself is about to
        // process — feeding it here too would be rejected by `_addPoint`'s duplicate check and take the
        // whole move with it, which is why the real injector drops it.
        for (let i = 1; i < 8; i += 1) brush.appendCoalescedSample(arcPoint(i / 8));
      }

      brush.onMouseMove(arcPoint(1), EVENT);

      const fills = ctx.ops.filter((op) => op.name === 'fill');
      const path = (fills[fills.length - 1]?.args[0] as { ops: string[] } | undefined)?.ops ?? [];

      // The stub records 'M x,y' / 'L x,y' and a bare 'Z' — drop the close.
      return path
        .filter((op) => op.startsWith('M') || op.startsWith('L'))
        .map((op) => op.slice(1).split(',').map(Number)) as number[][];
    };

    // The arc's own midpoint. It sits ~25px off the chord, so a stroke that followed the chord cannot
    // have painted anywhere near it.
    const midpoint = arcPoint(0.5);
    const nearestTo = (points: number[][]) =>
      Math.min(...points.map(([x, y]) => Math.hypot(x - midpoint.x, y - midpoint.y)));

    const replayed = nearestTo(drawArc(true));
    const chordOnly = nearestTo(drawArc(false));

    assert.ok(
      replayed < 8,
      `the replayed stroke should pass through the arc it was drawn along (nearest point was ${replayed.toFixed(1)}px away)`,
    );
    assert.ok(
      chordOnly > 15,
      `without the buffered samples the stroke should cut the corner (nearest point was ${chordOnly.toFixed(1)}px away)`,
    );
  });
});
