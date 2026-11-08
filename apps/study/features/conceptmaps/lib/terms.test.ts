import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  levenshtein,
  matchTerms,
  missingTerms,
  normalizeTerm,
  parseTermList,
  singularize,
  termMatches,
  termTokens,
} from './terms';

test('normalizeTerm: case, punctuation, possessives, diacritics', () => {
  assert.equal(normalizeTerm("Bowen's Reaction Series"), 'bowen reaction series');
  assert.equal(normalizeTerm('  Plate-Tectonics!! '), 'plate tectonics');
  assert.equal(normalizeTerm('Earth’s layers'), 'earth layers');
  assert.equal(normalizeTerm('Café'), 'cafe');
});

test('singularize: plurals, keeps series/-ss/-us', () => {
  assert.equal(singularize('boundaries'), 'boundary');
  assert.equal(singularize('bonds'), 'bond');
  assert.equal(singularize('gases'), 'gas');
  assert.equal(singularize('series'), 'series');
  assert.equal(singularize('glass'), 'glass');
  assert.equal(singularize('focus'), 'focus');
});

test('termTokens drops stopwords and singularizes', () => {
  assert.deepEqual(termTokens('Origin of the Rocks'), ['origin', 'rock']);
});

test('levenshtein', () => {
  assert.equal(levenshtein('phaneritic', 'phanitic'), 2);
  assert.equal(levenshtein('extrusive', 'extrusiv'), 1);
  assert.equal(levenshtein('a', 'a'), 0);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('termMatches: exact, case, plural, contained, misspelled, compound', () => {
  assert.ok(termMatches('Lithosphere', 'lithosphere'));
  assert.ok(termMatches('Ionic Bonds', 'Ionic bond'));
  assert.ok(termMatches('Plate Tectonics', 'Plate tectonics theory'));
  assert.ok(termMatches('Phaneritic', 'Phanitic (coarse-grained)'));
  assert.ok(termMatches('Seafloor spreading', 'sea floor spreading'));
  assert.ok(termMatches("Bowen's Reaction Series", 'bowens reaction series'));
  assert.ok(termMatches('Magmatic Differentiation', 'Magmatic diferentiation'));
  assert.ok(!termMatches('Hardness', 'Luster'));
  assert.ok(!termMatches('Mafic', 'Felsic'));
  assert.ok(!termMatches('Test', 'Theory'));
  // Short words get no edit allowance: "mica" must not match "mice".
  assert.ok(!termMatches('Mica', 'Mice'));
});

test('matchTerms claims each node once, exact before fuzzy', () => {
  const nodes = [
    { id: 'a', label: 'Convergent plate boundaries' },
    { id: 'b', label: 'Plate boundaries' },
    { id: 'c', label: 'slab pull' },
    { id: 'd', label: 'Ridge push happens at the ridge' },
  ];
  const rows = matchTerms(
    ['Plate boundaries', 'Convergent Plate Boundaries', 'Slab Pull', 'Ridge Push', 'Transform'],
    nodes,
  );

  assert.deepEqual(
    rows.map((row) => [row.term, row.node?.id ?? null, row.exact]),
    [
      ['Plate boundaries', 'b', true],
      ['Convergent Plate Boundaries', 'a', true],
      ['Slab Pull', 'c', true],
      ['Ridge Push', 'd', false],
      ['Transform', null, false],
    ],
  );
  assert.deepEqual(missingTerms(['Slab Pull', 'Transform'], nodes), ['Transform']);
});

test('parseTermList splits, trims, dedupes, caps at 8', () => {
  assert.deepEqual(parseTermList('Crust, mantle;  Mantle\nCore,,'), ['Crust', 'mantle', 'Core']);
  assert.equal(parseTermList('a,b,c,d,e,f,g,h,i,j').length, 8);
  assert.deepEqual(parseTermList('   '), []);
});
