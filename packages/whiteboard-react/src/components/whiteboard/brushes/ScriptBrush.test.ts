import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Path, Point } from 'fabric';

import type { Canvas } from 'fabric';

import {
  SCRIPT_MAX_PRESSURE_SCALE,
  SCRIPT_MIN_PRESSURE_SCALE,
  SCRIPT_TAPER_MIN,
  ScriptBrush,
  scriptHalfWidth,
  scriptPressureScale,
  scriptTaperLength,
  scriptTaperScale,
} from './ScriptBrush';

/**
 * The script nib: gel / fountain ink. Its whole character is the width function — gentle pressure
 * (0.75×–1.25×), a fine taper at both ends, full width in between — so that is what is pinned here,
 * first as the pure function and then through the brush's own preview outline.
 */

function makeCanvas(added: unknown[] = []) {
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

const EVENT = { e: {} } as unknown as Parameters<ScriptBrush['onMouseDown']>[1];

type Vec = { x: number; y: number };

/** The preview paints through Path2D, which node lacks; this one records the vertices it is handed. */
class RecordingPath2D {
  static last: RecordingPath2D | null = null;
  vertices: Vec[] = [];

  constructor() {
    RecordingPath2D.last = this;
  }

  moveTo(x: number, y: number) {
    this.vertices.push({ x, y });
  }

  lineTo(x: number, y: number) {
    this.vertices.push({ x, y });
  }

  closePath() {}
}

(globalThis as unknown as { Path2D: unknown }).Path2D = RecordingPath2D;

const close = (actual: number, expected: number, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);

function makeBrush(width = 4) {
  const brush = new ScriptBrush(makeCanvas());

  brush.color = '#1f2937';
  brush.width = width;

  return brush;
}

/** A horizontal stroke along y = 300, x from 100 to 100 + length, one sample per 2 px, each frame rendered. */
function drawLine(brush: ScriptBrush, length = 120, pressure?: number) {
  const points = Array.from({ length: length / 2 + 1 }, (_, i) => new Point(100 + i * 2, 300));

  if (pressure !== undefined) brush.notePressure(pressure);
  brush.onMouseDown(points[0], EVENT);

  for (const point of points.slice(1)) {
    if (pressure !== undefined) brush.notePressure(pressure);
    brush.onMouseMove(point, EVENT);
  }

  return RecordingPath2D.last?.vertices ?? [];
}

/** Ink thickness (y extent) of the outline at x ± 1. */
function thicknessAt(outline: Vec[], x: number): number {
  const near = outline.filter((p) => Math.abs(p.x - x) <= 1);
  const ys = near.map((p) => p.y);

  return ys.length === 0 ? 0 : Math.max(...ys) - Math.min(...ys);
}

describe('ScriptBrush width function', () => {
  it('maps pressure 0..1 onto 0.75×..1.25× and treats a missing reading as exactly 1×', () => {
    close(scriptPressureScale(1), SCRIPT_MAX_PRESSURE_SCALE);
    close(scriptPressureScale(0.5), 1);
    close(scriptPressureScale(1e-6), SCRIPT_MIN_PRESSURE_SCALE, 1e-5);
    assert.equal(SCRIPT_MIN_PRESSURE_SCALE, 0.75);
    assert.equal(SCRIPT_MAX_PRESSURE_SCALE, 1.25);

    // Unknown: no pressure, a zero (the "unsupported" value of Touch.force), garbage.
    for (const unknown of [undefined, 0, -0.3, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(scriptPressureScale(unknown), 1, `pressure ${unknown}`);
    }

    // Out of range is clamped, never wider than 1.25×.
    close(scriptPressureScale(3), SCRIPT_MAX_PRESSURE_SCALE);
  });

  it('tapers to a fine point at both ends and is full width in between', () => {
    const taper = 12;

    close(scriptTaperScale(0, Number.POSITIVE_INFINITY, taper), SCRIPT_TAPER_MIN);
    close(scriptTaperScale(Number.POSITIVE_INFINITY, 0, taper), SCRIPT_TAPER_MIN);
    close(scriptTaperScale(taper, taper, taper), 1);
    close(scriptTaperScale(50, Number.POSITIVE_INFINITY, taper), 1);
    assert.ok(SCRIPT_TAPER_MIN > 0 && SCRIPT_TAPER_MIN < 0.5, 'a taper point, neither a blob nor nothing');

    // Monotone up the start ramp, and the end ramp mirrors it.
    let previous = 0;

    for (let d = 0; d <= taper; d += 0.5) {
      const start = scriptTaperScale(d, Number.POSITIVE_INFINITY, taper);

      assert.ok(start >= previous, `taper dipped at ${d}`);
      close(scriptTaperScale(Number.POSITIVE_INFINITY, d, taper), start);
      previous = start;
    }
  });

  it('runs a few pen widths, and shrinks for a stroke too short for two full ramps', () => {
    close(scriptTaperLength(4, 1000), 12);
    close(scriptTaperLength(0.5, 1000), 4, 1e-9); // floor: a thin pen still gets a visible point
    close(scriptTaperLength(4, 10), 5);
    close(scriptTaperLength(4, 0), 0);
  });

  it('half-width = width/2 × pressure × taper', () => {
    close(scriptHalfWidth(4, undefined, 100, 100, 12), 2);
    close(scriptHalfWidth(4, 1, 100, 100, 12), 2.5);
    close(scriptHalfWidth(4, 0.001, 100, 100, 12), 2 * scriptPressureScale(0.001));
    close(scriptHalfWidth(4, 1, 0, 100, 12), 2.5 * SCRIPT_TAPER_MIN);
  });
});

describe('ScriptBrush outline', () => {
  it('a stroke is pen-width in the middle and comes to a point at each end', () => {
    const outline = drawLine(makeBrush(4));

    close(thicknessAt(outline, 160), 4, 0.05);

    const xs = outline.map((p) => p.x);
    const startTip = thicknessAt(outline, Math.min(...xs) + 1);
    const endTip = thicknessAt(outline, Math.max(...xs) - 1);

    assert.ok(startTip < 2, `start is ${startTip.toFixed(2)} thick — a blob, not a taper`);
    assert.ok(endTip < 2, `end is ${endTip.toFixed(2)} thick — a blob, not a taper`);
  });

  it('pen pressure swells and thins the line within 0.75×–1.25×', () => {
    close(thicknessAt(drawLine(makeBrush(4), 120, 1), 160), 5, 0.05);
    close(thicknessAt(drawLine(makeBrush(4), 120, 0.5), 160), 4, 0.05);
    close(thicknessAt(drawLine(makeBrush(4), 120, 0.02), 160), 4 * scriptPressureScale(0.02), 0.05);
  });

  it('a tap commits a round dot the width of the pen', () => {
    const brush = makeBrush(4);

    brush.onMouseDown(new Point(200, 200), EVENT);

    const dot = RecordingPath2D.last?.vertices ?? [];
    const xs = dot.map((p) => p.x);
    const ys = dot.map((p) => p.y);

    assert.ok(dot.length >= 8, 'a tap drew nothing');
    close(Math.max(...xs) - Math.min(...xs), 4, 0.05);
    close(Math.max(...ys) - Math.min(...ys), 4, 0.1);
  });

  it('the append-only cache draws exactly what a from-scratch build of the same points draws', () => {
    // Frame by frame (offsets cached as the stroke grows) …
    const points = Array.from({ length: 80 }, (_, i) => new Point(100 + i * 3, 300 + 40 * Math.sin(i / 8)));
    const live = makeBrush(3);

    live.onMouseDown(points[0], EVENT);
    for (const point of points.slice(1)) live.onMouseMove(point, EVENT);

    const incremental = RecordingPath2D.last?.vertices ?? [];

    // … against the same samples arriving in one frame (coalesced, then a single repaint).
    const once = makeBrush(3);

    once.onMouseDown(points[0], EVENT);
    for (const point of points.slice(1, -1)) once.appendCoalescedSample(point);
    once.onMouseMove(points[points.length - 1], EVENT);

    const fresh = RecordingPath2D.last?.vertices ?? [];

    assert.equal(incremental.length, fresh.length);
    incremental.forEach((p, i) => {
      close(p.x, fresh[i].x, 1e-6);
      close(p.y, fresh[i].y, 1e-6);
    });
  });

  it('commits the preview outline as a FILLED path, so a saved stroke reloads as drawn', () => {
    const added: unknown[] = [];
    const brush = new ScriptBrush(makeCanvas(added));

    brush.color = '#1f2937';
    brush.width = 4;
    // The jitter filter (decimate) thins the points at commit for every freehand brush; off here so the
    // committed outline can be compared vertex for vertex with the preview.
    brush.decimate = 0;

    const points = Array.from({ length: 50 }, (_, i) => new Point(100 + i * 3, 300 + 25 * Math.sin(i / 6)));

    brush.onMouseDown(points[0], EVENT);
    for (const point of points.slice(1)) brush.onMouseMove(point, EVENT);

    const preview = RecordingPath2D.last?.vertices ?? [];

    brush.onMouseUp(EVENT as unknown as Parameters<ScriptBrush['onMouseUp']>[0]);

    assert.equal(added.length, 1);

    const path = added[0] as Path;

    assert.ok(path instanceof Path);
    assert.equal(path.fill, '#1f2937');
    assert.equal(path.strokeWidth, 0);

    // Same outline: one M/L command per preview vertex, plus the Z.
    const commands = path.path as unknown as [string, ...number[]][];

    assert.equal(commands.length, preview.length + 1);
    commands.slice(0, -1).forEach(([, x, y], i) => {
      close(x as number, preview[i].x, 0.006);
      close(y as number, preview[i].y, 0.006);
    });
  });
});
