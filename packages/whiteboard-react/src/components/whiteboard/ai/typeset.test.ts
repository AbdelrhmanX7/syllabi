import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BOARD_FONT_WEIGHTS, fontSpec, isBoardFontLoaded, loadBoardFontFaces } from './fontGate';
import { hasOverlayText } from './remakeDraft';
import {
  bboxToRect,
  choiceLine,
  fitFontSize,
  groupOverlayBlocks,
  isPlainMath,
  layoutChoices,
  needsTypesetMath,
  placeImageLabels,
  resolveOverlayGroup,
  tokenizeTypeset,
  wrapLineCount,
} from './typesetLayout';

import type { FontSetLike } from './fontGate';

/** Monospace stand-in for canvas text: every character is half the font size wide. */
const mono = (text: string, size: number) => Array.from(text).length * size * 0.5;

describe('bbox text fitting', () => {
  // A wrapped paragraph of `chars` mono characters in a box `width` wide, lines 1.25 × size apart.
  const paragraph = (chars: number, width: number) => (size: number) => {
    const perLine = Math.max(1, Math.floor(width / (size * 0.5)));
    const lines = Math.ceil(chars / perLine);

    return { width: Math.min(width, chars * size * 0.5), height: lines * size * 1.25 };
  };

  it('keeps the requested size when it already fits', () => {
    const fit = fitFontSize(paragraph(20, 400), { width: 400, height: 40 }, { start: 24, min: 10 });

    assert.equal(fit.fontSize, 24);
    assert.equal(fit.fits, true);
  });

  it('shrinks until the wrapped text fits the box height', () => {
    const fit = fitFontSize(paragraph(200, 300), { width: 300, height: 60 }, { start: 30, min: 6 });

    assert.ok(fit.fontSize < 30);
    assert.ok(fit.fits);
    assert.ok(fit.size.height <= 60 * 1.03);
    // Not over-shrunk: one step bigger would not fit.
    assert.ok(paragraph(200, 300)(fit.fontSize / 0.92).height > 60 * 1.03);
  });

  it('stops at the minimum and says it does not fit', () => {
    const fit = fitFontSize(paragraph(5000, 100), { width: 100, height: 20 }, { start: 20, min: 12 });

    assert.equal(fit.fontSize, 12);
    assert.equal(fit.fits, false);
  });

  it('counts wrapped lines greedily', () => {
    assert.equal(wrapLineCount([50, 50, 50], 120, 10), 2);
    assert.equal(wrapLineCount([200], 120, 10), 1, 'a word wider than the box stands alone');
    assert.equal(wrapLineCount([], 120, 10), 0);
  });

  it('maps normalised bboxes onto the page rect', () => {
    assert.deepEqual(bboxToRect({ x: 0.1, y: 0.5, w: 0.5, h: 0.1 }, { left: 100, top: 50, width: 1000, height: 2000 }), {
      left: 200,
      top: 1050,
      width: 500,
      height: 200,
    });
  });
});

