import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { Path } from 'fabric';

import type { Canvas, FabricObject } from 'fabric';

import { setPerfSpanRecorder } from '../utils/perfSpan';

import { registerSnappedShapePersistence } from '../brushes/shapeSnap';

import { InkAutoColorController, inkColorOf, markerOf, registerInkAutoPersistence } from './controller';
import { DEFAULT_INK_PALETTE } from './recolor';

import { DEFINITION_LINE, PART1_LINE, PART2_LINE, PART3_LINE } from './screenshotInk.fixture';

import type { AutoColorConfig } from './model';
import type { FixtureStroke } from './screenshotInk.fixture';
import type { InkCandidate, InkRecognizer, InkRecognizeRequest } from './types';

/** Just enough of a Fabric canvas: events, objects, selection. */
function fakeCanvas() {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const objects: FabricObject[] = [];
  let active: FabricObject | null = null;
  const fired: string[] = [];
  const canvas = {
    on(name: string, handler: (event: unknown) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);

      return () => handlers.get(name)?.delete(handler);
    },
    fire(name: string, event: unknown) {
      fired.push(name);
      handlers.get(name)?.forEach((handler) => handler(event));
    },
    getObjects: () => objects,
    getActiveObject: () => active,
    requestRenderAll() {},
    getWidth: () => 1000,
    getHeight: () => 1000,
    viewportTransform: [1, 0, 0, 1, 0, 0],
  };

  return {
    canvas: canvas as unknown as Canvas,
    fired,
    add(path: FabricObject) {
      objects.push(path);
      canvas.fire('path:created', { path });
    },
    remove(path: FabricObject) {
      objects.splice(objects.indexOf(path), 1);
      canvas.fire('object:removed', { target: path });
    },
    select(object: FabricObject | null) {
      active = object;
    },
  };
}

