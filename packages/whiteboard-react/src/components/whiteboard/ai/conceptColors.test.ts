import assert from 'node:assert/strict';
import { test } from 'node:test';

import { branchesOf, CONCEPT_INKS_DARK, CONCEPT_INKS_LIGHT, edgeBranch, mutedInk, nodeInk } from './conceptColors';

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);

  return (hi! + 0.05) / (lo! + 0.05);
};

test('every ink, and every muted phrase ink, reads at 4.5:1 on its paper', () => {
  for (const [inks, paper, name] of [
    [CONCEPT_INKS_LIGHT, '#ffffff', 'light'],
    [CONCEPT_INKS_DARK, '#141416', 'dark'],
  ] as const)
    for (const ink of [inks.root, ...inks.branches]) {
      assert.ok(contrast(ink, paper) >= 4.5, `${name} ${ink} ≥ 4.5`);
      assert.ok(contrast(mutedInk(ink, name), paper) >= 4.5, `${name} muted ${ink} ≥ 4.5`);
      assert.notEqual(ink.toLowerCase(), '#000000');
    }
});

test('branches: a root child starts a hue, descendants (nearest branch wins) and links inherit it, the root keeps the dark ink', () => {
  const graph = {
    nodes: ['r', 'a', 'b', 'a1', 'a2', 'b1', 'x'].map((id) => ({ id })),
    edges: [
      ['r', 'a'],
      ['r', 'b'],
      ['a', 'a1'],
      ['a1', 'a2'],
      ['b', 'b1'],
      ['b', 'a2'],
    ].map(([from, to]) => ({ from: from!, to: to! })),
  };
  const branch = branchesOf(graph);

  assert.deepEqual(['r', 'a', 'b', 'a1', 'a2', 'b1', 'x'].map(branch), [-1, 0, 1, 0, 1, 1, -1]);
  assert.equal(edgeBranch(branch, 'r', 'b'), 1);
  assert.equal(edgeBranch(branch, 'b', 'a2'), 1);
  assert.equal(nodeInk(CONCEPT_INKS_LIGHT, -1), CONCEPT_INKS_LIGHT.root);
  assert.equal(nodeInk(CONCEPT_INKS_LIGHT, 7), CONCEPT_INKS_LIGHT.branches[1]);
});
