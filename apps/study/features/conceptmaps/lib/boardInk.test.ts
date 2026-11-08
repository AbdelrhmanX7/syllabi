// The reference map as the board draws it in hand ink (`boardGraphInput` → the engine's parser →
// its hand planner): no two ellipses touch, no arrow runs through a node or a phrase, no phrase sits
// on a node or on another phrase, and the map fits the sheet. The engine modules are pure, so they
// are imported straight from the package source.
import type { ReferenceMap } from '../types';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseConceptMap } from '../../../../../packages/whiteboard-react/src/components/whiteboard/ai/conceptMap';
import { planHandConceptMap } from '../../../../../packages/whiteboard-react/src/components/whiteboard/ai/handConceptMap';
import { planProblems, SAMPLE_MAPS } from '../../../../../packages/whiteboard-react/src/components/whiteboard/ai/handConceptMap.fixture';

import { boardGraphInput } from './boardDraw';
import { PLATE_TECTONICS_REFERENCE } from './diagram.fixture';

const asReference = (map: (typeof SAMPLE_MAPS)[string]): ReferenceMap => ({
  title: map.title,
  nodes: map.nodes.map((node) => ({ id: node.id, text: node.text })),
  edges: map.edges.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}) })),
});

test('board ink: nothing overlaps on the plate-tectonics reference and the stress maps, and it fits the sheet', () => {
  const maps: Record<string, ReferenceMap> = { plate: PLATE_TECTONICS_REFERENCE };

  for (const [name, map] of Object.entries(SAMPLE_MAPS)) maps[name] = asReference(map);

  for (const [name, graph] of Object.entries(maps)) {
    const map = parseConceptMap(boardGraphInput(graph));

    assert.ok(map, name);
    for (const maxWidth of [1600, 900]) {
      const plan = planHandConceptMap(map, { letterHeight: 20, maxWidth, minLetterHeight: 4 });

      assert.deepEqual(planProblems(plan), [], `${name} @ ${maxWidth}`);
      assert.ok(plan.width <= maxWidth + 1e-6, `${name} fits ${maxWidth}`);
    }
  }
});