describe('multiple-choice layouts', () => {
  const box = { width: 800, height: 200 };

  it('inline: one row, the first choice on the left', () => {
    const { arrangement, cells } = layoutChoices([100, 100, 100, 100], box, { preferred: 'inline', lineHeight: 30, gap: 20 });

    assert.equal(arrangement, 'inline');
    assert.equal(new Set(cells.map((cell) => cell.top)).size, 1, 'one row');
    assert.ok(cells[0]!.left < cells[1]!.left && cells[1]!.left < cells[2]!.left && cells[2]!.left < cells[3]!.left, 'left to right');
    assert.ok(cells[0]!.left >= -0.001);
    assert.ok(cells[3]!.left + cells[3]!.width <= box.width + 0.001);
  });

  it('inline falls back to a 2×2 grid (a b / c d) and then a stack when choices are long', () => {
    const grid = layoutChoices([300, 300, 300, 300], box, { preferred: 'inline', lineHeight: 30, gap: 20 });

    assert.equal(grid.arrangement, 'grid');
    assert.equal(grid.cells[0]!.top, grid.cells[1]!.top);
    assert.ok(grid.cells[0]!.left < grid.cells[1]!.left, 'a left of b');
    assert.ok(grid.cells[2]!.top > grid.cells[0]!.top, 'c on the second row');

    const stacked = layoutChoices([700, 100, 100, 100], box, { preferred: 'inline', lineHeight: 30, gap: 20 });

    assert.equal(stacked.arrangement, 'stacked');
  });

  it('stacked: one full-width row each, top to bottom', () => {
    const { arrangement, cells, height } = layoutChoices([50, 50, 50], box, { preferred: 'stacked', lineHeight: 30, gap: 20 });

    assert.equal(arrangement, 'stacked');
    assert.ok(cells.every((cell) => cell.width === box.width && cell.left === 0));
    assert.ok(cells[0]!.top < cells[1]!.top && cells[1]!.top < cells[2]!.top);
    assert.ok(height <= box.height + 0.001);
  });

  it('choice lines get their label once', () => {
    assert.equal(choiceLine('a', 'newton'), 'a) newton');
    assert.equal(choiceLine('b)', 'joule'), 'b) joule');
    assert.equal(choiceLine('c', 'c) watt'), 'c) watt');
    assert.equal(choiceLine('', 'no letter'), 'no letter');
  });

  it('groups overlay blocks per question number, keeping order', () => {
    const groups = groupOverlayBlocks([{ n: '1', id: 'a' }, { id: 'h' }, { n: '2', id: 'b' }, { n: '1', id: 'c' }]);

    assert.deepEqual(
      groups.map((group) => group.map((block) => block.id)),
      [['a', 'c'], ['h'], ['b']],
    );
  });

  it('BE #564 group: number before the text, choice blocks as «label) text» in the question style, missing ones get the next slot', () => {
    const style = { fontSizeRel: 0.016, weight: 'medium', align: 'left', color: '#111111' };
    const box = (x: number, y: number, w = 0.2, h = 0.03) => ({ x, y, w, h });
    const resolved = resolveOverlayGroup([
      {
        n: '1',
        kind: 'question',
        bbox: box(0.1, 0.2, 0.8, 0.05),
        text: 'A body of mass $8\\,kg$…',
        number: '1)',
        style,
        choices: [
          { label: 'a', text: '3' },
          { label: 'b', text: '4' },
          { label: 'c', text: '5' },
        ],
      },
      { n: '1', kind: 'choice', bbox: box(0.6, 0.26), label: 'a', text: '3' },
      { n: '1', kind: 'choice', bbox: box(0.6, 0.3), label: 'b)', text: '4', style: { color: '#222222' } },
    ]);

    assert.equal(resolved[0]!.text, '1) A body of mass $8\\,kg$…');
    assert.equal(resolved[0]!.choices, undefined, 'the question draws its stem only');
    assert.equal(resolved[1]!.text, 'a) 3');
    assert.deepEqual(resolved[1]!.style, style, 'a choice uses its question style');
    assert.equal(resolved[2]!.text, 'b) 4');
    assert.equal((resolved[2]!.style as { color: string }).color, '#222222');
    assert.equal(resolved.length, 4, 'the missing «c» gets a block');
    assert.equal(resolved[3]!.kind, 'choice');
    assert.equal(resolved[3]!.text, 'c) 5');
    assert.ok(Math.abs(resolved[3]!.bbox.y - 0.34) < 1e-9 && resolved[3]!.bbox.x === 0.6, 'next slot in the stacked pattern');

    const inline = resolveOverlayGroup([
      { n: '2', kind: 'question', bbox: box(0.1, 0.5, 0.8, 0.04), text: 'Question', number: null, style, choiceLayout: 'inline' as const, choices: [{ label: 'a', text: 'x' }, { label: 'b', text: 'y' }] },
    ]);

    assert.equal(inline[0]!.text, 'Question', 'number null = none printed');
    assert.equal(inline.length, 3, 'no choice block at all → one slot per listed choice');
    assert.ok(inline[1]!.bbox.x < inline[2]!.bbox.x, 'inline fallback: first choice on the left');
    assert.ok(Math.abs(inline[1]!.bbox.y - 0.54) < 1e-9, 'under the question');
  });

  it('an overlay result counts only with something to write', () => {
    assert.equal(hasOverlayText(null), false);
    assert.equal(hasOverlayText({ layout: { blocks: [] } }), false);
    assert.equal(hasOverlayText({ layout: { blocks: [{ kind: 'question', bbox: { x: 0, y: 0, w: 1, h: 1 }, text: 'Q' }] } }), true);
  });
});