/** A pencil-like stroke (colour in `stroke`) filling a box. */
function word(left: number, top: number, w: number, h: number, color = '#000000') {
  return new Path(`M ${left} ${top} L ${left + w / 2} ${top + h} L ${left + w} ${top}`, { stroke: color, fill: '', strokeWidth: 2 });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recognizer(texts: string[]): InkRecognizer & { calls: number } {
  const queue = [...texts];
  const self = {
    id: 'fake',
    calls: 0,
    available: async () => true,
    recognize: async (): Promise<InkCandidate[]> => {
      self.calls += 1;

      return [{ text: queue.shift() ?? '', lang: 'en' }];
    },
  };

  return self;
}

function setup(config: Partial<AutoColorConfig> & { recognizer: InkRecognizer }, penColor = '#000000') {
  const board = fakeCanvas();
  let commits = 0;
  const marks: Array<{ label: string; detail?: string }> = [];

  setPerfSpanRecorder((label, _ms, detail) => marks.push({ label, detail }));
  const controller = new InkAutoColorController({
    canvas: board.canvas,
    getConfig: () => ({ pauseMs: 15, fadeMs: 0, ...config }),
    getPenColor: () => penColor,
    isInkTool: () => true,
    commitHistory: () => {
      commits += 1;
    },
  });

  return { board, controller, marks, commits: () => commits };
}

afterEach(() => setPerfSpanRecorder(null));

test('a pause after «Osmosis: water» colours the term; the batch is one undo step', async () => {
  const { board, controller, marks, commits } = setup({ recognizer: recognizer(['Osmosis:', 'water']) });
  const a = word(100, 100, 60, 30);
  const b = word(200, 100, 50, 30);

  board.add(a);
  board.add(b);
  await wait(80);

  assert.equal(inkColorOf(a), DEFAULT_INK_PALETTE.term);
  assert.equal(inkColorOf(b), '#000000', 'definition keeps the ink');
  assert.equal(markerOf(a)?.c, 'term');
  assert.equal(commits(), 2, 'checkpoint before + after the batch');
  assert.equal(board.fired.filter((name) => name === 'object:modified').length, 1);
  assert.ok(marks.some((m) => m.label === 'ink-recognize'));
  assert.ok(marks.some((m) => m.label === 'ink-classify' && m.detail?.includes('|term|')));
  controller.dispose();
});

test('ink written in a hand-picked colour is never recoloured', async () => {
  const { board, controller } = setup({ recognizer: recognizer(['Chapter', 'one']) }, '#2563eb');
  const a = word(100, 100, 60, 30, '#2563eb');

  board.add(a);
  await wait(60);

  assert.equal(inkColorOf(a), '#2563eb');
  controller.dispose();
});

test('a manual recolour of an auto-coloured word is a correction: logged, remembered, never touched again', async () => {
  const remembered: Array<[string, string]> = [];
  const { board, controller, marks } = setup({
    recognizer: recognizer(['Chapter', 'one', '', '']),
    memory: { lookup: () => null, remember: (text, cls) => remembered.push([text, cls]) },
  });
  const a = word(100, 100, 60, 30);

  board.add(a);
  await wait(60);
  assert.equal(inkColorOf(a), DEFAULT_INK_PALETTE.heading);

  a.set('stroke', DEFAULT_INK_PALETTE.formula!);
  board.canvas.fire('object:modified', { target: a } as never);

  assert.equal(markerOf(a), null);
  const correction = marks.find((m) => m.label === 'ink-correction');

  assert.ok(correction?.detail?.includes('heading>formula'));
  assert.deepEqual(remembered, [['Chapter', 'formula']]);

  // More writing on the line re-classifies it; the corrected word keeps the student's colour.
  board.add(word(180, 100, 40, 30));
  await wait(60);
  assert.equal(inkColorOf(a), DEFAULT_INK_PALETTE.formula);
  controller.dispose();
});

test('the phrase memory beats the rules', async () => {
  const { board, controller } = setup({
    recognizer: recognizer(['the law']),
    memory: { lookup: (text) => (text === 'the law' ? 'formula' : null), remember: () => undefined },
  });
  const a = word(100, 100, 60, 30);

  board.add(a);
  await wait(60);

  assert.equal(inkColorOf(a), DEFAULT_INK_PALETTE.formula);
  controller.dispose();
});

test('the class menu overrides the selection in one batch and counts as a correction', async () => {
  const { board, controller, marks, commits } = setup({ recognizer: recognizer(['Chapter']) });
  const a = word(100, 100, 60, 30);

  board.add(a);
  await wait(60);
  const before = commits();

  board.select(a);
  assert.equal(await controller.overrideSelection('example'), 1);
  assert.equal(inkColorOf(a), DEFAULT_INK_PALETTE.example);
  assert.equal(markerOf(a)?.c, 'example');
  assert.equal(commits() - before, 2);
  assert.ok(marks.some((m) => m.label === 'ink-correction' && m.detail?.includes('heading>example')));

  assert.equal(await controller.overrideSelection('plain'), 1);
  assert.equal(inkColorOf(a), '#000000', 'plain = back to the ink it was written in');
  controller.dispose();
});

test('an erased word is dropped before the pause; nothing is coloured', async () => {
  const rec = recognizer(['Chapter']);
  const { board, controller } = setup({ recognizer: rec });
  const a = word(100, 100, 60, 30);

  board.add(a);
  await wait(1);
  board.remove(a);
  await wait(60);

  assert.equal(rec.calls, 0);
  assert.equal(markerOf(a), null);
  controller.dispose();
});

test('ambiguous lines go to the cloud, which may upgrade plain words', async () => {
  const sent: string[] = [];
  const { board, controller } = setup({
    recognizer: recognizer(['enzymes', 'need', 'heat']),
    cloud: {
      classify: async (lines) => {
        sent.push(...lines.map((line) => line.text));

        return lines.map(() => ({ cls: 'keypoint' as const, confidence: 0.9 }));
      },
    },
  });
  const words = [word(100, 100, 60, 30), word(200, 100, 30, 30), word(260, 100, 60, 30)];

  words.forEach((w) => board.add(w));
  await wait(100);

  assert.deepEqual(sent, ['enzymes need heat']);
  assert.ok(words.every((w) => inkColorOf(w) === DEFAULT_INK_PALETTE.keypoint));
  controller.dispose();
});

test('a cloud failure (no route) leaves the rules result', async () => {
  const { board, controller } = setup({
    recognizer: recognizer(['hello']),
    cloud: { classify: async () => Promise.reject(new Error('404')) },
  });
  const a = word(100, 100, 60, 30);

  board.add(a);
  await wait(60);

  assert.equal(inkColorOf(a), '#000000');
  controller.dispose();
});

test('the marker survives toObject (saves + undo snapshots), whatever registered Path first', () => {
  registerSnappedShapePersistence();
  registerInkAutoPersistence();
  const path = word(0, 0, 10, 10);
  const marker = { c: 'term', k: '#0f766e', o: '#000000', g: 'g1', at: 1 };

  (path as unknown as Record<string, unknown>).inkAuto = marker;
  assert.deepEqual((path.toObject() as unknown as Record<string, unknown>).inkAuto, marker);
});

test('default ink is decided by the pen setting, so a contrast-shaded black still counts', async () => {
  const { board, controller } = setup({ recognizer: recognizer(['Chapter']) });
  const a = word(100, 100, 60, 30, '#3a3a3a');

  board.add(a);
  await wait(60);

  assert.equal(inkColorOf(a), DEFAULT_INK_PALETTE.heading);
  controller.dispose();
});

// --- the owner's screenshot, end to end -------------------------------------------------------------

/** One fixture stroke as a pencil Path (a «V» through its box). */
const fixturePath = ([left, top, w, h]: FixtureStroke['box']) =>
  new Path(`M ${left} ${top} L ${left + w / 2} ${top + h} L ${left + w} ${top}`, { stroke: '#000000', fill: '', strokeWidth: 1 });

/**
 * A recogniser that reads what the fixture says was written: each request stroke is matched to its
 * fixture stroke by where it starts; the words they belong to are the text (`garbage` overrides one).
 */
function fixtureRecognizer(lines: FixtureStroke[][], garbage: Record<string, string> = {}): InkRecognizer & { texts: string[] } {
  const all = lines.flat();
  const self = {
    id: 'mlkit',
    texts: [] as string[],
    available: async () => true,
    recognize: async (req: InkRecognizeRequest): Promise<InkCandidate[]> => {
      const words: string[] = [];

      for (const stroke of req.strokes) {
        const x = Math.min(...stroke.map((p) => p.x));
        const y = Math.min(...stroke.map((p) => p.y));
        let best = all[0];
        let bestD = Infinity;

        for (const fixture of all) {
          const d = Math.hypot(fixture.box[0] - x, fixture.box[1] - y);

          if (d < bestD) {
            best = fixture;
            bestD = d;
          }
        }

        if (!words.includes(best.word)) words.push(best.word);
      }

      const text = words.map((word) => garbage[word] ?? word).join(' ');

      self.texts.push(text);

      return [{ text, lang: 'en' }];
    },
  };

  return self;
}

function writeFixture(board: ReturnType<typeof fakeCanvas>, lines: FixtureStroke[][]) {
  return lines.map((line) => line.map((fixture) => ({ word: fixture.word, path: fixturePath(fixture.box) })));
}

async function addAll(board: ReturnType<typeof fakeCanvas>, strokes: Array<{ path: FabricObject }>) {
  for (const { path } of strokes) {
    board.add(path);
    await wait(0);
  }
}

const colorsOf = (strokes: Array<{ word: string; path: FabricObject }>, word: string) =>
  Array.from(new Set(strokes.filter((s) => s.word === word).map((s) => inkColorOf(s.path))));

test('screenshot: every word is ONE colour; arrows keep the ink; «Part N:» is a heading, never a formula', async () => {
  const lines = [DEFINITION_LINE, PART1_LINE, PART2_LINE, PART3_LINE];
  const { board, controller } = setup({ recognizer: fixtureRecognizer(lines) });
  const written = writeFixture(board, lines);

  for (const line of written) await addAll(board, line);
  await wait(120);

  const [definition, part1, part2, part3] = written;
  const H = DEFAULT_INK_PALETTE.heading;

  assert.deepEqual(colorsOf(definition, 'Definition:'), [H], '«Definition:» alone is a heading');
  assert.deepEqual(colorsOf(part1, '->'), ['#000000'], 'the arrow bullet keeps the ink');
  assert.deepEqual(colorsOf(part1, 'Part'), [H]);
  assert.deepEqual(colorsOf(part1, '1:'), [H]);
  assert.deepEqual(colorsOf(part1, 'Mitosis'), ['#000000'], '«Mitosis» is one colour: the definition keeps the ink');
  assert.deepEqual(colorsOf(part2, '->'), ['#000000']);
  assert.deepEqual(Array.from(new Set([...colorsOf(part2, 'Part'), ...colorsOf(part2, '1:')])), [H]);
  assert.deepEqual(colorsOf(part3, '->'), ['#000000']);
  assert.deepEqual(colorsOf(part3, 'Part3:'), [H]);
  assert.ok(written.flat().every((s) => inkColorOf(s.path) !== DEFAULT_INK_PALETTE.formula), 'nothing is a formula');
  controller.dispose();
});

test('screenshot: a garbage reading of «Mitosis» falls back to the line structure, whole word alike', async () => {
  const lines = [PART1_LINE];
  const { board, controller } = setup({ recognizer: fixtureRecognizer(lines, { Mitosis: 'M1t0$ ->s', '->': '-s' }) });
  const [part1] = writeFixture(board, lines);

  await addAll(board, part1);
  await wait(80);

  assert.deepEqual(colorsOf(part1, '->'), ['#000000']);
  assert.deepEqual(colorsOf(part1, 'Part'), [DEFAULT_INK_PALETTE.heading]);
  assert.equal(colorsOf(part1, 'Mitosis').length, 1, 'one colour for the whole word');
  controller.dispose();
});

test('a line written across pauses is re-coloured WHOLE and consistently at each pause', async () => {
  const lines = [PART1_LINE];
  const { board, controller } = setup({ recognizer: fixtureRecognizer(lines) });
  const [part1] = writeFixture(board, lines);
  const label = part1.filter((s) => s.word !== 'Mitosis');
  const rest = part1.filter((s) => s.word === 'Mitosis');

  // «-> Part 1:» then a pause: a section heading.
  await addAll(board, label);
  await wait(60);
  assert.deepEqual(Array.from(new Set(label.filter((s) => s.word !== '->').map((s) => inkColorOf(s.path)))), [DEFAULT_INK_PALETTE.heading]);

  // «Mitosis» letter by letter, pausing mid-word: never two colours inside it.
  for (let index = 0; index < rest.length; index += 1) {
    const stroke = rest[index];

    await addAll(board, [stroke]);
    if (index === 4) {
      await wait(60);
      assert.equal(colorsOf(part1, 'Mitosis').length, 1, 'mid-word pause: still one colour');
    }
  }

  await wait(60);
  assert.deepEqual(colorsOf(part1, 'Mitosis'), ['#000000']);
  assert.deepEqual(colorsOf(part1, 'Part'), [DEFAULT_INK_PALETTE.heading]);
  controller.dispose();
});

test('a letter the student recoloured keeps its colour; the rest of the word is one colour', async () => {
  const lines = [DEFINITION_LINE];
  const { board, controller } = setup({ recognizer: fixtureRecognizer(lines), fadeMs: 40 });
  const [definition] = writeFixture(board, lines);

  await addAll(board, definition);
  // The student recolours one letter by hand before the pause ends.
  (definition[3].path as FabricObject).set('stroke', '#2563eb');
  await wait(120);

  const auto = definition.filter((_, index) => index !== 3).map((s) => inkColorOf(s.path));

  assert.equal(new Set(auto).size, 1, 'the rest of the word is one colour');
  assert.equal(inkColorOf(definition[3].path), '#2563eb', 'the hand-picked colour wins');
  controller.dispose();
});

test('the fade moves every stroke of a segment in the same frame', async () => {
  const frames: Array<() => void> = [];
  const globals = globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => number };
  const saved = globals.requestAnimationFrame;

  globals.requestAnimationFrame = (cb) => {
    frames.push(cb);

    return frames.length;
  };

  try {
    const lines = [DEFINITION_LINE];
    const { board, controller } = setup({ recognizer: fixtureRecognizer(lines), fadeMs: 1000 });
    const [definition] = writeFixture(board, lines);

    await addAll(board, definition);
    await wait(60);

    let mid = 0;

    for (let frame = 0; frame < 4; frame += 1) {
      await wait(20);
      frames.splice(0).forEach((run) => run());
      const colours = new Set(definition.map((s) => inkColorOf(s.path)));

      assert.equal(colours.size, 1, `frame ${frame}: one colour across the word (${Array.from(colours).join(', ')})`);
      const [colour] = Array.from(colours);

      if (colour !== '#000000' && colour !== DEFAULT_INK_PALETTE.heading) mid += 1;
    }

    assert.ok(mid > 0, 'the fade really ran (mid-mix colours seen)');

    controller.dispose();
  } finally {
    globals.requestAnimationFrame = saved;
  }
});

