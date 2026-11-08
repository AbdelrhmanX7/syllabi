import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkCaptureRegion,
  groupInkLines,
  linesToClusters,
  nearestLine,
  parseStepCheck,
  parseStepNote,
  parseStepSections,
  pixelBoxToScene,
  placeStepMarks,
  stepCheckQuestion,
  stepCounts,
} from './stepCheck';

import type { StepLine } from './stepCheck';
import type { SceneRect } from './types';

const r = (left: number, top: number, width: number, height: number): SceneRect => ({ left, top, width, height });

// A calculus page: four handwritten lines under a typed question, 1000 × 1400 scene units.
const PAGE = r(0, 0, 1000, 1400);
const LINES: StepLine[] = [
  { id: 'L1', rect: r(80, 300, 500, 50) },
  { id: 'L2', rect: r(80, 380, 600, 60) },
  { id: 'L3', rect: r(80, 470, 450, 50) },
  { id: 'L4', rect: r(80, 550, 700, 50) },
];

test('groupInkLines: words on one row join; the next row does not', () => {
  const lines = groupInkLines([r(10, 100, 80, 40), r(120, 104, 60, 36), r(10, 180, 90, 40), r(200, 98, 50, 44)]);

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { id: 'L1', rect: r(10, 98, 240, 44) });
  assert.equal(lines[1]!.id, 'L2');
  assert.equal(lines[1]!.rect.top, 180);
});

test('groupInkLines: a superscript and a tall fraction join the line they sit in', () => {
  const base = r(10, 200, 100, 40);
  const superscript = r(112, 185, 20, 22); // sin⁻¹ — overlaps the base's top by 7/22
  const fraction = r(150, 170, 60, 100); // a tall d/dx fraction spanning the line
  const nextLine = r(10, 300, 100, 40);
  const lines = groupInkLines([nextLine, fraction, base, superscript]);

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0]!.rect, r(10, 170, 200, 100));
  assert.deepEqual(lines[1]!.rect, nextLine);
});

test('groupInkLines: a worked derivative at real line spacing, default settings', () => {
  // lh ≈ 40, lines ~1.6 lh apart. Line 2 is «dy/dx = (3)/(3x)»: a stacked fraction twice as tall,
  // with «=» beside it. A descender of line 1 dips 6 px into line 2's band — still two lines.
  const lines = groupInkLines([
    r(40, 100, 60, 40), // y
    r(120, 104, 30, 30), // =
    r(170, 98, 200, 58), // ln(3x) + sin^-1(x), its descender dips to 156
    r(40, 150, 70, 90), // dy/dx (stacked)
    r(130, 180, 30, 30), // =
    r(180, 150, 90, 92), // 3 / 3x (stacked)
    r(40, 268, 160, 40), // = 1/x
    r(220, 270, 140, 40), // + 1/sqrt(1-x^2)
  ]);

  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0]!.rect, r(40, 98, 330, 58));
  assert.deepEqual(lines[1]!.rect, r(40, 150, 230, 92));
  assert.deepEqual(lines[2]!.rect, r(40, 268, 320, 42));
});

test('groupInkLines: lines come back top → bottom whatever the input order', () => {
  const lines = groupInkLines([r(0, 500, 10, 10), r(0, 100, 10, 10), r(0, 300, 10, 10)]);

  assert.deepEqual(
    lines.map((line) => [line.id, line.rect.top]),
    [
      ['L1', 100],
      ['L2', 300],
      ['L3', 500],
    ],
  );
});

test('linesToClusters: normalised to the CROPPED region, clipped to it, x + w ≤ 1', () => {
  const region = r(50, 250, 800, 400);
  const clusters = linesToClusters([...LINES, { id: 'L9', rect: r(0, 2000, 10, 10) }], region);

  assert.equal(clusters.length, 4, 'a line outside the region is dropped');
  assert.deepEqual(clusters[0], { id: 'L1', bbox: { x: 0.0375, y: 0.125, w: 0.625, h: 0.125 } });

  // L4 runs past the region's right edge (80 + 700 = 780 < 850 — inside); push one out.
  const wide = linesToClusters([{ id: 'L1', rect: r(600, 300, 600, 50) }], region)[0]!;

  assert.ok(wide.bbox.x + wide.bbox.w <= 1);
  assert.equal(wide.bbox.x, 0.6875);
});

