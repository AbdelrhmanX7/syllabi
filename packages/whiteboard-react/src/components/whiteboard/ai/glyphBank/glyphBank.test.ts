import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { composeText, wordIsWritable } from './compose';
import { dotKey, shapeWord } from './latin';
import { normalizeGlyph, simplifyStroke } from './normalize';
import { paginate, sheetCells, sheetKeys, sheetPages } from './sheet';

import type { Composition } from './compose';
import type { GlyphBank, GlyphKey, GlyphPoint, GlyphSample } from './types';

// ---------------------------------------------------------------------------
// A synthetic bank: one simple programmatic glyph per sheet cell
// ---------------------------------------------------------------------------

const DENSITY = 12;

/** A hump from entry to exit, sampled densely, running rightward. */
function hump(width: number, height: number, pressure = 0.6): GlyphPoint[] {
  return Array.from({ length: DENSITY + 1 }, (_, index) => {
    const t = index / DENSITY;

    return [width * t, -height * Math.sin(Math.PI * t), pressure] as GlyphPoint;
  });
}

function sample(strokes: GlyphPoint[][], entry: [number, number], exit: [number, number]): GlyphSample {
  const xs = strokes.flat().map((point) => point[0]);
  const ys = strokes.flat().map((point) => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return { strokes, advance: Math.abs(exit[0] - entry[0]), entry, exit, bbox: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }, source: 'sheet', createdAt: 1 };
}

function syntheticSample(key: GlyphKey, variant = 0): GlyphSample {
  const grow = 1 + variant * 0.1;

  if (key === dotKey(1)) {
    return sample(
      [
        [
          [0, -0.05, 0.7],
          [0.08, 0, 0.7],
        ],
      ],
      [0, 0],
      [0.08, 0],
    );
  }

  const tall = 'bdfhklt'.includes(key.slice(-1));
  const width = 0.9 * grow;

  return sample([hump(width, tall ? 2.2 : 1.2)], [0, 0], [width, 0]);
}

function makeBank({ omit = [] as GlyphKey[], samplesPerKey = 1 } = {}): GlyphBank {
  const glyphs: GlyphBank['glyphs'] = {};

  for (const key of Array.from(sheetKeys())) {
    if (omit.includes(key)) continue;
    glyphs[key] = { key, samples: Array.from({ length: samplesPerKey }, (_, variant) => syntheticSample(key, variant)) };
  }

  return { version: 1, updatedAt: 1, glyphs };
}

const BANK = makeBank();
const OPTIONS = { letterHeight: 20, strokeWidth: 2, seed: 7 };

const allPoints = (composition: Composition): GlyphPoint[] => composition.lines.flatMap((line) => line.strokes.flatMap((stroke) => stroke.points));

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

describe('shapeWord', () => {
  it('one isolated glyph per character, in reading order', () => {
    assert.deepEqual(
      shapeWord('cat').map((glyph) => [glyph.char, glyph.form, glyph.candidates]),
      [
        ['c', 'isol', ['lat:c']],
        ['a', 'isol', ['lat:a']],
        ['t', 'isol', ['lat:t']],
      ],
    );
  });

  it('capitals fall back to the lower-case cell; digits use their own', () => {
    const [big, three] = shapeWord('A3');

    assert.deepEqual(big!.candidates, ['lat:A', 'lat:a']);
    assert.deepEqual(three!.candidates, ['digit:3']);
  });

  it('. , : are synthesised from the dot; unknown characters have no candidates', () => {
    const [period, comma, colon, star] = shapeWord('.,:*');

    assert.equal(period!.synth, 'period');
    assert.equal(comma!.synth, 'comma');
    assert.equal(colon!.synth, 'colon');
    assert.deepEqual(period!.candidates, [dotKey(1)]);
    assert.deepEqual(star!.candidates, []);
  });
});

// ---------------------------------------------------------------------------
// Composing
// ---------------------------------------------------------------------------

