import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Group, Path, Rect } from 'fabric';

import { boxesIntersect, normalizeBox, objectHitsBox, polylineHitsBox, segmentHitsBox, solidPolygonHitsBox } from './boxSelection';

const strokePath = (d: string, strokeWidth = 4) => new Path(d, { fill: null, stroke: '#111', strokeWidth, strokeLineCap: 'round' });

describe('normalizeBox', () => {
  it('spans the same box whichever way the drag went', () => {
    const expected = { left: 10, top: 20, right: 50, bottom: 80 };

    assert.deepEqual(normalizeBox({ x: 10, y: 20 }, { x: 50, y: 80 }), expected);
    assert.deepEqual(normalizeBox({ x: 50, y: 80 }, { x: 10, y: 20 }), expected);
    assert.deepEqual(normalizeBox({ x: 50, y: 20 }, { x: 10, y: 80 }), expected);
  });
});

describe('box geometry', () => {
  const box = { left: 0, top: 0, right: 10, bottom: 10 };

  it('intersects overlapping and touching boxes, not separate ones', () => {
    assert.ok(boxesIntersect(box, { left: 5, top: 5, right: 20, bottom: 20 }));
    assert.ok(boxesIntersect(box, { left: 10, top: 0, right: 20, bottom: 10 }));
    assert.ok(!boxesIntersect(box, { left: 11, top: 0, right: 20, bottom: 10 }));
  });

  it('a segment hits by an end inside or by crossing straight through', () => {
    assert.ok(segmentHitsBox({ x: 5, y: 5 }, { x: 50, y: 50 }, box));
    assert.ok(segmentHitsBox({ x: -5, y: 5 }, { x: 15, y: 5 }, box), 'crosses with both ends outside');
    assert.ok(!segmentHitsBox({ x: -5, y: 20 }, { x: 15, y: 20 }, box));
  });

  it('a polyline hits when any piece touches; a dot when inside', () => {
    assert.ok(polylineHitsBox([{ x: 50, y: 50 }, { x: 30, y: 30 }, { x: 5, y: 5 }], box));
    assert.ok(!polylineHitsBox([{ x: 50, y: 50 }, { x: 30, y: 30 }], box));
    assert.ok(polylineHitsBox([{ x: 3, y: 3 }], box));
    assert.ok(!polylineHitsBox([], box));
  });

  it('a solid polygon is hit when the box sits wholly inside it', () => {
    const big = [
      { x: -100, y: -100 },
      { x: 100, y: -100 },
      { x: 100, y: 100 },
      { x: -100, y: 100 },
    ];

    assert.ok(solidPolygonHitsBox(big, box));
    assert.ok(!solidPolygonHitsBox(big, { left: 200, top: 200, right: 210, bottom: 210 }));
  });
});

describe('objectHitsBox — partial strokes are caught by their ink, not their bounds', () => {
  it('catches a stroke the box only partly covers', () => {
    const path = strokePath('M 0 50 L 200 50');

    assert.ok(objectHitsBox(path, normalizeBox({ x: 150, y: 30 }, { x: 300, y: 70 })));
  });

  it('ignores a box in the empty corner of a diagonal stroke', () => {
    const path = strokePath('M 0 0 L 100 100');

    assert.ok(!objectHitsBox(path, normalizeBox({ x: 70, y: 5 }, { x: 95, y: 25 })));
    assert.ok(objectHitsBox(path, normalizeBox({ x: 40, y: 40 }, { x: 60, y: 60 })));
  });

  it('counts the stroke width as ink', () => {
    const path = strokePath('M 0 50 L 100 50', 10);

    assert.ok(objectHitsBox(path, normalizeBox({ x: 40, y: 53 }, { x: 60, y: 70 })), 'within half the stroke');
    assert.ok(!objectHitsBox(path, normalizeBox({ x: 40, y: 60 }, { x: 60, y: 70 })));
  });

  it('follows a stroke that was moved after drawing', () => {
    const path = strokePath('M 0 0 L 100 0');

    path.set({ left: path.left + 500, top: path.top + 500 });
    path.setCoords();

    assert.ok(!objectHitsBox(path, normalizeBox({ x: 40, y: -10 }, { x: 60, y: 10 })));
    assert.ok(objectHitsBox(path, normalizeBox({ x: 540, y: 490 }, { x: 560, y: 510 })));
  });

  it('a rect (image/text stand-in) is hit anywhere over its area', () => {
    const rect = new Rect({ left: 0, top: 0, width: 100, height: 100, fill: '#eee' });

    rect.setCoords();
    assert.ok(objectHitsBox(rect, normalizeBox({ x: 40, y: 40 }, { x: 60, y: 60 })));
    assert.ok(!objectHitsBox(rect, normalizeBox({ x: 140, y: 140 }, { x: 160, y: 160 })));
  });

  it('a group of handwritten paths is hit only on its words', () => {
    const group = new Group([strokePath('M 0 0 L 20 0'), strokePath('M 100 0 L 120 0')]);

    assert.ok(!objectHitsBox(group, normalizeBox({ x: 50, y: -10 }, { x: 70, y: 10 })));
    assert.ok(objectHitsBox(group, normalizeBox({ x: 105, y: -10 }, { x: 110, y: 10 })));
  });
});
