import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Path } from 'fabric';

import type { FabricObject } from 'fabric';

import { AI_OBJECT_PROP } from './boardObjects';
import { parseTermsMap, planTermsMap } from './termsMap';
import { buildTermsMapObjects } from './termsMapObjects';

const stroke = (d: string) => new Path(d, { fill: null, stroke: '#1d4ed8', strokeWidth: 3, strokeLineCap: 'round', strokeLineJoin: 'round' });

test('buildTermsMapObjects: ink is cloned (originals untouched), outlines/arrows are pen strokes, one tagged batch', async () => {
  const originals = { c1: [stroke('M 100 100 L 160 120'), stroke('M 170 100 L 190 125')], c2: [stroke('M 100 300 L 150 320')] };
  const before = [...originals.c1, ...originals.c2].map((object) => [object.left, object.top]);
  const result = parseTermsMap(
    {
      nodes: [
        { id: 'r', text: 'Root', clusterIds: ['c1'], level: 0 },
        { id: 'k', text: 'Kid', clusterIds: ['c2'], level: 1 },
      ],
      edges: [{ from: 'r', to: 'k', label: '' }],
      extra: [{ id: 'x', text: 'Extra', level: 1 }],
    },
    ['c1', 'c2'],
  )!;
  const rect = (objects: FabricObject[]) => {
    const boxes = objects.map((object) => object.getBoundingRect());
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));

    return { left, top, width: Math.max(...boxes.map((box) => box.left + box.width)) - left, height: Math.max(...boxes.map((box) => box.top + box.height)) - top };
  };
  const plan = planTermsMap(result, new Map([['c1', rect(originals.c1)], ['c2', rect(originals.c2)]]), { letterHeight: 20, seed: 1 });
  // Labels need the DOM handwriting pipeline; the rest of the plan is built here.
  const noLabels = { ...plan, primitives: plan.primitives.filter((primitive) => primitive.kind !== 'label') };
  const built = await buildTermsMapObjects(noLabels, {
    sources: new Map(Object.entries(originals)),
    color: '#1d4ed8',
    strokeWidth: 3,
    hand: null,
    zoom: 1,
    batch: 'ai-test',
  });
  const tags = built.objects.map((object) => (object as unknown as Record<string, { kind: string; batch?: string }>)[AI_OBJECT_PROP]);

  assert.deepEqual([...originals.c1, ...originals.c2].map((object) => [object.left, object.top]), before);
  assert.ok(tags.every((value) => value?.batch === 'ai-test'));
  assert.equal(tags.filter((value) => value?.kind === 'terms-ink').length, 3);
  assert.equal(tags.filter((value) => value?.kind === 'terms-node').length, 3);
  // Shaft + head = two strokes for the one bare arrow.
  assert.equal(tags.filter((value) => value?.kind === 'terms-edge').length, 2);

  for (const object of built.objects) {
    assert.ok(object instanceof Path);
    assert.equal(object.fill, null);
    assert.equal(object.stroke, '#1d4ed8');
    assert.equal(object.strokeLineCap, 'round');
  }

  const dashed = built.objects.filter((object) => object.strokeDashArray?.length);

  assert.equal(dashed.length, 1, 'only the AI-added concept is dashed');
  // The copies moved into the map's local frame; their shape is the original's.
  const copy = built.objects.find((_, index) => tags[index]?.kind === 'terms-ink')!;

  assert.notDeepEqual([copy.left, copy.top], before[0]);
  assert.equal((copy as Path).path.length, originals.c1[0]!.path.length);
  assert.ok(built.steps.length >= 3);
  assert.equal(built.steps.flat().length, built.objects.length);
});
