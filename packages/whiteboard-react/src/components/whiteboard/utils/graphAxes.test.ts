import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_GRAPH, niceStep, normalizeGraphSpec, planGraph, tickLabel, tickValues } from './graphAxes';

test('any input becomes a usable spec: backwards ranges swap, equal ends widen, junk falls back', () => {
  assert.deepEqual(normalizeGraphSpec(null), DEFAULT_GRAPH);
  assert.deepEqual(normalizeGraphSpec({ mode: 'x', xMin: 10, xMax: 2 }), { mode: 'x', xMin: 2, xMax: 10, yMin: -5, yMax: 5 });
  assert.deepEqual(normalizeGraphSpec({ mode: 'nope', xMin: 'abc', xMax: '7', yMin: 3, yMax: 3 }), { mode: 'xy', xMin: -5, xMax: 7, yMin: 3, yMax: 4 });
});

test('tick spacing is 1, 2 or 5 × a power of ten and never crowds the axis', () => {
  assert.equal(niceStep(10), 1);
  assert.equal(niceStep(20), 2);
  assert.equal(niceStep(100), 10);
  assert.equal(niceStep(1), 0.1);
  assert.equal(niceStep(55), 5);
  assert.deepEqual(tickValues(-1, 1, 0.5), [-1, -0.5, 0, 0.5, 1]);
  assert.deepEqual(tickValues(0, 0.3, 0.1), [0, 0.1, 0.2, 0.3]);
  assert.equal(tickLabel(-2, 1), '−2');
  assert.equal(tickLabel(0.5, 0.5), '0.5');
  assert.equal(tickLabel(1, 0.5), '1');
  assert.equal(tickLabel(-0, 1), '0');
});

test('both axes: they cross at zero, the grid covers the plot, one 0 at the corner', () => {
  const plan = planGraph(DEFAULT_GRAPH, 360);
  const axes = plan.lines.filter((line) => line.kind === 'axis');
  const zeros = plan.labels.filter((label) => label.text === '0');

  assert.equal(plan.width, 360);
  assert.equal(plan.height, 360);
  assert.equal(axes.length, 2);
  assert.equal(axes[0]!.y1, 180, 'the x-axis runs through y = 0');
  assert.equal(axes[1]!.x1, 180, 'the y-axis runs through x = 0');
  assert.equal(plan.lines.filter((line) => line.kind === 'grid').length, 22);
  assert.equal(zeros.length, 1);
  assert.equal(plan.arrows.length, 2, 'one arrow on each positive end');
  assert.deepEqual(plan.labels.filter((label) => label.name).map((label) => label.text), ['x', 'y']);
});

test('x alone is a number line: no height, no grid, arrows at both ends, every number written', () => {
  const plan = planGraph({ mode: 'x', xMin: 0, xMax: 10, yMin: -5, yMax: 5 }, 360);

  assert.equal(plan.height, 0);
  assert.equal(plan.lines.filter((line) => line.kind === 'grid').length, 0);
  assert.equal(plan.arrows.length, 2);
  assert.deepEqual(plan.labels.filter((label) => !label.name).map((label) => label.text), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
});

test('y alone runs upward: the start is at the bottom, the end at the top', () => {
  const plan = planGraph({ mode: 'y', xMin: -5, xMax: 5, yMin: 2, yMax: 6 }, 360);
  const numbers = plan.labels.filter((label) => !label.name);

  assert.equal(plan.width, 0);
  assert.equal(plan.height, 360);
  assert.equal(numbers[0]!.text, '2');
  assert.ok(numbers[0]!.y > numbers[numbers.length - 1]!.y, 'bigger numbers sit higher');
  assert.equal(plan.arrows.length, 2);
});

test('a range that does not include zero keeps its axes, on the edge nearest zero', () => {
  const plan = planGraph({ mode: 'xy', xMin: 2, xMax: 10, yMin: 1, yMax: 5 }, 360);
  const axes = plan.lines.filter((line) => line.kind === 'axis');

  assert.equal(axes[0]!.y1, plan.height, 'the x-axis sits at the bottom (y = 1 is the nearest to 0)');
  assert.equal(axes[1]!.x1, 0, 'the y-axis sits at the left (x = 2 is the nearest to 0)');
});

test('a squat graph never writes one number onto the next (the corner 0 included)', () => {
  for (const spec of [
    { mode: 'xy' as const, xMin: 0, xMax: 20, yMin: -5, yMax: 5 },
    { mode: 'xy' as const, xMin: -5, xMax: 5, yMin: -50, yMax: 50 },
    { mode: 'xy' as const, xMin: -100, xMax: 100, yMin: -3, yMax: 3 },
  ]) {
    const plan = planGraph(spec, 360);
    // Each number's vertical middle, for the ones written left of the y-axis.
    const middles = plan.labels
      .filter((label) => !label.name && label.alignX === 'right')
      .map((label) => (label.alignY === 'top' ? label.y + plan.fontSize / 2 : label.y))
      .sort((a, b) => a - b);

    for (let i = 1; i < middles.length; i += 1) assert.ok(middles[i]! - middles[i - 1]! >= plan.fontSize, JSON.stringify(spec));

    const across = plan.labels.filter((label) => !label.name && label.alignX === 'center').map((label) => label.x).sort((a, b) => a - b);

    for (let i = 1; i < across.length; i += 1) assert.ok(across[i]! - across[i - 1]! >= plan.fontSize * 2, JSON.stringify(spec));
  }
});
