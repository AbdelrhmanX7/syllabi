// The demo knowledge map: a well-formed answer for the calculus class, topics for any other class.
import assert from 'node:assert/strict';
import test from 'node:test';

import { mockClassKnowledge } from './knowledge';

test('calculus demo: topics with their parts, mixed strengths, two not tried yet, links between real concepts', () => {
  const k = mockClassKnowledge('cls_demo_math', []);
  const ids = new Set(k.concepts.map((c) => c.id));
  const byLabel = (label: string) => k.concepts.find((c) => c.label === label)!;

  assert.equal(ids.size, k.concepts.length);
  assert.equal(byLabel('Chain rule').parentId, byLabel('Derivatives').id);
  assert.equal(byLabel('Product rule').parentId, byLabel('Derivatives').id);
  assert.equal(byLabel('Substitution').parentId, byLabel('Integrals').id);
  assert.equal(byLabel('Limits').parentId, null);
  assert.equal(k.concepts.filter((c) => c.strength === null).length, 2);
  assert.ok(k.concepts.every((c) => (c.strength === null ? c.attempts === 0 && c.lastAt === null : c.strength >= 0 && c.strength <= 1)));
  assert.ok(k.concepts.some((c) => c.strength !== null && c.strength < 0.6));
  assert.ok(k.concepts.some((c) => c.strength !== null && c.strength >= 0.8));
  assert.ok(k.edges.every((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to));
  assert.equal(k.edges.filter((e) => e.kind === 'part-of').length, k.concepts.filter((c) => c.parentId).length);
  assert.ok(k.edges.some((e) => e.kind === 'linked'));
});

test('calculus demo: a topic the demo question bank has takes the bank\'s numbers', () => {
  const k = mockClassKnowledge('cls_demo_math', [
    { topic: 'Derivatives', mastery: 0.2, attempts: 6, dueCount: 3 },
    { topic: 'Limits', mastery: 0, attempts: 0, dueCount: 0 },
  ]);
  const byLabel = (label: string) => k.concepts.find((c) => c.label === label)!;

  assert.deepEqual([byLabel('Derivatives').strength, byLabel('Derivatives').attempts], [0.2, 6]);
  assert.deepEqual([byLabel('Limits').strength, byLabel('Limits').attempts], [0.86, 14]);
});

test('any other class: one concept per topic, General left out, untried topics have no strength', () => {
  const k = mockClassKnowledge('cls_demo_cs', [
    { topic: 'Constructors', mastery: 0.5, attempts: 2, dueCount: 1 },
    { topic: 'Pointers', mastery: 0, attempts: 0, dueCount: 0 },
    { topic: 'General', mastery: 1, attempts: 3, dueCount: 0 },
  ]);

  assert.deepEqual(
    k.concepts.map((c) => [c.label, c.strength, c.attempts]),
    [
      ['Constructors', 0.5, 2],
      ['Pointers', null, 0],
    ],
  );
  assert.deepEqual(k.edges, []);
  assert.deepEqual(mockClassKnowledge('cls_unknown', []), { concepts: [], edges: [] });
});
