import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  adjustSnappedShape,
  recognizeShape,
  resample,
  SHAPE_THRESHOLDS,
  snapLineEnd,
} from './shapeRecognition';

import type { EllipseGeometry, PolyGeometry, RecognizedShape, Vec } from './shapeRecognition';

// ---------------------------------------------------------------------------------------------------
// Synthetic hand-drawn strokes: dense, unevenly spaced samples with a slow wobble plus fine jitter,
// the way a real digitizer stroke looks. Seeded, so a failure reproduces.
// ---------------------------------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;

    return s / 2 ** 32;
  };
}

interface HandOptions {
  seed?: number;
  /** Wobble amplitude as a fraction of `scale`. */
  wobble?: number;
  /** Per-sample jitter in scene px. */
  jitter?: number;
  scale?: number;
}

/** Walk a polyline, emitting samples every ~2–5px with a smooth perpendicular wobble and jitter. */
function hand(path: Vec[], { seed = 1, wobble = 0.012, jitter = 0.6, scale = 200 }: HandOptions = {}): Vec[] {
  const random = rng(seed);
  const out: Vec[] = [];
  let travelled = 0;
  const phase = random() * Math.PI * 2;

  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / (length || 1);
    const ny = (b.x - a.x) / (length || 1);

    for (let t = 0; t < length; t += 2 + random() * 3) {
      const w = Math.sin(phase + (travelled + t) / 37) * wobble * scale;

      out.push({
        x: a.x + ((b.x - a.x) * t) / length + nx * w + (random() - 0.5) * jitter,
        y: a.y + ((b.y - a.y) * t) / length + ny * w + (random() - 0.5) * jitter,
      });
    }

    travelled += length;
  }

  out.push({ ...path[path.length - 1] });

  return out;
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number, angle = 0, startDeg = -90, sweepDeg = 360): Vec[] {
  const pts: Vec[] = [];
  const steps = 180;

  for (let i = 0; i <= steps; i += 1) {
    const t = ((startDeg + (sweepDeg * i) / steps) * Math.PI) / 180;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);

    pts.push({
      x: cx + x * Math.cos(angle) - y * Math.sin(angle),
      y: cy + x * Math.sin(angle) + y * Math.cos(angle),
    });
  }

  return pts;
}

function polygonPath(vertices: Vec[], overshoot = 0): Vec[] {
  const path = [...vertices, vertices[0]];

  if (overshoot > 0) {
    const a = vertices[0];
    const b = vertices[1];

    path.push({ x: a.x + (b.x - a.x) * overshoot, y: a.y + (b.y - a.y) * overshoot });
  }

  return path;
}

const rotatePoint = (p: Vec, c: Vec, deg: number): Vec => {
  const r = (deg * Math.PI) / 180;

  return {
    x: c.x + (p.x - c.x) * Math.cos(r) - (p.y - c.y) * Math.sin(r),
    y: c.y + (p.x - c.x) * Math.sin(r) + (p.y - c.y) * Math.cos(r),
  };
};

