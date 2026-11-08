import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Path } from 'fabric';

import { AI_OBJECT_PROP } from './boardObjects';
import { buildPenActionObjects } from './penActionObjects';
import { planPenActions } from './penActions';

import type { SceneRect } from './types';

const r = (left: number, top: number, width: number, height: number): SceneRect => ({ left, top, width, height });

test('buildPenActionObjects: strokes become pen Paths tagged with the turn batch; the pointer is a step only', async () => {
  const clusters = new Map([['c1', r(100, 200, 300, 40)]]);
  const plan = planPenActions(
    {
      actions: [
        { type: 'point_at', at: { x: 0.5, y: 0.5 }, note: 'here' },
        { type: 'circle', target: { clusterId: 'c1' } },
        { type: 'underline', target: { clusterId: 'c1' } },
        { type: 'arrow', from: { x: 0.1, y: 0.9 }, to: { clusterId: 'c1' } },
        { type: 'pen_stroke', points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }], tool: 'highlighter' },
      ],
    },
    { page: r(0, 0, 1000, 1400), clusters, occupied: Array.from(clusters.values()), letterHeight: 30, strokeWidth: 3, seed: 3 },
  );
  // Notes need the DOM handwriting pipeline; everything else is built here.
  const built = await buildPenActionObjects(plan, { color: '#1d4ed8', strokeWidth: 3, hand: null, zoom: 1, batch: 'ai-pen-test' });
  const tags = built.objects.map((object) => (object as unknown as Record<string, { kind: string; batch?: string; source?: string }>)[AI_OBJECT_PROP]);

  // circle + underline + arrow shaft + arrow head + free stroke.
  assert.equal(built.objects.length, 5);
  assert.ok(tags.every((tag) => tag?.batch === 'ai-pen-test'));
  assert.deepEqual(
    tags.map((tag) => tag?.kind),
    ['pen-mark', 'pen-mark', 'pen-mark', 'pen-mark', 'pen-stroke'],
  );
  assert.deepEqual(
    tags.map((tag) => tag?.source),
    ['circle', 'underline', 'arrow', 'arrow-head', 'ink'],
  );

  for (const object of built.objects) {
    assert.ok(object instanceof Path);
    assert.equal(object.fill, null);
    assert.equal(object.stroke, '#1d4ed8');
    assert.equal(object.strokeLineCap, 'round');
  }

  const highlighter = built.objects[4]!;

  assert.ok(highlighter.opacity < 1, 'a highlighter stroke is translucent');
  assert.equal(highlighter.strokeWidth, 27);

  // Steps in plan order: the pointer first (no object), then one step per stroke.
  assert.deepEqual(
    built.steps.map((step) => step.kind),
    ['pointer', 'stroke', 'stroke', 'stroke', 'stroke', 'stroke'],
  );
  assert.deepEqual(built.steps[0], { kind: 'pointer', at: { x: 500, y: 700 }, note: 'here' });
  assert.equal(built.steps.flatMap((step) => (step.kind === 'pointer' ? [] : step.objects)).length, built.objects.length);
});