test('no cloud: classify is reported straight after recognition, with the text and the line', async () => {
  const lines = [PART1_LINE];
  // The real cross-fade length: it must not count as classification time.
  const { board, controller, marks } = setup({ recognizer: fixtureRecognizer(lines), fadeMs: 60 });
  const [part1] = writeFixture(board, lines);

  await addAll(board, part1);
  await wait(200);

  const classify = marks.filter((m) => m.label === 'ink-classify');
  const recognize = marks.filter((m) => m.label === 'ink-recognize');

  assert.ok(classify.length > 0);

  for (const mark of classify) {
    const fields = mark.detail!.split('|');
    const ms = Number(fields[4].replace('ms', ''));

    assert.equal(fields[0], 'mlkit', 'engine is the recogniser, never «none»');
    assert.ok(ms < 20, `classify ms is the rules only (${ms})`);
    assert.ok(/\|f=\d+/.test(mark.detail!) && /\|q=\d+/.test(mark.detail!) && /\|w=\d+/.test(mark.detail!), mark.detail);
    assert.ok(mark.detail!.includes('|line=-> Part 1: Mitosis'), mark.detail);
    assert.ok(/\|t=[^|]+/.test(mark.detail!) && /\|lift=\d+/.test(mark.detail!) && /\|L=0/.test(mark.detail!));
    assert.ok(mark.detail!.length <= 200);
  }

  // Every word of the line is reported in the English script.
  assert.ok(recognize.length >= 4);
  assert.ok(recognize.every((m) => m.detail!.split('|')[1] === 'en'), recognize.map((m) => m.detail).join('\n'));
  assert.ok(recognize.some((m) => /\|t=Mitosis\|bb=\d+x\d+\|n=10\|L=0/.test(m.detail!)), recognize.map((m) => m.detail).join('\n'));
  controller.dispose();
});

