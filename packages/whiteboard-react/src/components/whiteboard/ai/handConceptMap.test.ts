import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planProblems, SAMPLE_MAPS } from './handConceptMap.fixture';
import { planHandConceptMap, wrapHandText } from './handConceptMap';

import type { TermsPrimitive } from './termsMap';
import type { ConceptMap } from './types';

const box = (x: number, y: number) => ({ x, y, w: 0.2, h: 0.1 });

// The live reference-map shape: page-fraction boxes, labelled end-arrows, levels.
const MAP: ConceptMap = {
  title: 'From **Continental Drift** to Plate Tectonics',
  nodes: [
    { id: 'n1', text: 'Alfred Wegener', level: 0, bbox: box(0.1, 0.05) },
    { id: 'n2', text: 'Continental Drift', level: 1, bbox: box(0.1, 0.2) },
    { id: 'n3', text: 'Supercontinent Pangaea', level: 2, bbox: box(0, 0.35) },
    { id: 'n4', text: 'Lacked a mechanism', level: 2, bbox: box(0.2, 0.35) },
    { id: 'n5', text: 'Fossil and rock evidence matching across oceans', level: 2, bbox: box(0.4, 0.35) },
  ],
  edges: [
    { from: 'n1', to: 'n2', label: 'proposed', arrow: 'end' },
    { from: 'n2', to: 'n3', label: 'described the breakup of', arrow: 'end' },
    { from: 'n2', to: 'n4', label: 'was rejected because it', arrow: 'end' },
    { from: 'n2', to: 'n5', label: 'was supported by', arrow: 'both' },
    { from: 'n4', to: 'n5', arrow: 'none' },
  ],
};

type Ellipse = { cx: number; cy: number; rx: number; ry: number };

const overlaps = (a: Ellipse, b: Ellipse) => Math.abs(a.cx - b.cx) < a.rx + b.rx && Math.abs(a.cy - b.cy) < a.ry + b.ry;

test('wrapHandText: words wrap at the limit, a long word stays whole, markup is dropped', () => {
  assert.deepEqual(wrapHandText('Fossil and rock evidence matching across oceans', 16), ['Fossil and rock', 'evidence', 'matching across', 'oceans']);
  assert.deepEqual(wrapHandText('**Lithosphere**', 6), ['Lithosphere']);
  assert.deepEqual(wrapHandText('  ', 6), ['']);
});

test('planHandConceptMap: nothing overlaps — nodes, phrases, arrows, title — on every sample map', () => {
  for (const [name, map] of Object.entries({ reference: MAP, ...SAMPLE_MAPS })) {
    for (const maxWidth of [undefined, 1400, 700]) {
      const plan = planHandConceptMap(map, { letterHeight: 22, maxWidth, minLetterHeight: 4 });

      assert.deepEqual(planProblems(plan), [], `${name} @ ${maxWidth ?? 'any width'}`);
      if (maxWidth) assert.ok(plan.width <= maxWidth + 1e-6, `${name} fits ${maxWidth}: ${plan.width}`);
      // Written text never runs past its slot.
      assert.ok(plan.primitives.every((p) => p.kind !== 'label' || p.fit === 1), `${name}: labels clamp to their box`);
    }
  }
});

test('planHandConceptMap: node text and phrases carry their node / link, so they can move with them', () => {
  const plan = planHandConceptMap(MAP, { letterHeight: 20 });
  const labels = plan.primitives.filter((p): p is Extract<TermsPrimitive, { kind: 'label' }> => p.kind === 'label');

  assert.ok(labels.filter((p) => p.role === 'node').every((p) => p.nodeId && plan.nodes.has(p.nodeId)));
  assert.deepEqual(Array.from(new Set(labels.filter((p) => p.role === 'link').map((p) => p.edge))).sort(), ['n1->n2', 'n2->n3', 'n2->n4', 'n2->n5']);
});

test('planHandConceptMap: every node is written inside a hand ellipse, no two ellipses collide', () => {
  const plan = planHandConceptMap(MAP, { letterHeight: 20 });

  assert.equal(plan.nodes.size, 5);
  const ellipses = Array.from(plan.nodes.values());

  for (let i = 0; i < ellipses.length; i += 1) {
    for (let j = i + 1; j < ellipses.length; j += 1) assert.ok(!overlaps(ellipses[i]!, ellipses[j]!), `nodes ${i} and ${j} overlap`);
  }

  const nodeLabels = plan.primitives.filter((p) => p.kind === 'label' && p.role === 'node');

  // n5 wraps to four lines; the rest fit on one or two.
  assert.ok(nodeLabels.length >= 8);
  assert.ok(nodeLabels.every((p) => p.kind === 'label' && p.textHeight === 20));

  // One outline per node + the root's second ring + the title underline.
  const outlines = plan.primitives.filter((p) => p.kind === 'outline');

  assert.equal(outlines.length, 5 + 1 + 1);
  assert.equal(outlines.filter((p) => p.kind === 'outline' && p.focusRing).length, 1);
  // No ink-copy: nothing of the owner's is moved — the text is written.
  assert.ok(plan.primitives.every((p) => p.kind !== 'ink-copy'));

  // Inside the plan box.
  for (const e of ellipses) {
    assert.ok(e.cx - e.rx >= -1e-6 && e.cx + e.rx <= plan.width + 1e-6);
    assert.ok(e.cy - e.ry >= -1e-6 && e.cy + e.ry <= plan.height + 1e-6);
  }
});

