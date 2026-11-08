import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPhraseMemory, MAX_PHRASES, normalizePhrase } from './phrase-memory';
import { DEFAULT_INK_SETTINGS, inkEnabledForPage, parseInkSettings } from './settings';

test('settings: off by default; malformed fields fall back one by one', () => {
  assert.equal(parseInkSettings(null).enabled, false);
  assert.deepEqual(parseInkSettings('{oops'), DEFAULT_INK_SETTINGS);
  const parsed = parseInkSettings(
    JSON.stringify({
      enabled: true,
      engine: 'gpu',
      palette: { term: '#ABCDEF', heading: 'red', plain: null },
      pageOverrides: { p1: false, p2: 'x' },
    }),
  );

  assert.equal(parsed.enabled, true);
  assert.equal(parsed.engine, 'device');
  assert.deepEqual(parsed.palette, { term: '#abcdef', plain: null });
  assert.deepEqual(parsed.pageOverrides, { p1: false });
});

test('a page override beats the device switch', () => {
  const settings = { ...DEFAULT_INK_SETTINGS, enabled: true, pageOverrides: { p1: false } };

  assert.equal(inkEnabledForPage(settings, 'p1'), false);
  assert.equal(inkEnabledForPage(settings, 'p2'), true);
  assert.equal(inkEnabledForPage({ ...DEFAULT_INK_SETTINGS, pageOverrides: { p3: true } }, 'p3'), true);
});

test('phrase memory: normalised lookup, newest wins, capped', () => {
  let stored: string | null = null;
  const memory = createPhraseMemory({ read: () => stored, write: (value) => (stored = value) });

  memory.remember('Ohm law:', 'formula');
  assert.equal(memory.lookup('ohm law'), 'formula');
  assert.equal(memory.lookup('Ohms law'), null, 'a different letter is a different phrase');
  assert.equal(memory.lookup('  OHM   law! '), 'formula', 'case, spacing and punctuation ignored');
  memory.remember('Osmosis', 'term');
  assert.equal(memory.lookup('osmosis'), 'term');

  // Survives a reload.
  assert.equal(createPhraseMemory({ read: () => stored, write: () => undefined }).lookup('OSMOSIS'), 'term');

  for (let i = 0; i < MAX_PHRASES + 5; i += 1) memory.remember(`w${i}`, 'plain');
  assert.equal(memory.size(), MAX_PHRASES);
  assert.equal(memory.lookup('ohm law'), null, 'oldest dropped');
  assert.equal(normalizePhrase('  Cell, (Membrane)! '), 'cell membrane');
});
