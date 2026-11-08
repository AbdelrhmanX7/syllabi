import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  capsuleBBox,
  distancePointToSegment,
  distanceSegmentToSegment,
  ellipsePoints,
  eraserSceneDiameter,
  eraserSceneRadius,
  flattenPath,
  pathHitsCapsule,
  pointInPolygon,
  polygonHitsCapsule,
  polylineHitsCapsule,
  segmentsIntersect,
} from './eraserGeometry';

import type { EraserCapsule, Vec } from './eraserGeometry';

const ring = (x: number, y: number, r: number): EraserCapsule => ({ a: { x, y }, b: { x, y }, r });
const sweep = (a: Vec, b: Vec, r: number): EraserCapsule => ({ a, b, r });

describe('eraserSceneDiameter — the swath equals the ring at any zoom', () => {
  it('is the screen size at zoom 1', () => {
    assert.equal(eraserSceneDiameter(24, 1), 24);
    assert.equal(eraserSceneRadius(24, 1), 12);
  });

  it('shrinks the scene width as the board zooms in, so the on-screen swath stays the ring', () => {
    for (const zoom of [0.25, 0.5, 1, 1.5, 2, 3, 4]) {
      const scene = eraserSceneDiameter(24, zoom);

      // What Fabric paints: scene width × zoom.
      assert.ok(Math.abs(scene * zoom - 24) < 1e-9, `zoom ${zoom}: swath ${scene * zoom}`);
      assert.ok(Math.abs(eraserSceneRadius(24, zoom) * 2 - scene) < 1e-9);
    }
  });

  it('treats a missing or absurd zoom as 1 rather than blowing the width up', () => {
    assert.equal(eraserSceneDiameter(24, 0), 24);
    assert.equal(eraserSceneDiameter(24, Number.NaN), 24);
    assert.equal(eraserSceneDiameter(24, -2), 24);
    assert.equal(eraserSceneDiameter(24, Number.POSITIVE_INFINITY), 24);
  });

  it('never returns a negative width', () => {
    assert.equal(eraserSceneDiameter(-10, 1), 0);
  });
});

describe('segment distances', () => {
  it('measures perpendicular distance inside the segment and endpoint distance outside it', () => {
    assert.equal(distancePointToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
    assert.equal(distancePointToSegment({ x: 14, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
    assert.equal(distancePointToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5);
  });

  it('is zero when segments cross and the gap otherwise', () => {
    assert.ok(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }));
    assert.equal(distanceSegmentToSegment({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), 0);
    assert.equal(distanceSegmentToSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }, { x: 10, y: 4 }), 4);
    assert.ok(!segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }, { x: 10, y: 4 }));
  });

  it('counts a collinear overlap as touching', () => {
    assert.ok(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 }));
  });
});

describe('polylineHitsCapsule — the ring must reach the paint, not the box', () => {
  // A diagonal stroke from (0,0) to (100,100): its bounding box is the whole 100×100 square.
  const diagonal: Vec[] = [
    { x: 0, y: 0 },
    { x: 50, y: 50 },
    { x: 100, y: 100 },
  ];

  it('misses a ring sitting in the empty corner of the stroke box', () => {
    // (90, 10) is inside the box but 56px from the line — the exact case that deleted untouched ink.
    assert.ok(!polylineHitsCapsule(diagonal, ring(90, 10, 12)));
    assert.ok(!polylineHitsCapsule(diagonal, ring(10, 90, 12)));
  });

  it('hits only once the ring edge reaches the stroke edge', () => {
    // Perpendicular distance from (60, 40) to the diagonal is 20/√2 ≈ 14.14.
    assert.ok(!polylineHitsCapsule(diagonal, ring(60, 40, 14)));
    assert.ok(polylineHitsCapsule(diagonal, ring(60, 40, 14.2)));
    // A 4px-wide stroke reaches 2px further.
    assert.ok(polylineHitsCapsule(diagonal, ring(60, 40, 12.2), 2));
    assert.ok(!polylineHitsCapsule(diagonal, ring(60, 40, 12), 2));
  });

  it('catches a stroke the ring jumped over between two frames', () => {
    // Frame 1 at (20, 80), frame 2 at (80, 20): both rings miss the diagonal, the sweep crosses it.
    assert.ok(!polylineHitsCapsule(diagonal, ring(20, 80, 8)));
    assert.ok(!polylineHitsCapsule(diagonal, ring(80, 20, 8)));
    assert.ok(polylineHitsCapsule(diagonal, sweep({ x: 20, y: 80 }, { x: 80, y: 20 }, 8)));
  });

  it('treats a lone point as a dot', () => {
    assert.ok(polylineHitsCapsule([{ x: 10, y: 10 }], ring(15, 10, 5)));
    assert.ok(!polylineHitsCapsule([{ x: 10, y: 10 }], ring(16, 10, 5)));
    assert.ok(!polylineHitsCapsule([], ring(0, 0, 100)));
  });

  it('closes the loop only when asked', () => {
    const square: Vec[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];

    // The ring sits on the (0,100)→(0,0) closing edge.
    assert.ok(!polylineHitsCapsule(square, ring(0, 50, 5)));
    assert.ok(polylineHitsCapsule(square, ring(0, 50, 5), 0, true));
  });
});

