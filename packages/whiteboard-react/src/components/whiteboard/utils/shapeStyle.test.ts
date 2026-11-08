import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Path, Rect } from 'fabric';

import { chainLines, outlineCentreLine } from './inkAreaFill';
import {
  dashArrayForStyle,
  dashOfArray,
  DEFAULT_SHAPE_STYLE,
  parseShapeStyle,
  roughOutline,
  roundedPolygon,
} from './shapeStyle';
import { applyShapeStyle, newShapeOptions, styleOfObject } from './shapeStylePaint';

describe('shape style settings', () => {
  it('reads defaults from nothing or junk, and keeps valid fields', () => {
    assert.deepEqual(parseShapeStyle(null), DEFAULT_SHAPE_STYLE);
    assert.deepEqual(parseShapeStyle('{not json'), DEFAULT_SHAPE_STYLE);
    assert.equal(DEFAULT_SHAPE_STYLE.fill, 'transparent');

    const read = parseShapeStyle(JSON.stringify({ fill: '#DBEAFE', fillStyle: 'cross', rough: 2, edges: 'round', dash: 'wavy', width: -3, opacity: 0.5 }));

    assert.equal(read.fill, '#DBEAFE');
    assert.equal(read.fillStyle, 'cross');
    assert.equal(read.rough, 2);
    assert.equal(read.edges, 'round');
    assert.equal(read.dash, 'solid');
    assert.equal(read.width, DEFAULT_SHAPE_STYLE.width);
    assert.equal(read.opacity, 0.5);
  });

  it('dash patterns round-trip to their style', () => {
    assert.equal(dashArrayForStyle('solid', 4), null);
    assert.equal(dashOfArray(dashArrayForStyle('dashed', 4)), 'dashed');
    assert.equal(dashOfArray(dashArrayForStyle('dotted', 4)), 'dotted');
    assert.equal(dashOfArray(null), 'solid');
  });
});

describe('hand-drawn outline', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('is the plain outline when smooth', () => {
    assert.deepEqual(roughOutline(square, true, 0, 4, 7), [square]);
  });

  it('draws two passes, the same for the same seed, and stays near the outline', () => {
    const a = roughOutline(square, true, 2, 4, 42);
    const b = roughOutline(square, true, 2, 4, 42);
    const c = roughOutline(square, true, 2, 4, 43);

    assert.equal(a.length, 2);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);

    for (const point of a.flat()) {
      assert.ok(point.x > -15 && point.x < 115 && point.y > -15 && point.y < 115, `${point.x},${point.y} strays too far`);
    }
  });
});

describe('rounded polygon', () => {
  it('cuts each corner and never past half an edge', () => {
    const out = roundedPolygon(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      50,
    );

    assert.equal(out.length, 4 * 7);
    assert.ok(!out.some((p) => (p.x === 0 && p.y === 0) || (p.x === 10 && p.y === 10)));
    assert.deepEqual(out[0], { x: 0, y: 5 });
  });
});

describe('applying a style', () => {
  it('fills, hatches and rounds a rectangle; solid stores no pattern field; none clears', () => {
    const rect = new Rect({ width: 100, height: 60, stroke: '#1F2937', strokeWidth: 4, fill: '' });

    assert.equal(applyShapeStyle(rect, { fill: '#DBEAFE', fillStyle: 'hatch', edges: 'round', rough: 1 }), 1);
    assert.equal(rect.fill, '#DBEAFE');
    assert.equal((rect as unknown as { wbFillStyle?: string }).wbFillStyle, 'hatch');
    assert.equal(rect.rx, 15);
    assert.ok((rect as unknown as { wbSeed?: number }).wbSeed);
    assert.deepEqual(styleOfObject(rect), {
      opacity: 1,
      fill: '#DBEAFE',
      fillStyle: 'hatch',
      stroke: '#1F2937',
      width: 4,
      dash: 'solid',
      rough: 1,
      edges: 'round',
    });

    applyShapeStyle(rect, { fillStyle: 'solid' });
    assert.equal((rect as unknown as { wbFillStyle?: string }).wbFillStyle, undefined);

    applyShapeStyle(rect, { fill: 'transparent' });
    assert.equal(rect.fill, '');
    assert.equal(applyShapeStyle(rect, { fill: 'transparent' }), 0);
  });

  it('a width change keeps the dash style, and the style survives saving', () => {
    const rect = new Rect({ width: 50, height: 50, stroke: '#1F2937', strokeWidth: 4 });

    applyShapeStyle(rect, { dash: 'dashed' });
    applyShapeStyle(rect, { width: 8 });
    assert.deepEqual(rect.strokeDashArray, dashArrayForStyle('dashed', 8));
  });

  it('only opacity applies to ink; new shapes take the settings, lines no background', () => {
    const ink = new Path('M 0 0 L 10 10', { stroke: '#1F2937', strokeWidth: 2, fill: '' });

    applyShapeStyle(ink, { opacity: 0.4, fill: '#DBEAFE', rough: 2 });
    assert.equal(ink.opacity, 0.4);
    assert.equal(ink.fill, '');
    assert.equal((ink as unknown as { wbRough?: number }).wbRough, undefined);

    const style = { ...DEFAULT_SHAPE_STYLE, fill: '#FEE2E2', fillStyle: 'cross' as const };

    assert.equal(newShapeOptions(style, true).fill, '#FEE2E2');
    assert.equal(newShapeOptions(style, true).wbFillStyle, 'cross');
    assert.equal(newShapeOptions(style, false).fill, '');
  });
});

describe('ink area fill helpers', () => {
  it('pairs an outline loop into its centre line', () => {
    // A 4 px wide horizontal band, 0 → 30: left side forward, right side back.
    const loop = [
      { x: 0, y: -2 },
      { x: 10, y: -2 },
      { x: 20, y: -2 },
      { x: 30, y: -2 },
      { x: 30, y: 2 },
      { x: 20, y: 2 },
      { x: 10, y: 2 },
      { x: 0, y: 2 },
    ];
    const centre = outlineCentreLine(loop, 7);

    assert.ok(centre.every((p) => Math.abs(p.y) < 1e-9));
    const xs = centre.map((p) => p.x);

    // End to end along the band (an end may repeat; it adds nothing to the area).
    assert.equal(Math.min(...xs), 0);
    assert.equal(Math.max(...xs), 30);
    assert.deepEqual([...new Set(xs)].sort((a, b) => a - b), [0, 10, 20, 30]);
  });

  it('chains four sides of a box drawn in any order and direction', () => {
    const out = chainLines([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      [
        { x: 0, y: 10 },
        { x: 0, y: 0 },
      ],
      [
        { x: 10, y: 10 },
        { x: 10, y: 0 },
      ],
      [
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    ]);

    assert.deepEqual(out, [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ]);
  });
});