describe('composeText — layout', () => {
  const composition = composeText('cat', BANK, OPTIONS);
  const line = composition.lines[0]!;

  it('writes the whole word, one stroke per glyph', () => {
    assert.equal(composition.coverage, 1);
    assert.deepEqual(line.missing, []);
    assert.equal(line.strokes.length, 3);
    assert.ok(line.strokes.every((stroke) => stroke.width === OPTIONS.strokeWidth));
  });

  it('is laid left-to-right from the top-left', () => {
    const [c, a, t] = line.words[0]!.glyphs;

    assert.ok(c!.bbox.x < a!.bbox.x && a!.bbox.x < t!.bbox.x, 'c left of a left of t');
    assert.equal(line.words[0]!.x, 0);
    assert.ok(allPoints(composition).every((point) => point[0] >= -1e-6), 'all ink right of the origin');
    assert.ok(line.baselineY > 0 && allPoints(composition).every((point) => point[1] >= -1e-6), 'ink below the block top');
  });

  it('words follow each other on the line', () => {
    const result = composeText('ab cd 25', BANK, OPTIONS);
    const words = result.lines[0]!.words;

    assert.equal(result.coverage, 1);
    assert.deepEqual(words.map((word) => word.text), ['ab', 'cd', '25']);
    assert.ok(words[1]!.x > words[0]!.x && words[2]!.x > words[1]!.x);

    const [two, five] = words[2]!.glyphs;

    assert.ok(two!.bbox.x < five!.bbox.x, '2 left of 5');
  });

  it('a period sits on the baseline after the word', () => {
    const result = composeText('cat.', BANK, OPTIONS);
    const glyphs = result.lines[0]!.words[0]!.glyphs;
    const period = glyphs[3]!;

    assert.equal(result.coverage, 1);
    assert.equal(period.key, dotKey(1));
    assert.ok(period.bbox.x > glyphs[2]!.bbox.x);
  });
});

describe('composeText — fallback and coverage', () => {
  it('a word with a missing letter gets no strokes and is listed; coverage drops', () => {
    const bank = makeBank({ omit: ['lat:z'] });
    const result = composeText('zoo cat', bank, OPTIONS);
    const line = result.lines[0]!;

    assert.deepEqual(line.missing, ['zoo']);
    assert.equal(result.coverage, 0.5);
    assert.equal(line.strokes.length, 3, 'only cat is drawn');

    const missing = line.words.find((word) => word.text === 'zoo')!;

    assert.equal(missing.missing, true);
    assert.ok(missing.width > 0, 'the missing word still takes room on the line');
    assert.equal(wordIsWritable('zoo', bank), false);
    assert.equal(wordIsWritable('cat', bank), true);
  });

  it('a missing dot glyph fails punctuated words too', () => {
    const result = composeText('cat.', makeBank({ omit: [dotKey(1)] }), OPTIONS);

    assert.deepEqual(result.lines[0]!.missing, ['cat.']);
    assert.equal(result.coverage, 0);
  });

  it('empty text → no lines, coverage 1', () => {
    const result = composeText('   ', BANK, OPTIONS);

    assert.equal(result.lines.length, 0);
    assert.equal(result.coverage, 1);
  });
});

describe('composeText — variation', () => {
  it('is deterministic for the same seed and different for another', () => {
    const bank = makeBank({ samplesPerKey: 3 });
    const a = composeText('cat dog', bank, { ...OPTIONS, seed: 1 });
    const b = composeText('cat dog', bank, { ...OPTIONS, seed: 1 });
    const c = composeText('cat dog', bank, { ...OPTIONS, seed: 2 });

    assert.deepEqual(a, b);
    assert.notDeepEqual(allPoints(a), allPoints(c));
  });

  it('slant shears the ink: tops move right for a positive angle', () => {
    const straight = composeText('l', BANK, OPTIONS);
    const slanted = composeText('l', BANK, { ...OPTIONS, slantDeg: 10 });
    const top = (composition: Composition) => allPoints(composition).reduce((best, point) => (point[1] < best[1] ? point : best));

    assert.ok(top(slanted)[0] > top(straight)[0]);
  });
});

