import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyDecoration, InkGrouper, writingDirection } from './grouping';

import { DEFINITION_LINE, PART1_LINE, PART2_LINE, PART3_LINE } from './screenshotInk.fixture';

import type { InkStrokeInput } from './model';
import type { FixtureStroke } from './screenshotInk.fixture';

let seq = 0;
let clock = 0;

/** A letter-ish stroke filling a box, drawn left→right (or right→left). */
function stroke(left: number, top: number, w: number, h: number, dir: 'ltr' | 'rtl' = 'ltr'): InkStrokeInput {
  seq += 1;
  clock += 100;
  const points = Array.from({ length: 10 }, (_, i) => {
    const k = i / 9;

    return { x: dir === 'ltr' ? left + k * w : left + w - k * w, y: top + (i % 2 ? h : 0), t: clock + i * 5 };
  });

  return { id: `t${seq}`, points, box: { left, top, right: left + w, bottom: top + h }, startedAt: clock, endedAt: clock + 50 };
}

test('letters close together form one word; a gap starts the next word on the same line', () => {
  const grouper = new InkGrouper();

  grouper.addStroke(stroke(100, 100, 20, 30));
  grouper.addStroke(stroke(122, 100, 20, 30));
  const third = grouper.addStroke(stroke(200, 102, 20, 28));

  assert.equal(grouper.lines.length, 1);
  assert.equal(grouper.lines[0].groups.length, 2);
  assert.equal(third.lineChanged, false);
  assert.deepEqual(grouper.lines[0].groups[0].strokeIds.length, 2);
});

test('a stroke well below the line starts a new line and reports the change', () => {
  const grouper = new InkGrouper();

  grouper.addStroke(stroke(100, 100, 20, 30));
  const next = grouper.addStroke(stroke(100, 160, 20, 30));

  assert.equal(grouper.lines.length, 2);
  assert.equal(next.lineChanged, true);
  assert.equal(next.previousLineId, grouper.lines[0].id);
});

test('a dot just under a letter joins its word, not a new line', () => {
  const grouper = new InkGrouper();

  grouper.addStroke(stroke(100, 100, 30, 30));
  grouper.addStroke(stroke(110, 138, 4, 4));

  assert.equal(grouper.lines.length, 1);
  assert.equal(grouper.lines[0].groups.length, 1);
  assert.equal(grouper.lines[0].groups[0].strokeIds.length, 2);
});

test('a bridging stroke merges two words', () => {
  const grouper = new InkGrouper();

  grouper.addStroke(stroke(100, 100, 20, 30));
  grouper.addStroke(stroke(160, 100, 20, 30));
  assert.equal(grouper.lines[0].groups.length, 2);
  grouper.addStroke(stroke(115, 110, 50, 12));

  assert.equal(grouper.lines[0].groups.length, 1);
  assert.equal(grouper.lines[0].groups[0].strokeIds.length, 3);
});

test('an underline is a decoration: it does not glue the words together', () => {
  const grouper = new InkGrouper();

  grouper.addStroke(stroke(100, 100, 30, 30));
  grouper.addStroke(stroke(200, 100, 30, 30));
  const under = grouper.addStroke(stroke(95, 136, 140, 3));

  assert.equal(under.decoration, 'underline');
  assert.equal(grouper.lines[0].groups.length, 2);
  assert.equal(grouper.lines[0].decorations.length, 1);
});

test('removing the strokes of a word removes it (erase / undo)', () => {
  const grouper = new InkGrouper();
  const a = stroke(100, 100, 20, 30);

  grouper.addStroke(a);
  grouper.removeStroke(a.id);

  assert.equal(grouper.lines.length, 0);
});

test('reading order: always left → right, even for strokes written right → left', () => {
  const grouper = new InkGrouper();

  grouper.addStroke(stroke(300, 100, 30, 30, 'rtl'));
  grouper.addStroke(stroke(200, 100, 30, 30, 'rtl'));
  grouper.addStroke(stroke(100, 100, 30, 30, 'rtl'));
  const line = grouper.lines[0];
  const dir = grouper.lineDirection(line);

  assert.deepEqual(
    grouper.readingOrder(line, dir).map((g) => g.box.left),
    [100, 200, 300],
  );
});

test('writingDirection reads stroke travel and successive starts', () => {
  assert.equal(writingDirection([stroke(0, 0, 30, 10, 'ltr'), stroke(40, 0, 30, 10, 'ltr')]), 'ltr');
  assert.equal(writingDirection([stroke(40, 0, 30, 10, 'rtl'), stroke(0, 0, 30, 10, 'rtl')]), 'rtl');
  assert.equal(writingDirection([]), null);
});

test('classifyDecoration: a closed big loop is a box, a long flat line an underline, a letter neither', () => {
  const loop: InkStrokeInput = {
    id: 'box',
    points: Array.from({ length: 24 }, (_, i) => {
      const a = (i / 23) * Math.PI * 2;

      return { x: 150 + 100 * Math.cos(a), y: 100 + 40 * Math.sin(a), t: i };
    }),
    box: { left: 50, top: 60, right: 250, bottom: 140 },
    startedAt: 0,
    endedAt: 24,
  };

  assert.equal(classifyDecoration(loop, 30), 'box');
  assert.equal(classifyDecoration(stroke(0, 0, 120, 3), 30), 'underline');
  assert.equal(classifyDecoration(stroke(0, 0, 20, 30), 30), null);
});

