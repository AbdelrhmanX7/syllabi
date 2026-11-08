import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampView, fitView, focusView, panView, readableView, zoomView } from './viewport';

const content = { w: 1000, h: 800 };

test('fitView width: full width from the top, the port aspect kept', () => {
  assert.deepEqual(fitView(content, { w: 500, h: 200 }, 'width'), { x: 0, y: 0, w: 1000, h: 400 });
  // Shorter than the port: centred vertically.
  assert.deepEqual(fitView(content, { w: 500, h: 500 }, 'width'), { x: 0, y: -100, w: 1000, h: 1000 });
});

test('fitView contain: the whole drawing, centred', () => {
  assert.deepEqual(fitView(content, { w: 1000, h: 400 }, 'contain'), { x: -500, y: 0, w: 2000, h: 800 });
  assert.deepEqual(fitView({ w: 0, h: 0 }, { w: 10, h: 10 }, 'contain'), { x: 0, y: 0, w: 0, h: 0 });
});

test('clampView: never past an edge; a bigger view stays around the drawing', () => {
  assert.deepEqual(clampView({ x: -50, y: 900, w: 500, h: 200 }, content), { x: 0, y: 600, w: 500, h: 200 });
  assert.deepEqual(clampView({ x: -800, y: 0, w: 2000, h: 800 }, content), { x: -800, y: 0, w: 2000, h: 800 });
  assert.deepEqual(clampView({ x: 300, y: 0, w: 2000, h: 800 }, content), { x: 0, y: 0, w: 2000, h: 800 });
});

test('zoomView: about the point, bounded, null at the fit', () => {
  const fit = fitView(content, { w: 500, h: 400 }, 'width');
  const zoomed = zoomView(fit, { x: 500, y: 400 }, 2, fit, content)!;

  assert.deepEqual(zoomed, { x: 250, y: 200, w: 500, h: 400 });
  assert.equal(zoomView(zoomed, { x: 500, y: 400 }, 0.4, fit, content), null);
  assert.equal(zoomView(fit, { x: 0, y: 0 }, 100, fit, content)!.w, 160);
});

test('panView: px → units at the current scale, clamped', () => {
  const view = { x: 250, y: 200, w: 500, h: 400 };

  // Port 250 px wide → 2 units per px.
  assert.deepEqual(panView(view, 50, -25, 250, content), { x: 150, y: 250, w: 500, h: 400 });
  assert.deepEqual(panView(view, -10_000, 0, 250, content), { x: 500, y: 200, w: 500, h: 400 });
});

test('focusView: centred on the box with a margin, at the fit aspect; null when it would be the fit', () => {
  const fit = fitView(content, { w: 500, h: 400 }, 'width');

  assert.deepEqual(focusView({ x: 400, y: 300, w: 200, h: 100 }, fit, content, 40, 320), {
    x: 340,
    y: 222,
    w: 320,
    h: 256,
  });
  assert.equal(focusView({ x: 0, y: 0, w: 990, h: 100 }, fit, content), null);
  // Near an edge: kept over the drawing.
  assert.equal(focusView({ x: 950, y: 0, w: 40, h: 40 }, fit, content)!.x, 680);
});

test('readableView: the whole drawing when it is big enough, else top-centre at the minimum scale', () => {
  const whole = fitView(content, { w: 800, h: 640 }, 'width');

  assert.equal(readableView(whole, content, { w: 800, h: 640 }, 0.75), whole);
  const small = fitView(content, { w: 400, h: 300 }, 'width');

  assert.deepEqual(readableView(small, content, { w: 400, h: 300 }, 0.8), { x: 250, y: 0, w: 500, h: 375 });
});
