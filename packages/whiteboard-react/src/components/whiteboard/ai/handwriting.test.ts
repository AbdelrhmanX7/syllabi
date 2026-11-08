import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Group, Path, util } from 'fabric';

import { AI_OBJECT_PROP, registerAiObjectPersistence } from './boardObjects';
import { estimateHandStyle } from './handStyle';
import {
  breakHandLines,
  handItemsFromBlocks,
  handwritingDefault,
  hashSeed,
  isHandDrawableMath,
  MAX_WORD_ROTATION,
  readHandPrefs,
  seededRandom,
  tokenizeHandText,
  wordWobbles,
  writeHandPrefs,
} from './handwritingLayout';
import { ringArea, ringsToPathData, traceAlpha, traceToRings } from './inkTrace';
import { serializeCanvasJson } from '../utils/canvasJson';
import { objectHitsEraser } from '../utils/eraserHitTest';

import type { InkSample } from './handStyle';
import type { TokenMetrics } from './handwritingLayout';

/** A width×height alpha raster with the given filled rectangles (x, y, w, h). */
function raster(width: number, height: number, rects: Array<[number, number, number, number]>, holes: Array<[number, number, number, number]> = []) {
  const alpha = new Uint8Array(width * height);
  const paint = ([x, y, w, h]: [number, number, number, number], value: number) => {
    for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) alpha[j * width + i] = value;
  };

  rects.forEach((rect) => paint(rect, 255));
  holes.forEach((rect) => paint(rect, 0));

  return alpha;
}

describe('tokenizeHandText — words and formulas', () => {
  it('writes a simple formula with the hand font, as left-to-right words', () => {
    const tokens = tokenizeHandText("the derivative $f'(x) = 2x$ is the slope");

    assert.deepEqual(
      tokens.map((token) => [token.kind, token.text, token.dir]),
      [
        ['word', 'the', 'ltr'],
        ['word', 'derivative', 'ltr'],
        ['word', "f'(x)", 'ltr'],
        ['word', '=', 'ltr'],
        ['word', '2x', 'ltr'],
        ['word', 'is', 'ltr'],
        ['word', 'the', 'ltr'],
        ['word', 'slope', 'ltr'],
      ],
    );
  });

  it('sends a fraction or a root to KaTeX as ONE formula token', () => {
    const tokens = tokenizeHandText('result $\\frac{1}{2}$ roughly');

    assert.equal(tokens.length, 3);
    assert.equal(tokens[1]!.kind, 'math');
    assert.equal(tokens[1]!.tex, '\\frac{1}{2}');
    assert.ok(!isHandDrawableMath('\\sqrt{9}'));
    assert.ok(!isHandDrawableMath('x \\to \\infty'), 'an arrow is outside the hand font');
    assert.ok(isHandDrawableMath('f(x)=x^2'));
  });

  it('handwrites word blocks and leaves a table typed', () => {
    const items = handItemsFromBlocks(
      [
        { type: 'heading', text: 'Solution' },
        { type: 'math', text: 'f(x)=x^2' },
        { type: 'table', header: ['a', 'b'], rows: [['1', '2']] },
        { type: 'list', ordered: true, items: ['First', 'Second'] },
      ],
      { withAnswers: false },
    );

    assert.deepEqual(
      items.map((item) => (item.type === 'hand' ? `${item.paragraph.kind}:${item.paragraph.align}` : `typed:${item.block.type}`)),
      ['heading:start', 'math:center', 'typed:table', 'list:start', 'list:start'],
    );
    // The list's markdown rides on its FIRST line only — copying the answer must not repeat it.
    const lists = items.filter((item) => item.type === 'hand' && item.paragraph.kind === 'list');

    assert.ok(lists[0]!.type === 'hand' && lists[0]!.paragraph.source.includes('Second'));
    assert.ok(lists[1]!.type === 'hand' && lists[1]!.paragraph.source === '');
  });
});

