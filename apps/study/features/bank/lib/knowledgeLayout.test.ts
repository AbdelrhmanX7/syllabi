import type { ClassKnowledge, KnowledgeConcept } from '@/lib/api/types';

import assert from 'node:assert/strict';
import test from 'node:test';

import { byWeakest, layoutKnowledge, practiseTopic, strengthLevel } from './knowledgeLayout';

const concept = (id: string, label: string, strength: number | null, parentId: string | null = null, sources: KnowledgeConcept['sources'] = ['topic']): KnowledgeConcept => ({
  id,
  label,
  parentId,
  sources,
  strength,
  attempts: strength === null ? 0 : 3,
  lastAt: null,
});

const demo: ClassKnowledge = {
  concepts: [
    concept('lim', 'Limits', 0.86),
    concept('der', 'Derivatives', 0.64),
    concept('chain', 'Chain rule', 0.38, 'der', ['subtopic']),
    concept('prod', 'Product rule', 0.81, 'der', ['subtopic']),
    concept('impl', 'Implicit differentiation of inverse trigonometric functions', null, 'der', ['subtopic']),
    concept('int', 'Integrals', 0.47),
    concept('sub', 'Substitution', 0.29, 'int', ['subtopic']),
    concept('tan', 'Tangent line', null, null, ['map-term']),
  ],
  edges: [
    { from: 'chain', to: 'der', kind: 'part-of' },
    { from: 'prod', to: 'der', kind: 'part-of' },
    { from: 'impl', to: 'der', kind: 'part-of' },
    { from: 'sub', to: 'int', kind: 'part-of' },
    { from: 'lim', to: 'der', kind: 'linked' },
    { from: 'der', to: 'lim', kind: 'linked' },
    { from: 'chain', to: 'der', kind: 'linked' },
    { from: 'lim', to: 'gone', kind: 'linked' },
  ],
};

test('strengthLevel: weak under 60%, strong from 80%, nothing tried is its own level', () => {
  assert.deepEqual([0, 0.59, 0.6, 0.79, 0.8, 1, null].map(strengthLevel), ['weak', 'weak', 'middle', 'middle', 'strong', 'strong', 'untried']);
  assert.deepEqual([...demo.concepts].sort(byWeakest).map((c) => c.id).slice(0, 3), ['sub', 'chain', 'int']);
  assert.equal([...demo.concepts].sort(byWeakest).at(-1)!.strength, null);
});

test('practiseTopic: a topic drills itself, a part drills its topic, a map term has nothing to drill', () => {
  const get = (id: string) => demo.concepts.find((c) => c.id === id)!;

  assert.equal(practiseTopic(get('der'), demo.concepts), 'Derivatives');
  assert.equal(practiseTopic(get('chain'), demo.concepts), 'Derivatives');
  assert.equal(practiseTopic(get('tan'), demo.concepts), null);
});

for (const width of [280, 360, 760, 1200]) {
  test(`layoutKnowledge at ${width}px: every concept inside the width, none on another, parts under their topic`, () => {
    const d = layoutKnowledge(demo, width);

    assert.equal(d.nodes.length, demo.concepts.length);
    assert.ok(d.width <= width, `${d.width} > ${width}`);
    for (const n of d.nodes) {
      assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= width && n.y + n.h <= d.height, `${n.id} sticks out`);
      assert.ok(n.lines.length >= 1 && n.lines.every((line) => line.length > 0));
    }
    for (const a of d.nodes)
      for (const b of d.nodes) {
        if (a.id >= b.id) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

        assert.ok(apart, `${a.id} overlaps ${b.id}`);
      }
    const at = (id: string) => d.nodes.find((n) => n.id === id)!;

    for (const part of ['chain', 'prod', 'impl']) assert.ok(at(part).y >= at('der').y + at('der').h, part);
    assert.ok(at('sub').y >= at('int').y + at('int').h);
    assert.equal(at('der').root, true);
    assert.equal(at('tan').root, false);
  });
}

test('layoutKnowledge: one line per part and per link; repeats, a link that doubles a part and unknown ends are dropped', () => {
  const d = layoutKnowledge(demo, 760);
  const keys = d.edges.map((e) => `${e.from}>${e.to}`);

  assert.deepEqual(keys.sort(), ['der>chain', 'der>impl', 'der>prod', 'int>sub', 'lim>der'].sort());
  assert.ok(d.edges.every((e) => e.path.startsWith('M') && e.labelBox === null));
});

test('layoutKnowledge: nothing to draw, a lone concept, and a part whose topic is missing', () => {
  const empty = layoutKnowledge({ concepts: [], edges: [] }, 400);

  assert.equal(empty.nodes.length, 0);
  const one = layoutKnowledge({ concepts: [concept('a', 'Limits', 0.5)], edges: [] }, 400);

  assert.equal(one.nodes.length, 1);
  assert.ok(one.height < 60);
  const orphan = layoutKnowledge({ concepts: [concept('a', 'Chain rule', 0.5, 'nope')], edges: [] }, 400);

  assert.equal(orphan.nodes.length, 1);
  assert.equal(orphan.edges.length, 0);
});

test('layoutKnowledge: a whole course (5 units, 45 parts) fits the width with no concept on top of another', () => {
  const units = ['Limits and continuity', 'Derivatives', 'Applications of derivatives', 'Antiderivatives and integration', 'Review'];
  const concepts: KnowledgeConcept[] = [];
  const edges: ClassKnowledge['edges'] = [];

  units.forEach((unit, u) => {
    concepts.push(concept(`u${u}`, unit, null, null, ['material']));
    for (let p = 0; p < 9; p += 1) {
      concepts.push(concept(`u${u}p${p}`, `${['Related rates', 'Limits at infinity and horizontal asymptotes', 'Chain rule'][p % 3]} ${p}`, p % 4 === 0 ? 0.4 : null, `u${u}`, ['material']));
      edges.push({ from: `u${u}p${p}`, to: `u${u}`, kind: 'part-of' });
    }
  });

  for (const width of [340, 760, 1200]) {
    const diagram = layoutKnowledge({ concepts, edges }, width);

    assert.equal(diagram.nodes.length, 50);
    assert.ok(diagram.nodes.every((node) => node.x >= 0 && node.x + node.w <= width + 0.5), `inside ${width}`);
    for (let a = 0; a < diagram.nodes.length; a += 1) {
      for (let b = a + 1; b < diagram.nodes.length; b += 1) {
        const [m, n] = [diagram.nodes[a]!, diagram.nodes[b]!];

        assert.ok(m.x + m.w <= n.x || n.x + n.w <= m.x || m.y + m.h <= n.y || n.y + n.h <= m.y, `${m.id} overlaps ${n.id} at ${width}`);
      }
    }
  }
});