describe('picture labels', () => {
  const picture = { width: 1000, height: 600 };

  it('centres a label on its anchor at sizeRel × height, with a leader to its target', () => {
    const [label] = placeImageLabels([{ text: 'root', anchor: { x: 0.5, y: 0.2 }, target: { x: 0.5, y: 0.8 }, sizeRel: 0.05 }], picture, mono);

    assert.ok(label);
    assert.equal(label.fontSize, 30);
    assert.ok(Math.abs(label.left + label.width / 2 - 500) < 0.001);
    assert.ok(Math.abs(label.top + label.height / 2 - 120) < 0.001);
    assert.ok(label.leader);
    assert.equal(label.leader.x2, 500);
    assert.equal(label.leader.y2, 480);
    // The leader starts at the box's lower edge, not inside the text.
    assert.ok(label.leader.y1 >= label.top + label.height);
  });

  it('keeps labels inside the picture and out of each other', () => {
    const placed = placeImageLabels(
      [
        { text: 'plant stem', anchor: { x: 0.99, y: 0.5 } },
        { text: 'plant stem', anchor: { x: 0.99, y: 0.5 } },
        { text: 'leaf', anchor: { x: 0.5, y: 0.0 } },
      ],
      picture,
      mono,
    );

    for (const label of placed) {
      assert.ok(label.left >= 0 && label.left + label.width <= picture.width + 0.001);
      assert.ok(label.top >= 0 && label.top + label.height <= picture.height + 0.001);
    }

    const [a, b] = placed;

    assert.ok(a!.top + a!.height <= b!.top || b!.top + b!.height <= a!.top, 'the twin label moved off the first');
  });

  it('no leader when the target sits under the label, and empty labels are skipped', () => {
    const placed = placeImageLabels(
      [
        { text: 'here', anchor: { x: 0.5, y: 0.5 }, target: { x: 0.5, y: 0.5 } },
        { text: '  ', anchor: { x: 0.1, y: 0.1 } },
      ],
      picture,
      mono,
    );

    assert.equal(placed.length, 1);
    assert.equal(placed[0]!.leader, null);
  });

  it('clamps the size between the limits', () => {
    const [small] = placeImageLabels([{ text: 'a', anchor: { x: 0.5, y: 0.5 }, sizeRel: 0.001 }], picture, mono, { minFont: 12 });
    const [big] = placeImageLabels([{ text: 'a', anchor: { x: 0.5, y: 0.5 }, sizeRel: 0.29 }], picture, mono, { maxFont: 64 });

    assert.equal(small!.fontSize, 12);
    assert.equal(big!.fontSize, 64);
  });
});

describe('math', () => {
  it('plain formulas stay Plex text; real ones go to KaTeX', () => {
    assert.equal(isPlainMath('x = 5'), true);
    assert.equal(isPlainMath('3 \\times 4'), true);
    assert.equal(isPlainMath('\\frac{1}{2}'), false);
    assert.equal(isPlainMath('x^2'), false);
    assert.equal(isPlainMath('H_2O'), false);
    assert.equal(isPlainMath('\\alpha'), false);
    assert.equal(needsTypesetMath('the force $F = ma$ is constant'), false);
    assert.equal(needsTypesetMath('acceleration $a = \\frac{F}{m}$'), true);
    assert.equal(needsTypesetMath('no maths'), false);
  });

  it('tokenizes a line into words and one formula token', () => {
    const tokens = tokenizeTypeset('find $\\frac{F}{m}$ if the mass is 2');

    assert.deepEqual(
      tokens.map((token) => [token.kind, token.kind === 'math' ? token.tex : token.text, token.dir]),
      [
        ['word', 'find', 'ltr'],
        ['math', '\\frac{F}{m}', 'ltr'],
        ['word', 'if', 'ltr'],
        ['word', 'the', 'ltr'],
        ['word', 'mass', 'ltr'],
        ['word', 'is', 'ltr'],
        ['word', '2', 'ltr'],
      ],
    );
  });
});