describe('composeText — wrapping', () => {
  it('breaks lines at maxWidth and stacks baselines', () => {
    const single = composeText('cat', BANK, OPTIONS);
    const wordWidth = single.lines[0]!.width;
    const result = composeText('cat cat cat cat cat', BANK, { ...OPTIONS, maxWidth: wordWidth * 2.5 });

    assert.ok(result.lines.length >= 2, `${result.lines.length} lines`);
    assert.ok(result.lines.every((line) => line.width <= wordWidth * 2.5 + 1e-6));
    assert.equal(
      result.lines.reduce((sum, line) => sum + line.words.length, 0),
      5,
    );

    for (let index = 1; index < result.lines.length; index += 1) {
      assert.ok(result.lines[index]!.baselineY > result.lines[index - 1]!.baselineY);
    }

    assert.ok(result.height > result.lines[result.lines.length - 1]!.baselineY);
    assert.ok(result.width <= wordWidth * 2.5 + 1e-6);
  });

  it('one line when no maxWidth is given', () => {
    assert.equal(composeText('cat cat cat cat cat cat cat cat', BANK, OPTIONS).lines.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

describe('normalizeGlyph', () => {
  const cell = { x: 0, y: 0, w: 200, h: 120 };
  const base = { baselineY: 100, xHeight: 20, cell, dir: 'ltr' as const, now: 5 };

  it('trims the tails into anchors, scales to the x-height and puts the entry at x = 0', () => {
    const glyph = normalizeGlyph({
      ...base,
      strokes: [
        [
          [10, 100, 0.4],
          [30, 100, 0.5],
          [50, 80, 0.6],
          [100, 60, 0.7],
          [140, 80, 0.6],
          [170, 100, 0.5],
          [190, 100, 0.4],
        ],
      ],
    })!;

    assert.ok(glyph);
    assert.deepEqual(glyph.entry, [0, 0]);
    assert.ok(glyph.exit[0] > 0 && Math.abs(glyph.exit[1]) < 1e-9);
    assert.ok(Math.abs(glyph.advance - glyph.exit[0]) < 1e-9);
    assert.ok(glyph.bbox.x >= -1e-9);
    assert.ok(Math.abs(glyph.bbox.y - -2) < 1e-9 && Math.abs(glyph.bbox.h - 2) < 1e-9);
    assert.equal(glyph.strokes.length, 1);
    assert.ok(glyph.strokes[0]!.every((point) => point[2] >= 0.4 && point[2] <= 0.7), 'pressure kept');
    assert.equal(glyph.source, 'sheet');
    assert.equal(glyph.createdAt, 5);
  });

  it('left-to-right cells enter on the left', () => {
    const glyph = normalizeGlyph({
      ...base,
      strokes: [
        [
          [10, 100, 0.5],
          [30, 100, 0.5],
          [100, 60, 0.5],
          [170, 100, 0.5],
          [190, 100, 0.5],
        ],
      ],
    })!;

    assert.deepEqual(glyph.entry, [0, 0]);
    assert.ok(Math.abs(glyph.exit[0] - 7.6) < 1e-9);
    assert.ok(glyph.bbox.x >= -1e-9);
  });

  it('returns null for an empty cell and simplifies straight runs', () => {
    assert.equal(normalizeGlyph({ ...base, strokes: [] }), null);

    const straight: GlyphPoint[] = Array.from({ length: 50 }, (_, index) => [50 + index * 2, 90, 0.5]);

    assert.equal(simplifyStroke(straight, 0.02).length, 2);
    assert.equal(normalizeGlyph({ ...base, strokes: [straight] })!.strokes[0]!.length, 2);
  });
});

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

describe('sheet', () => {
  it('every key compose needs is produced by some cell', () => {
    const keys = sheetKeys();

    for (const word of ['abcdefghijklmnopqrstuvwxyz', 'ABCXYZ', '0123456789', 'cat.', 'yes,', 'Q:']) {
      for (const glyph of shapeWord(word)) {
        assert.ok(glyph.candidates.some((key) => keys.has(key)), `${word} → ${glyph.char} needs one of ${glyph.candidates.join(', ')}`);
      }
    }

    assert.equal(wordIsWritable('abcdefghijklmnopqrstuvwxyz0123456789', BANK), true);
  });

  it('cells are unique, labelled, prompted and left-to-right', () => {
    const cells = sheetCells();

    assert.equal(cells.length, 37);
    assert.equal(new Set(cells.map((cell) => cell.key)).size, cells.length);
    assert.ok(cells.every((cell) => cell.label.length > 0 && cell.prompt.length > 0));
    assert.ok(cells.every((cell) => cell.dir === 'ltr' && cell.form === 'isol'));
    assert.equal(cells.find((cell) => cell.key === 'lat:q')!.prompt, 'q');
    assert.equal(cells.find((cell) => cell.key === 'digit:7')!.label, 'Digit 7');
    assert.ok(cells.some((cell) => cell.key === dotKey(1)));
  });

  it('pages hold about twenty cells and keep a group together when it fits', () => {
    const pages = sheetPages();
    const cells = sheetCells();

    assert.equal(
      pages.reduce((sum, page) => sum + page.cells.length, 0),
      cells.length,
    );
    assert.ok(pages.every((page) => page.cells.length <= 23 && page.cells.length > 0), pages.map((page) => page.cells.length).join(','));
    assert.ok(pages.every((page) => page.title.length > 0));

    const digitPages = new Set(pages.filter((page) => page.cells.some((cell) => cell.group === 'digits')).map((page) => page.index));

    assert.equal(digitPages.size, 1, 'digits stay on one page');
    assert.deepEqual(
      paginate(cells.slice(0, 3), 20).map((page) => page.cells.length),
      [3],
    );
  });
});
