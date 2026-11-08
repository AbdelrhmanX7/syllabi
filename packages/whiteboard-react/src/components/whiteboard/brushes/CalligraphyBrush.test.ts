import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Point } from 'fabric';

import type { Canvas } from 'fabric';

import { CalligraphyBrush } from './CalligraphyBrush';

/**
 * The brush's dot. A tap, or a stroke shorter than the nib is wide, must commit a proper dot — the nib
 * pulled a short way across its own edge — not the nib's bare footprint, which is a 2 : 1 sliver along
 * the cant and read as a hairline next to the strokes it sat between. i, j, full stops and colons are
 * dots, so this is much of what a tap is for.
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

function vertices(data: string | null): Vec[] {
  assert.ok(data && data.startsWith('M ') && data.endsWith(' Z'), `not a closed outline: ${data}`);

  const pattern = /[ML] (-?[\d.]+) (-?[\d.]+)/g;
  const out: Vec[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(data)) !== null) {
    out.push({ x: Number(match[1]), y: Number(match[2]) });
  }

  return out;
}

/** Extent of a polygon along a unit direction. */
function span(points: Vec[], direction: Vec): number {
  const projected = points.map((p) => p.x * direction.x + p.y * direction.y);

  return Math.max(...projected) - Math.min(...projected);
}

function area(points: Vec[]): number {
  let twice = 0;

  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const q = points[(i + 1) % points.length];

    twice += p.x * q.y - q.x * p.y;
  }

  return Math.abs(twice) / 2;
}

function centroid(points: Vec[]): Vec {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

const DIRECTIONS = Array.from({ length: 36 }, (_, i) => {
  const angle = (Math.PI * i) / 36;

  return { x: Math.cos(angle), y: Math.sin(angle) };
});

/** A long straight stroke in each direction: the thickest and thinnest line this nib can draw. */
function lineThickness(brush: CalligraphyBrush) {
  const thicknesses = DIRECTIONS.map((direction) => {
    const points = Array.from({ length: 41 }, (_, i) => ({ x: 300 + direction.x * i * 2, y: 300 + direction.y * i * 2 }));
    const outline = vertices(brush.outlinePathDataFor(points));
    // Measured mid-stroke, away from the caps: the width across the direction of travel.
    const normal = { x: -direction.y, y: direction.x };
    const middle = outline.filter((p) => Math.abs((p.x - 300) * direction.x + (p.y - 300) * direction.y - 40) < 10);

    return span(middle, normal);
  });

  return { broadest: Math.max(...thicknesses), thinnest: Math.min(...thicknesses) };
}

const tap = (x: number, y: number) => [{ x, y }, { x, y }];

describe('CalligraphyBrush dot', () => {
  it('a tap is as wide as the broadest line the nib draws, in every direction, and far heavier than the bare footprint', () => {
    const brush = new CalligraphyBrush(makeCanvas());

    brush.width = 6;

    const { broadest, thinnest } = lineThickness(brush);
    const dot = vertices(brush.outlinePathDataFor(tap(100, 100)));
    const spans = DIRECTIONS.map((direction) => span(dot, direction));

    // Never thinner than the brush's thickest stroke, whichever way you look at it …
    assert.ok(Math.min(...spans) > broadest * 0.95, `dot is only ${Math.min(...spans).toFixed(1)} across; lines reach ${broadest.toFixed(1)}`);
    // … and not a blob either: at most the diagonal of that square.
    assert.ok(Math.max(...spans) < broadest * 1.25, `dot sprawls to ${Math.max(...spans).toFixed(1)} for a ${broadest.toFixed(1)} nib`);

    // The bare footprint is an ellipse on the nib's two half-widths; the dot carries about twice that ink.
    const footprint = (Math.PI * broadest * thinnest) / 4;

    assert.ok(area(dot) > footprint * 2, `dot area ${area(dot).toFixed(0)} vs footprint ${footprint.toFixed(0)}`);
  });

  it('sits where the pen was, and scales with the pen width', () => {
    const brush = new CalligraphyBrush(makeCanvas());

    brush.width = 6;

    const at6 = vertices(brush.outlinePathDataFor(tap(100, 100)));
    const centre = centroid(at6);

    assert.ok(Math.hypot(centre.x - 100, centre.y - 100) < 0.5, `dot centred at ${centre.x.toFixed(1)},${centre.y.toFixed(1)}`);

    brush.width = 3;

    const at3 = vertices(brush.outlinePathDataFor(tap(100, 100)));

    assert.ok(Math.abs(span(at3, { x: 1, y: 0 }) * 2 - span(at6, { x: 1, y: 0 })) < 0.1, 'dot does not scale linearly with width');
  });

  it('a short wander — an S Pen tap, a tick for a diacritic — is the same dot, centred on the travel', () => {
    const brush = new CalligraphyBrush(makeCanvas());

    brush.width = 6;

    const reference = vertices(brush.outlinePathDataFor(tap(101, 101)));
    const wander = vertices(brush.outlinePathDataFor([{ x: 100, y: 100 }, { x: 100.6, y: 100.2 }, { x: 101.4, y: 101.2 }, { x: 102, y: 102 }]));
    const tick = vertices(brush.outlinePathDataFor([{ x: 97, y: 97 }, { x: 99, y: 99 }, { x: 101, y: 101 }, { x: 103, y: 103 }, { x: 105, y: 105 }]));
    const hairpin = vertices(brush.outlinePathDataFor([{ x: 98, y: 101 }, { x: 101, y: 101 }, { x: 104, y: 101 }, { x: 101, y: 101 }]));

    for (const [name, outline] of [['wander', wander], ['tick', tick], ['hairpin', hairpin]] as const) {
      assert.equal(outline.length, reference.length, `${name}: a different shape from the tap`);
      outline.forEach((p, i) => {
        assert.ok(Math.abs(p.x - reference[i].x) < 0.011 && Math.abs(p.y - reference[i].y) < 0.011, `${name}: vertex ${i} off`);
      });
    }
  });

  it('a stroke longer than the nib is wide is swept, not dotted', () => {
    const brush = new CalligraphyBrush(makeCanvas());

    brush.width = 6;

    const { broadest } = lineThickness(brush);
    const dot = vertices(brush.outlinePathDataFor(tap(100, 100)));
    // Along the nib's thin side — the direction a dot would hide best.
    const along = DIRECTIONS.reduce((best, d) => (span(dot, d) < span(dot, best) ? d : best), DIRECTIONS[0]);
    const length = broadest * 1.5;
    const stroke = vertices(
      brush.outlinePathDataFor(Array.from({ length: 11 }, (_, i) => ({ x: 100 + along.x * length * (i / 10), y: 100 + along.y * length * (i / 10) }))),
    );

    assert.ok(span(stroke, along) > span(dot, along) + length * 0.5, 'the stroke was flattened into a dot');
    assert.notEqual(stroke.length, dot.length);
  });

  it('the live preview of a tap is the committed dot, vertex for vertex', () => {
    const brush = new CalligraphyBrush(makeCanvas());

    brush.width = 6;
    brush.onMouseDown(new Point(100, 100), EVENT);

    const preview = RecordingPath2D.last?.vertices ?? [];
    const committed = vertices(brush.outlinePathDataFor(tap(100, 100)));

    assert.equal(preview.length, committed.length, 'preview and commit trace different outlines');
    preview.forEach((p, i) => {
      assert.ok(Math.abs(p.x - committed[i].x) < 0.011 && Math.abs(p.y - committed[i].y) < 0.011, `vertex ${i} differs`);
    });
  });
});
