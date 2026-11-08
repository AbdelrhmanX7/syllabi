import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Circle, Ellipse, Group, Line, Path, Polygon, Rect, Triangle } from 'fabric';

import { objectHitsEraser } from './eraserHitTest';

import type { EraserCapsule } from './eraserGeometry';

const ring = (x: number, y: number, r: number): EraserCapsule => ({ a: { x, y }, b: { x, y }, r });

// What the pen brush produces: an open path, stroked, never filled.
const strokePath = (d: string, strokeWidth = 4) =>
  new Path(d, { fill: null, stroke: '#111', strokeWidth, strokeLineCap: 'round' });

describe('objectHitsEraser — a stroke is hit only where it is painted', () => {
  it('ignores a ring inside the box of a diagonal stroke but off its ink', () => {
    const path = strokePath('M 0 0 L 100 100');

    assert.ok(!objectHitsEraser(path, ring(90, 10, 12)), 'empty corner of the box');
    assert.ok(objectHitsEraser(path, ring(50, 50, 4)), 'on the ink');
  });

  it('inflates by half the stroke width, exactly as the stroke is painted', () => {
    const path = strokePath('M 0 0 L 100 0', 10);

    // 5px of paint each side of the centreline: a ring whose edge reaches y=5 touches it.
    assert.ok(objectHitsEraser(path, ring(50, 11, 6.1)));
    assert.ok(!objectHitsEraser(path, ring(50, 11, 5.9)));
  });

  it('tests the stroke where it is NOW — after a move and a scale', () => {
    const path = strokePath('M 0 0 L 100 0', 2);

    assert.ok(objectHitsEraser(path, ring(50, 0, 2)));

    path.set({ left: path.left + 300, top: path.top + 300 });
    path.setCoords();

    assert.ok(!objectHitsEraser(path, ring(50, 0, 2)), 'old place');
    assert.ok(objectHitsEraser(path, ring(350, 300, 2)), 'new place');

    path.set({ scaleX: 2 });
    path.setCoords();

    // Scaled about its centre (350, 300): the ink now runs x = 250 … 450, and the stroke is 2× wider.
    assert.ok(objectHitsEraser(path, ring(449, 300, 2)), 'the stretched far end');
    assert.ok(!objectHitsEraser(path, ring(460, 300, 2)), 'past it');
  });

  it('follows a group transform', () => {
    const path = strokePath('M 0 0 L 100 0', 2);
    const group = new Group([path], { left: 500, top: 500 });

    group.setCoords();
    assert.ok(!objectHitsEraser(path, ring(50, 0, 2)), 'the ungrouped position');
    assert.ok(objectHitsEraser(path, ring(550, 501, 2)), 'inside the group');
  });

  it('catches a stroke the ring swept across between frames', () => {
    const path = strokePath('M 0 100 L 100 0', 2);

    assert.ok(!objectHitsEraser(path, ring(10, 10, 6)));
    assert.ok(!objectHitsEraser(path, ring(90, 90, 6)));
    assert.ok(objectHitsEraser(path, { a: { x: 10, y: 10 }, b: { x: 90, y: 90 }, r: 6 }));
  });
});

// Fabric 7 centres objects on `left`/`top` by default; these tests pin the origin to the top-left so the
// coordinates read like the drawing. With a stroke, the centre sits at left + (width + stroke) / 2.
const topLeft = { originX: 'left', originY: 'top' } as const;

describe('objectHitsEraser — shapes', () => {
  it('a hollow rect is hit on its edge, not through its middle', () => {
    const hollow = new Rect({ ...topLeft, left: 0, top: 0, width: 100, height: 100, fill: 'transparent', stroke: '#000', strokeWidth: 2 });

    hollow.setCoords();
    // Rect is "everything else": its box is tested as paint, filled or not — a box IS its outline
    // plus interior, and a hollow rect's interior erase is the one approximation this keeps.
    assert.ok(objectHitsEraser(hollow, ring(50, 1, 4)));
    assert.ok(!objectHitsEraser(hollow, ring(150, 150, 4)));
  });

  it('a hollow ellipse/circle is hit only on its ring; a filled one anywhere inside', () => {
    const hollow = new Ellipse({ ...topLeft, left: 0, top: 0, rx: 50, ry: 30, fill: '', stroke: '#000', strokeWidth: 2 });
    const filled = new Circle({ ...topLeft, left: 0, top: 0, radius: 50, fill: '#f00' });

    // Hollow ellipse: centre (51, 31) once the 2px stroke is counted; rim top at y = 1.
    assert.ok(!objectHitsEraser(hollow, ring(51, 31, 10)), 'hollow centre');
    assert.ok(objectHitsEraser(hollow, ring(50, 2, 4)), 'hollow rim');
    assert.ok(objectHitsEraser(filled, ring(50, 50, 10)), 'filled centre');
    assert.ok(!objectHitsEraser(filled, ring(130, 50, 10)), 'outside');
  });

  it('a hollow triangle is hit only on its sides', () => {
    const triangle = new Triangle({ ...topLeft, left: 0, top: 0, width: 100, height: 100, fill: 'rgba(0,0,0,0)', stroke: '#000', strokeWidth: 2 });

    assert.ok(!objectHitsEraser(triangle, ring(50, 70, 8)), 'inside the hollow');
    assert.ok(objectHitsEraser(triangle, ring(50, 99, 4)), 'on the base');
  });

  it('a line is its segment', () => {
    const line = new Line([0, 0, 100, 100], { stroke: '#000', strokeWidth: 2 });

    assert.ok(!objectHitsEraser(line, ring(90, 10, 10)));
    assert.ok(objectHitsEraser(line, ring(50, 50, 2)));
  });

  it('a polygon is its outline (plus its inside when filled)', () => {
    const hollow = new Polygon(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      { fill: 'transparent', stroke: '#000', strokeWidth: 2 },
    );

    assert.ok(!objectHitsEraser(hollow, ring(50, 50, 10)));
    assert.ok(objectHitsEraser(hollow, ring(50, 0, 3)));
  });

  it('a filled rect — and anything else box-shaped — is hit anywhere on its box', () => {
    const filled = new Rect({ ...topLeft, left: 0, top: 0, width: 100, height: 100, fill: '#0f0' });

    assert.ok(objectHitsEraser(filled, ring(50, 50, 2)));
    assert.ok(!objectHitsEraser(filled, ring(150, 50, 2)));
  });
});
