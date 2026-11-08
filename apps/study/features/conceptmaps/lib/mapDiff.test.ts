import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PLATE_TECTONICS_REFERENCE, PLATE_TECTONICS_TRANSCRIPTION } from './diagram.fixture';
import {
  descriptionsOverlap,
  diffMaps,
  ghostId,
  isDefinitionLabel,
  labelsCompatible,
  locateWrongLink,
  matchConcepts,
  overlayGraph,
  parseTranscription,
  readingGraph,
  summarizeDiff,
  summarizeExtras,
} from './mapDiff';

test('parseTranscription: concepts, unlabeled links, definition notes, markdown stripped', () => {
  const graph = parseTranscription(PLATE_TECTONICS_TRANSCRIPTION);
  const label = (id: string) => graph.nodes.find((node) => node.id === id)!.label;

  assert.deepEqual(
    graph.nodes.filter((node) => node.kind === 'concept').map((node) => node.label),
    ['Continental Drift', 'Plate Tectonics', 'Asthenosphere', 'Lithosphere'],
  );
  assert.equal(graph.nodes.filter((node) => node.kind === 'note').length, 4);
  assert.equal(graph.edges.length, 7);
  assert.deepEqual(graph.edges.map((edge) => `${label(edge.from)}|${edge.label}|${label(edge.to)}`).slice(1, 4), [
    'Continental Drift|null|Plate Tectonics',
    'Using it to know more about ocean ridges and the sea floor|null|Plate Tectonics',
    'Plate Tectonics|null|Asthenosphere',
  ]);
});

test('parseTranscription: quoted labels, ascii arrows, dangling and arrow-less lines', () => {
  const graph = parseTranscription(
    '- Convection -> "drives" -> Seafloor spreading\nHot spot → unlabeled\nJust a heading\nA => B',
  );

  assert.deepEqual(
    graph.edges.map((edge) => edge.label),
    ['drives', null],
  );
  assert.deepEqual(
    graph.nodes.map((node) => node.label),
    ['Convection', 'Seafloor spreading', 'A', 'B'],
  );
});

test('labelsCompatible: same idea in other words passes, a different relation does not', () => {
  assert.ok(labelsCompatible('later led to', 'led to'));
  assert.ok(labelsCompatible('Consists of', 'consists of'));
  assert.ok(labelsCompatible('is made of', 'made of rock'));
  assert.ok(!labelsCompatible('causes', 'is part of'));
  assert.ok(!labelsCompatible('', 'is'));
});

test('matchConcepts: case, plurals, one name inside the other; notes are not concepts', () => {
  const his = {
    nodes: [
      { id: 'a', label: 'asthenosphere', kind: 'concept' as const },
      { id: 'b', label: 'Lithospheric Plates', kind: 'concept' as const },
      { id: 'c', label: 'Crust + uppermost mantle, outermost strong rigid layer', kind: 'note' as const },
    ],
    edges: [],
  };
  const map = matchConcepts(his, [
    { id: 'r1', text: 'Asthenosphere (upper mantle)' },
    { id: 'r2', text: 'Lithospheric plate' },
    { id: 'r3', text: 'Crust + uppermost mantle' },
  ]);

  assert.equal(map.get('r1'), 'a');
  assert.equal(map.get('r2'), 'b');
  assert.equal(map.has('r3'), false);
});

test('descriptionsOverlap: one inside the other, or ≥ 30 % shared words', () => {
  const note = 'Crust + uppermost mantle, outermost strong rigid layer';

  assert.ok(descriptionsOverlap(note, 'Crust + uppermost mantle'));
  assert.ok(descriptionsOverlap(note, "Earth's outer rigid layer"));
  assert.ok(
    descriptionsOverlap(
      '(part of upper mantle) hotter and weak compared to the Lithosphere',
      'Weak, hot layer of the upper mantle',
    ),
  );
  assert.ok(
    !descriptionsOverlap(
      'Using it to know more about ocean ridges and the sea floor',
      "Unifying theory of how Earth's surface moves and changes",
    ),
  );
  assert.ok(
    isDefinitionLabel('is defined as') && isDefinitionLabel('Consists of') && !isDefinitionLabel('later led to'),
  );
});

const TERMS = ['Continental Drift', 'Plate Tectonics', 'Lithosphere', 'Asthenosphere', 'Pangaea'];