test('planHandConceptMap: the title is written first and plain; arrows follow their `arrow`', () => {
  const plan = planHandConceptMap(MAP, { letterHeight: 20 });
  const first = plan.primitives[0]!;

  assert.equal(first.kind, 'label');
  assert.equal(first.kind === 'label' && first.role, 'title');
  assert.equal(first.kind === 'label' && first.text, 'From Continental Drift to Plate Tectonics');

  const arrows = plan.primitives.filter((p) => p.kind === 'arrow');

  assert.equal(arrows.length, 5);
  const head = (from: string, to: string) => {
    const arrow = arrows.find((p) => p.kind === 'arrow' && p.from === from && p.to === to);

    return arrow && arrow.kind === 'arrow' ? arrow.head : null;
  };

  assert.equal(head('n1', 'n2')!.match(/M /g)!.length, 1);
  assert.equal(head('n2', 'n5')!.match(/M /g)!.length, 2);
  assert.equal(head('n4', 'n5'), '');
  // Levels draw in order: the root (and the title) before its arrows before the next level.
  const steps = plan.primitives.map((p) => p.step);

  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
});

test('planHandConceptMap: a narrow sheet shrinks the hand to fit; deterministic', () => {
  const wide = planHandConceptMap(MAP, { letterHeight: 24 });
  const narrow = planHandConceptMap(MAP, { letterHeight: 24, maxWidth: wide.width / 2 });

  assert.ok(narrow.width <= wide.width / 2 + 1e-6);
  assert.ok(Math.abs(narrow.letterHeight - 12) < 0.5);
  // The floor wins over the width.
  const floored = planHandConceptMap(MAP, { letterHeight: 24, maxWidth: wide.width / 4, minLetterHeight: 10 });

  assert.equal(floored.letterHeight, 10);
  assert.deepEqual(planHandConceptMap(MAP, { letterHeight: 24 }).primitives, wide.primitives);
});

test('planHandConceptMap: without server boxes it lays out top-down', () => {
  const plan = planHandConceptMap({ ...MAP, nodes: MAP.nodes.map(({ bbox: _bbox, ...node }) => node) }, { letterHeight: 20, title: false });
  const root = plan.nodes.get('n1')!;
  const child = plan.nodes.get('n2')!;

  assert.ok(child.cy > root.cy);
  assert.ok(plan.primitives.every((p) => !(p.kind === 'label' && p.role === 'title')));
});

test('planHandConceptMap → buildTermsMapObjects: plain pen Paths, two heads / no head as asked, one tagged batch', async () => {
  const { buildTermsMapObjects } = await import('./termsMapObjects');
  const { AI_OBJECT_PROP } = await import('./boardObjects');
  const plan = planHandConceptMap(MAP, { letterHeight: 20 });
  // Labels need the DOM handwriting pipeline; the rest of the plan is built here.
  const noLabels = { ...plan, primitives: plan.primitives.filter((primitive) => primitive.kind !== 'label') };
  const built = await buildTermsMapObjects(noLabels, { sources: new Map(), color: '#18204a', strokeWidth: 2.5, hand: null, zoom: 1, batch: 'ai-ref' });
  const tags = built.objects.map((object) => (object as unknown as Record<string, { kind: string; batch?: string; source?: string }>)[AI_OBJECT_PROP]);

  assert.ok(built.objects.length > 0);
  assert.ok(built.objects.every((object) => object.type === 'path' && object.fill === null && typeof object.stroke === 'string' && object.stroke !== '#000000'));
  // Ink by meaning: more than one colour on the page (root / branches), none of it black.
  assert.ok(new Set(built.objects.map((object) => object.stroke)).size > 1);
  assert.ok(tags.every((value) => value?.batch === 'ai-ref'));
  // Outlines: 5 nodes + the root ring + the title underline.
  assert.equal(tags.filter((value) => value?.kind === 'terms-node').length, 7);
  const both = tags.filter((value) => value?.kind === 'terms-edge' && value.source === 'n2->n5').length;
  const none = tags.filter((value) => value?.kind === 'terms-edge' && value.source === 'n4->n5').length;

  // n2→n5 has heads at both ends after its shaft (broken round its phrase, or whole with the phrase
  // beside it); n4→n5 is one shaft, no head.
  assert.ok(both === 3 || both === 4, `n2->n5 strokes: ${both}`);
  assert.equal(none, 1);
  // Steps in draw order, title first.
  assert.equal(built.steps.length, new Set(noLabels.primitives.map((primitive) => primitive.step)).size);
});