test('a class picked from the menu sticks: the next pause does not recolour it', async () => {
  const lines = [DEFINITION_LINE];
  const { board, controller } = setup({ recognizer: fixtureRecognizer(lines) });
  const [definition] = writeFixture(board, lines);

  await addAll(board, definition);
  await wait(60);
  board.select(definition[0].path);
  await controller.overrideSelection('term');
  assert.equal(inkColorOf(definition[0].path), DEFAULT_INK_PALETTE.term);

  // More writing on the line → a new pause re-classifies it.
  board.add(fixturePath([290, 160, 15, 20]));
  await wait(60);
  assert.equal(inkColorOf(definition[0].path), DEFAULT_INK_PALETTE.term);
  controller.dispose();
});

test('manual mode: nothing is coloured while writing; «colour the page» colours it all as one undo step', async () => {
  const { board, controller, commits } = setup({ recognizer: recognizer(['Osmosis:', 'water', 'Chapter', 'one']), mode: 'manual' });
  const a = word(100, 100, 60, 30);
  const b = word(200, 100, 50, 30);
  const c = word(100, 300, 60, 30);
  const d = word(200, 300, 50, 30);

  [a, b, c, d].forEach((path) => board.add(path));
  await wait(80);
  assert.equal(inkColorOf(a), '#000000', 'manual: untouched until the button');
  assert.equal(commits(), 0);

  const changed = await controller.colorAll();

  assert.ok(changed > 0);
  assert.equal(inkColorOf(a), DEFAULT_INK_PALETTE.term);
  assert.equal(commits(), 2, 'one batch → one undo step');
  assert.equal(await controller.colorAll(), 0, 'nothing new the second time');
  controller.dispose();
});

test('«colour the page» adopts ink already on the page (opened from storage)', async () => {
  const board = fakeCanvas();
  const old = word(100, 100, 60, 30);
  const tail = word(200, 100, 50, 30);
  const blue = word(300, 100, 50, 30, '#2563eb');

  // Present before the controller existed: no path:created for them.
  board.canvas.getObjects().push(old, tail, blue);
  const controller = new InkAutoColorController({
    canvas: board.canvas,
    getConfig: () => ({ pauseMs: 15, fadeMs: 0, recognizer: recognizer(['Osmosis:', 'water', 'x']) }),
    getPenColor: () => '#000000',
    isInkTool: () => true,
  });

  await controller.colorAll();
  assert.equal(inkColorOf(old), DEFAULT_INK_PALETTE.term);
  assert.equal(inkColorOf(blue), '#2563eb', 'a hand-picked colour is not adopted');
  controller.dispose();
});