test('stepCheckQuestion fits the server limit and names the tags', () => {
  const question = stepCheckQuestion(12);

  assert.ok(question.length <= 2000, `question is ${question.length} chars`);
  assert.match(question, /1\.\.12/);
  assert.match(question, /OK, WRONG or WARN/);
  assert.match(question, /reasons in English/);
});

test('parseStepNote: tag + verdict + reason in the shapes models send', () => {
  assert.deepEqual(parseStepNote('[3] WRONG: d/dx ln(3x) = 1/x, not 3/x'), { tag: 3, verdict: 'wrong', reason: 'd/dx ln(3x) = 1/x, not 3/x' });
  assert.deepEqual(parseStepNote('L2 OK — chain rule applied'), { tag: 2, verdict: 'correct', reason: 'chain rule applied' });
  assert.deepEqual(parseStepNote('4) warn: slope found but no tangent line equation'), {
    tag: 4,
    verdict: 'warning',
    reason: 'slope found but no tangent line equation',
  });
  assert.deepEqual(parseStepNote('WRONG [5]: sign error'), { tag: 5, verdict: 'wrong', reason: 'sign error' });
  assert.deepEqual(parseStepNote('✓ fine'), { tag: null, verdict: 'correct', reason: 'fine' });
  assert.equal(parseStepNote('The derivative of ln x is 1/x'), null);
  assert.equal(parseStepNote('[2] Okay')!.verdict, 'correct');
  // A word that only starts like a token is not one.
  assert.equal(parseStepNote('[2] okapi')?.verdict, undefined);
});

test('nearestLine: inside a band wins, else the closest band', () => {
  assert.equal(nearestLine(LINES, PAGE, 400 / 1400), 1);
  assert.equal(nearestLine(LINES, PAGE, 455 / 1400), 1); // in the gap, equidistant: the line above
  assert.equal(nearestLine(LINES, PAGE, 462 / 1400), 2)
  assert.equal(nearestLine(LINES, PAGE, 0), 0);
  assert.equal(nearestLine(LINES, PAGE, 1), 3);
  assert.equal(nearestLine([], PAGE, 0.5), -1);
});

test('parseStepSections: labels without newlines, items split, «none» dropped', () => {
  const sections = parseStepSections(
    'Good start. CORRECT: product rule set up; sin^-1 derivative. MISTAKES: line 3 — d/dx ln(3x) is 1/x, not 3/x (correct: 1/x). MISSING: none. NOTE: check the chain rule on ln.',
  );

  assert.deepEqual(sections.info, ['Good start.', 'check the chain rule on ln.']);
  assert.deepEqual(sections.correct, ['product rule set up', 'sin^-1 derivative.']);
  assert.deepEqual(sections.mistakes, ['line 3 — d/dx ln(3x) is 1/x, not 3/x (correct: 1/x).']);
  assert.deepEqual(sections.missing, []);
});

test('parseStepSections: lower-case labels still read; empty say is empty', () => {
  assert.deepEqual(parseStepSections('mistakes: sign slip in line 2. missing: the tangent line equation'), {
    correct: [],
    mistakes: ['sign slip in line 2.'],
    missing: ['the tangent line equation'],
    info: [],
  });
  assert.deepEqual(parseStepSections(undefined), { correct: [], mistakes: [], missing: [], info: [] });
});