describe('polygonHitsCapsule — hollow vs filled', () => {
  const square: Vec[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('leaves a hollow shape alone when the ring is in its empty middle', () => {
    assert.ok(!polygonHitsCapsule(square, ring(50, 50, 20), 0, false));
    assert.ok(polygonHitsCapsule(square, ring(50, 2, 5), 0, false));
  });

  it('counts the middle of a filled shape as paint', () => {
    assert.ok(polygonHitsCapsule(square, ring(50, 50, 20), 0, true));
    assert.ok(!polygonHitsCapsule(square, ring(150, 150, 20), 0, true));
  });

  it('pointInPolygon agrees with the geometry', () => {
    assert.ok(pointInPolygon({ x: 50, y: 50 }, square));
    assert.ok(!pointInPolygon({ x: 150, y: 50 }, square));
  });
});

describe('flattenPath / pathHitsCapsule — the pen brush emits M/Q/L', () => {
  it('samples a quadratic curve rather than testing its chord', () => {
    // A quadratic arc from (0,0) to (100,0) bulging to y≈50 at its midpoint via control (50,100).
    const commands = [
      ['M', 0, 0],
      ['Q', 50, 100, 100, 0],
    ];
    const [polyline] = flattenPath(commands);

    assert.ok(polyline.length > 2);
    assert.ok(polyline.some((p) => p.y > 45));
    // A ring on the chord's midpoint, far below the arc, must miss.
    assert.ok(!pathHitsCapsule(commands, ring(50, 0, 10)));
    // A ring on the arc's apex hits.
    assert.ok(pathHitsCapsule(commands, ring(50, 50, 4)));
  });

  it('samples cubic curves and closes Z onto the start', () => {
    const commands = [
      ['M', 0, 0],
      ['C', 0, 50, 100, 50, 100, 0],
      ['L', 100, -40],
      ['Z'],
    ];
    const [polyline] = flattenPath(commands);

    assert.deepEqual(polyline[polyline.length - 1], { x: 0, y: 0 });
    assert.ok(polyline.some((p) => p.y > 30));
    // The closing edge runs from (100,-40) back to (0,0).
    assert.ok(pathHitsCapsule(commands, ring(50, -20, 2)));
  });

  it('keeps sub-paths apart so a gap between two strokes is not a stroke', () => {
    const commands = [
      ['M', 0, 0],
      ['L', 40, 0],
      ['M', 60, 0],
      ['L', 100, 0],
    ];

    assert.equal(flattenPath(commands).length, 2);
    assert.ok(!pathHitsCapsule(commands, ring(50, 0, 9)));
    assert.ok(pathHitsCapsule(commands, ring(50, 0, 10.5)));
  });

  it('maps path points through the supplied transform before testing', () => {
    const commands = [
      ['M', 0, 0],
      ['L', 10, 0],
    ];
    const shift = (p: Vec) => ({ x: p.x + 200, y: p.y + 200 });

    assert.ok(!pathHitsCapsule(commands, ring(205, 200, 2)));
    assert.ok(pathHitsCapsule(commands, ring(205, 200, 2), 0, shift));
  });
});

describe('capsuleBBox + ellipsePoints', () => {
  it('spans both ends plus the reach', () => {
    assert.deepEqual(capsuleBBox(sweep({ x: 10, y: 20 }, { x: 30, y: 5 }, 4), 1), {
      minX: 5,
      minY: 0,
      maxX: 35,
      maxY: 25,
    });
  });

  it('walks the ellipse outline', () => {
    const points = ellipsePoints(10, 5, 4);

    assert.equal(points.length, 4);
    assert.ok(Math.abs(points[0].x - 10) < 1e-9);
    assert.ok(Math.abs(points[1].y - 5) < 1e-9);
  });
});
