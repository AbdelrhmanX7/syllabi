import type { KeyValueStore } from './links';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chipProgress,
  clampSplit,
  conceptChips,
  leadingQuestions,
  lectureNumber,
  mergeQuestions,
  readSplit,
  readTicks,
  toggleTick,
  writeSplit,
  writeTicks,
} from './workspace-state';

function memoryStore(): KeyValueStore {
  const data: Record<string, string> = {};

  return { getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const TERMS = ['Continental drift', 'Plate tectonics', 'Asthenosphere', 'Lithosphere'];

test('toggleTick ignores case and spacing', () => {
  let ticked = toggleTick([], 'Plate tectonics');

  ticked = toggleTick(ticked, 'Asthenosphere');
  assert.deepEqual(ticked, ['Plate tectonics', 'Asthenosphere']);
  assert.deepEqual(toggleTick(ticked, '  plate   TECTONICS '), ['Asthenosphere']);
});

test('ticks persist per map and survive a corrupt store', () => {
  const store = memoryStore();

  writeTicks(store, 'm1', ['Lithosphere']);
  writeTicks(store, 'm2', ['Asthenosphere']);
  assert.deepEqual(readTicks(store, 'm1'), ['Lithosphere']);
  writeTicks(store, 'm1', []);
  assert.deepEqual(readTicks(store, 'm1'), []);
  assert.deepEqual(readTicks(store, 'm2'), ['Asthenosphere']);
  store.setItem('study_cm_ticks', 'nope');
  assert.deepEqual(readTicks(store, 'm2'), []);
  assert.deepEqual(readTicks(null, 'm2'), []);
});

test('conceptChips: placed / todo / missing-from-notes, professor order, dedupe', () => {
  const chips = conceptChips([...TERMS, 'lithosphere ', ''], ['asthenosphere'], {
    missingFromNotes: ['Lithosphere', 'Asthenosphere'],
    concepts: [{ term: 'plate tectonics', matchesProfessor: false }],
  });

  assert.deepEqual(
    chips.map((chip) => [chip.term, chip.state, chip.differs]),
    [
      ['Continental drift', 'todo', false],
      ['Plate tectonics', 'todo', true],
      // ticked beats «missing from notes»: he placed it, from the slide
      ['Asthenosphere', 'placed', false],
      ['Lithosphere', 'missing-from-notes', false],
    ],
  );
  assert.deepEqual(chipProgress(chips), { placed: 1, total: 4 });
  assert.deepEqual(chipProgress(conceptChips([], [])), { placed: 0, total: 0 });
});

test('lectureNumber reads the common spellings', () => {
  assert.equal(lectureNumber('Lecture 4: Plate Tectonics'), 4);
  assert.equal(lectureNumber('L12 Volcanoes'), 12);
  assert.equal(lectureNumber('lecture_5'), 5);
  assert.equal(lectureNumber('Plate Tectonics'), null);
  assert.equal(lectureNumber(null), null);
});

const GUIDE = `# Earth Science guide
Use her wording.

## Lecture 4 — Plate Tectonics
- What is the continental drift?
- **How did theory of plate tectonics develop?**
Some prose line.
### Key terms
1. What is the asthenosphere?

## Lecture 5 — Earthquakes
- What causes an earthquake?

## Week 6
- Why do volcanoes form at boundaries?
`;

test('leadingQuestions: only the matching lecture section, nested headings included', () => {
  assert.deepEqual(leadingQuestions(GUIDE, { lecture: 'L4 Plate Tectonics', week: 4 }), [
    'What is the continental drift?',
    'How did theory of plate tectonics develop?',
    'What is the asthenosphere?',
  ]);
  assert.deepEqual(leadingQuestions(GUIDE, { lecture: 'Earthquakes', week: null }), ['What causes an earthquake?']);
  assert.deepEqual(leadingQuestions(GUIDE, { lecture: null, week: 6 }), ['Why do volcanoes form at boundaries?']);
  assert.deepEqual(leadingQuestions(GUIDE, { lecture: 'Lecture 9', week: 9 }), []);
  assert.deepEqual(leadingQuestions(null, { lecture: 'Lecture 4' }), []);
});

test('mergeQuestions keeps guide order and drops repeats', () => {
  assert.deepEqual(mergeQuestions(['What is X?', 'Why Y?'], ['what is  x?', 'How Z?']), [
    'What is X?',
    'Why Y?',
    'How Z?',
  ]);
});

test('split ratio is clamped and persisted', () => {
  const store = memoryStore();

  assert.equal(readSplit(store), 0.5);
  writeSplit(store, 0.9);
  assert.equal(readSplit(store), 0.75);
  writeSplit(store, 0.4321);
  assert.equal(readSplit(store), 0.432);
  assert.equal(clampSplit(Number.NaN), 0.5);
  assert.equal(clampSplit(0.1), 0.25);
});