describe('line breaking', () => {
  it('breaks greedily at the column width and starts at the left edge', () => {
    const tokens = Array.from({ length: 7 }, () => ({ dir: 'ltr' as const }));
    const metrics: TokenMetrics[] = tokens.map(() => ({ width: 40, ascent: 10, descent: 4 }));
    const lines = breakHandLines(tokens, metrics, { maxWidth: 150, space: 10 });

    // 3 × 40 + 2 × 10 = 140 ≤ 150; a 4th word would be 190.
    assert.deepEqual(
      lines.map((line) => line.tokens),
      [
        [0, 1, 2],
        [3, 4, 5],
        [6],
      ],
    );

    for (const line of lines) {
      assert.ok(line.width <= 150);
      const first = line.placed[0]!;

      assert.equal(first.x, 0, 'left-aligned');
      // Reading order runs left → right: the first logical word is the leftmost.
      assert.equal(first.index, line.tokens[0]);
    }
  });

  it('puts a word wider than the column alone on its line', () => {
    const lines = breakHandLines([{ dir: 'ltr' }, { dir: 'ltr' }], [{ width: 300, ascent: 1, descent: 1 }, { width: 20, ascent: 1, descent: 1 }], {
      maxWidth: 100,
      space: 5,
    });

    assert.equal(lines.length, 2);
  });

  it('centres a display formula', () => {
    const [line] = breakHandLines([{ dir: 'ltr' }], [{ width: 60, ascent: 1, descent: 1 }], { maxWidth: 200, space: 5, align: 'center' });

    assert.equal(line!.placed[0]!.x, 70);
  });
});

describe('humanising is seeded', () => {
  it('same seed → same handwriting, different seed → different', () => {
    const a = wordWobbles(seededRandom(hashSeed('solve the equation')), 40);
    const b = wordWobbles(seededRandom(hashSeed('solve the equation')), 40);
    const c = wordWobbles(seededRandom(hashSeed('solve the equation!')), 40);

    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });

  it('stays within ±1.5° and small size / baseline changes', () => {
    for (const wobble of wordWobbles(seededRandom(7), 500)) {
      assert.ok(Math.abs(wobble.rotate) <= MAX_WORD_ROTATION + 1e-9);
      assert.ok(Math.abs(wobble.dy) <= 0.04 + 1e-9);
      assert.ok(Math.abs(wobble.scale - 1) <= 0.04 + 1e-9);
    }
  });
});

describe('inkTrace — raster to outline', () => {
  it('traces a filled square as one closed ring of its area', () => {
    const rings = traceAlpha(raster(10, 10, [[2, 2, 5, 5]]), 10, 10);

    assert.equal(rings.length, 1);
    assert.ok(Math.abs(Math.abs(ringArea(rings[0]!)) - 25) < 1.5, `area ${ringArea(rings[0]!)}`);
  });

  it('traces a ring with a hole as two rings of opposite winding', () => {
    const rings = traceAlpha(raster(12, 12, [[1, 1, 10, 10]], [[4, 4, 4, 4]]), 12, 12);

    assert.equal(rings.length, 2);
    assert.ok(Math.sign(ringArea(rings[0]!)) !== Math.sign(ringArea(rings[1]!)));
  });

  it('closes shapes touching the raster edge and drops specks', () => {
    const rings = traceToRings(raster(8, 8, [[0, 0, 8, 3], [6, 6, 1, 1]]), 8, 8, { minArea: 2 });

    assert.equal(rings.length, 1);
  });

  it('emits smooth closed SVG path data', () => {
    const d = ringsToPathData(traceToRings(raster(10, 10, [[2, 2, 5, 5]]), 10, 10), (point) => point);

    assert.match(d, /^M [\d.]+ [\d.]+ (Q [\d. ]+ )+Z$/);
  });
});