test('diffMaps: the 9.5/10 plate-tectonics map scores on the core, not on the enrichment', () => {
  const his = parseTranscription(PLATE_TECTONICS_TRANSCRIPTION);
  const diff = diffMaps(his, PLATE_TECTONICS_REFERENCE, TERMS);
  const byLabel = (label: string) => his.nodes.find((node) => node.label === label)!.id;
  const lithNote = byLabel('Crust + uppermost mantle, outermost strong rigid layer');

  // Core: drift→pangaea, drift→plate tectonics, plate tectonics «is defined as», lithosphere «is» + «consists of».
  assert.deepEqual(diff.counts, {
    core: 5,
    matched: 2,
    needLabel: 1,
    reworded: 0,
    defDiffers: 1,
    coreMissing: 1,
    ideas: 12,
    extra: 2,
  });
  assert.equal(summarizeDiff(diff.counts), 'Core: 2/5 links · 1 needs a label · 1 definition differs · 1 core missing');
  assert.equal(summarizeExtras(diff.counts), '+12 ideas you could add · 2 links of your own');
  // The only red link is the Pangaea one he left out.
  const red = diff.edges.filter((edge) => edge.cls === 'missing');

  assert.deepEqual(
    red.map((edge) => [edge.refFrom, edge.refTo]),
    [['n2', 'n3']],
  );
  assert.ok(diff.nodes.find((node) => node.id === ghostId('n3'))!.absentTerm);
  // His Lithosphere note satisfies both of its definition links.
  assert.equal(diff.covered.get('n10'), lithNote);
  assert.equal(diff.covered.get('n11'), lithNote);
  assert.equal(diff.edges.find((edge) => edge.to === lithNote)!.cls, 'matched');
  // Drift → Plate Tectonics: right pair, no label — suggest «later led to».
  const drift = diff.edges.find(
    (edge) => edge.from === byLabel('Continental Drift') && edge.to === byLabel('Plate Tectonics'),
  )!;

  assert.deepEqual([drift.cls, drift.refLabel], ['labelOff', 'later led to']);
  assert.match(overlayGraph(diff).edges[diff.edges.indexOf(drift)]!.label!, /add «later led to»/);
  // Enrichment is never «missing»: Wegener, fossils, convection… are faint ideas.
  assert.ok(diff.edges.filter((edge) => edge.tier === 'enrichment').every((edge) => edge.cls !== 'missing'));
  assert.equal(diff.nodes.find((node) => node.id === ghostId('n1'))!.cls, 'idea');
  assert.equal(diff.nodes.find((node) => node.id === ghostId('n13'))!.cls, 'idea');
  // His own link Plate Tectonics → Asthenosphere: extra, not wrong.
  assert.equal(
    diff.edges.find((edge) => edge.from === byLabel('Plate Tectonics') && edge.to === byLabel('Asthenosphere'))!.cls,
    'extra',
  );
});

test('diffMaps: matched, reworded and reversed links; no prompt terms = everything is core', () => {
  const his = readingGraph({
    nodes: [
      { id: 'a', label: 'Mantle convection' },
      { id: 'b', label: 'Rigid lithospheric plates' },
      { id: 'c', label: 'Seafloor spreading' },
      { id: 'd', label: 'Plate tectonics' },
    ],
    edges: [
      { from: 'a', to: 'b', label: 'moves' },
      { from: 'd', to: 'c', label: 'explains' },
      { from: 'b', to: 'd', label: 'divides the surface into' },
    ],
  });
  const ref = {
    nodes: [
      { id: 'r1', text: 'Mantle convection' },
      { id: 'r2', text: 'Rigid lithospheric plates' },
      { id: 'r3', text: 'Seafloor spreading' },
      { id: 'r4', text: 'Plate Tectonics' },
      { id: 'r5', text: 'Hot spot' },
    ],
    edges: [
      { from: 'r1', to: 'r2', label: 'drags and moves' },
      { from: 'r4', to: 'r3', label: 'explains' },
      { from: 'r4', to: 'r2', label: 'divides the surface into' },
      { from: 'r4', to: 'r5', label: 'explains' },
    ],
  };
  const diff = diffMaps(his, ref);

  assert.deepEqual(
    diff.edges.map((edge) => edge.cls),
    ['matched', 'matched', 'labelOff', 'missing'],
  );
  assert.ok(diff.edges[2]!.reversed);
  assert.deepEqual([diff.counts.core, diff.counts.reworded, diff.counts.coreMissing], [4, 1, 1]);
  assert.match(overlayGraph(diff).edges[2]!.label!, /reversed/);

  // A prompt term found nowhere: a red-ringed ghost.
  const stray = diffMaps(his, ref, ['Magma']).nodes.find((node) => node.id.startsWith('term:'))!;

  assert.deepEqual([stray.label, stray.absentTerm, stray.cls], ['Magma', true, 'ghost']);
});

test('locateWrongLink: grader comment labels → his node ids', () => {
  const his = parseTranscription(PLATE_TECTONICS_TRANSCRIPTION);

  assert.ok(
    locateWrongLink(his, { from: 'plate tectonics', to: 'Asthenosphere', label: null, why: 'Plates ride on it' }),
  );
  assert.equal(locateWrongLink(his, { from: 'Magma', to: 'Lithosphere', label: null, why: '' }), null);
});