const OPTIONS = { minSize: 20 };
const angleOf = (a: Vec, b: Vec) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const near = (actual: number, expected: number, tolerance: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}±${tolerance}, got ${actual}`);

// ---------------------------------------------------------------------------------------------------

describe('resample', () => {
  it('returns the requested count, equally spaced along the path', () => {
    const out = resample(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 90 },
      ],
      11,
    );

    assert.equal(out.length, 11);
    near(out[1].x, 10, 1e-9);
    near(out[10].y, 90, 1e-9);
  });
});

describe('recognizeShape — lines', () => {
  it('a wobbly horizontal stroke becomes an exactly horizontal line', () => {
    const result = recognizeShape(hand([{ x: 0, y: 0 }, { x: 300, y: 9 }], { wobble: 0.004 }), OPTIONS);

    assert.equal(result.kind, 'line');

    const [a, b] = (result as { geometry: PolyGeometry }).geometry.points;

    near(angleOf(a, b), 0, 1e-6, 'angle');
    near(Math.hypot(b.x - a.x, b.y - a.y), 300, 8, 'length');
  });

  it('a diagonal off 45° by 3° snaps to 45°, by 12° keeps its angle', () => {
    const at = (deg: number) => {
      const r = (deg * Math.PI) / 180;

      return recognizeShape(hand([{ x: 0, y: 0 }, { x: 250 * Math.cos(r), y: 250 * Math.sin(r) }], { wobble: 0.003 }), OPTIONS);
    };
    const snapped = at(48) as { geometry: PolyGeometry };
    const free = at(57) as { geometry: PolyGeometry };

    near(angleOf(snapped.geometry.points[0], snapped.geometry.points[1]), 45, 1e-6);
    near(angleOf(free.geometry.points[0], free.geometry.points[1]), 57, 1.5);
  });

  it('an arc is not a line', () => {
    assert.equal(recognizeShape(hand(ellipsePath(0, 0, 200, 200, 0, 200, 80)), OPTIONS).kind, 'none');
  });

  it('a stroke that doubles back is not a line', () => {
    const result = recognizeShape(hand([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 60, y: 4 }], { wobble: 0 }), OPTIONS);

    assert.equal(result.kind, 'none');
  });

  it('too small to be a shape → none', () => {
    assert.equal(recognizeShape(hand([{ x: 0, y: 0 }, { x: 12, y: 0 }], { wobble: 0, jitter: 0.2 }), OPTIONS).kind, 'none');
  });
});

describe('recognizeShape — ellipses and circles', () => {
  it('a rough circle becomes a circle', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = recognizeShape(hand(ellipsePath(400, 300, 120, 115, 0, -90 + seed * 20, 365), { seed, wobble: 0.015 }), OPTIONS);

      assert.equal(result.kind, 'circle', `seed ${seed}`);

      const g = (result as { geometry: EllipseGeometry }).geometry;

      near(g.cx, 400, 10, 'cx');
      near(g.cy, 300, 10, 'cy');
      near(g.rx, 117, 10, 'r');
      assert.equal(g.rx, g.ry);
    }
  });

  it('an axis-aligned rough ellipse stays an ellipse, snapped to the axis', () => {
    const result = recognizeShape(hand(ellipsePath(0, 0, 200, 90, (4 * Math.PI) / 180), { wobble: 0.01 }), OPTIONS);

    assert.equal(result.kind, 'ellipse');

    const g = (result as { geometry: EllipseGeometry }).geometry;

    assert.equal(g.angle, 0);
    near(g.rx, 200, 15, 'rx');
    near(g.ry, 90, 12, 'ry');
  });

  it('a tall ellipse keeps its orientation (rx horizontal, ry vertical)', () => {
    const g = (recognizeShape(hand(ellipsePath(0, 0, 70, 180), { wobble: 0.008 }), OPTIONS) as { geometry: EllipseGeometry })
      .geometry;

    assert.equal(g.angle, 0);
    assert.ok(g.ry > g.rx * 2, `ry ${g.ry} rx ${g.rx}`);
  });

  it('a tilted ellipse keeps its tilt', () => {
    const result = recognizeShape(hand(ellipsePath(0, 0, 200, 80, (35 * Math.PI) / 180), { wobble: 0.006 }), OPTIONS);

    assert.equal(result.kind, 'ellipse');
    near(((result as { geometry: EllipseGeometry }).geometry.angle * 180) / Math.PI, 35, 4);
  });

  it('a double loop (spiral) is not a circle', () => {
    assert.equal(recognizeShape(hand(ellipsePath(0, 0, 150, 150, 0, 0, 720)), OPTIONS).kind, 'none');
  });

  it('a half-closed C is not a circle', () => {
    assert.equal(recognizeShape(hand(ellipsePath(0, 0, 150, 150, 0, 40, 280)), OPTIONS).kind, 'none');
  });
});

describe('recognizeShape — polygons', () => {
  it('a rough square becomes an exact axis-aligned square', () => {
    for (const seed of [1, 2, 3, 4]) {
      const square = [
        { x: 0, y: 0 },
        { x: 200, y: 6 },
        { x: 196, y: 205 },
        { x: -4, y: 198 },
      ];
      const result = recognizeShape(hand(polygonPath(square, 0.1), { seed, wobble: 0.006 }), OPTIONS);

      assert.equal(result.kind, 'rectangle', `seed ${seed}`);
      assert.equal((result as { square: boolean }).square, true);

      const pts = (result as { geometry: PolyGeometry }).geometry.points;

      for (let k = 0; k < 4; k += 1) {
        const angle = angleOf(pts[k], pts[(k + 1) % 4]);

        near(Math.abs(Math.round(angle / 90) * 90 - angle), 0, 1e-6, 'edge angle');
      }
    }
  });

  it('a rectangle stays a rectangle (not squared), axis-snapped', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 320, y: 0 },
      { x: 320, y: 150 },
      { x: 0, y: 150 },
    ].map((p) => rotatePoint(p, { x: 160, y: 75 }, 5));
    const result = recognizeShape(hand(polygonPath(rect), { wobble: 0.005 }), OPTIONS);

    assert.equal(result.kind, 'rectangle');
    assert.equal((result as { square: boolean }).square, false);

    const [a, b] = (result as { geometry: PolyGeometry }).geometry.points;

    near(angleOf(a, b) % 90, 0, 1e-6);
  });

  it('a rectangle rotated 30° keeps its rotation', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 160 },
      { x: 0, y: 160 },
    ].map((p) => rotatePoint(p, { x: 150, y: 80 }, 30));
    const result = recognizeShape(hand(polygonPath(rect), { wobble: 0.005 }), OPTIONS);

    assert.equal(result.kind, 'rectangle');

    const [a, b] = (result as { geometry: PolyGeometry }).geometry.points;
    const angle = ((angleOf(a, b) % 90) + 90) % 90;

    near(angle, 30, 3);
  });

  it('a rough triangle becomes a triangle with sharp vertices near the drawn corners', () => {
    const tri = [
      { x: 100, y: 0 },
      { x: 210, y: 190 },
      { x: -5, y: 185 },
    ];
    const result = recognizeShape(hand(polygonPath(tri, 0.08), { wobble: 0.006 }), OPTIONS);

    assert.equal(result.kind, 'triangle');

    const pts = (result as { geometry: PolyGeometry }).geometry.points;

    assert.equal(pts.length, 3);

    for (const corner of tri) {
      const closest = Math.min(...pts.map((p) => Math.hypot(p.x - corner.x, p.y - corner.y)));

      assert.ok(closest < 14, `corner ${JSON.stringify(corner)} off by ${closest}`);
    }

    // The near-horizontal base was snapped flat.
    const flat = pts.some((p, k) => Math.abs(angleOf(p, pts[(k + 1) % 3]) % 180) < 1e-6);

    assert.ok(flat, 'base snapped to horizontal');
  });

  it('a parallelogram is a 4-gon polygon, not a rectangle', () => {
    const quad = [
      { x: 0, y: 0 },
      { x: 220, y: 0 },
      { x: 300, y: 150 },
      { x: 80, y: 150 },
    ];
    const result = recognizeShape(hand(polygonPath(quad), { wobble: 0.004 }), OPTIONS);

    assert.equal(result.kind, 'polygon');
    assert.equal((result as { geometry: PolyGeometry }).geometry.points.length, 4);
  });
});

describe('recognizeShape — handwriting must be left alone', () => {
  const cases: Record<string, Vec[]> = {
    zigzag: [
      { x: 0, y: 0 },
      { x: 30, y: 60 },
      { x: 60, y: 0 },
      { x: 90, y: 60 },
      { x: 120, y: 0 },
      { x: 150, y: 60 },
    ],
    'letter m': [
      { x: 0, y: 80 },
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 40, y: 80 },
      { x: 50, y: 0 },
      { x: 80, y: 0 },
      { x: 85, y: 80 },
    ],
    'letter S': [
      ...ellipsePath(50, 30, 40, 30, 0, 0, -270),
      ...ellipsePath(50, 90, 40, 30, 0, -90, 270),
    ],
    'letter e': [{ x: 0, y: 40 }, { x: 80, y: 40 }, ...ellipsePath(40, 40, 40, 40, 0, 0, -300)],
    'figure eight': [...ellipsePath(0, -60, 60, 60, 0, 90, 360), ...ellipsePath(0, 60, 60, 60, 0, -90, -360)],
    'tick ✓': [
      { x: 0, y: 40 },
      { x: 30, y: 80 },
      { x: 110, y: 0 },
    ],
  };

  for (const [name, path] of Object.entries(cases)) {
    it(`${name} → none`, () => {
      for (const seed of [1, 2, 3]) {
        assert.equal(recognizeShape(hand(path, { seed, scale: 100 }), OPTIONS).kind, 'none', `seed ${seed}`);
      }
    });
  }
});

describe('adjustSnappedShape', () => {
  it('a line follows the pen with its end, start fixed, angle snapped', () => {
    const line: RecognizedShape = {
      kind: 'line',
      geometry: {
        type: 'poly',
        closed: false,
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      },
    };
    const moved = adjustSnappedShape(line, { x: 100, y: 0 }, { x: 150, y: 3 }) as { geometry: PolyGeometry };

    assert.deepEqual(moved.geometry.points[0], { x: 0, y: 0 });
    near(moved.geometry.points[1].y, 0, 1e-9);
    near(moved.geometry.points[1].x, Math.hypot(150, 3), 1e-9);
  });

  it('a closed shape scales around its centre, a small twist does not rotate it', () => {
    const square: RecognizedShape = {
      kind: 'rectangle',
      square: true,
      geometry: {
        type: 'poly',
        closed: true,
        points: [
          { x: -50, y: -50 },
          { x: 50, y: -50 },
          { x: 50, y: 50 },
          { x: -50, y: 50 },
        ],
      },
    };
    const grown = adjustSnappedShape(square, { x: -50, y: -50 }, { x: -101, y: -99 }) as { geometry: PolyGeometry };

    near(grown.geometry.points[2].x, 100, 1.5);
    near(grown.geometry.points[2].y, 100, 1.5);
    near(angleOf(grown.geometry.points[0], grown.geometry.points[1]), 0, 1e-9);

    const turned = adjustSnappedShape(square, { x: 50, y: 0 }, { x: 0, y: 50 }) as { geometry: PolyGeometry };

    near(angleOf(turned.geometry.points[0], turned.geometry.points[1]), 90, 1e-6);
  });

  it('a circle scales and stays a circle', () => {
    const circle: RecognizedShape = { kind: 'circle', geometry: { type: 'ellipse', cx: 0, cy: 0, rx: 50, ry: 50, angle: 0 } };
    const out = adjustSnappedShape(circle, { x: 50, y: 0 }, { x: 0, y: 80 }) as { geometry: EllipseGeometry };

    near(out.geometry.rx, 80, 1e-9);
    assert.equal(out.geometry.rx, out.geometry.ry);
    assert.equal(out.geometry.angle, 0);
  });
});

describe('snapLineEnd', () => {
  it('only snaps within the configured tolerance', () => {
    const deg = SHAPE_THRESHOLDS.lineAngleSnapDeg;
    const at = (d: number) => {
      const r = (d * Math.PI) / 180;

      return angleOf(...snapLineEnd({ x: 0, y: 0 }, { x: Math.cos(r) * 100, y: Math.sin(r) * 100 }));
    };

    near(at(90 - deg + 0.5), 90, 1e-9);
    near(at(90 - deg - 1), 90 - deg - 1, 1e-9);
  });
});