describe('a handwritten line survives the save format', () => {
  it('round-trips through canvas JSON with its paths, fill rule and source text', async () => {
    registerAiObjectPersistence();

    const word = (x: number) => {
      const d = ringsToPathData(traceToRings(raster(12, 12, [[1, 1, 10, 10]], [[4, 4, 4, 4]]), 12, 12), (p) => ({ x: p.x + x, y: p.y }));

      return new Path(d, { fill: '#1d4ed8', stroke: '#1d4ed8', strokeWidth: 0.8, fillRule: 'evenodd' });
    };
    const line = new Group([word(0), word(20)], { originX: 'left', originY: 'top' });

    (line as unknown as Record<string, unknown>)[AI_OBJECT_PROP] = { kind: 'paragraph', source: "$f'(x) = 2x$", batch: 'ai-1', hand: true };

    const json = JSON.parse(serializeCanvasJson({ toJSON: () => ({ version: '7', objects: [line.toObject()] }) })) as { objects: unknown[] };
    const [restored] = (await util.enlivenObjects(json.objects)) as unknown as Group[];

    assert.ok(restored!.isType('Group'));

    const children = restored!.getObjects() as Path[];

    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.isType('Path') && child.fillRule === 'evenodd' && child.fill === '#1d4ed8'));
    assert.equal(children[0]!.path.length, (line.getObjects()[0] as Path).path.length);
    assert.deepEqual((restored as unknown as Record<string, unknown>)[AI_OBJECT_PROP], { kind: 'paragraph', source: "$f'(x) = 2x$", batch: 'ai-1', hand: true });
    assert.ok(Math.abs(restored!.left - line.left) < 0.01 && Math.abs(restored!.width - line.width) < 0.01);
  });

  it('is erased where its words are painted, not across the gap between them', () => {
    const square = (x: number) => new Path(`M ${x} 0 L ${x + 10} 0 L ${x + 10} 10 L ${x} 10 Z`, { fill: '#000', strokeWidth: 0, fillRule: 'evenodd' });
    const line = new Group([square(0), square(100)], { originX: 'left', originY: 'top', left: 0, top: 0 });
    const ring = (x: number, y: number) => ({ a: { x, y }, b: { x, y }, r: 3 });

    assert.ok(objectHitsEraser(line, ring(5, 5)), 'on the first word');
    assert.ok(objectHitsEraser(line, ring(105, 5)), 'on the second word');
    assert.ok(!objectHitsEraser(line, ring(55, 5)), 'between the words');
  });
});

describe('«Match my handwriting» — the teacher hand as numbers', () => {
  const stroke = (x: number, slantDeg: number, height: number, width = 3, color = '#1d4ed8'): InkSample => {
    const lean = Math.tan((slantDeg * Math.PI) / 180);

    return {
      points: Array.from({ length: 6 }, (_, index) => ({ x: x + index * (height / 5) * lean, y: 100 - index * (height / 5) })),
      width,
      color,
    };
  };

  it('reads slant, nib, letter size and the most used colour', () => {
    const samples = [
      ...Array.from({ length: 10 }, (_, index) => stroke(index * 30, 10, 20)),
      stroke(400, 10, 20, 3, '#e11d48'),
      stroke(500, 0, 400), // an underline-sized stroke is not a letter
    ];
    const style = estimateHandStyle(samples)!;

    assert.ok(Math.abs(style.slantDeg - 10) < 0.5, `slant ${style.slantDeg}`);
    assert.equal(style.strokeWidth, 3);
    assert.ok(Math.abs(style.letterHeight - 20) < 0.01);
    assert.equal(style.color, '#1d4ed8');
  });

  it('refuses to guess from too little ink', () => {
    assert.equal(estimateHandStyle([stroke(0, 5, 20)]), null);
  });
});

describe('the choice is remembered per board', () => {
  it('defaults ON for solve / explain until the teacher chooses', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    const fresh = readHandPrefs('b1', storage);

    assert.equal(handwritingDefault(fresh, 'solve'), true);
    assert.equal(handwritingDefault(fresh, 'explain'), true);
    assert.equal(handwritingDefault(fresh, 'check_answer'), false);

    writeHandPrefs('b1', { on: false, matchHand: true }, storage);

    assert.equal(handwritingDefault(readHandPrefs('b1', storage), 'solve'), false);
    assert.equal(readHandPrefs('b1', storage).matchHand, true);
    assert.equal(readHandPrefs('b2', storage).on, null, 'another board keeps its own default');
  });
});