// --- the owner's screenshot: letters as separate strokes, arrows, colons ----------------------------

/** A stroke over a fixture box (a «V» through it), written left → right. */
function boxStroke([left, top, w, h]: FixtureStroke['box'], dir: 'ltr' | 'rtl' = 'ltr'): InkStrokeInput {
  seq += 1;
  clock += 120;
  const points = Array.from({ length: 8 }, (_, i) => {
    const k = dir === 'ltr' ? i / 7 : 1 - i / 7;

    return { x: left + k * w, y: top + (i % 2 ? h : 0), t: clock + i * 6 };
  });

  return { id: `f${seq}`, points, box: { left, top, right: left + w, bottom: top + h }, startedAt: clock, endedAt: clock + 60 };
}

function writeLines(...lines: FixtureStroke[][]) {
  return writeDir('ltr', ...lines);
}

function writeDir(dir: 'ltr' | 'rtl', ...lines: FixtureStroke[][]) {
  const grouper = new InkGrouper();
  const tagged: Array<{ id: string; word: string; line: number }> = [];

  lines.forEach((line, index) => {
    for (const fixture of line) {
      const stroke = boxStroke(fixture.box, dir);

      grouper.addStroke(stroke);
      tagged.push({ id: stroke.id, word: fixture.word, line: index });
    }
  });

  for (const line of grouper.lines) grouper.settleLine(line);

  return { grouper, tagged };
}

const groupIdOf = (grouper: InkGrouper, id: string) => grouper.groupOfStroke(id)?.id;

test('screenshot: four lines, and no word is ever split across groups', () => {
  const { grouper, tagged } = writeLines(DEFINITION_LINE, PART1_LINE, PART2_LINE, PART3_LINE);

  assert.equal(grouper.lines.length, 4);

  for (const [line, word] of Array.from(new Set(tagged.map((t) => `${t.line}\u0000${t.word}`))).map((key) => key.split('\u0000'))) {
    const groups = new Set(tagged.filter((t) => String(t.line) === String(line) && t.word === word).map((t) => groupIdOf(grouper, t.id)));

    assert.equal(groups.size, 1, `«${word}» on line ${line} is in ${groups.size} groups`);
  }
});

test('screenshot: «Definition:» is one word closed by a colon', () => {
  const { grouper } = writeLines(DEFINITION_LINE);
  const [line] = grouper.lines;

  assert.equal(line.groups.length, 1);
  assert.equal(line.groups[0].colon, true);
  assert.equal(line.groups[0].strokeIds.length, DEFINITION_LINE.length);
});

test('screenshot: the arrow is a bullet word of its own; the colon closes «1:»; «Mitosis» is one word', () => {
  const { grouper, tagged } = writeLines(PART1_LINE);
  const [line] = grouper.lines;
  const ofWord = (word: string) => grouper.groupOfStroke(tagged.find((t) => t.word === word)!.id)!;
  const arrow = ofWord('->');

  assert.equal(arrow.bullet, true);
  assert.deepEqual(arrow.strokeIds.length, 2);
  assert.equal(ofWord('1:').colon, true);
  assert.notEqual(ofWord('Mitosis').id, ofWord('1:').id, 'nothing joins across a colon');
  assert.equal(ofWord('Mitosis').strokeIds.length, 10);
  assert.equal(line.groups.filter((g) => g.bullet).length, 1);
});

test('screenshot: the arrow almost touching «Part» is still its own bullet', () => {
  const { grouper, tagged } = writeLines(PART2_LINE);
  const arrow = grouper.groupOfStroke(tagged.find((t) => t.word === '->')!.id)!;
  const part = grouper.groupOfStroke(tagged.find((t) => t.word === 'Part')!.id)!;

  assert.equal(arrow.bullet, true);
  assert.notEqual(arrow.id, part.id);
});

test('settleLine keeps an unchanged word (id, text, not dirty) and re-cuts a changed one', () => {
  const { grouper, tagged } = writeLines(DEFINITION_LINE);
  const [line] = grouper.lines;
  const word = line.groups[0];

  word.text = 'Definition:';
  word.dirty = false;
  grouper.settleLine(line);
  assert.equal(line.groups[0], word);
  assert.equal(line.groups[0].dirty, false);
  assert.equal(groupIdOf(grouper, tagged[0].id), word.id);
});

test('a T bar at the line start is not a bullet', () => {
  const grouper = new InkGrouper();

  grouper.addStroke(boxStroke([100, 100, 24, 3])); // T bar
  grouper.addStroke(boxStroke([110, 100, 4, 40])); // T stem
  grouper.addStroke(boxStroke([120, 115, 15, 25])); // h
  grouper.addStroke(boxStroke([140, 120, 15, 20])); // e
  grouper.settleLine(grouper.lines[0]);

  assert.equal(grouper.lines[0].groups.length, 1);
  assert.ok(!grouper.lines[0].groups[0].bullet);
});