describe('font-ready gating', () => {
  /** A FontFaceSet stand-in: `declared` weights have @font-face rules, `loaded` ones are in memory. */
  const fakeFonts = ({ declared, loaded = [] as number[], hang = false }: { declared: number[]; loaded?: number[]; hang?: boolean }) => {
    const faces = new Map<number, { family: string; weight: string; status: string }>();

    for (const weight of declared) faces.set(weight, { family: 'IBM Plex Sans Arabic', weight: String(weight), status: 'unloaded' });
    for (const weight of loaded) faces.set(weight, { family: '"IBM Plex Sans Arabic"', weight: weight === 400 ? 'normal' : String(weight), status: 'loaded' });

    const added: unknown[] = [];
    const weightOf = (spec: string) => Number(spec.split(' ')[0]);
    const set: FontSetLike & { added: unknown[] } = {
      added,
      forEach: (callback) => faces.forEach((face) => callback(face)),
      load: (spec) => {
        if (hang) return new Promise(() => {});

        const face = faces.get(weightOf(spec));

        if (face) face.status = 'loaded';

        return Promise.resolve(face ? [face] : []);
      },
      add: (face) => {
        added.push(face);
      },
      ready: Promise.resolve(),
    };

    return set;
  };

  it('treats an undeclared family as NOT loaded (unlike document.fonts.check)', () => {
    assert.equal(isBoardFontLoaded(fakeFonts({ declared: [] })), false);
    assert.equal(isBoardFontLoaded(fakeFonts({ declared: [], loaded: [400] })), true, "'normal' is weight 400, quotes ignored");
    assert.equal(isBoardFontLoaded(fakeFonts({ declared: [400] })), false, 'declared but not loaded yet');
  });

  it('opens at once when every weight is already loaded', async () => {
    const fonts = fakeFonts({ declared: [], loaded: [...BOARD_FONT_WEIGHTS] });
    const result = await loadBoardFontFaces(fonts);

    assert.deepEqual(result, { ready: true, injected: [], missing: [] });
  });

  it('loads through the page @font-face rules', async () => {
    const result = await loadBoardFontFaces(fakeFonts({ declared: [...BOARD_FONT_WEIGHTS] }));

    assert.equal(result.ready, true);
    assert.deepEqual(result.injected, []);
  });

  it('declares the face itself from /font/ when the page has no rule (static export, test page)', async () => {
    const fonts = fakeFonts({ declared: [400] });
    const urls: string[] = [];
    const result = await loadBoardFontFaces(fonts, {
      baseUrl: '/font/',
      createFace: (family, source, descriptors) => {
        urls.push(`${family}|${descriptors.weight}|${source}`);

        return { load: () => Promise.resolve() };
      },
    });

    assert.equal(result.ready, true);
    assert.deepEqual(result.injected.sort(), [500, 600, 700]);
    assert.equal(fonts.added.length, 3);
    assert.ok(urls.includes("IBM Plex Sans Arabic|600|url(/font/IBMPlexSansArabic-SemiBold.woff2) format('woff2')"));
  });

  it('stays closed (ready:false) when a weight cannot load — no FontFace API, or a file that fails', async () => {
    const noApi = await loadBoardFontFaces(fakeFonts({ declared: [400] }));

    assert.equal(noApi.ready, false);
    assert.deepEqual(noApi.missing, [500, 600, 700]);

    const failing = await loadBoardFontFaces(fakeFonts({ declared: [] }), {
      createFace: () => ({ load: () => Promise.reject(new Error('404')) }),
    });

    assert.equal(failing.ready, false);
    assert.equal(failing.missing.length, BOARD_FONT_WEIGHTS.length);
  });

  it('gives up after the timeout instead of hanging an insert', async () => {
    const started = Date.now();
    const result = await loadBoardFontFaces(fakeFonts({ declared: [400], hang: true }), { timeoutMs: 60 });

    assert.equal(result.ready, false);
    assert.ok(Date.now() - started < 1000);
  });

  it('asks for the exact weight + family Fabric will draw with', () => {
    assert.equal(fontSpec(600), "600 24px 'IBM Plex Sans Arabic'");
  });
});