test('parseStepCheck: anchors by tag, falls back to the point, one step per line, mistakes first', () => {
  const reply = {
    actions: [
      { type: 'point_at', at: { x: 0.9, y: 0.1 }, note: '[3] WRONG: d/dx ln(3x) = 1/x, not 3/x' },
      { type: 'point_at', at: { x: 0.9, y: 0.25 }, note: 'OK: setup' }, // no tag → y 0.25 = scene 350 → nearest L1
      { type: 'point_at', at: { x: 0.9, y: 0.3 }, note: '[2] OK: product rule' },
      { type: 'arrow', from: { x: 0.95, y: 0.4 }, to: { clusterId: 'L4' }, label: 'WARN: tangent line not written' },
      { type: 'point_at', at: { x: 0.9, y: 0.35 }, note: '[2] WARN: missing dx' }, // L2 again: warning beats ok
      { type: 'circle', target: { clusterId: 'L1' } }, // no text: ignored
      { type: 'point_at', at: { x: 0.9, y: 0.3 }, note: 'just a remark' }, // no verdict: ignored
    ],
    say: 'CORRECT: setup. MISTAKES: ln derivative. MISSING: tangent line.',
  };
  const result = parseStepCheck(reply, LINES, PAGE)!;

  assert.deepEqual(
    result.steps.map((step) => [step.lineId, step.verdict, step.note]),
    [
      ['L3', 'wrong', 'd/dx ln(3x) = 1/x, not 3/x'],
      ['L2', 'warning', 'missing dx'],
      ['L4', 'warning', 'tangent line not written'],
      ['L1', 'correct', 'setup'],
    ],
  );
  assert.deepEqual(stepCounts(result.steps), { correct: 1, wrong: 1, warning: 2 });
  assert.deepEqual(result.sections.mistakes, ['ln derivative.']);
});

test('parseStepCheck: a tag past the last line falls back to the point; junk → null', () => {
  const result = parseStepCheck({ actions: [{ type: 'point_at', at: { x: 0.5, y: 0.4 }, note: '[40] WRONG: x' }] }, LINES, PAGE)!;

  assert.equal(result.steps[0]!.lineId, 'L4'); // y 0.4 = 560 → L4 (550..600)
  assert.equal(parseStepCheck(null, LINES, PAGE), null);
  assert.deepEqual(parseStepCheck('```json\n{"actions":[],"say":"MISSING: no handwritten working on this page."}\n```', LINES, PAGE)!.sections.missing, [
    'no handwritten working on this page.',
  ]);
});

test('placeStepMarks: past the line end, centred, sized to the line; RTL on the left', () => {
  const steps = [{ lineId: 'L2', n: 2, verdict: 'wrong' as const, note: '' }];
  const [mark] = placeStepMarks(steps, LINES, PAGE);

  assert.equal(mark!.side, 'end');
  assert.equal(mark!.size, 44); // 60 × 0.8 = 48 → capped at 44
  assert.equal(mark!.left, 80 + 600 + 22);
  assert.equal(mark!.top, 380 + 30 - 22);
});

test('placeStepMarks: a line running to the edge takes the other side; marks never stack', () => {
  const lines: StepLine[] = [
    { id: 'L1', rect: r(100, 100, 890, 40) },
    { id: 'L2', rect: r(100, 120, 300, 40) },
    { id: 'L3', rect: r(100, 125, 300, 40) },
  ];
  const marks = placeStepMarks(
    [
      { lineId: 'L3', n: 3, verdict: 'correct', note: '' },
      { lineId: 'L1', n: 1, verdict: 'wrong', note: '' },
      { lineId: 'L2', n: 2, verdict: 'warning', note: '' },
    ],
    lines,
    r(0, 0, 1000, 1000),
  );

  assert.equal(marks[0]!.side, 'start');
  assert.ok(marks[0]!.left + marks[0]!.size <= 100);

  const [, second, third] = marks;

  assert.ok(third!.top >= second!.top + second!.size, 'the third mark is pushed below the second');
});

test('checkCaptureRegion: the current sheet wins over the multi-page export bounds', () => {
  const sheet = r(0, 1450, 1000, 1400); // page 2 of a stacked document
  const everything = r(0, 0, 1000, 4300); // union of all hydrated pages' ink

  assert.deepEqual(checkCaptureRegion(sheet, everything), sheet);
  assert.deepEqual(checkCaptureRegion(null, everything), everything);
  assert.deepEqual(checkCaptureRegion(r(0, 0, 0, 10), everything), everything);
  assert.equal(checkCaptureRegion(null, null), null);
});

test('pixelBoxToScene: crop pixels → scene rect of the same region', () => {
  assert.deepEqual(pixelBoxToScene(r(0, 1450, 1000, 1400), 2000, { x: 200, y: 400, width: 1000, height: 600 }), r(100, 1650, 500, 300));
});
