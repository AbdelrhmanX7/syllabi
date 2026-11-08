import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildChecklist, CHECKLIST_CAP, extrasFolded, herSentence, isNoPromptTerms, suggestLabel } from './checklist';
import { PLATE_TECTONICS_REFERENCE, PLATE_TECTONICS_TRANSCRIPTION } from './diagram.fixture';
import { diffMaps, parseTranscription, readingGraph } from './mapDiff';

const TERMS = ['Continental Drift', 'Plate Tectonics', 'Lithosphere', 'Asthenosphere', 'Pangaea'];
const MODEL =
  "Wegener's **continental drift** said the continents were once joined as **Pangaea**, but it lacked a mechanism. **Plate tectonics** supplied one: the rigid **lithosphere** is broken into plates that move over the weak, hot **asthenosphere**.";

test('buildChecklist: the L4 map — add Pangaea, label three arrows, then one definition', () => {
  const his = parseTranscription(PLATE_TECTONICS_TRANSCRIPTION);
  const diff = diffMaps(his, PLATE_TECTONICS_REFERENCE, TERMS);
  const items = buildChecklist({ his, promptTerms: TERMS, reference: PLATE_TECTONICS_REFERENCE, diff, modelAnswer: MODEL });

  assert.deepEqual(
    items.map((item) => item.title),
    [
      'Add Pangaea',
      'Label Continental Drift → Plate Tectonics',
      'Label Plate Tectonics → Asthenosphere',
      'Label Asthenosphere → Lithosphere',
      'Reword the definition of Plate Tectonics',
    ],
  );
  assert.equal(items.length, CHECKLIST_CAP);
  assert.equal(items[0]!.detail, 'Link it from Continental Drift: «described the breakup of», and give it a definition.');
  assert.equal(items[1]!.detail, 'write «later led to»');
  assert.equal(items[2]!.detail, 'write «moves over»');
  assert.match(items[2]!.why!, /through Rigid lithospheric plates: «divides the surface into» … «glide over the weak»/);
  assert.equal(items[3]!.detail, 'write «lies beneath»');
  assert.match(items[3]!.why!, /through Rigid lithospheric plates/);
  assert.equal(items[1]!.why, null);
  assert.match(items[4]!.detail!, /^Closer to the teacher’s wording: «Plate tectonics supplied one/);
  // Enrichment never shows up: no Wegener, fossils or convection.
  assert.ok(items.every((item) => !/Wegener|Fossil|convection/.test(item.title)));
});

test('buildChecklist: full marks on a criterion drop its items; a complete map has none', () => {
  const his = readingGraph({
    nodes: [
      { id: 'a', label: 'Lithosphere', kind: 'concept' },
      { id: 'b', label: 'Asthenosphere', kind: 'concept' },
      { id: 'n', label: "Earth's outer rigid layer: crust + uppermost mantle", kind: 'note' },
    ],
    edges: [
      { from: 'a', to: 'b', label: null },
      { from: 'a', to: 'n', label: null },
    ],
  });
  const terms = ['Lithosphere', 'Asthenosphere'];
  const all = buildChecklist({ his, promptTerms: terms, reference: PLATE_TECTONICS_REFERENCE });

  assert.deepEqual(
    all.map((item) => item.kind),
    ['label', 'define'],
  );
  assert.equal(all[1]!.title, 'Define Asthenosphere');
  const graded = buildChecklist({
    his,
    promptTerms: terms,
    reference: PLATE_TECTONICS_REFERENCE,
    criteria: [
      { name: 'Key terms', score: 2, max: 2, note: '' },
      { name: 'Labeled arrows', score: 2, max: 2, note: '' },
      { name: 'Accurate relationships', score: 2, max: 2, note: '' },
    ],
  });

  assert.deepEqual(graded, []);
});

test('buildChecklist: no map picture read — the verdict still names missing terms and wrong links', () => {
  const items = buildChecklist({
    his: null,
    promptTerms: [],
    verdict: {
      score: 7,
      max: 10,
      rawScore: 6.5,
      missingTerms: ['Hot spot'],
      unlabeledArrows: 0,
      wrongLinks: [{ from: 'Subduction', to: 'Seafloor spreading', label: 'creates', why: 'Backwards.' }],
      suggestions: [],
    },
  });

  assert.deepEqual(
    items.map((item) => [item.kind, item.title]),
    [
      ['term', 'Add Hot spot'],
      ['wrong', 'Fix Subduction → Seafloor spreading'],
    ],
  );
});

test('herSentence / suggestLabel', () => {
  assert.match(herSentence('Pangaea', MODEL)!, /^Wegener's continental drift said/);
  assert.equal(herSentence('Subduction', MODEL), null);
  assert.equal(suggestLabel(PLATE_TECTONICS_REFERENCE, 'Lithosphere', 'Continental Drift'), null);
  const back = suggestLabel(PLATE_TECTONICS_REFERENCE, 'Plate Tectonics', 'Continental Drift')!;

  assert.equal(back.text, 'write «grew out of»');
  assert.match(back.why!, /other way/);
  // A path with no known relation on it: the generic ask, the path still behind «why?».
  const loose = suggestLabel(PLATE_TECTONICS_REFERENCE, 'Alfred Wegener', 'Lacked a mechanism')!;

  assert.equal(loose.text, 'add a linking phrase');
  assert.match(loose.why!, /through Continental Drift/);
});

test('extrasFolded / isNoPromptTerms', () => {
  const one = [{ kind: 'term' as const, title: 'Add Pangaea', detail: null }];

  assert.equal(extrasFolded({ score: 9.5, max: 10 }, one), true);
  assert.equal(extrasFolded({ score: 8.5, max: 10 }, one), false);
  assert.equal(extrasFolded({ score: 4.5, max: 5 }, one), true);
  assert.equal(extrasFolded(null, one), false);
  assert.equal(extrasFolded({ score: null, max: 10 }, []), true);
  assert.equal(isNoPromptTerms(Object.assign(new Error('x'), { status: 400, code: 'NO_PROMPT_TERMS' })), true);
  assert.equal(isNoPromptTerms(Object.assign(new Error('x'), { status: 400, code: 'NO_TERMS' })), false);
  assert.equal(isNoPromptTerms(null), false);
});

test('buildChecklist: an unlabeled arrow already listed as wrong is not listed twice', () => {
  const his = readingGraph({
    nodes: [
      { id: 'a', label: 'Plate Tectonics', kind: 'concept' },
      { id: 'b', label: 'Asthenosphere', kind: 'concept' },
    ],
    edges: [{ from: 'a', to: 'b', label: null }],
  });
  const items = buildChecklist({
    his,
    promptTerms: [],
    verdict: {
      score: 8,
      max: 10,
      rawScore: 7.5,
      missingTerms: [],
      unlabeledArrows: 1,
      wrongLinks: [{ from: 'Plate tectonics', to: 'Asthenosphere', label: '', why: 'Backwards.' }],
      suggestions: [],
    },
  });

  assert.deepEqual(
    items.map((item) => item.kind),
    ['wrong'],
  );
});
